// The build route's engine selection (routes/build.tsx loader + view) over a
// memory router, the real queries/gateway/contracts and the in-memory mocks:
// every open asks the resolver; a console-v1 session opens with the new engine
// whatever the new-session flag or this tab's storage says; legacy drafts open
// as before; a failed resolution never falls back to the legacy engine.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { buildSessionsApi } from '../api/build-sessions'
import { groupsContract } from '../api/contracts/console/groups'
import { meContract } from '../api/contracts/console/me'
import { consoleKeys } from '../api/queries/console'
import { queryClient as appQueryClient } from '../api/queries/shared'
import { sessionExpiryStore } from '../api/session-expiry'
import { createConsoleMockFetch, resetMocks, type ConsoleMockFetch } from '../api/testing/console-mock-fetch'
import { createTestGateway } from '../api/testing/gateway'
import { platformRoutes } from '../dev/mock-platform'
import { startConsoleBuild } from '../features/build/entry'
import { initialSession, saveBuildSession } from '../features/build/session'
import { buildCopy } from '../model/build/copy'
import { setLanguage } from '../shell/language'
import { UnsavedChangesProvider } from '../ui/use-unsaved-changes-guard'
import { preserveLanguage } from '../../test/language'
import { BuildRouteView, loadBuildRoute } from './build'

const RESOLVE = /^\/api\/console\/v1\/build-sessions\/resolve\?/
let mock: ConsoleMockFetch
let mounted: { root: Root; container: HTMLDivElement; client: QueryClient }[] = []
const originalFetch = globalThis.fetch
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const restore: (() => void)[] = []

beforeEach(async () => {
  restore.push(preserveLanguage())
  setLanguage('ja')
  await resetMocks()
  mock = createConsoleMockFetch()
  globalThis.fetch = mock.fetch as typeof globalThis.fetch
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage })
  window.sessionStorage.clear()
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restore.push(() => warn.mockRestore())
  const url = new URL('/api/v1/__mock/codex', 'http://mock.test')
  await platformRoutes(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ available: true }) }), url)
})

afterEach(async () => {
  for (const { root, container, client } of mounted) {
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
  }
  mounted = []
  globalThis.fetch = originalFetch
  await act(async () => { sessionExpiryStore.setState(() => false) })
  window.sessionStorage.clear()
  if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
  for (const undo of restore.splice(0).reverse()) undo()
})

async function settle(rounds = 12) {
  for (let tick = 0; tick < rounds; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** Opens `/-/build/{draftId}` in a fresh page (a reload): new query cache and router, the same tab storage. */
async function open(draftId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false } } })
  const gateway = createTestGateway({ consoleFetch: (path, init) => mock.fetch(path, init) })
  const [me, groups] = await Promise.all([gateway.console(meContract, undefined), gateway.console(groupsContract, undefined)])
  client.setQueryData(consoleKeys.me, me)
  client.setQueryData(consoleKeys.groups, groups)
  const rootRoute = createRootRoute({ component: () => <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> })
  const buildRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/-/build/$draftId',
    loader: ({ params }) => loadBuildRoute(client, params.draftId),
    component: function BuildRoute() {
      return <BuildRouteView draftId={buildRoute.useParams().draftId} loaded={buildRoute.useLoaderData()} />
    },
    notFoundComponent: () => <p data-testid="not-found" />,
    errorComponent: () => <p data-testid="route-error" />,
  })
  const router = createRouter({ routeTree: rootRoute.addChildren([buildRoute]), history: createMemoryHistory({ initialEntries: [`/-/build/${draftId}`] }) })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container, client })
  await act(async () => { root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>) })
  await settle()
  return container
}

const engineOf = (container: HTMLElement) => {
  const page = container.querySelector('[data-testid="build-session"]')
  return page ? page.getAttribute('data-engine') ?? 'platform-v1' : undefined
}

async function legacyDraft() {
  const url = new URL('/api/v1/projects/commerce/application-drafts', 'http://mock.test')
  const response = await platformRoutes(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: '見積を管理するアプリ', title: '見積を管理' }) }), url)
  return ((await response!.json()) as { resource: { id: string } }).resource.id
}

const draftReads = (draftId: string) => mock.count('GET', new RegExp(`/application-drafts/${draftId}$`))

test('a legacy draft opens with the legacy engine and its Platform conversation, as before', async () => {
  const draftId = await legacyDraft()
  const page = await open(draftId)
  expect(engineOf(page)).toBe('platform-v1')
  expect(page.querySelector('[data-testid="build-session"]')!.getAttribute('data-stage')).toBe('ask')
  expect(mock.count('GET', RESOLVE)).toBe(1)
  expect(draftReads(draftId)).toBeGreaterThan(0)
  expect(mock.requests.filter((item) => item.path.startsWith('/api/console/v1/') && !RESOLVE.test(item.path))).toEqual([])
  // The legacy flow still sends its hidden opening turn to Platform.
  expect(mock.count('POST', new RegExp(`/application-drafts/${draftId}/conversation-turns$`))).toBe(1)
})

test('a console-v1 session opens with the new engine on every open; the flag, reloads and tab storage do not change it', async () => {
  // Created while the flag was on; the route never reads the flag, so turning it off cannot change this.
  const { id: draftId } = await startConsoleBuild('点検を記録するアプリ', 'g-team-a')
  // A legacy tab record for the same draft id must not pull it into the legacy engine.
  saveBuildSession(draftId, initialSession({ baseIntent: '点検を記録するアプリ', projectId: 'commerce', ownerSubject: 'sub-yamada', groupId: 'g-team-a' }))
  const first = await open(draftId)
  expect(engineOf(first)).toBe('console-v1')
  expect(draftReads(draftId)).toBe(0)
  expect(first.querySelector('h1')!.textContent).toBe('点検を記録するアプリ')

  window.sessionStorage.clear()
  const reloaded = await open(draftId)
  expect(engineOf(reloaded)).toBe('console-v1')
  expect(mock.count('GET', RESOLVE)).toBe(2)
  expect(draftReads(draftId)).toBe(0)
  // The legacy writer never runs for it: no Platform conversation turn, no draft update.
  expect(mock.requests.filter((item) => item.method !== 'GET' && item.path.includes(`/application-drafts/${draftId}`))).toEqual([])
})

test('the console page shows the server turns and requests a plan with its typed action', async () => {
  const { id: draftId } = await startConsoleBuild('点検を記録するアプリ', 'g-team-a')
  const resolved = await buildSessionsApi.resolve(draftId)
  const sessionId = resolved.engine === 'console-v1' ? resolved.sessionId : ''
  // The server answers the opening turn before the page opens, so nothing is running.
  const opening = (await buildSessionsApi.get(sessionId)).activeTurnId!
  for (let step = 0; step < 3; step++) await buildSessionsApi.getTurn(sessionId, opening)
  const page = await open(draftId)
  const log = page.querySelector('[role="log"]')!.textContent
  expect(log).toContain('点検を記録するアプリ')
  expect(log).toContain('ご質問の点を確認しました。')
  const plan = [...page.querySelectorAll('button')].find((button) => button.textContent === buildCopy.questions.kickoffReply)!
  expect(plan.disabled).toBe(false)
  await act(async () => { plan.click() })
  await settle()
  const turns = await buildSessionsApi.allTurns(sessionId)
  expect(turns.map((turn) => turn.kind)).toEqual(['conversation', 'request_plan'])
  expect(mock.count('POST', new RegExp(`/build-sessions/${sessionId}/turns$`))).toBe(1)
})

test('a failed resolution (401, 403, 503) is an error or a retry, never the legacy engine', async () => {
  const { id: draftId } = await startConsoleBuild('点検を記録するアプリ', 'g-team-a')
  // The router reports the loader's rejection to the console; that is the expected error path here.
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  restore.push(() => logged.mockRestore())
  mock.rewrites.push({ method: 'GET', path: RESOLVE, once: true, response: () => new Response(null, { status: 401 }) })
  const expired = await open(draftId)
  expect(engineOf(expired)).toBeUndefined()
  expect(sessionExpiryStore.state).toBe(true)
  expect(draftReads(draftId)).toBe(0)
  await act(async () => { sessionExpiryStore.setState(() => false) })

  mock.rewrites.push({ method: 'GET', path: RESOLVE, once: true, response: () => Response.json({ error: 'forbidden', message: 'not allowed' }, { status: 403 }) })
  const forbidden = await open(draftId)
  expect(engineOf(forbidden)).toBeUndefined()
  expect(forbidden.querySelector('[data-testid="route-error"]')).not.toBeNull()

  // An unavailable resolver is retried (rollout, database blip); meanwhile nothing opens the draft another way.
  mock.rewrites.push({ method: 'GET', path: RESOLVE, once: true, response: () => Response.json({ error: 'service_unavailable', message: 'database unavailable' }, { status: 503 }) })
  const unavailable = await open(draftId)
  expect(engineOf(unavailable)).toBeUndefined()
  expect(draftReads(draftId)).toBe(0)

  expect(engineOf(await open(draftId))).toBe('console-v1')
})

test('an unknown draft is not found', async () => {
  const page = await open('draft-missing')
  expect(page.querySelector('[data-testid="not-found"]')).not.toBeNull()
})
