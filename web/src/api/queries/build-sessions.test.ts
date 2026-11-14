// Read models of console-v1 sessions: §13 polling, newer-wins caches, and a
// malformed refresh keeping the last good session.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { createBuildSessionsApi, intentKeys, mintIdempotencyKey, type BuildSessionsApi } from '../build-sessions'
import { ConsoleApiError, parseRetryAfter } from '../console'
import { createConsoleMockFetch, createSessionApp, resetMocks, type ConsoleMockFetch } from '../testing/console-mock-fetch'
import { createTestGateway } from '../testing/gateway'
import type { BuildSession } from '../../model/contracts/console'
import { buildPollDelay, buildSessionKeys, buildSessionOptions, buildTurnsOptions, HIDDEN_POLL_MS, receiveSession, receiveTurn, RETRY_AFTER_MAX_MS, type PollInput } from './build-sessions'

const observe = { kind: 'known', value: 'observe' } as const
const base: PollInput = { nextAction: observe, phaseElapsedMs: 0, hidden: false, consecutiveErrors: 0, random: () => 0.5 }

describe('§13 poll delay', () => {
  test('2 s, then 3 s after 10 s, then 5 s after 30 s, each within ±20 %', () => {
    expect(buildPollDelay(base)).toBe(2_000)
    expect(buildPollDelay({ ...base, phaseElapsedMs: 10_000 })).toBe(3_000)
    expect(buildPollDelay({ ...base, phaseElapsedMs: 30_000 })).toBe(5_000)
    expect(buildPollDelay({ ...base, random: () => 0 })).toBe(1_600)
    expect(buildPollDelay({ ...base, random: () => 0.999999 })).toBe(2_400)
  })
  test('a longer pollAfterMs wins; a hidden tab waits at least 15 s', () => {
    expect(buildPollDelay({ ...base, pollAfterMs: 7_000 })).toBe(7_000)
    expect(buildPollDelay({ ...base, pollAfterMs: 500 })).toBe(2_000)
    expect(buildPollDelay({ ...base, hidden: true })).toBe(HIDDEN_POLL_MS)
  })
  test('failed reads back off 2/4/8/15/30 s, capped at 30 s', () => {
    expect([1, 2, 3, 4, 5, 9].map((consecutiveErrors) => buildPollDelay({ ...base, consecutiveErrors }))).toEqual([2_000, 4_000, 8_000, 15_000, 30_000, 30_000])
  })
  test('a failed read\'s Retry-After only lengthens the backoff, up to 60 s', () => {
    expect(buildPollDelay({ ...base, consecutiveErrors: 1, retryAfterMs: 20_000 })).toBe(20_000)
    expect(buildPollDelay({ ...base, consecutiveErrors: 3, retryAfterMs: 1_000 })).toBe(8_000)
    expect(buildPollDelay({ ...base, consecutiveErrors: 1, retryAfterMs: 0 })).toBe(2_000)
    expect(buildPollDelay({ ...base, consecutiveErrors: 1, retryAfterMs: 3_600_000 })).toBe(RETRY_AFTER_MAX_MS)
    // Only a failed read waits for it.
    expect(buildPollDelay({ ...base, retryAfterMs: 20_000 })).toBe(2_000)
  })
  test('Retry-After is delta seconds or an HTTP date', () => {
    const now = Date.parse('2026-11-13T00:00:00Z')
    expect(parseRetryAfter('12', now)).toBe(12_000)
    expect(parseRetryAfter('Fri, 13 Nov 2026 00:00:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfter('Thu, 12 Nov 2026 00:00:00 GMT', now)).toBe(0)
    expect(parseRetryAfter('soon', now)).toBeUndefined()
    expect(parseRetryAfter(null, now)).toBeUndefined()
  })
  test('none, confirm and resume stop polling; an unknown next action keeps observing', () => {
    for (const value of ['none', 'confirm', 'resume'] as const) expect(buildPollDelay({ ...base, nextAction: { kind: 'known', value } })).toBe(false)
    expect(buildPollDelay({ ...base, nextAction: { kind: 'known', value: 'advance' } })).toBe(2_000)
    expect(buildPollDelay({ ...base, nextAction: { kind: 'unknown' } })).toBe(2_000)
  })
})

let mock: ConsoleMockFetch
let api: BuildSessionsApi
let client: QueryClient
const restore: (() => void)[] = []

beforeEach(async () => {
  await resetMocks()
  mock = createConsoleMockFetch()
  api = createBuildSessionsApi(createTestGateway({ consoleFetch: (path, init) => mock.fetch(path, init) }))
  client = new QueryClient({ defaultOptions: { queries: { refetchInterval: false } } })
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restore.push(() => warn.mockRestore())
})
afterEach(() => {
  client.clear()
  for (const undo of restore.splice(0)) undo()
})

async function initialized() {
  const created = await api.create({ kind: 'new-app', groupId: 'g-team-a', intent: '備品を貸し出すアプリ', locale: 'ja' }, mintIdempotencyKey())
  return api.advance(created.id, { key: intentKeys.advance(created.id, created.version), version: created.version })
}

/** A created session: the opening turn answered, a plan made and the creation begun on its draft. */
async function created() {
  const session = await initialized()
  for (let step = 0; step < 3; step++) await api.getTurn(session.id, session.activeTurnId!)
  return createSessionApp(api, mock, session.id)
}

describe('Retry-After from the server (mock 503)', () => {
  test('the session poll waits as long as the server asked, never shorter than its own backoff, never longer than 60 s', async () => {
    const session = await initialized()
    const options = buildSessionOptions(session.id, api)
    // The session poll runs while the session itself is observed (no active turn); a failed read keeps this data.
    client.setQueryData(options.queryKey, { ...session, activeTurnId: undefined, nextAction: { kind: 'known', value: 'observe' } })
    const interval = options.refetchInterval as (query: unknown) => number | false
    const query = () => client.getQueryCache().find({ queryKey: options.queryKey, exact: true })!
    const read = () => client.fetchQuery({ ...options, staleTime: 0 }).catch(() => undefined)
    const unavailable = (retryAfterSeconds: number) => mock.fetch('/api/console/__mock/build-session-unavailable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reads: 1, retryAfterSeconds }) })
    expect(interval(query())).toBeLessThanOrEqual(2_400)

    await unavailable(20)
    await read()
    const failed = query().state.error
    expect(failed).toBeInstanceOf(ConsoleApiError)
    expect(failed).toMatchObject({ status: 503, code: 'service_unavailable', retryAfterMs: 20_000 })
    expect(interval(query())).toBe(20_000)

    await unavailable(600)
    await read()
    expect(query().state.error).toMatchObject({ retryAfterMs: 600_000 })
    expect(interval(query())).toBe(RETRY_AFTER_MAX_MS)

    await unavailable(1)
    await read()
    // The third failure's own backoff (8 s) is longer than the 1 s asked for.
    expect(interval(query())).toBe(8_000)

    await read()
    expect(query().state.status).toBe('success')
  })
})

describe('newer answers win', () => {
  test('a session read that started before a write and lands after it does not bring the old session back', async () => {
    const before = await created()
    let started!: () => void
    const readStarted = new Promise<void>((resolve) => { started = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow: BuildSessionsApi = { ...api, get: async (id) => { const read = await api.get(id); started(); await gate; return read } }
    const options = buildSessionOptions(before.id, slow)
    client.setQueryData(options.queryKey, before)
    const read = client.fetchQuery({ ...options, staleTime: 0 })
    await readStarted
    const written = await api.setPublishPreferences(before.id, { name: '備品貸出', shareScope: 'group' }, { key: mintIdempotencyKey(), version: before.version })
    const newer = await api.get(before.id)
    expect(newer.version).toBe(written.sessionVersion)
    await receiveSession(client, newer)
    release()
    await read.catch(() => undefined)
    expect(client.getQueryData<BuildSession>(options.queryKey)!.version).toBe(newer.version)
  })

  test('the session cache keeps the higher version even when an older read is not cancelled', async () => {
    const before = await created()
    const newer = await api.setPublishPreferences(before.id, { name: '備品貸出', shareScope: 'group' }, { key: mintIdempotencyKey(), version: before.version }).then(() => api.get(before.id))
    const options = buildSessionOptions(before.id, { ...api, get: async () => before })
    client.setQueryData(options.queryKey, newer)
    await client.fetchQuery({ ...options, staleTime: 0 })
    expect(client.getQueryData<BuildSession>(options.queryKey)!.version).toBe(newer.version)
  })

  test('a turn list read missing a just-written turn keeps that turn', async () => {
    const session = await initialized()
    const listOptions = buildTurnsOptions(session.id, api)
    const oldList = await client.fetchQuery(listOptions)
    for (let step = 0; step < 3; step++) await api.getTurn(session.id, session.activeTurnId!)
    const ready = await api.get(session.id)
    const turn = await api.createTurn(session.id, { kind: 'conversation', message: '質問', intent: 'question', baseSpecRevision: 0 }, { key: mintIdempotencyKey(), version: ready.version })
    await receiveTurn(client, session.id, turn)
    // A list read that started before the write answers without the new turn.
    await client.fetchQuery({ ...buildTurnsOptions(session.id, { ...api, allTurns: async () => oldList }), staleTime: 0 })
    expect(client.getQueryData<{ id: string }[]>(listOptions.queryKey)!.map((item) => item.id)).toContain(turn.id)
  })
})

test('a malformed session refresh keeps the last good session and reports the failure', async () => {
  const session = await initialized()
  const options = buildSessionOptions(session.id, api)
  const good = await client.fetchQuery(options)
  const goodAt = client.getQueryState(options.queryKey)!.dataUpdatedAt
  mock.rewrites.push({ method: 'GET', path: new RegExp(`/build-sessions/${session.id}$`), once: true, body: (wire) => ({ ...wire, specification: 'SENTINEL' }) })
  await client.refetchQueries({ queryKey: buildSessionKeys.session(session.id) })
  expect(client.getQueryState(options.queryKey)!.status).toBe('error')
  expect(Object.is(client.getQueryData(options.queryKey), good)).toBe(true)
  expect(client.getQueryState(options.queryKey)!.dataUpdatedAt).toBe(goodAt)
  expect(JSON.stringify(client.getQueryData(options.queryKey))).not.toContain('SENTINEL')
})
