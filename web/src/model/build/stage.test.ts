import { describe, expect, test } from 'bun:test'
import type { ApplicationDraft, ApplicationDraftConversationTurn, ApplicationDraftCreationExecution, ApplicationDraftCreationPlanGeneration } from '@appthrust/api-schema/platform-api'
import { buildCopy } from './copy'
import { deriveStage, draftPublished, needsPlanRefresh } from './stage'
import { executionSteps, formatElapsed, progressCard } from './progress'

const startedAt = '2026-10-08T00:00:00Z'
const now = Date.parse(startedAt) + 67_000
const generation: ApplicationDraftCreationPlanGeneration = { id: 'gen-1', status: 'succeeded', startedAt, finishedAt: '2026-10-08T00:01:00Z', devWorkspaceId: 'ws-1' }
const execution: ApplicationDraftCreationExecution = { id: 'exec-1', attempt: 1, status: 'running', startedAt, steps: [] }
const turn: ApplicationDraftConversationTurn = { id: 'turn-1', kind: 'conversation', status: 'running', startedAt, devWorkspaceId: 'ws-1', userMessage: 'PDF も' }
const draft: ApplicationDraft = {
  id: 'draft-1', projectId: 'project-1', title: '見積', intent: '見積を作る', phase: 'planned', specMarkdown: '', architectureMarkdown: '',
  creationPlan: { summary: '見積を作る', markdown: '# 見積', representation: [] }, creationPlanGenerations: [generation], creationExecutions: [],
  ownerUserId: 'user-1', createdAt: startedAt, updatedAt: startedAt,
}
const unplanned: ApplicationDraft = { ...draft, phase: 'specifying', creationPlan: undefined, creationPlanGenerations: [] }
const base = { draft, now, published: draftPublished(draft) }

describe('design section 4 stage table', () => {
  test('keeps asking through successful turns until a plan or successful generation exists', () => {
    expect(deriveStage({ ...base, draft: unplanned })).toMatchObject({ stage: 'ask', primary: { action: 'none', enabled: false } })
    expect(deriveStage({ ...base, draft: { ...unplanned, conversationTurns: [{ ...turn, status: 'succeeded' }] } }).stage).toBe('ask')
    expect(deriveStage({ ...base, draft: unplanned, generation }).stage).toBe('decide')
    expect(deriveStage({ ...base, draft: { ...unplanned, creationPlan: draft.creationPlan } }).stage).toBe('decide')
    expect(deriveStage({ ...base, draft: undefined }).stage).toBe('ask')
  })
  test('an idle unplanned conversation offers a plan action without pretend progress', () => {
    const current = { ...unplanned, conversationTurns: [{ ...turn, status: 'succeeded' as const, userMessage: buildCopy.questions.kickoffReply }] }
    expect(deriveStage({ ...base, draft: current })).toEqual({
      stage: 'ask', primary: { action: 'plan', label: buildCopy.questions.kickoffReply, enabled: true },
    })
    expect(deriveStage({ ...base, draft: current, turn }).primary.action).toBe('none')
    expect(deriveStage({ ...base, draft: current, generation: { ...generation, status: 'pending' } }).primary.action).toBe('none')
  })
  test('decides with a ready plan and enables preparation', () => {
    expect(deriveStage(base)).toEqual({ stage: 'decide', primary: { action: 'prepare', label: buildCopy.primary.prepare, enabled: true } })
  })
  test('reserves preparation while generating or when the spec needs refresh', () => {
    for (const status of ['pending', 'running'] as const) {
      expect(deriveStage({ ...base, generation: { ...generation, status } })).toMatchObject({ stage: 'decide', primary: { action: 'prepare-after-plan', enabled: true }, progress: { kind: 'plan' } })
    }
    expect(deriveStage({ ...base, draft: { ...draft, phase: 'specifying' } })).toMatchObject({ stage: 'decide', primary: { action: 'prepare-after-plan' } })
    expect(deriveStage({ ...base, draft: unplanned }).primary.action).toBe('none')
  })
  test('shows workspace warm-up during questions and the active turn before a background plan', () => {
    expect(deriveStage({ ...base, draft: unplanned, generation: { ...generation, status: 'running', stage: 'workspace' } })).toMatchObject({ stage: 'ask', primary: { action: 'none' }, progress: { kind: 'workspace' } })
    expect(deriveStage({ ...base, turn, generation: { ...generation, status: 'running' } })).toMatchObject({ stage: 'decide', primary: { enabled: false }, progress: { kind: 'turn' } })
  })
  test('only the initial real conversation operation includes first-use startup progress', () => {
    const initialDraft = { ...draft, phase: 'specifying' as const, creationPlan: undefined, creationPlanGenerations: [], conversationTurns: [turn] }
    for (const status of ['pending', 'running'] as const) {
      expect(deriveStage({ ...base, draft: initialDraft, turn: { ...turn, status } }).progress).toMatchObject({ kind: 'workspace' })
    }
    expect(deriveStage({ ...base, draft: { ...initialDraft, conversationTurns: [] } }).progress).toBeUndefined()
    expect(deriveStage({ ...base, draft: initialDraft, turn: { ...turn, status: 'succeeded' } }).progress).toBeUndefined()
    for (const status of ['succeeded', 'failed'] as const) {
      expect(deriveStage({ ...base, draft: { ...initialDraft, conversationTurns: [{ ...turn, id: 'earlier-turn', status }, turn] } }).progress?.kind).toBe('turn')
    }
    expect(deriveStage({ ...base, turn }).progress?.kind).toBe('turn')
  })
  test('preparation disables the primary and owns progress even with an active turn', () => {
    expect(deriveStage({ ...base, execution, turn })).toMatchObject({ stage: 'build', build: { phase: 'preparing' }, primary: { action: 'none', enabled: false }, progress: { kind: 'prepare', elapsedLabel: '1:07' } })
    expect(deriveStage({ ...base, draft: { ...draft, creationExecutions: [execution] } }).stage).toBe('build')
  })
  test('failed preparation returns to deciding with the retained plan and failed step list', () => {
    const failed: ApplicationDraftCreationExecution = {
      ...execution, status: 'failed', error: 'name already exists: foo',
      steps: [{ id: 'source', tool: 'appthrust.applicationSourceRepository.create', status: 'failed', message: 'name already exists: foo' }],
    }
    expect(deriveStage({ ...base, execution: failed })).toMatchObject({
      stage: 'decide', primary: { action: 'prepare', enabled: true },
      progress: { kind: 'prepare', title: '置き場の名前がすでに使われています', steps: [{ label: '作ったものの置き場', state: 'failed' }] },
    })
    expect(deriveStage({ ...base, execution: failed, turn }).progress?.kind).toBe('turn')
    expect(deriveStage({ ...base, execution: failed, generation: { ...generation, status: 'running' } }).progress?.kind).toBe('plan')
  })
  test('a failed plan retains a failed progress row until a new operation starts', () => {
    expect(deriveStage({ ...base, generation: { ...generation, status: 'failed', error: 'unexpected response' } })).toMatchObject({
      stage: 'decide', primary: { action: 'prepare-after-plan' },
      progress: { kind: 'plan', title: '計画を作れませんでした', steps: [{ state: 'failed' }] },
    })
  })
  test('a failed first plan remains in 聞く and does not expose preparation', () => {
    expect(deriveStage({ ...base, draft: unplanned, generation: { ...generation, status: 'failed' } })).toMatchObject({
      stage: 'ask', primary: { action: 'none', enabled: false }, progress: { kind: 'plan' },
    })
  })
  test('created enters implementation, gating publication on handoff completion', () => {
    const handoff = { summary: '画面を作る', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'created-source-repository', tasks: [{ title: '画面', description: '一覧', acceptanceCriteria: ['表示'] }] } as const
    const created = { ...draft, phase: 'created' as const, creationPlan: { ...draft.creationPlan!, implementationHandoff: { ...handoff, tasks: handoff.tasks.map((task) => ({ ...task, acceptanceCriteria: [...task.acceptanceCriteria] })) } } }
    expect(deriveStage({ ...base, draft: created, implementation: { phase: 'running', done: false, implemented: false } })).toMatchObject({ stage: 'build', build: { phase: 'implementing' }, primary: { action: 'publish', enabled: false } })
    expect(deriveStage({ ...base, draft: created }).primary.enabled).toBe(false)
    expect(deriveStage({ ...base, draft: created, implementation: { phase: 'running', done: false, implemented: true } }).primary.enabled).toBe(false)
    // Skipping every task finishes the checklist but leaves the template; the app is not ready to show.
    expect(deriveStage({ ...base, draft: created, implementation: { phase: 'done', done: true, implemented: false } }).primary.enabled).toBe(false)
    expect(deriveStage({ ...base, draft: created, implementation: { phase: 'done', done: true, implemented: true } })).toMatchObject({ build: { phase: 'done' }, primary: { enabled: true } })
    expect(deriveStage({ ...base, execution: { ...execution, status: 'succeeded' } })).toMatchObject({ stage: 'build', build: { phase: 'implementing' }, primary: { action: 'publish', enabled: false } })
    expect(deriveStage({ ...base, draft: { ...draft, phase: 'created' } }).primary.enabled).toBe(false)
    expect(deriveStage({ ...base, draft: created, implementation: { phase: 'publishing', done: true, implemented: true } })).toMatchObject({ primary: { enabled: false } })
  })
  test('published offers continuation, independent of earlier operations', () => {
    const published = { ...draft, publishedAt: startedAt }
    expect(deriveStage({ ...base, draft: published, published: draftPublished(published), execution })).toMatchObject({ stage: 'publish', primary: { action: 'continue', enabled: true } })
  })
})

test('only implementation runs started after publication invalidate the published version', () => {
  expect(draftPublished(draft)).toBe(false)
  expect(draftPublished({ ...draft, publishedAt: startedAt })).toBe(true)
  for (const status of ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
    const run = { id: 'impl-1', status, startedAt, devWorkspaceId: 'ws-1', taskIds: [], tasks: [] }
    for (const publishedAt of [startedAt, '2026-10-08T01:00:00Z']) {
      const current = { ...draft, publishedAt, implementationRuns: [run] }
      expect(draftPublished(current)).toBe(true)
      expect(deriveStage({ ...base, draft: current, published: draftPublished(current) }).primary.action).toBe('continue')
    }
    const current = { ...draft, phase: 'created' as const, publishedAt: '2026-10-07T23:59:59Z', implementationRuns: [run] }
    expect(draftPublished(current)).toBe(false)
    expect(deriveStage({ ...base, draft: current, published: draftPublished(current) }).stage).toBe('build')
  }
})

test('a locally changed intent updates the primary before a new generation exists', () => {
  expect(deriveStage({ ...base, lastPlannedIntent: '前の内容' }).primary.action).toBe('prepare-after-plan')
  expect(deriveStage({ ...base, lastPlannedIntent: draft.intent }).primary.action).toBe('prepare')
})

describe('plan freshness', () => {
  test('only material spec or intent changes require regeneration', () => {
    expect(needsPlanRefresh(draft, draft.intent)).toBe(false)
    expect(needsPlanRefresh(draft, '前の内容')).toBe(true)
    expect(needsPlanRefresh(undefined)).toBe(true)
    expect(needsPlanRefresh({ ...draft, creationPlan: undefined })).toBe(true)
    expect(needsPlanRefresh({ ...draft, creationPlanGenerations: [] })).toBe(true)
    expect(needsPlanRefresh({ ...draft, updatedAt: '2026-10-08T01:00:00Z' })).toBe(false)
    expect(needsPlanRefresh({ ...draft, phase: 'specifying' })).toBe(true)
    const finished = { ...turn, status: 'succeeded' as const, finishedAt: '2026-10-08T00:02:00Z', specMarkdown: 'new spec' }
    expect(needsPlanRefresh({ ...draft, conversationTurns: [finished] })).toBe(true)
    expect(needsPlanRefresh({ ...draft, conversationTurns: [{ ...finished, status: 'failed' }] })).toBe(false)
    expect(needsPlanRefresh({ ...draft, conversationTurns: [{ ...finished, finishedAt: '2026-10-07T23:00:00Z' }] })).toBe(false)
  })
  test('name and audience clarification turns stay in the exchange after cleanup, but spec requests invalidate the plan', () => {
    const exchange = [buildCopy.questions.prepareTurn, 'ほかの名前にしたい', '提案して', '営業見積にしたい', 'まだ決めていない', '全社'].map((userMessage, index) => ({
      ...turn, id: `prepare-${index}`, status: 'succeeded' as const, userMessage,
      startedAt: `2026-10-08T00:0${index + 2}:00Z`, specMarkdown: `spec ${index}`,
    }))
    expect(needsPlanRefresh({ ...draft, conversationTurns: exchange })).toBe(false)
    expect(needsPlanRefresh({ ...draft, conversationTurns: exchange.slice(0, -1) })).toBe(false)
    const request = { ...turn, id: 'spec-request', status: 'succeeded' as const, startedAt: '2026-10-08T00:08:00Z', userMessage: '一覧に検索をつけてください。', specMarkdown: 'new spec' }
    expect(needsPlanRefresh({ ...draft, conversationTurns: [...exchange, request] })).toBe(true)
  })
  test('turns while preparing (and the 用意する exchange after cleanup) keep the plan in use', () => {
    const at = (time: string) => `2026-10-08T00:${time}Z`
    const reply = (id: string, userMessage: string, time: string) => ({ ...turn, id, userMessage, status: 'succeeded' as const, startedAt: at(time), finishedAt: at(time.replace(/0$/, '5')), specMarkdown: `spec ${id}` })
    const exchange = [reply('t-prepare', buildCopy.questions.prepareTurn, '03:10'), reply('t-name', '見積作成', '03:30'), reply('t-share', '自分の課', '04:00')]
    const failed = { ...execution, status: 'failed' as const, startedAt: at('03:00'), finishedAt: at('05:00') }
    const preparing = { ...draft, creationExecutions: [failed], conversationTurns: exchange }
    expect(needsPlanRefresh(preparing, draft.intent)).toBe(false)
    expect(deriveStage({ ...base, draft: preparing, lastPlannedIntent: draft.intent }).primary.action).toBe('prepare')
    expect(needsPlanRefresh({ ...preparing, conversationTurns: [...exchange, reply('t-free', '画面を増やして', '04:30')] }, draft.intent)).toBe(false)
    // cleanupCreation removes the execution; the exchange still does not count, a new request does.
    const cleaned = { ...preparing, creationExecutions: [] }
    expect(needsPlanRefresh(cleaned, draft.intent)).toBe(false)
    expect(needsPlanRefresh({ ...cleaned, conversationTurns: [...exchange, reply('t-free', '画面を増やして', '06:00')] }, draft.intent)).toBe(true)
    expect(needsPlanRefresh({ ...cleaned, conversationTurns: [reply('t-before', 'PDF も', '02:00'), ...exchange] }, draft.intent)).toBe(true)
  })
})

describe('long-operation progress', () => {
  test('ports all generation phases with product vocabulary and elapsed time', () => {
    for (const [stage, title] of [['workspace', 'AI の準備をしています'], ['prepare', '資料を準備しています'], ['plan', '計画を考えています'], ['read', '計画を読み込んでいます']]) {
      expect(progressCard({ kind: 'plan', operation: { ...generation, status: 'running', stage }, now })).toMatchObject({ title, interrupted: false, elapsedLabel: '1:07' })
    }
    expect(progressCard({ kind: 'publish', now }).title).toBe('公開の準備をしています')
    expect(progressCard({ kind: 'implement', phase: 'starting-workspace', now }).kind).toBe('workspace')
    expect(progressCard({ kind: 'implement', phase: 'pushing', now }).title).toBe('新しい版を保存しています')
  })
  test('a running operation shows its last activity lines; a finished one shows none', () => {
    const activityTail = ['', 'a', 'b ', '', 'c', 'd', 'e', 'f', 'g', ''].join('\n')
    expect(progressCard({ kind: 'plan', operation: { ...generation, status: 'running', activityTail }, now }).activity).toEqual(['b', 'c', 'd', 'e', 'f', 'g'])
    expect(progressCard({ kind: 'plan', operation: { ...generation, status: 'succeeded', activityTail }, now }).activity).toBeUndefined()
    expect(progressCard({ kind: 'implement', phase: 'running', activityTail: 'x\ny', now }).activity).toEqual(['x', 'y'])
  })
  test('only expired running leases are interrupted, and the clock never stops polling recovery', () => {
    const runLeaseExpiresAt = new Date(now - 1000).toISOString()
    for (const kind of ['turn', 'plan', 'prepare'] as const) {
      expect(progressCard({ kind, operation: { ...generation, status: 'running', runLeaseExpiresAt }, now })).toMatchObject({ interrupted: true, elapsedLabel: '1:07', title: '基盤の更新で中断しました。自動で再開します。' })
      for (const status of ['pending', 'failed', 'succeeded']) expect(progressCard({ kind, operation: { ...generation, status, runLeaseExpiresAt }, now }).interrupted).toBe(false)
      expect(progressCard({ kind, operation: { ...generation, status: 'running', runLeaseExpiresAt: new Date(now + 1).toISOString() }, now }).interrupted).toBe(false)
    }
    expect(progressCard({ kind: 'turn', operation: { ...turn, startedAt: 'invalid' }, now }).elapsedLabel).toBeUndefined()
    expect(formatElapsed(-100)).toBe('0:00')
    expect(formatElapsed(67_999)).toBe('1:07')
  })
  test('maps execution tools and states without leaking raw errors into normal details', () => {
    const steps = executionSteps({ ...execution, steps: [
      { id: '1', tool: 'appthrust.applicationSourceRepository.validate', status: 'done' },
      { id: '2', tool: 'appthrust.applicationSourceRepository.create', status: 'running' },
      { id: '3', tool: 'appthrust.applicationStack.create', status: 'pending' },
      { id: '4', tool: 'appthrust.applicationStack.validate', status: 'skipped' },
      { id: '5', tool: 'appthrust.applicationStack.create', status: 'failed', message: 'PodUnschedulable secret-ws-id' },
      { id: '6', tool: 'appthrust.applicationStack.observe', status: 'pending' },
      { id: '7', tool: 'appthrust.databaseChange.createFromDevWorkspace', status: 'pending' },
    ] })
    expect(steps.map((step) => step.state)).toEqual(['done', 'doing', 'todo', 'done', 'failed', 'todo', 'todo'])
    expect(steps[1]?.label).toBe('作ったものの置き場')
    expect(steps[2]?.label).toBe('最初の版')
    expect(steps[5]?.label).toBe('アプリの準備を確認する')
    expect(steps[6]?.label).toBe('記録する内容を整える')
    expect(steps[4]?.detail).toContain('空きが足りません')
    expect(JSON.stringify(steps)).not.toContain('secret-ws-id')
  })
})
