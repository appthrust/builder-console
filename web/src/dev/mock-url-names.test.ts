import { expect, test } from 'bun:test'
import { platformRoutes } from './mock-platform'

const project = '/api/v1/projects/commerce'
async function call(method: string, path: string, body?: unknown) {
  const url = new URL(path, 'http://mock.test')
  const response = await platformRoutes(new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), url)
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  return { status: response.status, body: await response.json() }
}

async function plannedDraft() {
  const draft = (await call('POST', `${project}/application-drafts`, { intent: '予約を管理する' })).body.resource
  const path = `${project}/application-drafts/${draft.id}`
  await call('POST', `${path}/creation-plan-generations`)
  for (let i = 0; i < 4; i++) await call('POST', '/api/v1/__mock/advance')
  return { path, draft: (await call('GET', path)).body }
}

async function execute(path: string, clientRequestId: string) {
  const validation = await call('POST', `${path}/creation-plan-validations`)
  expect(validation.body.resource.valid).toBe(true)
  const begun = await call('POST', `${path}/creation-executions`, { clientRequestId, creationPlanFingerprint: validation.body.resource.creationPlanFingerprint })
  // Like the Platform: 202 for a new execution (200 only for a replay of its clientRequestId).
  expect(begun.status).toBe(202)
  const execution = begun.body.resource.creationExecutions.at(-1)
  await call('POST', `${path}/creation-executions/${execution.id}/run`)
  for (let i = 0; i < 2; i++) await call('POST', '/api/v1/__mock/advance')
  return (await call('GET', path)).body
}

test('generated plans skip taken application names and URLs consistently without renaming the repository', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const draft = (await call('POST', `${project}/application-drafts`, { intent: '予約を管理する' })).body.resource
  const path = `${project}/application-drafts/${draft.id}`
  const base = `ai-app-${draft.id.slice(-4)}`
  for (const [name, subdomain] of [[base, 'unrelated-url'], ['different-app', `${base}-2`]]) {
    expect((await call('POST', `${project}/application-stacks`, {
      templateId: 'nextjs-postgres', application: { name }, source: { kind: 'sample-image', imageRef: 'ghcr.io/acme/sample:latest' },
      publish: { enabled: true, customDomain: 'commerce.appthrust.test', hostnamePattern: 'wildcard', subdomain },
    })).status).toBe(202)
  }
  await call('POST', `${path}/creation-plan-generations`)
  for (let i = 0; i < 4; i++) await call('POST', '/api/v1/__mock/advance')
  const plan = (await call('GET', path)).body.creationPlan
  expect(plan.applicationStackRequest.application.name).toBe(`${base}-3`)
  expect(plan.applicationStackRequest.publish.subdomain).toBe(`${base}-3`)
  expect(plan.applicationSourceRepositoryRequest.destination.repositoryName).toBe(base)
})

test('publish conflict fails stack validation before any create; rename without cleanup succeeds', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const { path, draft } = await plannedDraft()
  const sources = (await call('GET', `${project}/application-source-repositories`)).body.data
  const stacks = (await call('GET', `${project}/application-stacks`)).body.data
  await call('POST', '/api/v1/__mock/creation-publish-conflict')
  const failed = await execute(path, 'first')
  const execution = failed.creationExecutions.at(-1)
  expect(execution.status).toBe('failed')
  expect(execution.steps.map((step: { tool: string }) => step.tool)).toEqual([
    'appthrust.applicationSourceRepository.validate', 'appthrust.applicationStack.validate',
    'appthrust.applicationSourceRepository.create', 'appthrust.applicationStack.create', 'appthrust.applicationStack.observe',
  ])
  expect(execution.steps[1]).toMatchObject({ status: 'failed', detail: { reason: 'PublishURLConflict' } })
  expect(execution.steps[2].status).toBe('pending')
  expect(execution.steps[3].status).toBe('pending')
  expect((await call('GET', `${project}/application-source-repositories`)).body.data).toEqual(sources)
  expect((await call('GET', `${project}/application-stacks`)).body.data).toEqual(stacks)
  const name = `${draft.creationPlan.applicationStackRequest.application.name}-2`
  expect((await call('PATCH', path, { renameApplication: { name } })).status).toBe(200)
  const succeeded = await execute(path, 'renamed')
  expect(succeeded.creationExecutions.at(-1).status).toBe('succeeded')
  expect(succeeded.creationExecutions).toHaveLength(2)
  expect(succeeded.createdApplicationId).toBe(name)
})

test('rename intent after a partial create preserves legacy stored inputs and reuses the repository', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const { path, draft } = await plannedDraft()
  const stack = draft.creationPlan.applicationStackRequest
  stack.applicationName = stack.application.name
  delete stack.application
  delete stack.database.provider
  expect((await call('PATCH', path, { creationPlan: draft.creationPlan })).status).toBe(200)
  await call('POST', '/api/v1/__mock/stack-conflict', { message: 'later stack mutation failed' })
  const failed = await execute(path, 'partial')
  expect(failed.creationExecutions.at(-1).status).toBe('failed')
  const sourceId = failed.createdSourceRepositoryId
  expect(sourceId).toBeTruthy()
  const count = (await call('GET', `${project}/application-source-repositories`)).body.data.length
  const name = `${failed.creationPlan.applicationStackRequest.applicationName}-2`
  const expected = structuredClone(failed.creationPlan)
  expected.applicationStackRequest.applicationName = name
  expected.applicationStackRequest.publish.subdomain = name
  expect((await call('PATCH', path, { creationPlan: expected })).status).toBe(409)
  const renamed = await call('PATCH', path, { renameApplication: { name } })
  expect(renamed.status).toBe(200)
  expect(renamed.body.resource.creationPlan).toEqual(expected)
  expect(renamed.body.resource.creationPlan.applicationStackRequest).not.toHaveProperty('application')
  expect(renamed.body.resource.creationPlan.applicationStackRequest.database).not.toHaveProperty('provider')
  expect(renamed.body.resource.validatedCreationPlanFingerprint).toBeUndefined()
  const succeeded = await execute(path, 'renamed-partial')
  expect(succeeded.creationExecutions.at(-1).status).toBe('succeeded')
  expect(succeeded.createdSourceRepositoryId).toBe(sourceId)
  expect(succeeded.creationPlan.applicationStackRequest.source.sourceRepositoryId).toBe(sourceId)
  expect((await call('GET', `${project}/application-source-repositories`)).body.data).toHaveLength(count)
})

test('rename rejects invalid, taken and created destinations without changing stored inputs', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const { path, draft } = await plannedDraft()
  for (const renameApplication of [null, {}, { name: '' }, { name: 'Upper' }, { name: '-app' }, { name: 'a'.repeat(64) }]) {
    expect((await call('PATCH', path, { renameApplication })).status).toBe(400)
  }
  expect((await call('PATCH', path, { creationPlan: draft.creationPlan, renameApplication: { name: 'new-name' } })).status).toBe(400)
  for (const [name, subdomain] of [['taken-app', 'other-url'], ['other-app', 'taken-url']]) {
    expect((await call('POST', `${project}/application-stacks`, {
      templateId: 'nextjs-postgres', application: { name }, source: { kind: 'sample-image', imageRef: 'ghcr.io/acme/sample:latest' },
      publish: { enabled: true, customDomain: 'commerce.appthrust.test', hostnamePattern: 'wildcard', subdomain },
    })).status).toBe(202)
  }
  for (const name of ['taken-app', 'taken-url']) {
    const response = await call('PATCH', path, { title: 'must not apply', renameApplication: { name } })
    expect(response.status).toBe(409)
    expect(response.body.error.details.reason).toBe('NameTaken')
    expect((await call('GET', path)).body).toEqual(draft)
  }
  const created = await execute(path, 'create')
  expect(created.creationExecutions.at(-1).status).toBe('succeeded')
  expect((await call('PATCH', path, { renameApplication: { name: 'new-name' } })).status).toBe(409)
})

test('rename requires a plan and refuses a running creation', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const empty = (await call('POST', `${project}/application-drafts`, { intent: '予約を管理する' })).body.resource
  expect((await call('PATCH', `${project}/application-drafts/${empty.id}`, { renameApplication: { name: 'new-name' } })).status).toBe(412)
  const { path } = await plannedDraft()
  const validation = await call('POST', `${path}/creation-plan-validations`)
  await call('POST', `${path}/creation-executions`, { clientRequestId: 'running', creationPlanFingerprint: validation.body.resource.creationPlanFingerprint })
  expect((await call('PATCH', path, { renameApplication: { name: 'new-name' } })).status).toBe(409)
})

test.each([undefined, 'old-name', 'explicit-id'])('rename preserves unrelated identity and disabled publication: %s', async (id) => {
  await call('POST', '/api/v1/__mock/reset')
  const { path, draft } = await plannedDraft()
  const stack = draft.creationPlan.applicationStackRequest
  stack.application = { name: 'old-name', ...(id ? { id } : {}) }
  stack.applicationName = 'old-name'
  stack.publish.enabled = false
  expect((await call('PATCH', path, { creationPlan: draft.creationPlan })).status).toBe(200)
  const expected = structuredClone(draft.creationPlan)
  expected.applicationStackRequest.applicationName = 'new-name'
  expected.applicationStackRequest.application.name = 'new-name'
  if (id === 'old-name') expected.applicationStackRequest.application.id = 'new-name'
  const renamed = await call('PATCH', path, { renameApplication: { name: 'new-name' } })
  expect(renamed.status).toBe(200)
  expect(renamed.body.resource.creationPlan).toEqual(expected)
})
