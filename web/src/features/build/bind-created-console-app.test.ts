import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { ConsoleApiError, createConsoleTransport } from '../../api/console'
import { createConsoleApi, type CreateAppInput } from '../../api/console-unverified'
import { consoleRoutes } from '../../dev/mock-console'
import type { AppDetails } from '../create/submit'
import { bindCreatedConsoleApp, ConsoleAppCreationError } from './bind-created-console-app'
import { initialSession, readBuildSession, saveBuildSession } from './session'

const draftId = 'draft-ae97efbc'
const stackId = 'stack-6b1759583b597a0d'
const request: AppDetails = {
  projectId: 'commerce', displayName: 'Facility inspection', description: '', tags: [],
  groupId: 'g-team-a', urlName: 'facility-inspection-map-2',
  share: { scope: 'private', groupIds: [], extraPersonIds: [] },
}
const input: CreateAppInput = {
  displayName: request.displayName, description: request.description, tags: request.tags,
  groupId: request.groupId, slug: request.urlName, share: request.share,
}

async function fetchConsole(path: string, init: RequestInit): Promise<Response> {
  const url = new URL(path, 'http://mock.test')
  const response = await consoleRoutes(new Request(url, init), url)
  if (!response) throw new Error(`unhandled ${init.method} ${path}`)
  return response
}

beforeEach(async () => {
  await fetchConsole('/api/console/__mock/reset', { method: 'POST' })
  await fetchConsole('/api/console/__mock/caller', { method: 'POST', body: JSON.stringify({ personId: 'p-yamada', role: 'Editor' }) })
})
afterEach(async () => { await fetchConsole('/api/console/__mock/reset', { method: 'POST' }) })

function harness(createdAppId?: string) {
  const api = createConsoleApi(createConsoleTransport(fetchConsole))
  const apps = {
    ...api.apps,
    list: mock(api.apps.list), get: mock(api.apps.get), create: mock(api.apps.create),
    update: mock(api.apps.update), bind: mock(api.apps.bind),
  }
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  let session = { ...initialSession({ baseIntent: request.displayName, projectId: request.projectId, ownerSubject: 'owner', groupId: request.groupId }), createdAppId }
  saveBuildSession(draftId, session, storage)
  const savedIds: Array<string | undefined> = []
  const deps = {
    console: apps,
    onCreatedAppId: (createdAppId: string | undefined) => {
      session = { ...session, createdAppId }
      savedIds.push(createdAppId)
      saveBuildSession(draftId, session, storage)
    },
  }
  const run = (details = request) => bindCreatedConsoleApp(details, { stackId, createdAppId: session.createdAppId }, deps)
  return { api, apps, savedIds, run, saved: () => readBuildSession(draftId, storage)! }
}

describe('bindCreatedConsoleApp', () => {
  test('only a legacy create not_found carries the creation-operation marker', async () => {
    const h = harness()
    const error = new ConsoleApiError(404, { error: 'not_found', message: 'The requested resource was not found' })
    h.apps.create.mockRejectedValueOnce(error)
    const caught = await h.run().catch((failure: unknown) => failure)
    expect(caught).toBeInstanceOf(ConsoleAppCreationError)
    expect(caught).toMatchObject({ status: error.status, code: error.code, message: error.message, cause: error })
    expect(h.apps.bind).not.toHaveBeenCalled()
  })

  test.each(['list', 'update', 'bind'] as const)('a %s not_found remains unmarked', async (operation) => {
    const h = harness()
    const existing = operation === 'update' ? await h.api.apps.create({ ...input, displayName: 'Earlier name' }) : undefined
    const resumed = existing ? harness(existing.id) : h
    const error = new ConsoleApiError(404, { error: 'not_found', message: 'The requested resource was not found' })
    resumed.apps[operation].mockRejectedValueOnce(error)
    await expect(resumed.run()).rejects.toBe(error)
  })

  test('invalid_request preserves the server group diagnostic and does not bind', async () => {
    const h = harness()
    const error = new ConsoleApiError(400, { error: 'invalid_request', message: 'groupId must be one of your directory groups' })
    h.apps.create.mockRejectedValueOnce(error)
    await expect(h.run()).rejects.toBe(error)
    expect(h.apps.bind).not.toHaveBeenCalled()
  })

  test('a stale id returns 404, is cleared, and is replaced by a fresh record bound to the existing stack', async () => {
    const h = harness('deleted-console-record')
    h.apps.create.mockImplementation(async (input) => {
      expect(h.saved().createdAppId).toBeUndefined()
      return h.api.apps.create(input)
    })
    h.apps.bind.mockImplementation(async (appId, binding) => {
      expect(h.saved().createdAppId).toBe(appId)
      return h.api.apps.bind(appId, binding)
    })
    const app = await h.run()
    expect(h.apps.get.mock.calls).toEqual([['deleted-console-record']])
    expect(h.apps.create.mock.calls).toEqual([[input]])
    expect(h.apps.update).not.toHaveBeenCalled()
    expect(h.apps.bind.mock.calls).toEqual([[app.id, { stackId, appName: request.urlName }]])
    expect(app).toMatchObject({ stackId, appName: request.urlName, slug: request.urlName })
    expect(h.savedIds).toEqual([undefined, app.id])
    expect(h.saved().createdAppId).toBe(app.id)
    expect(await h.api.apps.get(app.id)).toEqual(app)
  })

  test.each([
    new ConsoleApiError(403, { error: 'forbidden', message: 'forbidden' }),
    new ConsoleApiError(500, { error: 'internal', message: 'database unavailable' }),
    new ConsoleApiError(503, undefined),
    new Error('network unavailable'),
    Object.assign(new Error('not a console response'), { status: 404 }),
  ])('non-not_found errors fail without clearing the saved id or creating a replacement: %s', async (error) => {
    const h = harness('previous-console-record')
    h.apps.get.mockRejectedValueOnce(error)
    await expect(h.run()).rejects.toBe(error)
    expect(h.savedIds).toEqual([])
    expect(h.saved().createdAppId).toBe('previous-console-record')
    expect(h.apps.create).not.toHaveBeenCalled()
    expect(h.apps.update).not.toHaveBeenCalled()
    expect(h.apps.bind).not.toHaveBeenCalled()
  })

  test('an existing stack binding wins over the stale id and missing plan name, without creating or rebinding', async () => {
    const h = harness('deleted-console-record')
    const existing = await h.api.apps.create(input)
    const bound = await h.api.apps.bind(existing.id, { stackId, appName: request.urlName })
    expect(await h.run({ ...request, urlName: '' })).toEqual(bound)
    expect(h.apps.list.mock.calls).toEqual([[{ scope: 'mine' }]])
    expect(h.apps.get).not.toHaveBeenCalled()
    expect(h.apps.create).not.toHaveBeenCalled()
    expect(h.apps.update).not.toHaveBeenCalled()
    expect(h.apps.bind).not.toHaveBeenCalled()
    expect(h.saved().createdAppId).toBe(existing.id)
  })

  test('a slug conflict reuses an owned unbound record in the requested group', async () => {
    const h = harness('deleted-console-record')
    const existing = await h.api.apps.create(input)
    const app = await h.run()
    expect(app).toMatchObject({ id: existing.id, stackId, appName: request.urlName })
    expect(h.apps.create).toHaveBeenCalledTimes(1)
    expect(h.apps.list.mock.calls).toEqual([[{ scope: 'mine' }], [{ scope: 'mine' }]])
    expect(h.apps.bind.mock.calls).toEqual([[existing.id, { stackId, appName: request.urlName }]])
    expect(h.savedIds).toEqual([undefined, existing.id])
    expect(h.saved().createdAppId).toBe(existing.id)
    expect((await h.api.apps.list({ scope: 'mine' })).filter((app) => app.slug === request.urlName)).toHaveLength(1)
  })

  test('an update slug conflict also reuses the existing unbound record', async () => {
    const h = harness()
    const previous = await h.api.apps.create({ ...input, slug: 'old-inspection-name' })
    const existing = await h.api.apps.create(input)
    // Resume from the previous record, whose rename now collides.
    const resumed = harness(previous.id)
    expect(await resumed.run()).toMatchObject({ id: existing.id, stackId })
    expect(resumed.apps.create).not.toHaveBeenCalled()
    expect(resumed.apps.update).toHaveBeenCalledTimes(1)
    expect(resumed.savedIds).toEqual([existing.id])
    expect((await h.api.apps.get(previous.id)).stackId).toBeNull()
  })

  test('a record bound to the same stack during creation is reused without rebinding', async () => {
    const h = harness()
    const existing = await h.api.apps.create(input)
    h.apps.create.mockImplementation(async (input) => {
      await h.api.apps.bind(existing.id, { stackId, appName: request.urlName })
      return h.api.apps.create(input)
    })
    expect(await h.run()).toMatchObject({ id: existing.id, stackId })
    expect(h.apps.bind).not.toHaveBeenCalled()
    expect(h.saved().createdAppId).toBe(existing.id)
  })

  test('a slug collision bound to another stack stays a slug_taken failure and is never rebound', async () => {
    const h = harness()
    const existing = await h.api.apps.create(input)
    const bound = await h.api.apps.bind(existing.id, { stackId: 'another-stack', appName: request.urlName })
    await expect(h.run()).rejects.toMatchObject({ status: 409, code: 'slug_taken' })
    expect(h.apps.bind).not.toHaveBeenCalled()
    expect(h.savedIds).toEqual([])
    expect(await h.api.apps.get(existing.id)).toEqual(bound)
  })

  test('a slug conflict cannot adopt a same-slug record from another group or another owner', async () => {
    const h = harness()
    const otherGroup = await h.api.apps.create({ ...input, groupId: 'g-sales-east' })
    await fetchConsole('/api/console/__mock/caller', { method: 'POST', body: JSON.stringify({ personId: 'p-suzuki', role: 'Editor' }) })
    const otherOwner = await h.api.apps.create(input)
    await fetchConsole('/api/console/__mock/caller', { method: 'POST', body: JSON.stringify({ personId: 'p-yamada', role: 'Editor' }) })
    await expect(h.run()).rejects.toMatchObject({ status: 409, code: 'slug_taken' })
    expect(h.apps.bind).not.toHaveBeenCalled()
    expect(h.savedIds).toEqual([])
    expect((await h.api.apps.get(otherGroup.id)).stackId).toBeNull()
    await fetchConsole('/api/console/__mock/caller', { method: 'POST', body: JSON.stringify({ personId: 'p-suzuki', role: 'Editor' }) })
    expect((await h.api.apps.get(otherOwner.id)).stackId).toBeNull()
  })

  test('a failed bind keeps the fresh record id so retry reuses it', async () => {
    const h = harness('deleted-console-record')
    const error = new ConsoleApiError(500, { error: 'internal', message: 'bind unavailable' })
    h.apps.bind.mockRejectedValueOnce(error)
    await expect(h.run()).rejects.toBe(error)
    const createdAppId = h.saved().createdAppId
    expect(createdAppId).toBeDefined()
    expect(createdAppId).not.toBe('deleted-console-record')
    expect(await h.run()).toMatchObject({ id: createdAppId, stackId })
    expect(h.apps.create).toHaveBeenCalledTimes(1)
    expect(h.apps.bind).toHaveBeenCalledTimes(2)
  })
})
