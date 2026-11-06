import { expect, test } from 'bun:test'
import { platformRoutes } from './mock-platform'
import { parseAssistantMessage } from '../model/build/messages'
import { parseSpec } from '../model/build/spec'
import { textJa } from '../model/build/copy'

const FIRST_TURN = textJa.questions.firstTurn
const KICKOFF_REPLY = textJa.questions.kickoffReply

const project = '/api/v1/projects/commerce'
async function request(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const url = new URL(path, 'http://mock.test')
  const response = await platformRoutes(new Request(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), url)
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  return response
}
async function call(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const response = await request(method, path, body, headers)
  return { status: response.status, body: await response.json() }
}

test('conversation turns settle on advance, preserve the spec, and replay the same idempotent turn', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const draft = (await call('POST', `${project}/application-drafts`, { intent: '見積を作る' })).body.resource
  const path = `${project}/application-drafts/${draft.id}`
  await call('PATCH', path, { specMarkdown: '---\nspec:\n  name: 見積作成\n  users: [営業]\n  rules: [承認後は編集不可]\n---\n仕様の本文' })
  const turn = await call('POST', `${path}/conversation-turns`, { message: 'PDF に会社ロゴを入れる' }, { 'Idempotency-Key': 'turn-one' })
  expect(turn).toMatchObject({ status: 202, body: { resource: { status: 'pending', userMessage: 'PDF に会社ロゴを入れる' } } })
  expect(turn.body.operation).toMatchObject({ type: 'applicationDraft.conversationTurn.create', writeChannel: 'W', links: { self: `${path}/conversation-turns/${turn.body.resource.id}` } })
  expect(await call('POST', `${path}/conversation-turns`, { message: '別の返信' }, { 'Idempotency-Key': 'turn-one' })).toMatchObject({ status: 409, body: { error: { message: 'Idempotency-Key was already used with a different request' } } })
  expect((await call('POST', `${path}/conversation-turns`, { message: '別の返信' })).status).toBe(409)
  expect((await call('POST', `${path}/creation-plan-generations`)).status).toBe(409)
  const replay = await call('POST', `${path}/conversation-turns`, { message: 'PDF に会社ロゴを入れる' }, { 'Idempotency-Key': 'turn-one' })
  expect(replay.body.resource.id).toBe(turn.body.resource.id)
  await call('POST', '/api/v1/__mock/advance')
  const settled = (await call('GET', `${path}/conversation-turns/${turn.body.resource.id}`)).body
  expect(settled.status).toBe('succeeded')
  expect(parseAssistantMessage(settled.assistantMessage)).toEqual({
    summary: 'ご希望を仕様に反映しました。', changed: settled.changed, question: '見積の承認はどうしますか？',
  })
  expect(settled.changed).toEqual(['ルール「PDF に会社ロゴを入れる」を追加しました。', '見積一覧と見積の編集の画面を追加しました。', '見積に顧客・品目・金額を追加しました。'])
  expect(settled.suggestedReplies).toHaveLength(2)
  const spec = parseSpec(settled.specMarkdown)
  expect(spec.spec.name).toBe('見積作成')
  expect(spec.spec.users).toEqual(['営業'])
  expect(spec.spec.rules).toEqual(['承認後は編集不可', 'PDF に会社ロゴを入れる'])
  expect(spec.body).toContain('仕様の本文')
  const updated = (await call('GET', path)).body
  expect(updated.specMarkdown).toBe(settled.specMarkdown)
  expect(updated.conversationTurns).toHaveLength(1)
})

test.each([
  ['いいかんじに人事情報管理したい', '社員情報を管理するのは誰ですか？', ['人事担当者のみ', '人事と各部署の責任者'], '社員', ['氏名', '部署', '入社日']],
  ['営業が見積書を PDF で出したい', '見積の PDF には何を載せますか？', ['会社ロゴと連絡先', '支払期限と振込先'], '見積', ['顧客', '品目', '金額']],
  ['備品の在庫を数えたい', '在庫数はどう更新しますか？', ['数量を直接入力する', '入出庫の履歴から計算する'], '品目', ['品名', '数量', '保管場所']],
] as const)('opening questions use the intent domain: %s', async (intent, question, options, record, fields) => {
  await call('POST', '/api/v1/__mock/reset')
  const draft = (await call('POST', `${project}/application-drafts`, { intent })).body.resource
  const path = `${project}/application-drafts/${draft.id}`
  const send = async (message: string) => {
    const created = await call('POST', `${path}/conversation-turns`, { message })
    expect(created.status).toBe(202)
    await call('POST', '/api/v1/__mock/advance')
    return (await call('GET', `${path}/conversation-turns/${created.body.resource.id}`)).body
  }
  const opening = await send(FIRST_TURN)
  expect(parseAssistantMessage(opening.assistantMessage).question).toBe(question)
  expect(opening.suggestedReplies).toEqual(options)
  expect(parseSpec(opening.specMarkdown).spec).toMatchObject({ records: [{ name: record, fields }], rules: [] })
  if (record === '社員') expect(opening.assistantMessage + JSON.stringify(opening.suggestedReplies)).not.toContain('顧客')
  const second = await send(options[0])
  expect(parseAssistantMessage(second.assistantMessage).question).not.toBe(question)
  expect(second.suggestedReplies).toHaveLength(2)
  expect(second.suggestedReplies).not.toContain(KICKOFF_REPLY)
  const ready = await send(second.suggestedReplies[0])
  expect(ready.suggestedReplies[0]).toBe(KICKOFF_REPLY)
  expect(parseAssistantMessage(ready.assistantMessage).question).toBe('ここまでで最初の版を用意できます。')
  for (const message of [KICKOFF_REPLY, 'ここまでの内容で提案してください。']) {
    const kickoff = await send(message)
    expect(kickoff.suggestedReplies).toEqual([])
    expect(parseAssistantMessage(kickoff.assistantMessage).question).toBe('この内容で提案を用意します。')
    expect(parseSpec(kickoff.specMarkdown).spec.rules).not.toContain(message)
  }
  expect((await call('GET', path)).body.creationPlanGenerations).toEqual([])
})

test('conversation routes reject unavailable, forbidden, invalid and missing requests', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const draft = (await call('POST', `${project}/application-drafts`, { intent: '見積を作る' })).body.resource
  const path = `${project}/application-drafts/${draft.id}/conversation-turns`
  expect((await call('POST', path, { message: '' })).status).toBe(400)
  expect((await call('POST', path, { message: 'a'.repeat(4001) })).status).toBe(400)
  await call('POST', '/api/v1/__mock/codex', { available: false })
  expect((await call('POST', path, { message: 'ロゴを追加' })).status).toBe(412)
  await call('POST', '/api/v1/__mock/role', { role: 'Viewer' })
  expect((await call('POST', path, { message: 'ロゴを追加' })).status).toBe(403)
  expect((await call('GET', `${path}/missing`)).status).toBe(404)
  await call('POST', '/api/v1/__mock/reset')
})

test('policy availability is shared by creation tools, turn and generation admission and clears on recovery', async () => {
  await call('POST', '/api/v1/__mock/reset')
  try {
    const draft = (await call('POST', `${project}/application-drafts`, { intent: '見積を作る' })).body.resource
    const details = { reason: 'ai_approval_policy_denied', policy: 'default' }
    await call('POST', '/api/v1/__mock/codex', { available: false, ...details })
    expect((await call('GET', `${project}/application-drafts/creation-tools`)).body).toMatchObject({
      codexAvailable: false, codexUnavailableReason: details.reason, codexPolicy: details.policy,
    })
    for (const endpoint of ['conversation-turns', 'creation-plan-generations']) {
      expect(await call('POST', `${project}/application-drafts/${draft.id}/${endpoint}`, { message: 'ロゴを追加' })).toMatchObject({
        status: 412, body: { error: { code: 'failed_precondition', details } },
      })
    }
    await call('POST', '/api/v1/__mock/codex', { available: true })
    const tools = (await call('GET', `${project}/application-drafts/creation-tools`)).body
    expect(tools.codexAvailable).toBe(true)
    expect(tools).not.toHaveProperty('codexUnavailableReason')
    expect(tools).not.toHaveProperty('codexPolicy')
    expect((await call('POST', `${project}/application-drafts/${draft.id}/conversation-turns`, { message: 'ロゴを追加' })).status).toBe(202)
  } finally {
    await call('POST', '/api/v1/__mock/reset')
  }
})

test('implementation workspace serves documents, streamed tasks, preview and one release per push', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const created = await call('POST', `${project}/dev-workspaces`, { scope: 'application', applicationId: 'mitsumori', displayName: '見積 <営業>', codex: { enabled: true, approvalPolicy: 'unattended' }, preview: { port: 3000 } })
  expect(created).toMatchObject({ status: 201, body: { resource: { phase: 'Starting', applicationId: 'mitsumori' } } })
  const workspace = created.body.resource
  const path = `${project}/dev-workspaces/${workspace.id}`
  expect((await call('POST', `${workspace.codexUrl}api/tasks`, { prompt: '見積の画面を作る' })).status).toBe(503)
  await call('POST', '/api/v1/__mock/advance')
  expect((await call('GET', path)).body.phase).toBe('Ready')
  const preview = await request('GET', workspace.previewUrl)
  expect(preview.headers.get('Content-Type')).toContain('text/html')
  expect(await preview.text()).toContain('プレビュー: 見積 &lt;営業&gt;')
  const documentPath = `${workspace.codexUrl}api/appthrust/spec`
  await call('PUT', documentPath, { markdown: '# 見積の仕様' })
  expect((await call('GET', documentPath)).body).toEqual({ markdown: '# 見積の仕様' })
  const todos = [{ id: 'task-one', title: '見積の画面', status: 'todo', acceptanceCriteria: ['PDF を出せる'] }]
  await call('PUT', `${workspace.codexUrl}api/appthrust/todos`, { todos })
  expect((await call('GET', `${workspace.codexUrl}api/appthrust/workflow`)).body).toEqual({ todos })
  const task = await request('POST', `${workspace.codexUrl}api/tasks`, { prompt: '見積の画面を作る' })
  expect(task.headers.get('Content-Type')).toBe('application/x-ndjson')
  const events = (await task.text()).trim().split('\n').map((line) => JSON.parse(line))
  expect(events.map((event) => event.type)).toEqual(['task.started', 'output.delta', 'output.delta', 'task.completed'])
  const releases = (await call('GET', `${project}/releases`)).body.data
  for (let index = 0; index < 2; index++) {
    const commit = await call('POST', `${path}/commit`, { message: '見積の画面を作成', push: true })
    expect(commit).toMatchObject({ status: 202, body: { commitOperation: { phase: 'Pending', workspaceId: workspace.id } } })
    const operationPath = `${path}/operations/${commit.body.commitOperation.id}`
    await call('POST', '/api/v1/__mock/advance')
    expect((await call('GET', operationPath)).body).toMatchObject({ phase: 'Succeeded', commit: { hasChanges: true, pushed: true } })
    expect((await call('GET', `${project}/releases`)).body.data).toHaveLength(releases.length + index + 1)
  }
  await call('POST', '/api/v1/__mock/advance')
  expect((await call('GET', `${project}/releases`)).body.data).toHaveLength(releases.length + 2)
  await call('POST', '/api/v1/__mock/reset')
  expect((await call('GET', path)).status).toBe(404)
})

test('implementation run polls persist across readers, reject concurrent starts, and reuse the workspace on change/retry/skip', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const draft = (await call('POST', `${project}/application-drafts`, { intent: '見積を作る' })).body.resource
  const path = `${project}/application-drafts/${draft.id}`
  const runsPath = `${path}/implementation-runs`
  expect((await call('POST', runsPath)).status).toBe(412)
  await call('POST', `${path}/creation-plan-generations`)
  for (let step = 0; step < 4; step++) await call('POST', '/api/v1/__mock/advance')
  const planned = (await call('GET', path)).body
  planned.creationPlan.implementationHandoff.tasks.push({ title: '顧客一覧', description: '顧客を表示', acceptanceCriteria: ['表示できる'] })
  await call('PATCH', path, { creationPlan: planned.creationPlan })
  const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
  const begun = (await call('POST', `${path}/creation-executions`, { clientRequestId: 'impl-test', creationPlanFingerprint: validation.creationPlanFingerprint })).body.resource
  await call('POST', `${path}/creation-executions/${begun.creationExecutions[0].id}/run`)
  for (let step = 0; step < 6; step++) await call('POST', '/api/v1/__mock/advance')
  const created = await call('POST', runsPath)
  expect(created.status).toBe(202)
  const run = created.body.run
  expect(created.body.resource).toEqual(run)
  expect(run.status).toBe('pending')
  expect(run.tasks).toHaveLength(2)
  expect(run.taskIds).toEqual(run.tasks.map((task: { id: string }) => task.id))
  expect((await call('POST', runsPath)).status).toBe(409)
  await call('POST', '/api/v1/__mock/advance')
  const active = (await call('GET', `${runsPath}/${run.id}`)).body
  expect(active).toMatchObject({ status: 'running', step: 'request', currentTaskId: run.taskIds[0] })
  expect(active.tasks[0].startedAt).toBeTruthy()
  const workspaceId = active.devWorkspaceId
  expect((await call('GET', `${project}/dev-workspaces/${workspaceId}`)).body).toMatchObject({ phase: 'Ready', applicationId: (await call('GET', path)).body.createdApplicationId })
  for (const step of ['working', 'pushing']) {
    await call('POST', '/api/v1/__mock/advance')
    expect((await call('GET', path)).body.implementationRuns.at(-1).step).toBe(step)
  }
  await call('POST', '/api/v1/__mock/advance')
  expect((await call('GET', path)).body.implementationRuns.at(-1).tasks[0]).toMatchObject({ status: 'done', versionLabel: 'v2' })
  // No browser is advancing the lifecycle: manual server advances retain the same run.
  await call('POST', '/api/v1/__mock/advance')
  const cancelled = (await call('POST', `${runsPath}/${run.id}/cancel`)).body.run
  expect(cancelled.status).toBe('cancelled')
  const changed = (await call('POST', runsPath, { change: { taskId: run.taskIds[1], message: '色を変えて' } })).body.run
  expect(changed.taskIds).toEqual([run.taskIds[1]])
  expect(changed.tasks[0].status).toBe('done')
  expect(changed.tasks[1].message).toBe('色を変えて')
  expect(changed.devWorkspaceId).toBe(workspaceId)
  await call('POST', '/api/v1/__mock/implementation-run', { outcome: 'failed', error: 'could not implement' })
  for (let step = 0; step < 3; step++) await call('POST', '/api/v1/__mock/advance')
  expect((await call('GET', path)).body.implementationRuns.at(-1)).toMatchObject({ status: 'failed', error: 'could not implement' })
  const retry = (await call('POST', runsPath)).body.run
  expect(retry.taskIds).toEqual([run.taskIds[1]])
  expect(retry.devWorkspaceId).toBe(workspaceId)
  await call('POST', `${runsPath}/${retry.id}/cancel`)
  const skipped = (await call('POST', runsPath, { skipTaskIds: [run.taskIds[1]] })).body.run
  expect(skipped.tasks.map((task: { status: string }) => task.status)).toEqual(['done', 'skipped'])
  await call('POST', '/api/v1/__mock/advance')
  expect((await call('GET', path)).body.implementationRuns.at(-1).status).toBe('succeeded')
  expect((await call('POST', runsPath, { taskIds: ['unknown'] })).status).toBe(400)
  await call('POST', '/api/v1/__mock/reset')
})

test('conversation shares the generation busy gate and stops after fifty turns', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const draft = (await call('POST', `${project}/application-drafts`, { intent: '見積を作る' })).body.resource
  const path = `${project}/application-drafts/${draft.id}`
  await call('POST', `${path}/creation-plan-generations`)
  expect((await call('POST', `${path}/conversation-turns`, { message: '画面を追加' })).status).toBe(409)
  for (let step = 0; step < 4; step++) await call('POST', '/api/v1/__mock/advance')
  for (let turn = 0; turn < 50; turn++) {
    expect((await call('POST', `${path}/conversation-turns`, { message: `ルール ${turn + 1}` })).status).toBe(202)
    await call('POST', '/api/v1/__mock/advance')
  }
  expect(await call('POST', `${path}/conversation-turns`, { message: '上限後の返信' })).toMatchObject({ status: 412, body: { error: { message: 'application draft has reached 50 conversation turns' } } })
  expect((await call('GET', path)).body.conversationTurns).toHaveLength(50)
  await call('POST', '/api/v1/__mock/reset')
})

async function failedDraftAfterSourceCreation() {
  await call('POST', '/api/v1/__mock/reset')
  const draft = (await call('POST', `${project}/application-drafts`, { intent: '旅程を管理する' })).body.resource
  const path = `${project}/application-drafts/${draft.id}`
  await call('POST', `${path}/creation-plan-generations`)
  for (let step = 0; step < 4; step++) await call('POST', '/api/v1/__mock/advance')
  const planned = (await call('GET', path)).body
  const name = planned.creationPlan.applicationSourceRepositoryRequest.destination.repositoryName
  const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
  expect(validation.valid).toBe(true)
  const begun = (await call('POST', `${path}/creation-executions`, { clientRequestId: 'first', creationPlanFingerprint: validation.creationPlanFingerprint })).body.resource
  await call('POST', '/api/v1/__mock/stack-conflict', { appName: name, message: 'stack admission failed' })
  await call('POST', `${path}/creation-executions/${begun.creationExecutions[0].id}/run`)
  // An execution now observes 設計図を反映 (syncing) for one step before the creation settles.
  for (let step = 0; step < 2; step++) await call('POST', '/api/v1/__mock/advance')
  const failed = (await call('GET', path)).body
  expect(failed.creationExecutions[0].status).toBe('failed')
  expect(failed.createdApplicationStackId).toBeUndefined()
  const sourceId = failed.createdSourceRepositoryId
  expect(sourceId).toBeDefined()
  expect((await call('GET', `${project}/application-source-repositories/${sourceId}`)).body.status).toBe('ready')
  return { path, name, sourceId }
}

test('creation retry receives the bound cleanup plan and executes only stack tools', async () => {
  const { path, sourceId } = await failedDraftAfterSourceCreation()
  const original = (await call('GET', `${project}/application-source-repositories/${sourceId}`)).body
  const cleaned = (await call('POST', `${path}/creation-cleanups`)).body.resource
  expect(cleaned.creationExecutions).toEqual([])
  expect(cleaned.creationPlan.applicationSourceRepositoryRequest).toBeUndefined()
  expect(cleaned.creationPlan.applicationStackRequest.source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: sourceId })
  const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
  expect(validation.valid).toBe(true)
  const begun = (await call('POST', `${path}/creation-executions`, { clientRequestId: 'retry', creationPlanFingerprint: validation.creationPlanFingerprint })).body.resource
  expect(begun.creationExecutions[0].steps.map((step: { tool: string }) => step.tool)).toEqual([
    'appthrust.applicationStack.validate', 'appthrust.applicationStack.create', 'appthrust.applicationStack.observe',
  ])
  await call('POST', `${path}/creation-executions/${begun.creationExecutions[0].id}/run`)
  for (let step = 0; step < 2; step++) await call('POST', '/api/v1/__mock/advance')
  const finished = (await call('GET', path)).body
  expect(finished.creationExecutions[0].status).toBe('succeeded')
  expect((await call('GET', `${project}/application-source-repositories/${sourceId}`)).body.createdAt).toBe(original.createdAt)
  expect((await call('GET', `${project}/application-stacks/${finished.createdApplicationStackId}`)).body.sourceRepositoryRefName).toBe(sourceId)
})

test.each([false, true])('regenerated plans reuse the draft repository, including deleted ASRs: %s', async (deleted) => {
  const { path, sourceId, name } = await failedDraftAfterSourceCreation()
  await call('POST', `${path}/creation-cleanups`)
  if (deleted) expect((await call('DELETE', `${project}/application-source-repositories/${sourceId}`)).status).toBe(202)
  await call('POST', `${path}/creation-plan-generations`)
  for (let step = 0; step < 4; step++) await call('POST', '/api/v1/__mock/advance')
  const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
  expect(validation.valid).toBe(true)
  expect(validation.message).toContain(`Existing repository ${name} created by this draft will be`)
  const begun = (await call('POST', `${path}/creation-executions`, { clientRequestId: 'regenerated', creationPlanFingerprint: validation.creationPlanFingerprint })).body.resource
  await call('POST', `${path}/creation-executions/${begun.creationExecutions[0].id}/run`)
  for (let step = 0; step < 2; step++) await call('POST', '/api/v1/__mock/advance')
  const finished = (await call('GET', path)).body
  expect(finished.creationExecutions[0].status).toBe('succeeded')
  const repository = (await call('GET', `${project}/application-source-repositories/${finished.createdSourceRepositoryId}`)).body
  if (deleted) expect(repository.existing.repository).toBe(`acme/${name}`)
  else expect(finished.creationExecutions[0].steps[0].status).toBe('skipped')
})

test('draft validation keeps the name-taken prefix for a repository it did not create', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const draft = (await call('POST', `${project}/application-drafts`, { intent: '旅程を管理する' })).body.resource
  const path = `${project}/application-drafts/${draft.id}`
  await call('POST', `${path}/creation-plan-generations`)
  for (let step = 0; step < 4; step++) await call('POST', '/api/v1/__mock/advance')
  const planned = (await call('GET', path)).body
  const name = planned.creationPlan.applicationSourceRepositoryRequest.destination.repositoryName
  await call('POST', '/api/v1/__mock/github-repository', { name })
  const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
  expect(validation.valid).toBe(false)
  expect(validation.message).toStartWith(`name already exists: ${name}:`)
})

test('AI plans can omit publish and the created app can be repaired through the production web publish route', async () => {
  await call('POST', '/api/v1/__mock/reset')
  await call('POST', '/api/v1/__mock/plan-generation', { publish: false })
  const draft = (await call('POST', `${project}/application-drafts`, { intent: '見積を作る' })).body.resource
  const path = `${project}/application-drafts/${draft.id}`
  await call('POST', `${path}/creation-plan-generations`)
  for (let step = 0; step < 4; step++) await call('POST', '/api/v1/__mock/advance')
  const planned = (await call('GET', path)).body
  expect(planned.creationPlan.applicationStackRequest.publish).toBeUndefined()
  const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
  const begun = (await call('POST', `${path}/creation-executions`, { clientRequestId: 'repair-test', creationPlanFingerprint: validation.creationPlanFingerprint })).body.resource
  await call('POST', `${path}/creation-executions/${begun.creationExecutions.at(-1).id}/run`)
  for (let step = 0; step < 6; step++) await call('POST', '/api/v1/__mock/advance')
  const created = (await call('GET', path)).body
  const applicationId = created.createdApplicationId
  const before = (await call('GET', `${project}/publishes`)).body.data
  expect(before.some((publish: { applicationId: string }) => publish.applicationId === applicationId)).toBe(false)
  const body = { applicationId, branchId: 'production', componentId: `${applicationId}-web`, destination: { type: 'gateway' }, customDomain: 'commerce.appthrust.test', hostnamePattern: 'wildcard', subdomain: applicationId, idempotencyKey: 'repair-test' }
  const repaired = await call('POST', `${project}/publishes`, body)
  expect(repaired).toMatchObject({ status: 201, body: { applicationId, branchId: 'production', componentId: `${applicationId}-web`, publicUrl: `https://${applicationId}.commerce.appthrust.test/` } })
  const after = (await call('GET', `${project}/publishes`)).body.data
  expect(after).toHaveLength(before.length + 1)
  expect(after.filter((publish: { applicationId: string }) => publish.applicationId !== applicationId)).toEqual(before)
  await call('POST', `${project}/publishes`, body)
  expect((await call('GET', `${project}/publishes`)).body.data).toHaveLength(after.length)
  await call('POST', '/api/v1/__mock/reset')
})
