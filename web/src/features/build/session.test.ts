import { afterAll, describe, expect, mock, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import type { ApplicationDraftCreationPlanValidation } from '@appthrust/api-schema/platform-api'
import { buildCopy } from '../../model/build/copy'
import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
import { acknowledgeReply, forgetBuildSession, initialSession, queueReply, readBuildSession, saveBuildSession, startConversation, startPrepareConversation, titleFromIntent } from './session'
import { validatePreparationPlan } from './use-build-session'

// Language tests must leave the Dashboard's shared browser preference alone.
const originalCookie = document.cookie
const originalDocumentLanguage = document.documentElement.getAttribute('lang')
afterAll(() => {
  expect(document.cookie).toBe(originalCookie)
  expect(document.documentElement.getAttribute('lang')).toBe(originalDocumentLanguage)
})

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
    clear: () => { values.clear() },
    key: (index) => [...values.keys()][index] ?? null,
  }
}
const initial = initialSession({ projectId: 'p1', ownerSubject: 'u1', groupId: 'sales', baseIntent: '見積を作りたい' })

describe('build session persistence', () => {
  test('reserves and queues the opening once, including after reload before the request settles', () => {
    const draft = { phase: 'specifying' as const, conversationTurns: [], creationExecutions: [] }
    const started = startConversation(initial, draft, 'now')
    expect(started.kickoffSent).toBe(true)
    expect(started.pending).toEqual([{ text: buildCopy.questions.firstTurn, at: 'now' }])
    expect(started.messages).toEqual([{ role: 'user', text: buildCopy.questions.firstTurn, at: 'now' }])
    expect(initial.pending).toEqual([])
    expect(initial.kickoffSent).toBe(false)
    expect(startConversation(started, draft, 'later')).toBe(started)
    const target = storage()
    saveBuildSession('opening', started, target)
    const reloaded = readBuildSession('opening', target)!
    expect(startConversation(reloaded, draft, 'later')).toBe(reloaded)
    const acknowledged = acknowledgeReply(reloaded, 'now')
    expect(startConversation(acknowledged, draft, 'later')).toBe(acknowledged)
  })
  test('existing, failed or running turns and existing plans never start another opening', () => {
    for (const status of ['pending', 'running', 'succeeded', 'failed'] as const) {
      const draft = { phase: 'specifying' as const, conversationTurns: [{ id: 't1', kind: 'conversation' as const, status, startedAt: 'now', userMessage: buildCopy.questions.firstTurn, devWorkspaceId: 'ws-1' }], creationExecutions: [] }
      expect(startConversation(initial, draft, 'later')).toBe(initial)
    }
    expect(startConversation(initial, { phase: 'planned', creationPlan: { summary: '', markdown: '', representation: [] }, creationExecutions: [] }, 'later')).toBe(initial)
    expect(startConversation(initial, { phase: 'created', creationExecutions: [] }, 'later')).toBe(initial)
    const queued = queueReply(initial, '人事の一覧', 'now')
    expect(startConversation(queued, { phase: 'specifying', creationExecutions: [] }, 'later')).toBe(queued)
  })
  test('用意する asks once: the preparation turn is queued when the execution runs and the AI is idle', () => {
    const execution = { id: 'e1', attempt: 1, status: 'running' as const, startedAt: 'now', steps: [] }
    const opening = { id: 't1', kind: 'conversation' as const, status: 'succeeded' as const, startedAt: 'before', userMessage: buildCopy.questions.firstTurn, devWorkspaceId: 'ws-1' }
    const preparing = { conversationTurns: [opening], creationExecutions: [execution] }
    const started = startPrepareConversation(initial, preparing, 'now')
    expect(started.pending).toEqual([{ text: buildCopy.questions.prepareTurn, at: 'now' }])
    expect(startPrepareConversation(started, preparing, 'later')).toBe(started)
    const target = storage()
    saveBuildSession('prepare', started, target)
    const reloaded = readBuildSession('prepare', target)!
    expect(startPrepareConversation(reloaded, preparing, 'later')).toBe(reloaded)
    const accepted = { ...preparing, conversationTurns: [...preparing.conversationTurns, { ...opening, id: 'prepare', userMessage: buildCopy.questions.prepareTurn }] }
    expect(startPrepareConversation(acknowledgeReply(reloaded, 'now'), accepted, 'later').pending).toEqual([])
    // Not before or after 用意する, not while the AI or the plan is busy, and never twice for one draft.
    for (const status of ['succeeded', 'failed'] as const) {
      expect(startPrepareConversation(initial, { ...preparing, creationExecutions: [{ ...execution, status }] }, 'later')).toBe(initial)
    }
    expect(startPrepareConversation(initial, { conversationTurns: [opening], creationExecutions: [] }, 'later')).toBe(initial)
    expect(startPrepareConversation(initial, { ...preparing, conversationTurns: [{ ...opening, status: 'running' }] }, 'later')).toBe(initial)
    expect(startPrepareConversation(initial, { ...preparing, creationPlanGenerations: [{ id: 'g1', status: 'running', startedAt: 'now', devWorkspaceId: 'ws-1' }] }, 'later')).toBe(initial)
    expect(startPrepareConversation(initial, { ...preparing, conversationTurns: [opening, { ...opening, id: 't2', userMessage: buildCopy.questions.prepareTurn }] }, 'later')).toBe(initial)
    const queued = queueReply(initial, '一覧に検索', 'now')
    expect(startPrepareConversation(queued, preparing, 'later')).toBe(queued)
  })
  test('draft preferences skip preparation in a fresh session and obsolete session choices are discarded', () => {
    const target = storage()
    target.setItem('builder-console:build:excel', JSON.stringify({ ...initial, prepareTurnSent: true, publishName: '以前の名前', shareChoice: 'private' }))
    const reloaded = readBuildSession('excel', target)!
    expect(reloaded).toEqual(initial)
    const draft = {
      phase: 'planned' as const,
      creationPlan: { summary: '', markdown: '', representation: [] },
      creationExecutions: [{ id: 'e1', attempt: 1, status: 'running' as const, startedAt: 'now', steps: [] }],
      publishPreferences: { name: '不具合管理', shareScope: 'group' as const },
    }
    expect(startConversation(reloaded, draft, 'now')).toBe(reloaded)
    expect(startPrepareConversation(reloaded, draft, 'now')).toBe(reloaded)
    expect(reloaded.pending).toEqual([])
    expect(reloaded.messages).toEqual([])
  })
  test('acknowledging one reply preserves later replies including identical text', () => {
    const queued = queueReply(queueReply(initial, 'ロゴを入れる', 'first'), 'ロゴを入れる', 'second')
    const acknowledged = acknowledgeReply(queued, 'first')
    expect(acknowledged.pending).toEqual([{ text: 'ロゴを入れる', at: 'second' }])
    expect(acknowledged.messages).toEqual([{ role: 'user', text: 'ロゴを入れる', at: 'second' }])
    expect(queued.pending).toHaveLength(2)
    expect(queueReply(initial, '  ', 'empty')).toBe(initial)
  })
  test('reload retains preparation reservation, queued messages, binding, template release and continuation', () => {
    const target = storage()
    const session = { ...queueReply(initial, '変更したい', 'now'), kickoffSent: true, lastPlannedIntent: '見積を作りたい', prepareRequested: true, createdAppId: 'app1', continuedAfterPublishAt: '2026-10-29T00:00:00Z', initialReleaseId: 'template-release' }
    saveBuildSession('draft1', session, target)
    expect(target.getItem('builder-console:build:draft1')).not.toBeNull()
    expect(readBuildSession('draft1', target)).toEqual(session)
  })
  test.each([true, false])('legacy published=%s sessions parse without retaining tab-owned publication', (published) => {
    const target = storage()
    const session = queueReply(initial, '変更したい', 'now')
    target.setItem('builder-console:build:legacy', JSON.stringify({ ...session, published }))
    expect(readBuildSession('legacy', target)).toEqual(session)
    expect(readBuildSession('legacy', target)).not.toHaveProperty('published')
  })
  test('reload retains the support reference and failure time without raw diagnostics', () => {
    const target = storage()
    const at = '2026-10-17T09:09:00.000Z'
    const reference = { draftId: 'draft-ae97efbc', executionId: 'exec-123', at }
    const session = { ...initial, messages: [{ role: 'notice' as const, tone: 'error' as const, title: buildCopy.failure.platform.title, detail: buildCopy.failure.platform.reason, retry: 'prepare' as const, at, reference }] }
    saveBuildSession(reference.draftId, session, target)
    expect(readBuildSession(reference.draftId, target)?.messages).toEqual(session.messages)
  })
  test('reload discards the obsolete one-shot publish reservation', () => {
    const target = storage()
    target.setItem('builder-console:build:repair', JSON.stringify({ ...initial, publishRepairAppId: 'platform-app1' }))
    expect(readBuildSession('repair', target)).toEqual(initial)
  })
  test('やめる forgets the session so a later visit starts fresh', () => {
    const target = storage()
    saveBuildSession('draft1', initial, target)
    forgetBuildSession('draft1', target)
    expect(readBuildSession('draft1', target)).toBeUndefined()
    expect(() => forgetBuildSession('no-access', { removeItem() { throw new Error('denied') } })).not.toThrow()
  })
  test('malformed or unavailable storage does not prevent starting', () => {
    const target = storage()
    for (const text of ['{', '{}', '{"pending":[]}']) {
      target.setItem('builder-console:build:bad', text)
      expect(readBuildSession('bad', target)).toBeUndefined()
    }
    expect(readBuildSession('no-access', { getItem() { throw new Error('denied') } })).toBeUndefined()
    expect(() => saveBuildSession('no-access', initial, { setItem() { throw new Error('denied') } })).not.toThrow()
  })
  test('draft titles use a bounded first clause, not an AI response', () => {
    expect(titleFromIntent(' 見積を作りたい。承認も必要 ')).toBe('見積を作りたい')
    expect(titleFromIntent('# 「台帳」仕様書\n## 1. 概要')).toBe('「台帳」仕様書')
    expect(titleFromIntent('')).toBe('新しいアプリ')
    expect(titleFromIntent('あ'.repeat(100))).toHaveLength(60)
  })
  test('new turns follow the language while persisted preparation turns stay reserved', () => {
    const restoreLanguage = preserveLanguage()
    try {
      setLanguage('ja')
      const japanesePrepareTurn = buildCopy.questions.prepareTurn
      setLanguage('en')
      const opening = startConversation(initial, { phase: 'specifying', creationExecutions: [] }, 'now')
      expect(opening.pending[0]?.text).toBe(buildCopy.questions.firstTurn)
      expect(opening.pending[0]?.text).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
      expect(titleFromIntent('')).toBe('New app')
      const preparing = { creationExecutions: [{ id: 'e1', attempt: 1, status: 'running' as const, startedAt: 'now', steps: [] }] }
      const started = startPrepareConversation(initial, preparing, 'now')
      expect(started.pending[0]?.text).toBe(buildCopy.questions.prepareTurn)
      expect(started.pending[0]?.text).not.toBe(japanesePrepareTurn)
      const persisted = { ...preparing, conversationTurns: [{ id: 't1', kind: 'conversation' as const, status: 'succeeded' as const, startedAt: 'before', userMessage: japanesePrepareTurn, devWorkspaceId: 'ws-1' }] }
      expect(startPrepareConversation(initial, persisted, 'later')).toBe(initial)
    } finally {
      restoreLanguage()
    }
  })
})

describe('prepare validation recovery', () => {
  const conflictText = 'application draft changed while validating the creation plan; validate the latest plan again'
  const conflict = new ORPCError('CONFLICT', { status: 409, data: { body: { error: { code: 'conflict', message: conflictText } } } })
  const valid: ApplicationDraftCreationPlanValidation = { valid: true, message: 'Ready', creationPlanFingerprint: 'fresh-fingerprint' }

  test('a stale validation conflict is retried once and returns only the fresh fingerprint', async () => {
    const validate = mock(async (_projectId: string, _draftId: string): Promise<ApplicationDraftCreationPlanValidation> => valid)
      .mockRejectedValueOnce(conflict)
    expect(await validatePreparationPlan('project-1', 'draft-ae97efbc', validate)).toBe('fresh-fingerprint')
    expect(validate.mock.calls).toEqual([['project-1', 'draft-ae97efbc'], ['project-1', 'draft-ae97efbc']])
  })
  test('a valid plan needs only one validation', async () => {
    const validate = mock(async () => valid)
    expect(await validatePreparationPlan('project-1', 'draft-1', validate)).toBe('fresh-fingerprint')
    expect(validate).toHaveBeenCalledTimes(1)
  })
  test('a second stale conflict is surfaced without an unbounded retry', async () => {
    const validate = mock(async (): Promise<ApplicationDraftCreationPlanValidation> => { throw conflict })
    await expect(validatePreparationPlan('project-1', 'draft-1', validate)).rejects.toBe(conflict)
    expect(validate).toHaveBeenCalledTimes(2)
  })
  test.each([
    [409, 'name already exists: inventory'],
    [409, 'application draft conversation turn or plan generation is running'],
    [500, conflictText],
    [403, conflictText],
  ])('does not automatically retry unrelated failure %s %s', async (status, message) => {
    const error = new ORPCError('ERROR', { status, data: { body: { error: { message } } } })
    const validate = mock(async (): Promise<ApplicationDraftCreationPlanValidation> => { throw error })
    await expect(validatePreparationPlan('project-1', 'draft-1', validate)).rejects.toBe(error)
    expect(validate).toHaveBeenCalledTimes(1)
  })
  test('a plain HTTP conflict also gets one retry', async () => {
    const validate = mock(async () => valid).mockRejectedValueOnce(Object.assign(new Error(conflictText), { status: 409 }))
    expect(await validatePreparationPlan('project-1', 'draft-1', validate)).toBe('fresh-fingerprint')
    expect(validate).toHaveBeenCalledTimes(2)
  })
  test('invalid validation keeps the runtime rejection for the advanced disclosure, without retrying', async () => {
    const validate = mock(async (): Promise<ApplicationDraftCreationPlanValidation> => ({
      valid: false, message: 'Launch needs changes before resources can be created.',
      staticErrors: ['Invalid generated plan'],
      applicationStackValidation: {
        valid: false, message: 'Stack needs changes', source: { valid: true, message: 'Ready' },
        runtime: { valid: false, message: "'definitionRef' is required" },
        resolvedBranch: { applicationId: 'inventory', branchId: 'main', state: 'pending', management: { source: 'applicationStack', mutableFields: [] } },
      },
    }))
    await expect(validatePreparationPlan('project-1', 'draft-1', validate)).rejects.toThrow("Launch needs changes before resources can be created.\nInvalid generated plan\n'definitionRef' is required")
    expect(validate).toHaveBeenCalledTimes(1)
  })
  test('valid without a fingerprint never starts creation or retries validation', async () => {
    const validate = mock(async () => ({ valid: true, message: 'Missing validation fingerprint' }))
    await expect(validatePreparationPlan('project-1', 'draft-1', validate)).rejects.toThrow('Missing validation fingerprint')
    expect(validate).toHaveBeenCalledTimes(1)
  })
})
