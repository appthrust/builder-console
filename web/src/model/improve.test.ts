import { describe, expect, test } from 'bun:test'
import type { ApplicationDraft, ApplicationDraftConversationTurn, ApplicationDraftImplementationRun } from '@appthrust/api-schema/platform-api'
import { implementationTodoId } from '../features/build/implement/state'
import { draftOf, readEachFirst, readFirst } from '../api/testing/build-domain'
import * as model from './improve'

/** The tests vary turns, runs and the plan; the rest of the draft is a fixed valid improvement draft. */
const full = (draft: object) => ({ id: 'draft-1', projectId: 'project-1', title: '直す', intent: '直す', phase: 'created', kind: 'improvement', specMarkdown: '', ownerUserId: 'u', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z', ...draft })
const of = (draft: unknown) => draftOf(full(draft as object))
const deriveImprove = readFirst(of, model.deriveImprove)
const improveTimeline = readFirst(of, model.improveTimeline)
const improveVersions = readFirst(of, model.improveVersions)
const improvementFor = readEachFirst(of, model.improvementFor)
const pendingProposal = readFirst(of, model.pendingProposal)

const at = (minute: number) => `2026-10-26T00:${String(minute).padStart(2, '0')}:00Z`
const turn = (id: string, minute: number, status: ApplicationDraftConversationTurn['status'] = 'succeeded'): ApplicationDraftConversationTurn => ({
  kind: 'conversation',
  id, status, startedAt: at(minute), ...(status === 'succeeded' ? { finishedAt: at(minute + 1), assistantMessage: '## 要約\nわかりました。' } : {}), devWorkspaceId: 'ws', userMessage: '一覧に絞り込みを足したい',
})
const tasks = [
  { title: '一覧に絞り込みを足す', description: '状態で絞り込めるようにする。担当者でも絞る。', acceptanceCriteria: ['状態で絞り込める'] },
  { title: 'workspace の設定を直す', description: 'branch を整える', acceptanceCriteria: ['x'] },
]
const plan: ApplicationDraft['creationPlan'] = {
  summary: '絞り込みを足します', markdown: '# 絞り込み', representation: ['ApplicationStack'],
  implementationHandoff: { summary: '絞り込み', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'existing-source-repository', tasks },
}
const ids = tasks.map((task, index) => implementationTodoId(task.title, index))
const run = (id: string, minute: number, status: ApplicationDraftImplementationRun['status'], done = status === 'succeeded'): ApplicationDraftImplementationRun => ({
  id, status, startedAt: at(minute), ...(status === 'pending' || status === 'running' ? {} : { finishedAt: at(minute + 5) }), devWorkspaceId: 'ws', taskIds: ids,
  tasks: ids.map((taskId, index) => ({ id: taskId, title: tasks[index]!.title, status: done ? 'done' : status === 'running' && index === 0 ? 'running' : 'pending', ...(done ? { versionLabel: `v${4 + index}` } : {}) })),
})
const draft: ApplicationDraft = {
  id: 'draft-1', projectId: 'project-1', kind: 'improvement', title: '見積作成', intent: '一覧に絞り込みを足したい', phase: 'created',
  specMarkdown: '一覧に絞り込みを足したい', architectureMarkdown: '', creationPlanGenerations: [], creationExecutions: [],
  createdApplicationId: 'mitsumori', createdApplicationStackId: 'mitsumori', ownerUserId: 'user-1', createdAt: at(0), updatedAt: at(0),
}

describe('improvement stages (聞く → 直す → 確認)', () => {
  test('asks while there is no proposal, including while the first turn runs and after a clarifying question', () => {
    expect(deriveImprove(draft)).toMatchObject({ phase: 'asking', stage: 'ask', proposal: [], busy: false })
    expect(deriveImprove({ ...draft, conversationTurns: [turn('t1', 1, 'running')] })).toMatchObject({ stage: 'ask', turnActive: true, busy: true })
    expect(deriveImprove({ ...draft, conversationTurns: [turn('t1', 1)] })).toMatchObject({ stage: 'ask', busy: false })
  })

  test('a proposal with tasks moves to 直す and attaches to the latest answer', () => {
    const proposed = { ...draft, creationPlan: plan, conversationTurns: [turn('t1', 1), turn('t2', 3)] }
    expect(deriveImprove(proposed)).toMatchObject({ phase: 'proposed', stage: 'fix', proposalTurnId: 't2' })
    expect(deriveImprove(proposed).proposal.map((task) => task.id)).toEqual(ids)
    // A follow-up question in flight returns to 聞く until it answers.
    expect(deriveImprove({ ...proposed, conversationTurns: [...proposed.conversationTurns, turn('t3', 5, 'pending')] })).toMatchObject({ phase: 'asking', stage: 'ask', busy: true })
  })

  test('fixes while the latest run is pending or running and blocks sending', () => {
    for (const status of ['pending', 'running'] as const) {
      expect(deriveImprove({ ...draft, creationPlan: plan, conversationTurns: [turn('t1', 1)], implementationRuns: [run('r1', 4, status)] })).toMatchObject({ phase: 'running', stage: 'fix', busy: true })
    }
  })

  test('checks after a finished run, with the last pushed version', () => {
    const done = { ...draft, creationPlan: plan, conversationTurns: [turn('t1', 1)], implementationRuns: [run('r1', 4, 'succeeded')] }
    expect(deriveImprove(done)).toMatchObject({ phase: 'done', stage: 'check', version: 'v5', proposal: [] })
    expect(improveVersions(done)).toEqual([{ runId: 'r1', version: 'v5', tasks: tasks.map((task) => task.title), at: at(9) }])
  })

  test('talking after a finished run asks again; identical re-proposed tasks count as done, new ones are proposed', () => {
    const done = { ...draft, creationPlan: plan, conversationTurns: [turn('t1', 1)], implementationRuns: [run('r1', 4, 'succeeded')] }
    expect(deriveImprove({ ...done, conversationTurns: [turn('t1', 1), turn('t2', 20)] })).toMatchObject({ phase: 'asking', stage: 'ask', version: 'v5' })
    const next = { ...plan!, implementationHandoff: { ...plan!.implementationHandoff!, tasks: [...tasks, { title: 'CSV で書き出す', description: '一覧を CSV にする', acceptanceCriteria: ['CSV が出る'] }] } }
    const reproposed = deriveImprove({ ...done, creationPlan: next, conversationTurns: [turn('t1', 1), turn('t2', 20)] })
    expect(reproposed).toMatchObject({ phase: 'proposed', stage: 'fix', proposalTurnId: 't2' })
    expect(reproposed.proposal.map((task) => task.title)).toEqual(['CSV で書き出す'])
  })

  test('a stopped run stays in 直す until the user speaks again', () => {
    const failed = { ...draft, creationPlan: plan, conversationTurns: [turn('t1', 1)], implementationRuns: [run('r1', 4, 'failed')] }
    expect(deriveImprove(failed)).toMatchObject({ phase: 'failed', stage: 'fix', busy: false })
    expect(deriveImprove({ ...failed, implementationRuns: [run('r1', 4, 'cancelled')] }).phase).toBe('failed')
    expect(deriveImprove({ ...failed, conversationTurns: [turn('t1', 1), turn('t2', 30)] }).phase).toBe('proposed')
  })
})

test('proposal details keep only business language', () => {
  expect(pendingProposal({ creationPlan: plan })).toEqual([
    { id: ids[0]!, title: tasks[0]!.title, detail: '状態で絞り込めるようにする。' },
    { id: ids[1]!, title: tasks[1]!.title },
  ])
})

test('the app page resumes the newest open improvement session of that app only', () => {
  const older = { ...draft, id: 'old', createdAt: at(1) }
  const newer = { ...draft, id: 'new', createdAt: at(2) }
  const archived = { ...draft, id: 'archived', phase: 'archived' as const, createdAt: at(3) }
  const creation = { ...draft, id: 'creation', kind: undefined, createdAt: at(4) }
  const other = { ...draft, id: 'other', createdApplicationStackId: 'kintai', createdAt: at(5) }
  expect(improvementFor([older, newer, archived, creation, other], 'mitsumori')?.id).toBe('new')
  expect(improvementFor([archived, creation], 'mitsumori')).toBeUndefined()
})

test('the timeline interleaves turns and runs by start time', () => {
  const items = improveTimeline({ conversationTurns: [turn('t2', 10), turn('t1', 1)], implementationRuns: [run('r1', 4, 'succeeded')] })
  expect(items.map((item) => item.kind === 'turn' ? item.turn.id : item.run.id)).toEqual(['t1', 'r1', 't2'])
})
