// The NEW-APP conversation client over the real gateway, transport and S4-0
// contracts, against the in-memory v1 mock (dev/mock-build-sessions.ts).
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isResponseContractError, type ResponseContractError } from './boundary'
import { createBuildSessionsApi, intentKeys, isVersionConflict, mintIdempotencyKey, sessionETag, type BuildSessionsApi } from './build-sessions'
import { buildCreateHeaders, buildETag, buildMutationHeaders, buildSchemas } from './contracts/console/schema/build-sessions'
import { buildSessionOperations } from './contracts/console/schema/build-session-operations'
import { createConsoleMockFetch, resetMocks, type ConsoleMockFetch } from './testing/console-mock-fetch'
import { createTestGateway } from './testing/gateway'

type Fixture = { name: string; schema: string; raw: string; expected: { accept: boolean } }
const fixtures = JSON.parse(readFileSync(new URL('../../../cmd/server/internal/api/testdata/build-conversation.json', import.meta.url), 'utf8')) as Fixture[]

let mock: ConsoleMockFetch
let api: BuildSessionsApi
const restore: (() => void)[] = []

beforeEach(async () => {
  await resetMocks()
  mock = createConsoleMockFetch()
  api = createBuildSessionsApi(createTestGateway({ consoleFetch: (path, init) => mock.fetch(path, init) }))
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restore.push(() => warn.mockRestore())
})
afterEach(() => { for (const undo of restore.splice(0)) undo() })

const create = (intent = '経費を申請して承認するアプリ') => api.create({ kind: 'new-app', groupId: 'g-team-a', intent, locale: 'ja' }, mintIdempotencyKey())

/** An initialized session (draft made, opening turn answered) that accepts turns. */
async function ready() {
  const created = await create()
  let session = await api.advance(created.id, { key: intentKeys.advance(created.id, created.version), version: created.version })
  for (let step = 0; step < 3; step++) await api.getTurn(session.id, session.activeTurnId!)
  session = await api.get(session.id)
  expect(session.activeTurnId).toBeUndefined()
  return session
}

describe('If-Match from the verified session version', () => {
  test('formats exactly the shared corpus ETags and only valid ones', () => {
    const accepted = fixtures.filter((item) => item.schema === 'BuildETag' && item.expected.accept).map((item) => JSON.parse(item.raw) as string)
    expect(accepted.length).toBeGreaterThan(0)
    for (const value of accepted) expect(sessionETag(Number(/^"bs-(\d+)"$/.exec(value)![1]))).toBe(value)
    for (const item of fixtures.filter((entry) => entry.schema === 'BuildSession' && entry.expected.accept)) {
      expect(buildETag.safeParse(sessionETag((JSON.parse(item.raw) as { version: number }).version)).success).toBe(true)
    }
  })

  test('equals the ETag the server sends with each session-bearing answer', async () => {
    const session = await ready()
    const url = new URL(`/api/console/v1/build-sessions/${session.id}`, 'http://mock.test')
    const answer = await mock.fetch(url)
    expect(answer.headers.get('ETag')).toBe(sessionETag(session.version))
    expect(answer.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('the twelve operations', () => {
  test('writes carry contract-valid Idempotency-Key and If-Match; reads carry none; no 428 is ever answered', async () => {
    // Every v1 answer of the mock is checked against the strict writer schema and the response-header rules.
    const problems: string[] = []
    api = createBuildSessionsApi(createTestGateway({ consoleFetch: async (path, init) => {
      const response = await mock.fetch(path, init)
      const url = new URL(path, 'http://mock.test')
      const method = init?.method ?? 'GET'
      const candidates = Object.values(buildSessionOperations).filter((item) => item.method === method && new RegExp(`^${item.routeTemplate.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(url.pathname))
      // `/build-sessions/resolve` also fits `/build-sessions/{id}`: the literal route is the one served.
      const operation = candidates.find((item) => !item.routeTemplate.includes('{')) ?? candidates[0]
      if (!operation) problems.push(`no operation for ${method} ${url.pathname}`)
      if (response.headers.get('Cache-Control') !== 'no-store') problems.push(`${method} ${url.pathname}: Cache-Control`)
      if (operation && response.ok) {
        const wire = buildSchemas[operation.schema].safeParse(await response.clone().json())
        if (!wire.success) problems.push(`${operation.operationId}: ${wire.error.message}`)
        if ('etag' in operation && !buildETag.safeParse(response.headers.get('ETag')).success) problems.push(`${operation.operationId}: ETag`)
        if ('location' in operation && !response.headers.get('Location')?.startsWith('/api/console/v1/build-sessions/')) problems.push(`${operation.operationId}: Location`)
      }
      return response
    } }))
    const session = await ready()
    const turn = await api.createTurn(session.id, { kind: 'conversation', message: '承認を二段階にして', intent: 'change', baseSpecRevision: 0 }, { key: mintIdempotencyKey(), version: session.version })
    for (let step = 0; step < 3; step++) await api.getTurn(session.id, turn.id)
    let current = await api.get(session.id)
    const resolved = await api.resolveTurn(session.id, turn.id, { decision: 'accept_spec' }, { key: intentKeys.resolution(session.id, current.version, turn.id, 'accept_spec'), version: current.version })
    expect(resolved.sessionVersion).toBeGreaterThan(current.version)
    current = await api.get(session.id)
    const revision = await api.specRevision(session.id, current.specification.revision)
    expect(revision.revision).toBe(1)
    const publish = await api.setPublishPreferences(session.id, { name: '経費ノート', shareScope: 'group' }, { key: mintIdempotencyKey(), version: current.version })
    // The mock writes the typed preference to the session's Platform draft, as the server does.
    expect(publish.sync.state).toEqual({ kind: 'known', value: 'applied' })
    await api.list()
    expect((await api.listTurns(session.id)).items.length).toBeGreaterThan(0)
    expect(await api.resolve(current.draftId!)).toEqual({ engine: 'console-v1', sessionId: session.id })
    const archived = await api.archive(session.id, { key: intentKeys.archive(session.id, publish.sessionVersion), version: publish.sessionVersion })
    expect(archived.lifecycle).toEqual({ kind: 'known', value: 'archived' })

    expect(mock.requests.some((item) => item.status === 428)).toBe(false)
    const routes = Object.values(buildSessionOperations).map((operation) => ({ operation, path: new RegExp(`^${operation.routeTemplate.replace(/\{[^}]+\}/g, '[^/?]+')}(\\?.*)?$`) }))
    for (const request of mock.requests.filter((item) => item.path.startsWith('/api/console/v1/'))) {
      const matched = routes.filter(({ operation, path }) => operation.method === request.method && path.test(request.path)).map(({ operation }) => operation)
      expect(matched.length, request.path).toBeGreaterThan(0)
      const headers = { ...(request.idempotencyKey === null ? {} : { 'Idempotency-Key': request.idempotencyKey }), ...(request.ifMatch === null ? {} : { 'If-Match': request.ifMatch }) }
      if (request.method === 'GET') expect(headers).toEqual({})
      else if (matched.some((operation) => operation.operationId === 'consoleCreateBuildSession')) expect(buildCreateHeaders.safeParse(headers).success).toBe(true)
      else expect(buildMutationHeaders.safeParse(headers).success, `${request.method} ${request.path}`).toBe(true)
    }
    const used = new Set(mock.requests.flatMap((request) => routes.filter(({ operation, path }) => operation.method === request.method && path.test(request.path)).map(({ operation }) => operation.operationId)))
    expect(used.size).toBe(12)
    expect(problems).toEqual([])
  })

  test('a missing precondition is the server answering 428 (what the client never sends)', async () => {
    const session = await ready()
    const url = new URL(`/api/console/v1/build-sessions/${session.id}/advance`, 'http://mock.test')
    const answer = await mock.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k' }, body: '{}' })
    expect(answer.status).toBe(428)
    expect(((await answer.json()) as { error: string }).error).toBe('precondition_required')
  })

  test('a stale If-Match is 412 version_conflict with the current version; a replay of the same intent precedes it', async () => {
    const session = await ready()
    const write = { key: mintIdempotencyKey(), version: session.version }
    const body = { kind: 'conversation', message: 'Rust で作れますか？', intent: 'question', baseSpecRevision: 0 } as const
    const turn = await api.createTurn(session.id, body, write)
    // The same intent resent after the version moved on: the original answer, not a conflict.
    expect((await api.createTurn(session.id, body, write)).id).toBe(turn.id)
    let error: unknown
    try { await api.createTurn(session.id, body, { key: mintIdempotencyKey(), version: session.version }) } catch (caught) { error = caught }
    expect(isVersionConflict(error)).toBe(true)
    expect((error as { details: unknown }).details).toEqual({ currentVersion: turn.sessionVersion })
    let reused: unknown
    try { await api.createTurn(session.id, { ...body, message: '別の質問' }, write) } catch (caught) { reused = caught }
    expect((reused as { code: string }).code).toBe('idempotency_conflict')
  })

  test('the turn list follows nextCursor to the end, in ordinal order', async () => {
    let session = await ready()
    for (let round = 0; round < 2; round++) {
      const turn = await api.createTurn(session.id, { kind: 'conversation', message: `質問 ${round}`, intent: 'question', baseSpecRevision: 0 }, { key: mintIdempotencyKey(), version: session.version })
      for (let step = 0; step < 3; step++) await api.getTurn(session.id, turn.id)
      session = await api.get(session.id)
    }
    const listed: string[] = []
    const all = await createBuildSessionsApi(createTestGateway({ consoleFetch: async (path, init) => {
      // A one-item page size forces the cursor walk.
      listed.push(path)
      return mock.fetch(path.replace('limit=50', 'limit=1'), init)
    } })).allTurns(session.id)
    expect(all.map((turn) => turn.ordinal)).toEqual([1, 2, 3])
    expect(listed).toHaveLength(3)
  })
})

describe('unreadable 2xx answers to writes', () => {
  const families: { name: string; method: string; path: RegExp; run: (session: Awaited<ReturnType<typeof ready>>) => Promise<unknown> }[] = [
    { name: 'create', method: 'POST', path: /\/build-sessions$/, run: () => create('別のアプリ') },
    { name: 'advance', method: 'POST', path: /\/advance$/, run: async () => { const created = await create('初期化を待つアプリ'); return api.advance(created.id, { key: intentKeys.advance(created.id, created.version), version: created.version }) } },
    { name: 'createTurn', method: 'POST', path: /\/turns$/, run: (session) => api.createTurn(session.id, { kind: 'conversation', message: '質問', intent: 'question', baseSpecRevision: 0 }, { key: mintIdempotencyKey(), version: session.version }) },
    { name: 'resolveTurn', method: 'POST', path: /\/resolution$/, run: async (session) => {
      const turn = await api.createTurn(session.id, { kind: 'conversation', message: '承認を二段階にして', intent: 'change', baseSpecRevision: 0 }, { key: mintIdempotencyKey(), version: session.version })
      for (let step = 0; step < 3; step++) await api.getTurn(session.id, turn.id)
      const current = await api.get(session.id)
      return api.resolveTurn(session.id, turn.id, { decision: 'keep_spec' }, { key: intentKeys.resolution(session.id, current.version, turn.id, 'keep_spec'), version: current.version })
    } },
    { name: 'publishPreferences', method: 'PATCH', path: /\/publish-preferences$/, run: (session) => api.setPublishPreferences(session.id, { name: '名前', shareScope: 'private' }, { key: mintIdempotencyKey(), version: session.version }) },
    { name: 'archive', method: 'POST', path: /\/archive$/, run: (session) => api.archive(session.id, { key: intentKeys.archive(session.id, session.version), version: session.version }) },
  ]
  for (const family of families) {
    test(`${family.name}: a typed write_unconfirmed failure carrying no payload`, async () => {
      const session = await ready()
      mock.rewrites.push({ method: family.method, path: family.path, once: true, body: (wire) => ({ ...wire, version: 'SENTINEL-unreadable', sessionVersion: 'SENTINEL-unreadable' }) })
      let error: unknown
      try { await family.run(session) } catch (caught) { error = caught }
      expect(isResponseContractError(error)).toBe(true)
      expect((error as ResponseContractError).outcome).toBe('write_unconfirmed')
      expect(JSON.stringify(error)).not.toContain('SENTINEL')
    })
  }
})
