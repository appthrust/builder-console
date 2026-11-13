// Starting a NEW-APP session (entry.ts) against the in-memory Console and
// Platform mocks: the flag picks the engine of new sessions only; a console-v1
// start keeps one create key per intent, so reloads, lost answers and retries
// resume the same server session; the wait is bounded and stops typed.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createBuildSessionsApi, type BuildSessionsApi } from '../../api/build-sessions'
import { createConsoleMockFetch, resetMocks, type ConsoleMockFetch } from '../../api/testing/console-mock-fetch'
import { createTestGateway } from '../../api/testing/gateway'
import { readConsoleStart } from './console-session-state'
import { beginBuild, BuildStartError, START_WAIT_MS, startConsoleBuild, type ConsoleStartDeps } from './entry'

const CREATE = /^\/api\/console\/v1\/build-sessions$/
const INTENT = '来客の受付を記録するアプリ'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

let mock: ConsoleMockFetch
let api: BuildSessionsApi
let storage: Storage
let clock: number
let sleeps: number[]
const restore: (() => void)[] = []
const deps = (): Partial<ConsoleStartDeps> => ({ api, storage, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms }, random: () => 0.5 })
const sessions = async () => (await api.list()).items

beforeEach(async () => {
  await resetMocks()
  mock = createConsoleMockFetch()
  api = createBuildSessionsApi(createTestGateway({ consoleFetch: (path, init) => mock.fetch(path, init) }))
  storage = memoryStorage()
  clock = 0
  sleeps = []
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restore.push(() => warn.mockRestore())
})
afterEach(() => { for (const undo of restore.splice(0)) undo() })

test('a console-v1 start creates one server session, follows advance to its draft and keeps nothing afterwards', async () => {
  const { id } = await startConsoleBuild(INTENT, 'g-team-a', deps())
  const [session] = await sessions()
  expect(session!.draftId).toBe(id)
  expect(await api.resolve(id)).toEqual({ engine: 'console-v1', sessionId: session!.id })
  expect(mock.count('POST', CREATE)).toBe(1)
  expect(readConsoleStart(storage)).toBeUndefined()
})

test('a lost create answer: the next start replays the same key and gets the same session (no second one)', async () => {
  mock.rewrites.push({ method: 'POST', path: CREATE, once: true, body: (wire) => ({ ...wire, id: 'SENTINEL' }) })
  const error = await startConsoleBuild(INTENT, 'g-team-a', deps()).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(BuildStartError)
  expect((error as BuildStartError).reason).toBe('unconfirmed')
  expect(readConsoleStart(storage)?.sessionId).toBeUndefined()
  const { id } = await startConsoleBuild(INTENT, 'g-team-a', deps())
  const creates = mock.requests.filter((item) => item.method === 'POST' && CREATE.test(item.path))
  expect(creates).toHaveLength(2)
  expect(creates[0]!.idempotencyKey).toBe(creates[1]!.idempotencyKey)
  expect(await sessions()).toHaveLength(1)
  expect((await sessions())[0]!.draftId).toBe(id)
})

test('a reload during the wait resumes the stored session by reading it, never by creating again', async () => {
  mock.rewrites.push({ method: 'POST', path: /\/advance$/, once: true, response: () => new Response('upstream reset', { status: 503 }) })
  await expect(startConsoleBuild(INTENT, 'g-team-a', deps())).rejects.toThrow()
  const kept = readConsoleStart(storage)
  expect(kept?.sessionId).toBeDefined()
  const { id } = await startConsoleBuild(INTENT, 'g-team-a', deps())
  expect(mock.count('POST', CREATE)).toBe(1)
  expect(mock.count('GET', new RegExp(`/build-sessions/${kept!.sessionId}$`))).toBe(1)
  expect((await sessions())[0]!.draftId).toBe(id)
})

test('other words start another intent with another key', async () => {
  await startConsoleBuild(INTENT, 'g-team-a', deps())
  await startConsoleBuild('別のアプリ', 'g-team-a', deps())
  const keys = mock.requests.filter((item) => item.method === 'POST' && CREATE.test(item.path)).map((item) => item.idempotencyKey)
  expect(new Set(keys).size).toBe(2)
})

describe('a session that stops before its draft exists', () => {
  const stopped = (changes: Record<string, unknown>) => (wire: Record<string, unknown>) => {
    const { draftId: _draft, ...rest } = wire
    return { ...rest, lifecycle: 'initializing', nextAction: 'none', ...changes }
  }
  test('a recorded failure is typed; starting again reuses the key and creates nothing', async () => {
    const failure = { error: 'forbidden', message: 'この Project で AI を使う権限がありません。' }
    mock.rewrites.push({ method: 'POST', path: /\/advance$/, once: false, body: stopped({ failure }) })
    mock.rewrites.push({ method: 'GET', path: /\/build-sessions\/[^/]+$/, once: false, body: stopped({ failure }) })
    const first = await startConsoleBuild(INTENT, 'g-team-a', deps()).catch((caught: unknown) => caught) as BuildStartError
    expect(first.reason).toBe('failed')
    expect(first.failure).toEqual({ error: { kind: 'known', value: 'forbidden' }, message: failure.message })
    const again = await startConsoleBuild(INTENT, 'g-team-a', deps()).catch((caught: unknown) => caught) as BuildStartError
    expect(again.reason).toBe('failed')
    expect(again.sessionId).toBe(first.sessionId)
    expect(mock.count('POST', CREATE)).toBe(1)
  })
  test('an archived session is typed as archived', async () => {
    mock.rewrites.push({ method: 'POST', path: /\/advance$/, once: true, body: stopped({ lifecycle: 'archived', archivedAt: '2026-11-12T00:00:00Z' }) })
    const error = await startConsoleBuild(INTENT, 'g-team-a', deps()).catch((caught: unknown) => caught) as BuildStartError
    expect(error.reason).toBe('archived')
  })
  test('the wait is bounded: observed at the server pace, then a typed timeout that a new start resumes', async () => {
    mock.rewrites.push({ method: 'POST', path: /\/advance$/, once: true, body: stopped({ nextAction: 'observe', pollAfterMs: 2_500 }) })
    mock.rewrites.push({ method: 'GET', path: /\/build-sessions\/[^/]+$/, once: false, body: stopped({ nextAction: 'observe', pollAfterMs: 2_500 }) })
    const error = await startConsoleBuild(INTENT, 'g-team-a', deps()).catch((caught: unknown) => caught) as BuildStartError
    expect(error.reason).toBe('timeout')
    expect(clock).toBeLessThanOrEqual(START_WAIT_MS)
    expect(Math.min(...sleeps.slice(0, -1))).toBeGreaterThanOrEqual(2_500)
    mock.rewrites.splice(0)
    const { id } = await startConsoleBuild(INTENT, 'g-team-a', deps())
    expect(mock.count('POST', CREATE)).toBe(1)
    expect((await sessions())[0]!.draftId).toBe(id)
  })
  test('a 503 with Retry-After during the wait is waited out as asked (bounded to 60 s), then the start goes on', async () => {
    mock.rewrites.push({ method: 'POST', path: /\/advance$/, once: true, body: stopped({ nextAction: 'observe' }) })
    await mock.fetch('/api/console/__mock/build-session-unavailable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reads: 1, retryAfterSeconds: 600 }) })
    const { id } = await startConsoleBuild(INTENT, 'g-team-a', deps())
    expect(sleeps).toContain(60_000)
    expect(Math.max(...sleeps)).toBe(60_000)
    expect((await sessions())[0]!.draftId).toBe(id)
    expect(mock.count('POST', CREATE)).toBe(1)
  })
})

describe('the new-session engine (server flag) at beginBuild', () => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage })
    window.sessionStorage.clear()
    globalThis.fetch = mock.fetch as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    window.sessionStorage.clear()
    if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor)
    else Reflect.deleteProperty(globalThis, 'sessionStorage')
  })
  test('platform-v1 (the default, flag off) creates a legacy draft and never calls the console engine', async () => {
    const draft = await beginBuild('commerce', INTENT, { groupId: 'g-team-a', ownerSubject: 'sub-yamada' })
    expect(mock.count('POST', /\/application-drafts$/)).toBe(1)
    expect(mock.requests.filter((item) => item.path.startsWith('/api/console/v1/'))).toEqual([])
    expect((await api.resolve(draft.id)).engine).toBe('platform-v1')
  })
  test('console-v1 creates a console session and does not look up or adopt a legacy draft', async () => {
    const legacy = await beginBuild('commerce', INTENT, { groupId: 'g-team-a', ownerSubject: 'sub-yamada' })
    const started = await beginBuild('commerce', INTENT, { groupId: 'g-team-a', ownerSubject: 'sub-yamada', newSessionEngine: 'console-v1' })
    expect(started.id).not.toBe(legacy.id)
    expect(mock.count('GET', /\/application-drafts$/)).toBe(1)
    expect((await api.resolve(started.id)).engine).toBe('console-v1')
  })
})
