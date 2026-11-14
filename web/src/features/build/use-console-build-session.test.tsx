// useConsoleBuildSession over the real queries, gateway, transport and S4-0
// contracts against the in-memory v1 mock: the server owns the session, a
// double submit sends once, 412 re-reads, unreadable writes are neither cached
// nor resent, 401 keeps the intent, and the client never causes a 428.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { buildSessionsApi, intentKeys, mintIdempotencyKey } from '../../api/build-sessions'
import { sessionExpiryStore } from '../../api/session-expiry'
import { createConsoleMockFetch, createSessionApp, resetMocks, type ConsoleMockFetch } from '../../api/testing/console-mock-fetch'
import { buildCopy } from '../../model/build/copy'
import type { BuildSession } from '../../model/contracts/console'
import { useConsoleBuildSession, type ConsoleBuildSession } from './use-console-build-session'

const SECRET = 'SENTINEL-console-hook-41c2'
const api = buildSessionsApi
let mock: ConsoleMockFetch
const originalFetch = globalThis.fetch
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
let mounted: { root: Root; container: HTMLDivElement; client: QueryClient }[] = []
const restore: (() => void)[] = []

beforeEach(async () => {
  await resetMocks()
  mock = createConsoleMockFetch()
  globalThis.fetch = mock.fetch as typeof globalThis.fetch
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage })
  window.sessionStorage.clear()
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restore.push(() => warn.mockRestore())
})

afterEach(async () => {
  for (const { root, container, client } of mounted) {
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
  }
  mounted = []
  // The client never sends a write without its preconditions.
  expect(mock.requests.filter((item) => item.status === 428)).toEqual([])
  globalThis.fetch = originalFetch
  sessionExpiryStore.setState(() => false)
  window.sessionStorage.clear()
  if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
  for (const undo of restore.splice(0)) undo()
})

/** Lets fetches settle and React Query's batched notifications (macrotasks) reach the component. */
async function settle(rounds = 10) {
  for (let tick = 0; tick < rounds; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null, removeItem: (key) => { values.delete(key) }, setItem: (key, value) => { values.set(key, value) },
  }
}

/** One browser tab showing the session: its own query cache and storage. */
async function openTab(sessionId: string, storage: Storage = window.sessionStorage) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  const tab: { current?: ConsoleBuildSession } = {}
  function Probe() {
    tab.current = useConsoleBuildSession(sessionId, { storage })
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container, client })
  await act(async () => { root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>) })
  await settle()
  return { get build() { return tab.current! }, get view() { return tab.current!.view! }, client }
}

/** A session past initialization whose opening turn was answered: idle, accepting turns. */
async function idleSession(): Promise<BuildSession> {
  const created = await api.create({ kind: 'new-app', groupId: 'g-team-a', intent: '設備の点検を記録するアプリ', locale: 'ja' }, mintIdempotencyKey())
  const advanced = await api.advance(created.id, { key: intentKeys.advance(created.id, created.version), version: created.version })
  for (let step = 0; step < 3; step++) await api.getTurn(advanced.id, advanced.activeTurnId!)
  return api.get(created.id)
}

/** A conversation turn with a proposed change, waiting for 反映する／反映しない. */
async function confirmingSession(): Promise<{ session: BuildSession; turnId: string }> {
  const idle = await idleSession()
  const turn = await api.createTurn(idle.id, { kind: 'conversation', message: '承認を二段階にして', intent: 'change', baseSpecRevision: 0 }, { key: mintIdempotencyKey(), version: idle.version })
  for (let step = 0; step < 3; step++) await api.getTurn(idle.id, turn.id)
  return { session: await api.get(idle.id), turnId: turn.id }
}

const turnPosts = (sessionId: string) => mock.count('POST', new RegExp(`/build-sessions/${sessionId}/turns$`))
const cached = (client: QueryClient) => JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))

test('the session and its turns are the server values; this tab stores only the open write', async () => {
  const session = await idleSession()
  const tab = await openTab(session.id)
  expect(tab.view.engine).toBe('console-v1')
  expect(tab.view.session).toEqual(await api.get(session.id))
  expect(tab.view.turns).toEqual(await api.allTurns(session.id))
  expect(window.sessionStorage.length).toBe(0)

  await act(async () => { tab.build.actions.send('点検の頻度は毎日です') })
  await settle()
  // Accepted: nothing of the session, its turns or specification is kept by the tab.
  expect(window.sessionStorage.length).toBe(0)
  const turns = await api.allTurns(session.id)
  expect(tab.view.turns.map((turn) => turn.id)).toEqual(turns.map((turn) => turn.id))
  expect(tab.view.session.version).toBeGreaterThan(session.version)
})

test('a double submit sends one turn', async () => {
  const session = await idleSession()
  const tab = await openTab(session.id)
  let results: boolean[] = []
  await act(async () => { results = [tab.build.actions.send('点検表を印刷したい'), tab.build.actions.send('点検表を印刷したい')] })
  await settle()
  expect(results).toEqual([true, false])
  expect(turnPosts(session.id)).toBe(1)
  expect((await api.allTurns(session.id)).filter((turn) => turn.kind === 'conversation' && turn.request.message === '点検表を印刷したい')).toHaveLength(1)
})

test('the plan is requested by its typed kind; the same words typed are a conversation', async () => {
  const session = await idleSession()
  const tab = await openTab(session.id)
  await act(async () => { tab.build.actions.send(buildCopy.questions.kickoffReply) })
  await settle()
  const said = (await api.allTurns(session.id)).at(-1)!
  expect(said.kind).toBe('conversation')
  expect(tab.view.plan).toBeUndefined()
  for (let step = 0; step < 3; step++) await api.getTurn(session.id, said.id)
  await act(async () => { await tab.build.actions.resume() })
  await settle()
  let sent = false
  await act(async () => { sent = tab.build.actions.requestPlan() })
  expect(sent).toBe(true)
  await settle()
  const requested = (await api.allTurns(session.id)).at(-1)!
  expect(requested.kind).toBe('request_plan')
  expect(tab.view.plan?.id).toBe(requested.id)
})

test('a second tab writing on an older version gets 412: it re-reads, shows the newer state and resends nothing', async () => {
  const session = await idleSession()
  const tabA = await openTab(session.id)
  const tabB = await openTab(session.id, memoryStorage())
  await act(async () => { tabA.build.actions.send('タブ A の質問') })
  await settle()
  const sessionReads = mock.count('GET', new RegExp(`/build-sessions/${session.id}$`))
  await act(async () => { tabB.build.actions.send('タブ B の質問') })
  await settle()
  expect(mock.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/turns')).map((item) => item.status)).toEqual([202, 412])
  expect(mock.count('GET', new RegExp(`/build-sessions/${session.id}$`))).toBeGreaterThan(sessionReads)
  expect(tabB.view.engine).toBe('console-v1')
  // Tab B now shows a version at least as new as tab A's write (the server also moves it on each step of A's turn).
  expect(tabB.view.session.version).toBeGreaterThanOrEqual(tabA.view.session.version)
  expect(tabB.view.session.activeTurnId).toBe(tabA.view.session.activeTurnId)
  expect(tabB.view.conflict?.rejected).toMatchObject({ family: 'turn', body: { message: 'タブ B の質問' } })
  expect(tabB.view.write).toBeUndefined()
  await settle()
  expect(turnPosts(session.id)).toBe(2)
})

test('反映する right after the turn read that showed the proposal carries that read\'s session version, not the session still being re-read', async () => {
  const idle = await idleSession()
  const turn = await api.createTurn(idle.id, { kind: 'conversation', message: '承認を二段階にして', intent: 'change', baseSpecRevision: 0 }, { key: mintIdempotencyKey(), version: idle.version })
  // Two observations: running, then validating. The tab's own turn read is the step that imports the proposal.
  for (let step = 0; step < 2; step++) await api.getTurn(idle.id, turn.id)
  // The session re-read that the turn read triggers is still on its way when the user clicks.
  const { promise: held, resolve: release } = Promise.withResolvers<void>()
  let sessionReads = 0
  const sessionPath = new RegExp(`/build-sessions/${idle.id}$`)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET' && sessionPath.test(new URL(String(input), window.location.href).pathname) && sessionReads++ > 0) await held
    return mock.fetch(input, init)
  }) as typeof globalThis.fetch
  const tab = await openTab(idle.id)
  expect(tab.view.confirmation?.id).toBe(turn.id)
  const shownTurn = tab.client.getQueryData<{ sessionVersion: number }>(['build-session', idle.id, 'turn', turn.id])!
  expect(tab.view.session.version).toBeLessThan(shownTurn.sessionVersion)

  await act(async () => { tab.build.actions.resolve(turn.id, 'accept_spec') })
  await settle()
  const resolution = mock.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/resolution'))
  expect(resolution.map((item) => [item.status, item.ifMatch])).toEqual([[200, `"bs-${shownTurn.sessionVersion}"`]])
  release()
  await settle()
  expect(tab.view.conflict).toBeUndefined()
  expect(tab.view.session.specification.revision).toBe(1)
})

describe('an unreadable 2xx answer to a write', () => {
  const unreadable = (wire: Record<string, unknown>) => ({ ...wire, version: SECRET, sessionVersion: SECRET })
  const families: { name: string; method: string; path: RegExp; setup: () => Promise<BuildSession>; act: (build: ConsoleBuildSession, session: BuildSession) => void }[] = [
    { name: 'turn', method: 'POST', path: /\/turns$/, setup: idleSession, act: (build) => { build.actions.send('質問です') } },
    { name: 'resolution', method: 'POST', path: /\/resolution$/, setup: async () => (await confirmingSession()).session, act: (build, session) => { build.actions.resolve(session.activeTurnId ?? build.view!.confirmation!.id, 'accept_spec') } },
    // Publish preferences are a created session's (design §12).
    { name: 'publish', method: 'PATCH', path: /\/publish-preferences$/, setup: async () => createSessionApp(api, mock, (await idleSession()).id), act: (build) => { build.actions.setPublishPreferences({ name: '点検ノート', shareScope: 'group' }) } },
    { name: 'archive', method: 'POST', path: /\/archive$/, setup: idleSession, act: (build) => { build.actions.archive() } },
    // advance is sent by the hook itself when the server says `advance`.
    { name: 'advance', method: 'POST', path: /\/advance$/, setup: () => api.create({ kind: 'new-app', groupId: 'g-team-a', intent: '初期化中のアプリ', locale: 'ja' }, mintIdempotencyKey()), act: () => {} },
  ]
  for (const family of families) {
    test(`${family.name}: not cached, not resent, kept unconfirmed across a reload, cleared only by a re-read`, async () => {
      const session = await family.setup()
      mock.rewrites.push({ method: family.method, path: family.path, once: true, body: unreadable })
      const tab = await openTab(session.id)
      await act(async () => { family.act(tab.build, session) })
      await settle()
      const writes = () => mock.count(family.method, family.path)
      expect(writes()).toBe(1)
      expect(tab.view.write).toEqual({ family: family.name as never, status: 'unconfirmed' })
      expect(cached(tab.client)).not.toContain(SECRET)
      // Neither a resend nor a new write is possible while it is unconfirmed.
      await act(async () => { tab.build.actions.retry(); tab.build.actions.send('別の質問'); tab.build.actions.archive() })
      await settle()
      expect(writes()).toBe(1)
      expect(tab.view.canSend).toBe(false)

      const reloaded = await openTab(session.id)
      expect(reloaded.view.write).toEqual({ family: family.name as never, status: 'unconfirmed' })
      await settle()
      expect(writes()).toBe(1)

      await act(async () => { await reloaded.build.actions.confirm() })
      await settle()
      expect(reloaded.view.write).toBeUndefined()
      expect(reloaded.view.session).toEqual(await api.get(session.id))
      expect(writes()).toBe(1)
    })
  }
})

test('401 on a write keeps the intent for after sign-in; the engine and the intent key do not change', async () => {
  const session = await idleSession()
  mock.rewrites.push({ method: 'POST', path: /\/turns$/, once: true, response: () => new Response(null, { status: 401 }) })
  const tab = await openTab(session.id)
  await act(async () => { tab.build.actions.send('期限切れの前に書いた質問') })
  await settle()
  expect(sessionExpiryStore.state).toBe(true)
  expect(tab.view.engine).toBe('console-v1')
  expect(tab.view.canSend).toBe(false)
  const first = mock.requests.find((item) => item.method === 'POST' && item.path.endsWith('/turns'))!

  // Signing in again reloads the page: the same tab storage, a new page state.
  await act(async () => { sessionExpiryStore.setState(() => false) })
  const reloaded = await openTab(session.id)
  expect(reloaded.view.engine).toBe('console-v1')
  expect(reloaded.view.write).toEqual({ family: 'turn', status: 'interrupted' })
  await act(async () => { reloaded.build.actions.retry() })
  await settle()
  const posts = mock.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/turns'))
  expect(posts.map((item) => item.status)).toEqual([401, 202])
  expect(posts[1]!.idempotencyKey).toBe(first.idempotencyKey)
  expect(posts[1]!.ifMatch).toBe(first.ifMatch)
  expect(reloaded.view.write).toBeUndefined()
})

test('a transient failure keeps the intent; the resend is the same request, and a replay is not applied twice', async () => {
  const session = await idleSession()
  // The server applies the turn, but its answer is lost on the way back (a gateway 502).
  const tab = await openTab(session.id)
  const realFetch = mock.fetch
  let dropped = false
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await realFetch(input, init)
    if (!dropped && init?.method === 'POST' && String(input).endsWith('/turns')) { dropped = true; return new Response('bad gateway', { status: 502 }) }
    return response
  }) as typeof globalThis.fetch
  await act(async () => { tab.build.actions.send('届いたが答えが失われた質問') })
  await settle()
  expect(tab.view.write).toEqual({ family: 'turn', status: 'interrupted' })
  expect(tab.view.failure?.retryable).toBe(true)
  await act(async () => { tab.build.actions.retry() })
  await settle()
  const posts = mock.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/turns'))
  expect(posts).toHaveLength(2)
  expect(posts[0]!.idempotencyKey).toBe(posts[1]!.idempotencyKey)
  expect((await api.allTurns(session.id)).filter((turn) => turn.kind === 'conversation' && turn.request.message === '届いたが答えが失われた質問')).toHaveLength(1)
  expect(tab.view.write).toBeUndefined()
})

test('advance is sent once per session version when the server asks for it', async () => {
  const created = await api.create({ kind: 'new-app', groupId: 'g-team-a', intent: '受付を記録するアプリ', locale: 'ja' }, mintIdempotencyKey())
  const tab = await openTab(created.id)
  await settle()
  const advances = mock.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/advance'))
  expect(advances).toHaveLength(1)
  expect(advances[0]!.idempotencyKey).toBe(intentKeys.advance(created.id, created.version))
  expect(tab.view.session.draftId).toBeDefined()
})
