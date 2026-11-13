import { expect, spyOn, test } from 'bun:test'
import { platformRoutes } from '../../dev/mock-platform'
import { ApplicationDraft, ApplicationDraftImplementationRun, UpdateApplicationDraftRequest } from '@appthrust/api-schema/platform-api'
import { draftPublished } from './stage'
import { draftOf } from '../../api/testing/build-domain'

const project = '/api/v1/projects/commerce'
async function call(method: string, path: string, body?: unknown) {
  const request = new Request(`http://mock${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const response = await platformRoutes(request, new URL(request.url))
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  return { status: response.status, body: await response.json() }
}

test('mock execution observes syncing then ready and the prepare knob stalls the created build/start only', async () => {
  await call('POST', '/api/v1/__mock/reset')
  try {
    const draft = (await call('POST', `${project}/application-drafts`, { intent: '見積を作る' })).body.resource
    const path = `${project}/application-drafts/${draft.id}`
    await call('POST', `${path}/creation-plan-generations`)
    for (let n = 0; n < 4; n++) await call('POST', '/api/v1/__mock/advance')
    const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
    const created = (await call('POST', `${path}/creation-executions`, { clientRequestId: 'prepare', creationPlanFingerprint: validation.creationPlanFingerprint })).body.resource
    const executionId = created.creationExecutions[0].id
    await call('POST', `${path}/creation-executions/${executionId}/run`)
    await call('POST', '/api/v1/__mock/advance')
    const syncing = (await call('GET', path)).body.creationExecutions[0].steps.at(-1)
    expect(syncing).toMatchObject({ phase: 'syncing', status: 'running', detail: { attempt: 1 } })
    expect(Number.isFinite(Date.parse(syncing.detail.since))).toBe(true)
    await call('POST', '/api/v1/__mock/advance')
    const settled = (await call('GET', path)).body
    expect(settled.creationExecutions[0].steps.at(-1)).toMatchObject({ phase: 'ready', status: 'done', detail: { attempt: 2 } })
    await call('POST', '/api/v1/__mock/prepare', { stall: 'building' })
    await call('POST', '/api/v1/__mock/advance')
    await call('POST', '/api/v1/__mock/advance')
    const repositories = (await call('GET', `${project}/application-source-repositories`)).body.data
    const source = repositories.find((repository: { destination: { repositoryName: string } }) => repository.destination.repositoryName === settled.createdApplicationId)
    expect(source.status).toBe('pending')
    await call('POST', '/api/v1/__mock/prepare', { stall: 'starting' })
    await call('POST', '/api/v1/__mock/advance')
    const ready = (await call('GET', `${project}/application-source-repositories`)).body.data.find((repository: { id: string }) => repository.id === source.id)
    expect(ready.status).toBe('ready')
    expect(ready.conditions).toContainEqual({ type: 'ImageReady', status: 'True', reason: 'ImageAvailable' })
    await call('POST', '/api/v1/__mock/prepare', {})
    await call('POST', '/api/v1/__mock/advance')
    await call('POST', '/api/v1/__mock/advance')
    expect((await call('GET', `${project}/application-stacks/${settled.createdApplicationStackId}`)).body.state).toBe('ACTIVE')
  } finally { await call('POST', '/api/v1/__mock/reset') }
})

test('mock publication stamps server time, rejects active work and invalidates on a later implementation', async () => {
  await call('POST', '/api/v1/__mock/reset')
  let now = '2026-10-29T00:00:00.000Z'
  const clock = spyOn(Date.prototype, 'toISOString').mockImplementation(() => now)
  try {
    const draft = (await call('POST', `${project}/application-drafts`, { intent: '見積を作る' })).body.resource
    const path = `${project}/application-drafts/${draft.id}`
    expect(UpdateApplicationDraftRequest.parse({ markPublished: true })).toEqual({ markPublished: true })
    for (const markPublished of [false, null, 'true', 1]) {
      expect(UpdateApplicationDraftRequest.safeParse({ markPublished }).success).toBe(false)
      expect((await call('PATCH', path, { markPublished })).status).toBe(400)
    }
    expect((await call('PATCH', path, { publishedAt: now })).status).toBe(400)
    expect(await call('PATCH', path, { markPublished: true })).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } })
    await call('POST', `${path}/creation-plan-generations`)
    for (let n = 0; n < 4; n++) await call('POST', '/api/v1/__mock/advance')
    const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
    const created = (await call('POST', `${path}/creation-executions`, { clientRequestId: 'publication', creationPlanFingerprint: validation.creationPlanFingerprint })).body.resource
    await call('POST', `${path}/creation-executions/${created.creationExecutions[0].id}/run`)
    for (let n = 0; n < 6; n++) await call('POST', '/api/v1/__mock/advance')
    const first = await call('PATCH', path, { markPublished: true })
    expect(first.status).toBe(200)
    expect(first.body.resource.publishedAt).toBe(now)
    expect(draftPublished(draftOf((await call('GET', path)).body))).toBe(true)
    now = '2026-10-29T00:01:00.000Z'
    const run = ApplicationDraftImplementationRun.parse((await call('POST', `${path}/implementation-runs`)).body.run)
    expect(run.startedAt).toBe(now)
    for (const status of ['pending', 'running'] as const) {
      const before = ApplicationDraft.parse((await call('GET', path)).body)
      expect(before.implementationRuns?.at(-1)?.status).toBe(status)
      expect(before.implementationRuns?.at(-1)?.startedAt).toBe(run.startedAt)
      expect(draftPublished(draftOf(before))).toBe(false)
      expect(await call('PATCH', path, { markPublished: true })).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } })
      expect(ApplicationDraft.parse((await call('GET', path)).body)).toEqual(before)
      if (status === 'pending') await call('POST', '/api/v1/__mock/advance')
    }
    for (let n = 0; n < 12; n++) await call('POST', '/api/v1/__mock/advance')
    expect(draftPublished(draftOf((await call('GET', path)).body))).toBe(false)
    now = '2026-10-29T00:02:00.000Z'
    const republished = await call('PATCH', path, { markPublished: true })
    expect(republished.status).toBe(200)
    expect(republished.body.resource.publishedAt).toBe(now)
    expect(draftPublished(draftOf((await call('GET', path)).body))).toBe(true)
  } finally {
    clock.mockRestore()
    await call('POST', '/api/v1/__mock/reset')
  }
})
