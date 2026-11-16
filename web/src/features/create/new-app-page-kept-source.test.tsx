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
import { locale, setLanguage } from '../../shell/language'
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
 * says what else it did. Then an administrator moved the Project default (`moveTo`: the built-in registry, B, unless
 * another state is given).
 */
async function resumedAtA(progressFor: (context: { draft: CreateProgress['draft']; destination: ResolvedRepositoryDestination; projectId: string }) => Promise<CreateProgress>, moveTo = 'builtin') {
  const [me, groups] = await Promise.all([gateway.console(meContract, undefined), gateway.console(groupsContract, undefined)])
  // A new app goes only into a group the caller belongs to.
  const group = groups.find((candidate) => me.effectiveGroupIds.includes(candidate.id))!
  const destination = await api.repositoryDestination(me.projectId)
  if (destination.kind !== 'resolved') throw new Error('the mock default destination is not resolved')
  const draft = await api.createApp({ displayName: '在庫管理', description: '', tags: [], groupId: group.id, slug: name, share: { scope: 'private', groupIds: [], extraPersonIds: [] } })
  const progress = await progressFor({ draft, destination, projectId: me.projectId })
  saveCreateSession({
    version: 1, step: 'confirm', progress,
    values: { entry: 'template', imageRef: '', repository: undefined, intent: '', templateId, displayName: '在庫管理', description: '', tags: [], groupId: group.id, urlName: name, urlNameEdited: false, scope: 'private', shareGroupIds: null },
  })
  await mock('/api/v1/__mock/repository-destination', { state: moveTo })

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
  const templateRequest = (revision: string) => ({ template: { repository: 'appthrust/template-biz-inventory', ref: 'main' }, destination: { repositoryName: name, visibility: 'private' }, destinationRevision: revision, build: { mode: 'observed-image', ref: 'main' } })
  const where = text.unsettled.repository(`acme/${name}`, `ghcr.io/acme/${name}`)
  const check = () => button(text.unconfirmed.confirm)
  const sourceReads = () => requests.filter((item) => item.method === 'GET' && item.path.endsWith('/application-source-repositories')).length

  test('K\'s resend is refused: the page holds it at A and sends nothing; a readback that does not find it offers the explicit give-up, which alone moves to B', async () => {
    let sent: Record<string, unknown> = {}
    const { destination } = await resumedAtA(async ({ draft, destination }) => {
      sent = templateRequest(destination.revision)
      // POST with K got no answer: the attempt keeps K, its exact request and where it goes.
      return { draft, attempts: { source: { key: 'K-1', origin, request: sent as never, binding: atA(destination) } } }
    })
    expect(rows()[text.destination.pending]).toBe(`acme/${name}`)
    expect(rows()[text.destination.image]).toBe(`ghcr.io/acme/${name}`)
    expect(pageText()).toContain(text.destination.pendingNote)
    expect(pageText()).not.toContain(builtinImage)

    await click(button('作る'))
    // Only K's own request, under K, with A's revision: no validation, no other destination, no new key.
    expect(sourceWrites()).toEqual([{ method: 'POST', path: '/api/v1/projects/commerce/application-source-repositories', key: 'K-1', body: sent }])
    expect(sent.destinationRevision).toBe(destination.revision)
    // Platform refused it (DestinationChanged), which does not prove K failed: A stays on screen, B is not offered.
    expect(pageText()).toContain(text.unsettled.title)
    expect(pageText()).toContain(text.unsettled.body(where))
    expect(pageText()).not.toContain(text.destination.changedTitle)
    expect(rows()[text.destination.pending]).toBe(`acme/${name}`)
    expect(pageText()).not.toContain(builtinImage)
    expect(button('作る').disabled).toBe(true)
    expect(() => button(text.unsettled.startOver)).toThrow()

    await click(check())
    expect(sourceReads()).toBe(1)
    expect(pageText()).toContain(text.unsettled.notFound(where))
    expect(button('作る').disabled).toBe(true)
    expect(sourceWrites()).toHaveLength(1)

    // Only the user's explicit choice gives K up; then the current destination (B) is shown for a new confirmation.
    await click(button(text.unsettled.startOver))
    expect(sourceWrites()).toHaveLength(1)
    expect(pageText()).not.toContain(text.unsettled.title)
    expect(rows()[text.destination.repository]).toBe(`acme/${name}`)
    expect(rows()[text.destination.image]).toBe(builtinImage)
    expect(button('作る').disabled).toBe(false)
  })

  test('K was applied at A but its resend is refused (the record gap): the readback offers it at A, and once the user says it is theirs the app continues there', async () => {
    await resumedAtA(async ({ draft, destination, projectId }) => {
      const sent = templateRequest(destination.revision)
      // The first send was applied, but its answer was lost and its key is unknown to the (mock) Platform's replay.
      await api.createSourceRepository(projectId, sent as never, 'applied-without-record')
      return { draft, attempts: { source: { key: 'K-2', origin, request: sent as never, binding: atA(destination), sentAt: new Date().toISOString() } } }
    })
    await click(button('作る'))
    expect(pageText()).toContain(text.unsettled.title)

    await click(check())
    // Offered, not adopted: where it is, when it was made and when K was sent; 作る stays disabled until the user chooses.
    expect(pageText()).toContain(text.candidate.title)
    expect(pageText()).toContain(text.candidate.body(where))
    expect(container.querySelector('[data-testid="create-candidate-created-at"]')?.textContent).toContain(text.candidate.createdAt('').trim())
    expect(container.querySelector('[data-testid="create-candidate-sent-at"]')?.textContent).toContain(text.candidate.sentAt('').trim())
    expect(container.querySelector('[data-testid="create-candidate-created-before"]')).toBeNull()
    // What choosing it means: the app is built on it, and deleting the app later removes its record too.
    expect(pageText()).toContain(text.candidate.useMeans)
    expect(button('作る').disabled).toBe(true)
    expect(sourceWrites()).toHaveLength(1)

    await click(button(text.candidate.use))
    expect(pageText()).not.toContain(text.candidate.title)
    expect(rows()[text.destination.found]).toBe(`acme/${name}`)
    expect(rows()[text.destination.image]).toBe(`ghcr.io/acme/${name}`)
    expect(pageText()).toContain(text.destination.foundNote)
    expect(button('作る').disabled).toBe(false)

    await click(button('作る'))
    expect(sourceWrites()).toHaveLength(1)
    const stack = requests.find((item) => item.method === 'POST' && item.path.endsWith('/application-stacks'))
    expect(stack?.body).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: `${name}-src` } })
  })

  test('another attempt\'s repository with the same name at A: "not mine" keeps K held with the explicit give-up and sends nothing; looking again re-offers it, and choosing it goes on', async () => {
    await resumedAtA(async ({ draft, destination, projectId }) => {
      // Someone else's request made a repository with this name at A; K itself was never applied.
      await api.createSourceRepository(projectId, templateRequest(destination.revision) as never, 'someone-else')
      return { draft, attempts: { source: { key: 'K-3', origin, request: templateRequest(destination.revision) as never, binding: atA(destination), sentAt: new Date().toISOString() } } }
    })
    await click(button('作る'))
    await click(check())
    expect(pageText()).toContain(text.candidate.title)

    await click(button(text.candidate.notMine))
    expect(pageText()).not.toContain(text.candidate.title)
    expect(pageText()).toContain(text.unsettled.title)
    expect(pageText()).toContain(text.unsettled.notMine)
    expect(pageText()).toContain(text.unsettled.notFound(where))
    expect(rows()[text.destination.pending]).toBe(`acme/${name}`)
    expect(button('作る').disabled).toBe(true)
    expect(button(text.unsettled.startOver).disabled).toBe(false)
    // Only K's one resend was ever written; checking again does not offer the rejected repository.
    await click(check())
    expect(pageText()).not.toContain(text.candidate.title)
    expect(sourceWrites()).toHaveLength(1)

    // The user reconsiders: the same hit is offered again with both choices, and choosing it goes on with its id.
    await click(button(text.unsettled.reconsider))
    expect(pageText()).toContain(text.candidate.title)
    expect(pageText()).toContain(text.candidate.body(where))
    expect(button(text.candidate.notMine).disabled).toBe(false)
    expect(button('作る').disabled).toBe(true)
    await click(button(text.candidate.use))
    expect(rows()[text.destination.found]).toBe(`acme/${name}`)
    await click(button('作る'))
    expect(sourceWrites()).toHaveLength(1)
    const stack = requests.find((item) => item.method === 'POST' && item.path.endsWith('/application-stacks'))
    expect(stack?.body).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: `${name}-src` } })
  })

  /** Platform's list, with every repository's creation time set to `createdAt` (the cluster's clock). */
  async function listedAt(projectId: string, createdAt: string) {
    const listed = await (await route(new Request(`http://mock.test/api/v1/projects/${projectId}/application-source-repositories`))).json() as { data: Record<string, unknown>[] }
    overrides.set(`GET /api/v1/projects/${projectId}/application-source-repositories`, () => Response.json({ ...listed, data: listed.data.map((item) => ({ ...item, createdAt })) }))
  }

  test('a repository created an hour before K\'s first send (by this browser\'s clock) is still a candidate with both choices, plus a neutral hint', async () => {
    const sentAt = new Date().toISOString()
    const { projectId } = await resumedAtA(async ({ draft, destination, projectId }) => {
      await api.createSourceRepository(projectId, templateRequest(destination.revision) as never, 'long-ago')
      return { draft, attempts: { source: { key: 'K-4', origin, request: templateRequest(destination.revision) as never, binding: atA(destination), sentAt } } }
    })
    await listedAt(projectId, new Date(Date.parse(sentAt) - 3_600_000).toISOString())
    await click(button('作る'))
    await click(check())

    expect(pageText()).toContain(text.candidate.title)
    expect(pageText()).toContain(text.candidate.body(where))
    expect(container.querySelector('[data-testid="create-candidate-created-before"]')?.textContent).toBe(text.candidate.createdBeforeSent)
    expect(container.querySelector('[data-testid="create-candidate-sent-at"]')?.textContent).toBe(text.candidate.sentAt(new Date(sentAt).toLocaleString(locale())))
    expect(button(text.candidate.use).disabled).toBe(false)
    expect(button(text.candidate.notMine).disabled).toBe(false)
    expect(button('作る').disabled).toBe(true)
    expect(sourceWrites()).toHaveLength(1)
  })

  test('the browser clock is 10 minutes ahead of the cluster and K really made the repository: the user chooses it and creation goes on with its id', async () => {
    const sentAt = new Date().toISOString()
    const { projectId } = await resumedAtA(async ({ draft, destination, projectId }) => {
      // K's first send was applied, but its answer was lost and its key is unknown to the (mock) Platform's replay.
      await api.createSourceRepository(projectId, templateRequest(destination.revision) as never, 'applied-without-record')
      return { draft, attempts: { source: { key: 'K-5', origin, request: templateRequest(destination.revision) as never, binding: atA(destination), sentAt } } }
    })
    // The cluster stamped it by a clock 10 minutes behind this browser's.
    await listedAt(projectId, new Date(Date.parse(sentAt) - 10 * 60_000).toISOString())
    await click(button('作る'))
    await click(check())
    expect(pageText()).toContain(text.candidate.title)
    expect(container.querySelector('[data-testid="create-candidate-created-before"]')).not.toBeNull()

    await click(button(text.candidate.use))
    expect(rows()[text.destination.found]).toBe(`acme/${name}`)
    expect(button('作る').disabled).toBe(false)
    await click(button('作る'))
    expect(sourceWrites()).toHaveLength(1)
    const stack = requests.find((item) => item.method === 'POST' && item.path.endsWith('/application-stacks'))
    expect(stack?.body).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: `${name}-src` } })
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

  test('progress saved with only an id Platform cannot place: no create until the user starts over, which forgets it without deleting it and shows B', async () => {
    await resumedAtA(async ({ draft }) => ({ draft, sourceRepositoryId: 'gone-src', sourceRepositoryOrigin: origin }))

    expect(pageText()).toContain(text.destination.retainedUnknown)
    expect(rows()[text.destination.created]).toBeUndefined()
    expect(button('作る').disabled).toBe(true)

    await click(button(text.destination.startOver))
    // Progress saved without how the id was learned is not provably this console's: it is never deleted.
    expect(sourceWrites()).toEqual([])
    expect(pageText()).not.toContain(text.destination.retainedUnknown)
    expect(rows()[text.destination.repository]).toBe(`acme/${name}`)
    expect(rows()[text.destination.image]).toBe(builtinImage)
    expect(button('作る').disabled).toBe(false)
  })

  test('a repository made at A, and today the default is not set: going on needs no destination, so 作る reuses A and sends no new source', async () => {
    await resumedAtA(async ({ draft, destination, projectId }) => {
      const made = await api.createSourceRepository(projectId, { template: { repository: 'appthrust/template-biz-inventory', ref: 'main' }, destination: { repositoryName: name, visibility: 'private' }, destinationRevision: destination.revision, build: { mode: 'observed-image', ref: 'main' } }, 'setup-key')
      return { draft, sourceRepositoryId: made.id, sourceRepositoryOrigin: origin, sourceRepositoryBinding: atA(destination), sourceRepositoryProvenance: 'created' }
    }, 'NotConfigured')

    expect(rows()[text.destination.created]).toBe(`acme/${name}`)
    // The blocked-destination notice is about new repositories; it does not apply here.
    expect(container.querySelector('[data-testid="create-destination-blocked"]')).toBeNull()
    expect(pageText()).not.toContain(text.destination.blocked)
    expect(button('作る').disabled).toBe(false)

    await click(button('作る'))
    expect(sourceWrites()).toEqual([])
    const stack = requests.find((item) => item.method === 'POST' && item.path.endsWith('/application-stacks'))
    expect(stack?.body).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: `${name}-src` } })
  })
})
