import { expect, test } from 'bun:test'
import type { ApplicationDraftImplementationHandoff, ApplicationDraftImplementationRun } from '@appthrust/api-schema/platform-api'
import { classifyBuildFailure } from '../../../model/build/failure'
import { runOf } from '../../../api/testing/build-domain'
import { knownValue } from '../../../model/contracts/build'
import * as model from './state'

const { implementationTodoId, implemented } = model
const projectImplementation = (draft: Parameters<typeof model.projectImplementation>[0], run?: unknown, plan?: Parameters<typeof model.projectImplementation>[2]) => model.projectImplementation(draft, run === undefined ? undefined : runOf(run), plan)
const statuses = (state: model.ImplementationState) => state.tasks.map((task) => knownValue(task.status) ?? 'unknown')

const handoff: ApplicationDraftImplementationHandoff = {
  summary: '見積を作る', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId',
  sourceRepositoryStrategy: 'created-source-repository',
  tasks: [{ title: 'Customer List', description: '一覧を作る', acceptanceCriteria: ['顧客が見える'] }, { title: '見積の編集', description: '編集する', acceptanceCriteria: ['保存できる'] }],
}
const startedAt = '2026-10-10T00:00:00Z'
const taskStartedAt = '2026-10-10T00:01:00Z'
const draft = { id: 'draft-ae97efbc', updatedAt: '2026-10-17T09:09:00Z' }
const run: ApplicationDraftImplementationRun = {
  id: 'impl-1', status: 'running', devWorkspaceId: 'ws-1', startedAt, runLeaseExpiresAt: startedAt,
  currentTaskId: 'two', step: 'working', activityTail: '画面を作っています\n', taskIds: ['one', 'two'],
  tasks: [{ id: 'one', title: '顧客', status: 'done', versionLabel: 'v2' }, { id: 'two', title: '見積', status: 'running', startedAt: taskStartedAt }],
}

test('pending handoff task IDs match the server ASCII and non-ASCII rules', () => {
  expect(statuses(projectImplementation(draft, undefined, handoff))).toEqual(['pending', 'pending'])
  expect(implementationTodoId('Customer List', 0)).toBe('todo-1-customer-list')
  expect(implementationTodoId('あ', 0)).toBe('todo-1-task-3042')
  expect(implementationTodoId('X'.repeat(50), 1)).toBe(`todo-2-${'x'.repeat(40)}`)
})

test('reload projects the same active task and workspace without rerunning or inventing resume evidence', () => {
  const state = projectImplementation(draft, run, handoff)
  expect(state).toMatchObject({ phase: 'running', currentTaskId: 'two', workspaceId: 'ws-1', startedAt: taskStartedAt, step: { kind: 'known', value: 'working' }, activityTail: run.activityTail })
  expect(state.tasks).toEqual(runOf(run).tasks)
  expect(projectImplementation(draft, structuredClone(run))).toEqual(state)
  expect(state).not.toHaveProperty('resumed')
  expect(state).not.toHaveProperty('outputCount')
  expect(state).not.toHaveProperty('waiting')
  expect(projectImplementation(draft, { ...run, step: 'pushing' }).phase).toBe('pushing')
  expect(projectImplementation(draft, { ...run, status: 'pending', currentTaskId: undefined, devWorkspaceId: '' }).phase).toBe('starting-workspace')
  // A run status this console does not know is neither running, done nor stopped: nothing retries or restarts it.
  expect(projectImplementation(draft, { ...run, status: 'paused-for-review' })).toMatchObject({ phase: 'unsupported' })
  expect(projectImplementation(draft, { ...run, status: 'paused-for-review' }).failure).toBeUndefined()
})

test('run and task errors use the implement failure classifier, preserving completed tasks', () => {
  for (const error of ['task timeout', 'runtime unavailable', 'could not push']) {
    const failed = { ...run, status: 'failed' as const, error }
    expect(projectImplementation(draft, failed).failure).toEqual(classifyBuildFailure(error, undefined, 'implement'))
    const tasks = [run.tasks[0]!, { ...run.tasks[1]!, status: 'failed' as const, error }]
    expect(projectImplementation(draft, { ...failed, error: undefined, tasks }).failure).toEqual(classifyBuildFailure(error, undefined, 'implement'))
    expect(projectImplementation(draft, failed).tasks[0]).toEqual(runOf(run).tasks[0])
  }
  expect(statuses(projectImplementation(draft, { ...run, status: 'cancelled' }))).toEqual(['done', 'failed'])
  expect(projectImplementation(draft, { ...run, status: 'cancelled' }).phase).toBe('failed')
})

test('success is complete only after all handoff tasks settle; all-skipped never counts as implemented', () => {
  const tasks = run.tasks.map((task) => ({ ...task, status: 'skipped' as const }))
  const state = projectImplementation(draft, { ...run, status: 'succeeded', tasks })
  expect(state.phase).toBe('done')
  expect(implemented(state)).toBe(false)
  expect(implemented(projectImplementation(draft, run))).toBe(true)
  expect(projectImplementation(draft, { ...run, status: 'succeeded', tasks: [run.tasks[0]!, { ...run.tasks[1]!, status: 'pending' }] }).phase).toBe('idle')
})

test('platform failures retain the draft, failed run and failure time across reloads', () => {
  const failed = { ...run, status: 'failed' as const, error: 'gitops: deployment preflight failed', finishedAt: '2026-10-17T09:08:00Z' }
  const state = projectImplementation(draft, failed)
  expect(state.failure).toMatchObject({ kind: 'platform', reference: { draftId: draft.id, executionId: run.id, at: failed.finishedAt } })
  expect(projectImplementation(draft, structuredClone(failed))).toEqual(state)
  expect(projectImplementation(draft, { ...failed, finishedAt: undefined }).failure?.reference?.at).toBe(draft.updatedAt)
  const tasks = run.tasks.map((task) => task.id === run.currentTaskId ? { ...task, finishedAt: failed.finishedAt } : task)
  expect(projectImplementation(draft, { ...failed, finishedAt: undefined, tasks }).failure?.reference?.at).toBe(failed.finishedAt)
})

test('structured run reasons win and task-only reasons survive projection', () => {
  const tasks: ApplicationDraftImplementationRun['tasks'] = [run.tasks[0]!, { ...run.tasks[1]!, status: 'failed', failureReason: 'TaskFailed' }]
  expect(projectImplementation(draft, { ...run, status: 'failed', error: 'network failed', failureReason: 'RuntimeRestarted', tasks }).failure?.kind).toBe('interrupted')
  expect(projectImplementation(draft, { ...run, status: 'failed', error: 'network failed', tasks }).failure?.kind).toBe('failed')
})
