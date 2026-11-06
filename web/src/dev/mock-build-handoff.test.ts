import { beforeEach, expect, test } from 'bun:test'
import { ApplicationDraft, ApplicationDraftImplementationRun } from '@appthrust/api-schema/platform-api'
import { textJa as buildCopy } from '../model/build/copy'
import { parseSpec } from '../model/build/spec'
import { toDraftWorkbook } from '../features/excel2app/model'
import { SAMPLE_SETS } from '../features/excel2app/samples'
import { platformRoutes } from './mock-platform'

const project = '/api/v1/projects/commerce'
const conflict = { status: 409, body: { error: { message: 'application draft creation is running; wait for it to finish before updating the draft' } } }

async function call(method: string, path: string, body?: unknown) {
  const url = new URL(path, 'http://mock.test')
  const response = await platformRoutes(new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), url)
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  return { status: response.status, body: await response.json() }
}

async function createDraft() {
  const created = await call('POST', `${project}/application-drafts`, { title: '対応台帳', intent: 'Excel から対応台帳を作る' })
  expect(created.status).toBe(201)
  return `${project}/application-drafts/${created.body.resource.id}`
}

async function advance(count = 1) {
  for (let step = 0; step < count; step++) await call('POST', '/api/v1/__mock/advance')
}

beforeEach(async () => { await call('POST', '/api/v1/__mock/reset') })

test('the workbook set hands off one integrated model, structured decisions and a seed task', async () => {
  const path = await createDraft()
  const workbooks = SAMPLE_SETS.find((sample) => sample.id === 'orders')!.workbooks.map(toDraftWorkbook)
  const ids: string[] = []
  for (const workbook of workbooks) {
    const response = await call('POST', `${path}/workbooks`, workbook)
    expect(response.status).toBe(201)
    ids.push(response.body.workbook.id)
  }
  expect((await call('POST', `${path}/conversation-turns`, { kind: 'excel-analysis', message: '' })).status).toBe(202)
  await advance()
  expect(parseSpec((await call('GET', path)).body.specMarkdown).spec.importFrom).toBe('excel')
  expect((await call('POST', `${path}/conversation-turns`, { kind: 'ui-design', message: '__init__' })).status).toBe(202)
  await advance()
  expect((await call('POST', `${path}/creation-plan-generations`)).status).toBe(202)
  await advance(4)
  const draft = (await call('GET', path)).body
  expect(parseSpec(draft.specMarkdown).spec.importFrom).toBe('excel')
  expect(draft.creationPlan.summary).toBe(draft.excelAnalysis.summary)
  expect(draft.excelAnalysis.entities.map((entity: { importRows: number }) => entity.importRows)).toEqual([6, 3])
  expect(draft.excelAnalysis.entities[0].sources.map((source: { workbookId: string }) => source.workbookId)).toEqual(ids.slice(0, 2))
  expect(draft.uiDesign.screens.every((screen: { entity: string }) => draft.excelAnalysis.entities.some((entity: { name: string }) => entity.name === screen.entity))).toBe(true)
  expect(draft.creationPlan.implementationHandoff.tasks).toEqual([
    { title: buildCopy.mockExcelHandoff.screenTitle, description: buildCopy.mockExcelHandoff.screenDescription, acceptanceCriteria: [buildCopy.mockExcelHandoff.screenCriterion] },
    { title: buildCopy.mockExcelHandoff.seedTitle, description: buildCopy.mockExcelHandoff.seedDescription, acceptanceCriteria: [buildCopy.mockExcelHandoff.seedCriterion] },
  ])
  expect(JSON.stringify(draft.creationPlan.implementationHandoff)).not.toMatch(/analysis\.json|ui-design\.json|workbooks\/|seed|migration/)
  for (const [index, id] of ids.entries()) expect((await call('GET', `${path}/workbooks/${id}`)).body).toEqual(workbooks[index])
})

test('publish metadata PATCH remains blocked by preparation, but is allowed during implementation', async () => {
  const path = await createDraft()
  expect((await call('POST', `${path}/conversation-turns`, { message: '状態を記録します' })).status).toBe(202)
  for (const body of [{ title: '公開名' }, { publishPreferences: { name: '公開名', shareScope: 'group' } }]) expect(await call('PATCH', path, body)).toMatchObject(conflict)
  await advance()
  expect((await call('POST', `${path}/creation-plan-generations`)).status).toBe(202)
  expect(await call('PATCH', path, { title: '公開名' })).toMatchObject(conflict)
  await advance()
  expect(await call('PATCH', path, { title: '公開名' })).toMatchObject(conflict)
  await advance(3)
  const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
  const begun = (await call('POST', `${path}/creation-executions`, { clientRequestId: 'handoff-create', creationPlanFingerprint: validation.creationPlanFingerprint })).body.resource
  await call('POST', `${path}/creation-executions/${begun.creationExecutions[0].id}/run`)
  expect(await call('PATCH', path, { title: '公開名' })).toMatchObject(conflict)
  await advance(6)
  const run = await call('POST', `${path}/implementation-runs`)
  expect(run.status).toBe(202)
  for (const status of ['pending', 'running']) {
    const before = (await call('GET', path)).body
    expect(before.implementationRuns.at(-1).status).toBe(status)
    const renamed = await call('PATCH', path, { title: `公開名 ${status}` })
    expect(renamed.status).toBe(200)
    expect(renamed.body.resource.title).toBe(`公開名 ${status}`)
    expect(renamed.body.resource.specMarkdown).toBe(before.specMarkdown)
    expect(renamed.body.resource.implementationRuns).toEqual(before.implementationRuns)
    for (const body of [
      { publishPreferences: { name: '公開名', shareScope: 'company' } },
      { title: `公開名 ${status}`, publishPreferences: { shareScope: 'group' } },
      { publishPreferences: {} },
    ]) {
      const updated = await call('PATCH', path, body)
      expect(updated.status).toBe(200)
      expect(updated.body.resource.publishPreferences).toEqual(body.publishPreferences)
      expect((await call('GET', path)).body.publishPreferences).toEqual(body.publishPreferences)
      expect(updated.body.resource.implementationRuns).toEqual(before.implementationRuns)
    }
    for (const body of [
      { title: '拒否する名前', specMarkdown: '変更' },
      { title: '拒否する名前', specMarkdown: null },
      { title: '拒否する名前', intent: '変更' },
      { title: '拒否する名前', creationPlan: null },
      { title: '拒否する名前', phase: 'planning' },
      { title: '拒否する名前', activeWorkspaceId: 'other' },
      { title: '拒否する名前', extra: true },
      { publishPreferences: { shareScope: 'private' }, specMarkdown: '変更' },
      { publishPreferences: { shareScope: 'private' }, specMarkdown: null },
      { publishPreferences: { shareScope: 'private' }, extra: true },
      { publishPreferences: null },
      { title: null },
      {},
    ]) expect(await call('PATCH', path, body)).toMatchObject(conflict)
    expect((await call('GET', path)).body.title).toBe(`公開名 ${status}`)
    if (status === 'pending') await advance()
  }
})

async function createReadyDraft() {
  const path = await createDraft()
  expect((await call('POST', `${path}/creation-plan-generations`)).status).toBe(202)
  await advance(4)
  const planned = ApplicationDraft.parse((await call('GET', path)).body)
  planned.creationPlan!.implementationHandoff!.tasks = [
    { title: '一覧を用意する', description: '一覧を表示します', acceptanceCriteria: ['記録を表示できる', '検索できる'] },
    { title: '入力欄を用意する', description: '記録を入力します', acceptanceCriteria: ['新しい記録を保存できる'] },
    { title: '集計を用意する', description: '件数を表示します', acceptanceCriteria: ['件数が一致する'] },
  ]
  expect((await call('PATCH', path, { creationPlan: planned.creationPlan })).status).toBe(200)
  const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
  const begun = (await call('POST', `${path}/creation-executions`, { clientRequestId: 'ready-create', creationPlanFingerprint: validation.creationPlanFingerprint })).body.resource
  await call('POST', `${path}/creation-executions/${begun.creationExecutions[0].id}/run`)
  await advance(6)
  return { path, definitions: planned.creationPlan!.implementationHandoff!.tasks }
}

test('task verification uses the exact plan criteria and the unmet toggle is consumed once', async () => {
  const { path, definitions } = await createReadyDraft()
  await call('POST', '/api/v1/__mock/implementation-run', { unmetCriterion: true })
  expect((await call('POST', `${path}/implementation-runs`)).status).toBe(202)
  await advance(12)
  const draft = ApplicationDraft.parse((await call('GET', path)).body)
  const run = draft.implementationRuns!.at(-1)!
  expect(run.status).toBe('succeeded')
  for (const [index, task] of run.tasks.entries()) {
    expect(task.status).toBe('done')
    expect(task.verification?.reportedAt).toBe(task.finishedAt)
    expect(task.verification?.repairAttempts).toBe(index === 0 ? 1 : 0)
    expect(task.verification?.criteria).toEqual(definitions[index]!.acceptanceCriteria.map((criterion, criterionIndex) => ({
      criterion, met: index !== 0 || criterionIndex !== 0,
      ...(index === 0 && criterionIndex === 0 ? { note: buildCopy.mockExcelHandoff.unmetCriterionNote } : {}),
    })))
  }
  const retry = ApplicationDraftImplementationRun.parse((await call('POST', `${path}/implementation-runs`, { taskIds: [run.tasks[0]!.id] })).body.run)
  expect(retry.tasks[0]!.verification).toBeUndefined()
  await advance(4)
  const completed = ApplicationDraftImplementationRun.parse((await call('GET', `${path}/implementation-runs/${retry.id}`)).body)
  expect(completed.tasks[0]!.verification?.repairAttempts).toBe(0)
  expect(completed.tasks[0]!.verification?.criteria.every((criterion) => criterion.met)).toBeTrue()
})

test('a one-shot interruption fails the second selected task and retry resumes without redoing completed tasks', async () => {
  const { path } = await createReadyDraft()
  await call('POST', '/api/v1/__mock/implementation-run', { interruptSecondTask: true })
  const created = ApplicationDraftImplementationRun.parse((await call('POST', `${path}/implementation-runs`)).body.run)
  await advance(7)
  const failed = ApplicationDraftImplementationRun.parse((await call('GET', `${path}/implementation-runs/${created.id}`)).body)
  expect(failed).toMatchObject({ status: 'failed', currentTaskId: created.taskIds[1], failureReason: 'StreamInterrupted' })
  expect(failed.tasks.map((task) => task.status)).toEqual(['done', 'failed', 'pending'])
  expect(failed.tasks[1]!.failureReason).toBe('StreamInterrupted')
  const retry = ApplicationDraftImplementationRun.parse((await call('POST', `${path}/implementation-runs`)).body.run)
  expect(retry.taskIds).toEqual(created.taskIds.slice(1))
  expect(retry.devWorkspaceId).toBe(failed.devWorkspaceId)
  expect(retry.tasks[0]).toEqual(failed.tasks[0])
  expect(retry.tasks[1]!.failureReason).toBeUndefined()
  expect(retry.failureReason).toBeUndefined()
  await advance(8)
  const completed = ApplicationDraftImplementationRun.parse((await call('GET', `${path}/implementation-runs/${retry.id}`)).body)
  expect(completed.status).toBe('succeeded')
  expect(completed.tasks[0]).toEqual(failed.tasks[0])
  expect(completed.tasks.every((task) => task.status === 'done' && task.verification?.criteria.every((criterion) => criterion.met))).toBeTrue()
})

test('quota stops the current implementation task and manual retry retains completed work', async () => {
  const { path } = await createReadyDraft()
  const created = ApplicationDraftImplementationRun.parse((await call('POST', `${path}/implementation-runs`)).body.run)
  await advance(4)
  const firstDone = ApplicationDraftImplementationRun.parse((await call('GET', `${path}/implementation-runs/${created.id}`)).body)
  expect(firstDone.tasks.map((task) => task.status)).toEqual(['done', 'pending', 'pending'])
  await call('POST', '/api/v1/__mock/ai-quota', { exhausted: true })
  await advance(3)
  const failed = ApplicationDraftImplementationRun.parse((await call('GET', `${path}/implementation-runs/${created.id}`)).body)
  expect(failed).toMatchObject({
    status: 'failed', currentTaskId: created.taskIds[1], failureReason: 'TaskFailed',
    error: 'Codex task failed: Codex error: stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at <REDACTED>',
  })
  expect(failed.tasks.map((task) => task.status)).toEqual(['done', 'failed', 'pending'])
  expect(failed.tasks[0]).toEqual(firstDone.tasks[0])
  expect(failed.tasks[1]?.error).toBe(failed.error)
  await call('POST', '/api/v1/__mock/ai-quota', { exhausted: false })
  await advance(4)
  expect(ApplicationDraftImplementationRun.parse((await call('GET', `${path}/implementation-runs/${created.id}`)).body)).toEqual(failed)
  const retry = ApplicationDraftImplementationRun.parse((await call('POST', `${path}/implementation-runs`)).body.run)
  expect(retry.taskIds).toEqual(created.taskIds.slice(1))
  expect(retry.tasks[0]).toEqual(firstDone.tasks[0])
  expect(retry.devWorkspaceId).toBe(failed.devWorkspaceId)
  await advance(8)
  const completed = ApplicationDraftImplementationRun.parse((await call('GET', `${path}/implementation-runs/${retry.id}`)).body)
  expect(completed.status).toBe('succeeded')
  expect(completed.tasks[0]).toEqual(firstDone.tasks[0])
  expect(completed.tasks.every((task) => task.status === 'done')).toBe(true)
})

test('plan generation records quota failure until the allowance is restored and generation is retried', async () => {
  const path = await createDraft()
  await call('POST', '/api/v1/__mock/ai-quota', { exhausted: true })
  expect((await call('POST', `${path}/creation-plan-generations`)).status).toBe(202)
  await advance(4)
  const failed = ApplicationDraft.parse((await call('GET', path)).body)
  expect(failed.creationPlan).toBeUndefined()
  expect(failed.creationPlanGenerations?.at(-1)).toMatchObject({
    status: 'failed',
    error: 'Codex task failed: Codex error: stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at <REDACTED>',
  })
  await call('POST', '/api/v1/__mock/ai-quota', { exhausted: false })
  await advance(4)
  expect((await call('GET', path)).body.creationPlanGenerations).toEqual(failed.creationPlanGenerations)
  expect((await call('POST', `${path}/creation-plan-generations`)).status).toBe(202)
  await advance(4)
  const resumed = ApplicationDraft.parse((await call('GET', path)).body)
  expect(resumed.creationPlanGenerations?.map((generation) => generation.status)).toEqual(['failed', 'succeeded'])
  expect(resumed.creationPlan).toBeDefined()
  expect(resumed.devWorkspaceId).toBe(failed.devWorkspaceId)
})

test('reset clears one-shot implementation toggles and preference validation rejects invalid input', async () => {
  await call('POST', '/api/v1/__mock/implementation-run', { unmetCriterion: true, interruptSecondTask: true })
  await call('POST', '/api/v1/__mock/ai-quota', { exhausted: true })
  await call('POST', '/api/v1/__mock/reset')
  expect(await call('POST', '/api/v1/__mock/ai-quota', {})).toEqual({ status: 200, body: { exhausted: false } })
  const { path } = await createReadyDraft()
  for (const publishPreferences of [{ name: '' }, { name: 'x'.repeat(201) }, { shareScope: 'department' }]) {
    expect((await call('PATCH', path, { publishPreferences })).status).toBe(400)
  }
  await call('POST', `${path}/implementation-runs`)
  await advance(12)
  const draft = ApplicationDraft.parse((await call('GET', path)).body)
  expect(draft.publishPreferences).toBeUndefined()
  const run = draft.implementationRuns!.at(-1)!
  expect(run.status).toBe('succeeded')
  expect(run.tasks.every((task) => task.verification?.repairAttempts === 0 && task.verification.criteria.every((criterion) => criterion.met))).toBeTrue()
})
