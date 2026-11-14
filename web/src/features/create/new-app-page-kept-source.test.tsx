// The wizard's confirm step for a resumed creation (review findings 1 and 3), over the real page, queries, gateway
// and contracts; the in-memory Console and Platform mocks answer every request, which this test logs. An earlier
// attempt's repository is shown where it is (made, or sent with an outcome not known yet), never at the destination
// Platform resolves now, and the next 作る reuses it or resends exactly that create.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createCreateApi } from '../../api/create'
import { groupsContract } from '../../api/contracts/console/groups'
import { meContract } from '../../api/contracts/console/me'
import { consoleKeys } from '../../api/queries/console'
import { createTestGateway } from '../../api/testing/gateway'
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'
import type { ResolvedRepositoryDestination } from '../../model/contracts/catalog'
import { setLanguage } from '../../shell/language'
import { UnsavedChangesProvider } from '../../ui/use-unsaved-changes-guard'
import { preserveLanguage } from '../../../test/language'
import { text } from './copy'
import { NewAppPage } from './new-app-page'
import { saveCreateSession } from './persistence'
import type { CreateProgress, SourceBinding, SourceOrigin } from './submit'

type Override = (request: Request) => Response | Promise<Response>
let overrides = new Map<string, Override>()
let requests: { method: string; path: string; key: string | null; body?: unknown }[] = []

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const override = overrides.get(`${request.method} ${url.pathname}`)
  if (override) return override(request)
  const response = await (url.pathname.startsWith('/api/console/') ? consoleRoutes : platformRoutes)(request, url)
  return response ?? Response.json({ error: { code: 'not_found', message: 'unhandled' } }, { status: 404 })
}

/** The page's requests, logged with their Idempotency-Key and JSON body. */
async function pageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://mock.test'), init)
  const url = new URL(request.url)
  const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.clone().json().catch(() => undefined)
  requests.push({ method: request.method, path: url.pathname, key: request.headers.get('Idempotency-Key'), ...(body === undefined ? {} : { body }) })
  return route(request)
}

/** Setup and server-side truth: these calls are not the page's. */
const gateway = createTestGateway({
  consoleFetch: (path, init) => route(new Request(new URL(path, 'http://mock.test'), init)),
  platformFetch: (request) => route(request),
})
const api = createCreateApi(gateway)
async function mock(path: string, body: unknown) {
  const response = await route(new Request(new URL(path, 'http://mock.test'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
  if (!response.ok) throw new Error(`mock ${path}: ${response.status}`)
}

const storage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
let restore: (() => void)[] = []
let root: Root | undefined
let container: HTMLDivElement
let client: QueryClient

beforeEach(async () => {
  restore = [preserveLanguage()]
  setLanguage('ja')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage })
  window.sessionStorage.clear()
  overrides = new Map()
  requests = []
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(pageFetch as typeof globalThis.fetch)
  restore.push(() => fetch.mockRestore())
  await mock('/api/v1/__mock/reset', {})
  await mock('/api/console/__mock/reset', {})
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  // The mocks are module-level state shared with later test files: leave them as the next file expects them.
  await mock('/api/v1/__mock/reset', {})
  await mock('/api/console/__mock/reset', {})
  client?.clear()
  window.sessionStorage.clear()
  for (const undo of restore.reverse()) undo()
  if (storage) Object.defineProperty(globalThis, 'sessionStorage', storage)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
})

const name = 'inventory'
const templateId = 'biz-inventory-postgres'
const origin: SourceOrigin = { appName: name, kind: 'template', templateId }
const atA = (destination: ResolvedRepositoryDestination): SourceBinding => ({ repository: `acme/${name}`, image: `ghcr.io/acme/${name}`, revision: destination.revision, connectionId: destination.connectionId })

/**
 * The user confirmed 在庫管理 at the GHCR default (A) and an attempt started: the console app exists, and `progress`
 * says what else it did. Then an administrator moved the Project default to the built-in registry (B).
 */
async function resumedAtA(progressFor: (context: { draft: CreateProgress['draft']; destination: ResolvedRepositoryDestination; projectId: string }) => Promise<CreateProgress>) {
  const [me, groups] = await Promise.all([gateway.console(meContract, undefined), gateway.console(groupsContract, undefined)])
  const group = groups[0]!
  const destination = await api.repositoryDestination(me.projectId)
  if (destination.kind !== 'resolved') throw new Error('the mock default destination is not resolved')
  const draft = await api.createApp({ displayName: '在庫管理', description: '', tags: [], groupId: group.id, slug: name, share: { scope: 'private', groupIds: [], extraPersonIds: [] } })
  const progress = await progressFor({ draft, destination, projectId: me.projectId })
  saveCreateSession({
    version: 1, step: 'confirm', progress,
    values: { entry: 'template', imageRef: '', repository: undefined, intent: '', templateId, displayName: '在庫管理', description: '', tags: [], groupId: group.id, urlName: name, urlNameEdited: false, scope: 'private', shareGroupIds: null },
  })
  await mock('/api/v1/__mock/repository-destination', { state: 'builtin' })

  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  client.setQueryData(consoleKeys.me, { ...me, canCreateApps: true, effectiveGroupIds: [group.id] })
  client.setQueryData(consoleKeys.groups, groups)
  const rootRoute = createRootRoute()
  const newRoute = createRoute({ getParentRoute: () => rootRoute, path: '/new', component: NewAppPage })
  const router = createRouter({ routeTree: rootRoute.addChildren([newRoute]), history: createMemoryHistory({ initialEntries: ['/new?step=confirm'] }), isServer: true })
  await router.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider><NewAppPage /></UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>)
  })
  await settle()
  return { destination, projectId: me.projectId }
}

async function settle(rounds = 12) {
  for (let tick = 0; tick < rounds; tick++) await act(async () => { await Bun.sleep(10) })
}

/** The confirm step's label → value rows. */
function rows(): Record<string, string> {
  return Object.fromEntries([...container.querySelectorAll('dt')].map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? '']))
}
const pageText = () => container.textContent ?? ''
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}
async function click(target: HTMLButtonElement) {
  await act(async () => { target.click() })
  await settle()
}
const sourceWrites = () => requests.filter((item) => item.method !== 'GET' && item.path.includes('/application-source-repositories'))
const builtinImage = `registry.appthrust.test/commerce/${name}`

describe('an unsettled create (review finding 1)', () => {
  test('the confirm step shows where K went (A), not the new default; 作る resends only K\'s own request, and B is shown once Platform refuses it', async () => {
    let sent: Record<string, unknown> = {}
    const { destination } = await resumedAtA(async ({ draft, destination }) => {
      sent = { template: { repository: 'appthrust/template-biz-inventory', ref: 'main' }, destination: { repositoryName: name, visibility: 'private' }, destinationRevision: destination.revision, build: { mode: 'observed-image', ref: 'main' } }
      // POST with K got no answer: the attempt keeps K, its exact request and where it goes.
      return { draft, attempts: { source: { key: 'K-1', origin, request: sent as never, binding: atA(destination) } } }
    })

    expect(rows()[text.destination.pending]).toBe(`acme/${name}`)
    expect(rows()[text.destination.image]).toBe(`ghcr.io/acme/${name}`)
    expect(pageText()).toContain(text.destination.pendingNote)
    expect(pageText()).not.toContain(builtinImage)

    await click(button('作る'))
    // Only K's own request, under K, with A's revision: no validation, no other destination, no new key.
    expect(sourceWrites()).toEqual([{ method: 'POST', path: `/api/v1/projects/commerce/application-source-repositories`, key: 'K-1', body: sent }])
    expect(sent.destinationRevision).toBe(destination.revision)
    // Platform had not accepted K, so it answered the old revision DestinationChanged: K ended, B is shown for a new confirmation.
    expect(pageText()).toContain(text.destination.changedTitle)
    expect(rows()[text.destination.repository]).toBe(`acme/${name}`)
    expect(rows()[text.destination.image]).toBe(builtinImage)
    expect(pageText()).not.toContain(text.destination.pendingNote)
    expect(requests.filter((item) => item.method === 'POST' && item.path.endsWith('/application-stacks'))).toEqual([])
  })
})

describe('a resumed creation (review finding 3)', () => {
  test('a repository made at A is shown as already created there, and 作る reuses it without any source write', async () => {
    await resumedAtA(async ({ draft, destination, projectId }) => {
      const made = await api.createSourceRepository(projectId, { template: { repository: 'appthrust/template-biz-inventory', ref: 'main' }, destination: { repositoryName: name, visibility: 'private' }, destinationRevision: destination.revision, build: { mode: 'observed-image', ref: 'main' } }, 'setup-key')
      // The stack failed afterwards: progress keeps the repository and where it is.
      return { draft, sourceRepositoryId: made.id, sourceRepositoryOrigin: origin, sourceRepositoryBinding: atA(destination) }
    })

    expect(rows()[text.destination.created]).toBe(`acme/${name}`)
    expect(rows()[text.destination.image]).toBe(`ghcr.io/acme/${name}`)
    expect(rows()[text.destination.repository]).toBeUndefined()
    expect(pageText()).toContain(text.destination.createdNote)
    expect(pageText()).not.toContain(builtinImage)

    await click(button('作る'))
    expect(sourceWrites()).toEqual([])
    const stack = requests.find((item) => item.method === 'POST' && item.path.endsWith('/application-stacks'))
    expect(stack?.body).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: `${name}-src` } })
  })

  test('progress saved with only the repository id: Platform\'s record says where it is', async () => {
    await resumedAtA(async ({ draft, destination, projectId }) => {
      const made = await api.createSourceRepository(projectId, { template: { repository: 'appthrust/template-biz-inventory', ref: 'main' }, destination: { repositoryName: name, visibility: 'private' }, destinationRevision: destination.revision, build: { mode: 'observed-image', ref: 'main' } }, 'setup-key')
      // Created and ready: Platform's record names its repository URL.
      const listed = await (await route(new Request(`http://mock.test/api/v1/projects/${projectId}/application-source-repositories`))).json() as { data: Record<string, unknown>[] }
      overrides.set(`GET /api/v1/projects/${projectId}/application-source-repositories`, () => Response.json({ ...listed, data: listed.data.map((item) => item.id === made.id ? { ...item, repositoryUrl: `https://github.com/acme/${name}` } : item) }))
      return { draft, sourceRepositoryId: made.id, sourceRepositoryOrigin: origin }
    })

    expect(rows()[text.destination.created]).toBe(`https://github.com/acme/${name}`)
    expect(rows()[text.destination.image]).toBe(`ghcr.io/acme/${name}`)
    expect(pageText()).not.toContain(builtinImage)
    expect(button('作る').disabled).toBe(false)
  })

  test('progress saved with only an id Platform cannot place: no create until the user starts over, which forgets it and shows B', async () => {
    await resumedAtA(async ({ draft }) => ({ draft, sourceRepositoryId: 'gone-src', sourceRepositoryOrigin: origin }))

    expect(pageText()).toContain(text.destination.retainedUnknown)
    expect(rows()[text.destination.created]).toBeUndefined()
    expect(button('作る').disabled).toBe(true)

    await click(button(text.destination.startOver))
    expect(sourceWrites()).toEqual([expect.objectContaining({ method: 'DELETE', path: '/api/v1/projects/commerce/application-source-repositories/gone-src' })])
    expect(pageText()).not.toContain(text.destination.retainedUnknown)
    expect(rows()[text.destination.repository]).toBe(`acme/${name}`)
    expect(rows()[text.destination.image]).toBe(builtinImage)
    expect(button('作る').disabled).toBe(false)
  })
})
