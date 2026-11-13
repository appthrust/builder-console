// The create catalog queries over the production gateway; only `fetch` is in
// memory. Their answers are the evidence that creating is allowed, so a
// failure must stay a failure (never an empty list) and a malformed re-read
// must keep the last good value.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryObserver, skipToken } from '@tanstack/react-query'
import { isResponseContractError } from '../boundary'
import { domainOf } from '../testing/catalog-domain'
import { createConnectionsQuery, creationToolsQuery, githubRepositoriesQuery } from './catalog'
import { queryClient } from './shared'

const SECRET = 'SENTINEL-catalog-query-0d41'
const originalFetch = globalThis.fetch
let requests: Request[] = []
let restoreWarn: () => void = () => {}

/** Answers Platform requests with `answer`; every request is recorded. */
function answering(answer: (request: Request, path: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push(request)
    return answer(request, new URL(request.url).pathname)
  }) as typeof fetch
}

beforeEach(() => {
  requests = []
  // The boundary reports a contract failure with console.warn (safe metadata only).
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restoreWarn = () => warn.mockRestore()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  restoreWarn()
})

const json = (body: unknown, status = 200) => Response.json(body, { status })
const wireSource = {
  id: 'github-source-207cb7ce', displayName: 'Acme GitHub', account: { login: 'acme', type: 'Organization' },
  capabilities: ['createRepositories', 'readTemplateRepositories'], status: 'ready', source: 'github-source-connection-cr',
}
const wireRegistry = { id: 'ghcr-acme', displayName: 'GHCR', registryHost: 'ghcr.io', registryType: 'ghcr', status: 'ready', source: 'registry-connection-cr' }
const wireDomain = {
  id: 'pj-1.appthrust.test', projectId: 'pj-1', name: 'pj-1.appthrust.test', source: 'seed', dnsManagement: 'platform',
  configuration: { state: 'valid', expectedRecords: [] }, usableForPublish: true, deletable: false, delegationReady: true,
  publishDnsManaged: true, externalDnsManaged: true, usedBy: [],
}

function connectionsWorld(overrides: { sources?: () => Response; registries?: () => Response; domains?: () => Response } = {}) {
  answering((_request, path) => {
    if (path === '/api/v1/projects/pj-1/source-connections') return overrides.sources?.() ?? json({ data: [wireSource], meta: { total: 1 } })
    if (path === '/api/v1/registry-connections') return overrides.registries?.() ?? json({ data: [wireRegistry], meta: { total: 1 } })
    if (path === '/api/v1/projects/pj-1/domains') return overrides.domains?.() ?? json({ data: [wireDomain], meta: { total: 1, capabilities: { hostedZoneProvisioningEnabled: false } } })
    return json({ error: { code: 'not_found', message: 'unhandled' } }, 404)
  })
}

const appDefaults = () =>
  new QueryClient({ defaultOptions: { queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false } } })

test('create connections: the three lists are read through their contracts into domain values', async () => {
  connectionsWorld()
  const query = createConnectionsQuery('pj-1')
  expect([...query.queryKey]).toEqual(['create-connections', 'pj-1'])
  const value = await appDefaults().fetchQuery(query)
  expect(value).toEqual({
    sources: [{ id: 'github-source-207cb7ce', account: { login: 'acme' }, capabilities: [{ kind: 'known', value: 'createRepositories' }, { kind: 'known', value: 'readTemplateRepositories' }], status: { kind: 'known', value: 'ready' } }],
    registries: [{ id: 'ghcr-acme', registryHost: 'ghcr.io', status: { kind: 'known', value: 'ready' } }],
    domains: [{ name: 'pj-1.appthrust.test', usableForPublish: true, publishDnsManaged: true, source: { kind: 'known', value: 'seed' } }],
  })
  expect(requests.map((request) => new URL(request.url).pathname).sort()).toEqual(['/api/v1/projects/pj-1/domains', '/api/v1/projects/pj-1/source-connections', '/api/v1/registry-connections'])
})

test('create connections: a pending publish domain keeps polling; anything else does not', () => {
  const interval = createConnectionsQuery('pj-1').refetchInterval as unknown as (query: unknown) => number | false
  const pending = { ...wireDomain, usableForPublish: false, delegationReady: false, publishUnavailableReason: 'ProjectGatewayPending' }
  const intervalFor = (domains: unknown[]) => interval({ state: { data: { sources: [], registries: [], domains: domains.map(domainOf) } } })
  expect(intervalFor([pending])).toBe(10_000)
  expect(intervalFor([{ ...pending, publishUnavailableReason: 'PublishRuntimeCapabilityPending' }])).toBe(10_000)
  expect(intervalFor([{ ...pending, publishUnavailableReason: 'PublishUnsupportedByRuntime' }])).toBe(false)
  expect(intervalFor([{ ...pending, publishUnavailableReason: undefined }])).toBe(false)
  expect(intervalFor([{ ...pending, source: 'projectHostname' }])).toBe(false)
  expect(intervalFor([])).toBe(false)
  expect(intervalFor([pending, wireDomain])).toBe(false)
  expect(intervalFor([wireDomain])).toBe(false)
  expect(interval({ state: { data: undefined } })).toBe(false)
})

test('create connections: one unreadable list fails the whole read, never an empty connection list; nothing is retried', async () => {
  for (const broken of [
    { sources: () => json({ data: [{ ...wireSource, status: 7 }] }) },
    { sources: () => json({ data: null }) },
    { registries: () => json({ meta: { total: 0 } }) },
    { domains: () => json({ data: [{ ...wireDomain, usableForPublish: SECRET }] }) },
  ]) {
    requests = []
    connectionsWorld(broken)
    const error = await appDefaults().fetchQuery(createConnectionsQuery('pj-1')).catch((caught: unknown) => caught)
    expect(isResponseContractError(error)).toBe(true)
    expect(JSON.stringify(error)).not.toContain(SECRET)
    expect(String(error)).not.toContain(SECRET)
    expect(requests).toHaveLength(3)
  }
})

test('create connections: an unknown provider state or capability is kept as unknown, not dropped and not ready', async () => {
  connectionsWorld({ sources: () => json({ data: [{ ...wireSource, status: SECRET, capabilities: ['createRepositories', SECRET] }] }) })
  const value = await appDefaults().fetchQuery(createConnectionsQuery('pj-1'))
  expect(value.sources[0]?.status).toEqual({ kind: 'unknown' })
  expect(value.sources[0]?.capabilities).toEqual([{ kind: 'known', value: 'createRepositories' }, { kind: 'unknown' }])
  expect(JSON.stringify(value)).not.toContain(SECRET)
})

test('create connections: good → malformed re-read → recovery keeps the same data and read time, then takes the new one (X3)', async () => {
  let answer: 'good' | 'malformed' | 'second' = 'good'
  connectionsWorld({
    registries: () => answer === 'malformed'
      ? json({ data: [{ ...wireRegistry, registryHost: 7 }] })
      : json({ data: [answer === 'second' ? { ...wireRegistry, id: 'ghcr-second' } : wireRegistry] }),
  })
  const client = appDefaults()
  const observer = new QueryObserver(client, { ...createConnectionsQuery('pj-1'), refetchInterval: false })
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()
  const first = observer.getCurrentResult()
  expect(first.data?.registries[0]?.id).toBe('ghcr-acme')

  answer = 'malformed'
  await observer.refetch()
  const stale = observer.getCurrentResult()
  expect(stale.data).toBe(first.data)
  expect(stale.dataUpdatedAt).toBe(first.dataUpdatedAt)
  expect(isResponseContractError(stale.error)).toBe(true)
  expect(stale.isRefetchError).toBe(true)

  answer = 'second'
  await observer.refetch()
  const recovered = observer.getCurrentResult()
  expect(recovered.error).toBeNull()
  expect(recovered.data?.registries[0]?.id).toBe('ghcr-second')
  expect(recovered.dataUpdatedAt).toBeGreaterThanOrEqual(first.dataUpdatedAt)
  unsubscribe()
  client.clear()
})

test('github repositories: the search term is trimmed and only sent when present; no connection means no request', async () => {
  answering(() => json({ data: [{ fullName: 'acme/claude-mitsumori', defaultBranch: 'main', private: true }] }))
  const client = new QueryClient()
  const searched = githubRepositoriesQuery('pj-1', 'github-source-207cb7ce', ' mitsu ')
  expect([...searched.queryKey]).toEqual(['github-repositories', 'pj-1', 'github-source-207cb7ce', 'mitsu'])
  expect((await client.fetchQuery(searched)).data[0]?.fullName).toBe('acme/claude-mitsumori')
  await client.fetchQuery(githubRepositoriesQuery('pj-1', 'github-source-207cb7ce', ''))
  expect(requests.map((request) => `${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual([
    '/api/v1/projects/pj-1/source-connections/github-source-207cb7ce/repositories?q=mitsu',
    '/api/v1/projects/pj-1/source-connections/github-source-207cb7ce/repositories',
  ])
  expect(githubRepositoriesQuery('pj-1', undefined, 'x').queryFn).toBe(skipToken)
  client.clear()
})

const envoyNoUpstream = () => new Response('upstream connect error or disconnect/reset before headers', { status: 503, headers: { 'Content-Type': 'text/plain' } })

/** Platform answers in order (the last one repeats). */
function answersInOrder(responses: Array<() => Response>) {
  answering(() => (responses.length > 1 ? responses.shift()! : responses[0]!)())
}

test('creation tools: two Envoy 503s during a rollout stay pending, then resolve; no error state is ever exposed', async () => {
  answersInOrder([envoyNoUpstream, envoyNoUpstream, () => json({ version: 1, codexAvailable: true })])
  const client = appDefaults()
  const observer = new QueryObserver(client, creationToolsQuery('pj-1'))
  const seen: Array<{ status: string; isError: boolean }> = []
  const settled = Promise.withResolvers<void>()
  const unsubscribe = observer.subscribe((result) => {
    seen.push({ status: result.status, isError: result.isError })
    if (result.status !== 'pending') settled.resolve()
  })
  await settled.promise
  unsubscribe()
  expect(observer.getCurrentResult().data?.codexAvailable).toBe(true)
  expect(requests).toHaveLength(3)
  expect(seen.some((state) => state.isError || state.status === 'error')).toBe(false)
  expect(seen.at(-1)?.status).toBe('success')
  client.clear()
})

test('creation tools: a 404 and a coded 400 are answers, not retried', async () => {
  const client = appDefaults()
  answersInOrder([() => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })])
  await expect(client.fetchQuery(creationToolsQuery('pj-1'))).rejects.toMatchObject({ status: 404 })
  expect(requests).toHaveLength(1)
  requests = []
  answersInOrder([() => json({ error: { code: 'invalid_argument', message: 'bad project' } }, 400)])
  await expect(client.fetchQuery(creationToolsQuery('pj-2'))).rejects.toMatchObject({ status: 400 })
  expect(requests).toHaveLength(1)
  client.clear()
})

test('creation tools: a rollout longer than the transient retries surfaces after 1 + 3 attempts', async () => {
  answersInOrder([envoyNoUpstream])
  const client = appDefaults()
  await expect(client.fetchQuery(creationToolsQuery('pj-1'))).rejects.toMatchObject({ status: 503 })
  expect(requests).toHaveLength(4)
  client.clear()
})

test('creation tools: a malformed answer is a contract failure, read once, never "available"', async () => {
  answersInOrder([() => json({ version: 1, codexAvailable: SECRET })])
  const client = appDefaults()
  const error = await client.fetchQuery(creationToolsQuery('pj-1')).catch((caught: unknown) => caught)
  expect(isResponseContractError(error)).toBe(true)
  expect(requests).toHaveLength(1)
  client.clear()
})

test('creation tools: a reason this console does not know is not kept; codexAvailable alone gates', async () => {
  answersInOrder([() => json({ version: 1, codexAvailable: false, codexUnavailableReason: SECRET, codexPolicy: 'strict' })])
  const value = await appDefaults().fetchQuery(creationToolsQuery('pj-1'))
  expect(value).toEqual({ codexAvailable: false, codexPolicy: 'strict' })
})
