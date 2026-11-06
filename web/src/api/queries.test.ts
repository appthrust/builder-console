import { afterEach, expect, mock, test } from 'bun:test'
import type { Domain, GitHubSourceConnection } from '@appthrust/api-schema/platform-api'
import { platformApiRouter } from '@appthrust/api-schema/platform-api-router'
import { createORPCClient, ORPCError } from '@orpc/client'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import { QueryClient, QueryObserver, skipToken } from '@tanstack/react-query'
import type { PlatformApiClient } from './client'
import { ConsoleApiError } from './console'
import {
  appQuery,
  componentLogsQuery,
  consoleConfigQuery,
  createConnectionsQuery,
  creationToolsQuery,
  dataPreconditionReason,
  githubRepositoriesQuery,
  isDataForbidden,
  membershipUnboundReason,
  projectIdQuery,
  queryClient,
  readRetryDelay,
  resolveQuery,
  retryDelay,
  retryQuery,
  retryReadQuery,
} from './queries'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('loads the installed project from local config once, never from the project list', async () => {
  const requests: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    requests.push(String(input))
    return Response.json({ projectId: 'pj-eee7fa8eabbc' })
  }) as unknown as typeof fetch
  const client = new QueryClient()
  const query = projectIdQuery()
  const first: string = await client.fetchQuery<string>(query)
  const second: string = await client.fetchQuery<string>(query)
  expect(first).toBe('pj-eee7fa8eabbc')
  expect(second).toBe('pj-eee7fa8eabbc')
  expect(requests).toEqual(['/config'])
  client.clear()
})

test('a configured dev override avoids config and project-list requests', async () => {
  const fetch = mock(async () => { throw new Error('unexpected request') })
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  expect(await projectIdQuery('commerce').queryFn()).toBe('commerce')
  expect(fetch).not.toHaveBeenCalled()
})

test('config failure fails closed without retries or another project', async () => {
  const fetch = mock(async () => new Response('not found', { status: 404 }))
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: 3 } } })
  await expect(client.fetchQuery(projectIdQuery())).rejects.toThrow('Console config request failed (404)')
  expect(fetch).toHaveBeenCalledTimes(1)
  client.clear()
})

test.each([{}, { projectId: '' }, { projectId: 'wrong/project' }, { projectId: 12 }])(
  'invalid config fails closed: %j', async (config) => {
    globalThis.fetch = mock(async () => Response.json(config)) as unknown as typeof fetch
    await expect(projectIdQuery().queryFn()).rejects.toThrow('Console config contains an invalid projectId')
  }
)

test.each([
  [{ projectId: 'pj-1', dashboardUrl: 'https://dashboard.example.test/dashboard/settings' }, { projectId: 'pj-1', dashboardUrl: 'https://dashboard.example.test/dashboard/settings' }],
  [{ projectId: 'pj-1' }, { projectId: 'pj-1' }],
  [{ projectId: 'pj-1', dashboardUrl: 'javascript:alert(1)' }, { projectId: 'pj-1' }],
  [{ projectId: 'pj-1', dashboardUrl: '/dashboard/settings' }, { projectId: 'pj-1' }],
  [{ projectId: 'pj-1', dashboardUrl: 7 }, { projectId: 'pj-1' }],
])('console config keeps only an absolute http(s) Dashboard URL: %j', async (config, expected) => {
  globalThis.fetch = mock(async () => Response.json(config)) as unknown as typeof fetch
  const client = new QueryClient()
  expect(await client.fetchQuery(consoleConfigQuery)).toEqual(expected)
  client.clear()
})

const platformError = (status: number, details: Record<string, unknown>) =>
  new ORPCError('UNKNOWN', { status, data: { body: { error: { code: status === 412 ? 'failed_precondition' : 'forbidden', message: 'refused', details } } } })

test('a 412 database_access_membership_unbound is a data precondition with its membership reason, not a 403', () => {
  for (const membershipReason of ['SubjectUnbound', 'NotPersisted'] as const) {
    const error = platformError(412, { reason: 'database_access_membership_unbound', membershipReason, teamId: 'tm-1' })
    expect(dataPreconditionReason(error)).toBe('database_access_membership_unbound')
    expect(membershipUnboundReason(error)).toBe(membershipReason)
    expect(isDataForbidden(error)).toBe(false)
  }
  expect(membershipUnboundReason(platformError(412, { reason: 'database_access_membership_unbound', membershipReason: 'Other' }))).toBeUndefined()
  expect(membershipUnboundReason(platformError(412, { reason: 'database_suspended', membershipReason: 'SubjectUnbound' }))).toBeUndefined()
  const forbidden = platformError(403, { reason: 'database_access_membership_unbound', membershipReason: 'SubjectUnbound' })
  expect(dataPreconditionReason(forbidden)).toBeUndefined()
  expect(membershipUnboundReason(forbidden)).toBeUndefined()
  expect(isDataForbidden(forbidden)).toBe(true)
})

test('create connections: source connections are validated at the boundary, registries and domains pass through', async () => {
  const ready: GitHubSourceConnection = {
    id: 'github-source-207cb7ce',
    displayName: 'Acme',
    account: { login: 'acme', type: 'Organization' },
    capabilities: ['createRepositories'],
    status: 'ready',
    source: 'github-source-connection-cr',
  }
  const registry = {
    id: 'ghcr-acme',
    displayName: 'GHCR',
    registryHost: 'ghcr.io',
    registryType: 'ghcr',
    status: 'ready',
    source: 'registry-connection-cr',
  } as const
  const domain = {
    id: 'pj-1.appthrust.test',
    projectId: 'pj-1',
    name: 'pj-1.appthrust.test',
    source: 'seed',
    dnsManagement: 'platform',
    configuration: { state: 'valid', expectedRecords: [] as Domain['configuration']['expectedRecords'] },
    usableForPublish: true,
    deletable: false,
    delegationReady: true,
    publishDnsManaged: true,
    externalDnsManaged: true,
    usedBy: [] as Domain['usedBy'],
  } as const
  const calls: string[] = []
  const api = {
    platformApiListProjectGitHubSourceConnections: mock(async (input: { projectId: string }) => {
      calls.push(`sources:${input.projectId}`)
      return { data: [ready] }
    }),
    platformApiListRegistryConnections: mock(async () => {
      calls.push('registries')
      return { data: [registry] }
    }),
    platformApiListDomains: mock(async (input: { projectId: string }) => {
      calls.push(`domains:${input.projectId}`)
      return { data: [domain] }
    }),
  }
  const query = createConnectionsQuery('pj-1', api as never)
  expect(query.queryKey).toEqual(['create-connections', 'pj-1'])
  expect(await query.queryFn()).toEqual({ sources: [ready], registries: [registry], domains: [domain] })
  expect(calls.sort()).toEqual(['domains:pj-1', 'registries', 'sources:pj-1'])

  const pending = { ...domain, usableForPublish: false, delegationReady: false, publishUnavailableReason: 'ProjectGatewayPending' }
  const interval = query.refetchInterval as unknown as (query: unknown) => number | false
  expect(typeof interval).toBe('function')
  const intervalFor = (domains: unknown[]) => interval({ state: { data: { sources: [ready], registries: [registry], domains } } })
  expect(intervalFor([pending])).toBe(10_000)
  expect(intervalFor([{ ...pending, publishUnavailableReason: 'PublishRuntimeCapabilityPending' }])).toBe(10_000)
  expect(intervalFor([{ ...pending, publishUnavailableReason: 'PublishUnsupportedByRuntime' }])).toBe(false)
  expect(intervalFor([{ ...pending, publishUnavailableReason: undefined }])).toBe(false)
  expect(intervalFor([{ ...pending, source: 'projectHostname' }])).toBe(false)
  expect(intervalFor([])).toBe(false)
  expect(intervalFor([pending, domain])).toBe(false)
  expect(intervalFor([domain])).toBe(false)
  expect(interval({ state: { data: undefined } })).toBe(false)

  api.platformApiListProjectGitHubSourceConnections = mock(async () => ({ data: [{ ...ready, status: 'weird' } as unknown as GitHubSourceConnection] }))
  await expect(createConnectionsQuery('pj-1', api as never).queryFn()).rejects.toThrow()
})

test('github repositories: the search term is trimmed and only sent when present; no connection means no request', async () => {
  const inputs: unknown[] = []
  const api = {
    platformApiListGitHubSourceConnectionRepositories: mock(async (input: unknown) => {
      inputs.push(input)
      return { data: [{ fullName: 'acme/claude-mitsumori', defaultBranch: 'main', private: true }] }
    }),
  }
  const client = new QueryClient()
  const searched = githubRepositoriesQuery('pj-1', 'github-source-207cb7ce', ' mitsu ', api as never)
  expect([...searched.queryKey]).toEqual(['github-repositories', 'pj-1', 'github-source-207cb7ce', 'mitsu'])
  expect((await client.fetchQuery(searched)).data[0]?.fullName).toBe('acme/claude-mitsumori')
  await client.fetchQuery(githubRepositoriesQuery('pj-1', 'github-source-207cb7ce', '', api as never))
  expect(inputs).toEqual([
    { projectId: 'pj-1', id: 'github-source-207cb7ce', q: 'mitsu' },
    { projectId: 'pj-1', id: 'github-source-207cb7ce' },
  ])
  expect(githubRepositoriesQuery('pj-1', undefined, 'x', api as never).queryFn).toBe(skipToken)
  client.clear()
})

test('logs send branchId and isolate cached results between branches', async () => {
  const requests: URL[] = []
  const link = new OpenAPILink(platformApiRouter, {
    url: 'http://platform.test',
    fetch: async (request) => {
      requests.push(new URL(request.url))
      return Response.json({
        clusterId: 'wlc-1', namespace: 'pj-1', service: 'web',
        pods: [], containers: [], lines: [], message: 'No workload pods are running yet.',
        fetchedAt: '2026-10-08T00:00:00Z',
      })
    },
  })
  const api = createORPCClient<PlatformApiClient>(link)
  const cache = new QueryClient()
  const production = componentLogsQuery('pj-1', 'web', 'production', api)
  const staging = componentLogsQuery('pj-1', 'web', 'staging', api)
  expect(production.queryKey).not.toEqual(staging.queryKey)
  await cache.fetchQuery(production)
  await cache.fetchQuery(staging)
  expect(requests.map((url) => url.pathname)).toEqual([
    '/api/v1/projects/pj-1/components/web/logs',
    '/api/v1/projects/pj-1/components/web/logs',
  ])
  expect(requests.map((url) => url.searchParams.get('branchId'))).toEqual(['production', 'staging'])
  expect(requests.map((url) => url.searchParams.get('tailLines'))).toEqual(['100', '100'])
  expect(componentLogsQuery('pj-1', undefined, undefined, api).queryFn).toBe(skipToken)
  cache.clear()
})

const envoyNoUpstream = () =>
  new Response('upstream connect error or disconnect/reset before headers', { status: 503, headers: { 'Content-Type': 'text/plain' } })

/** A Platform API client on the real contract and link answering `responses` in order (the last one repeats). */
function platformAnswering(responses: Array<() => Response>) {
  const fetch = mock(async () => (responses.length > 1 ? responses.shift()! : responses[0]!)())
  const link = new OpenAPILink(platformApiRouter, { url: 'http://platform.test', fetch: () => fetch() })
  return { api: createORPCClient<PlatformApiClient>(link), fetch }
}

/** The app's query defaults (retry policy included) without the backoff wait. */
const appDefaults = () =>
  new QueryClient({ defaultOptions: { queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false } } })

test('creation tools: two Envoy 503s during a rollout stay pending, then resolve; no error state is ever exposed', async () => {
  const { api, fetch } = platformAnswering([envoyNoUpstream, envoyNoUpstream, () => Response.json({ version: 1, codexAvailable: true })])
  const client = appDefaults()
  const observer = new QueryObserver(client, creationToolsQuery('pj-1', api))
  const seen: Array<{ status: string; isError: boolean }> = []
  const settled = new Promise<void>((resolve) => {
    const unsubscribe = observer.subscribe((result) => {
      seen.push({ status: result.status, isError: result.isError })
      if (result.status !== 'pending') {
        unsubscribe()
        resolve()
      }
    })
  })
  await settled
  expect(observer.getCurrentResult().data?.codexAvailable).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(seen.some((state) => state.isError || state.status === 'error')).toBe(false)
  expect(seen.at(-1)?.status).toBe('success')
  client.clear()
})

test('creation tools: a 404 and a coded 400 are answers, not retried', async () => {
  const notFound = platformAnswering([() => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })])
  const client = appDefaults()
  await expect(client.fetchQuery(creationToolsQuery('pj-1', notFound.api))).rejects.toMatchObject({ status: 404 })
  expect(notFound.fetch).toHaveBeenCalledTimes(1)

  const invalid = platformAnswering([() => Response.json({ error: { code: 'invalid_argument', message: 'bad project' } }, { status: 400 })])
  await expect(client.fetchQuery(creationToolsQuery('pj-2', invalid.api))).rejects.toMatchObject({ status: 400 })
  expect(invalid.fetch).toHaveBeenCalledTimes(1)
  client.clear()
})

test('creation tools: a rollout longer than the transient retries surfaces after 1 + 3 attempts', async () => {
  const { api, fetch } = platformAnswering([envoyNoUpstream])
  const client = appDefaults()
  await expect(client.fetchQuery(creationToolsQuery('pj-1', api))).rejects.toMatchObject({ status: 503 })
  expect(fetch).toHaveBeenCalledTimes(4)
  client.clear()
})

test('retry policy: transient → 3 retries; 4xx → none; any other failure keeps the single generic retry', () => {
  const transient = new ConsoleApiError(503, undefined)
  expect([0, 1, 2, 3].map((count) => retryQuery(count, transient))).toEqual([true, true, true, false])
  expect(retryQuery(0, new ConsoleApiError(404, undefined))).toBe(false)
  expect(retryQuery(0, new ConsoleApiError(400, { error: 'invalid_slug', message: 'bad' }))).toBe(false)
  const coded5xx = new ConsoleApiError(502, { error: 'upstream_unavailable', message: 'down' })
  expect([retryQuery(0, coded5xx), retryQuery(1, coded5xx)]).toEqual([true, false])
  expect([0, 1, 2, 3, 4].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 8000])
})

test('resolve: a coded answer is final, a call nothing answered gets the transient retries', () => {
  const retry = resolveQuery('/sales').retry as (count: number, error: unknown) => boolean
  expect(retry(0, new ConsoleApiError(404, undefined))).toBe(false)
  expect(retry(0, new ConsoleApiError(502, { error: 'upstream_unavailable', message: 'down' }))).toBe(false)
  expect([0, 2, 3].map((count) => retry(count, new ConsoleApiError(0, undefined)))).toEqual([true, true, false])
})

test.each([500, 502, 503, 504])('draft/app read policy retries HTTP %i five times, including coded errors', (status) => {
  const errors = [
    new ORPCError('UPSTREAM_ERROR', { status }),
    new ORPCError('UPSTREAM_ERROR', { status, data: { body: { error: { code: 'internal_error', message: 'request canceled' } } } }),
    new ConsoleApiError(status, undefined),
    new ConsoleApiError(status, { error: 'upstream_unavailable', message: 'request canceled' }),
  ]
  for (const error of errors) {
    expect([0, 1, 2, 3, 4, 5, 6].map((count) => retryReadQuery(count, error))).toEqual([true, true, true, true, true, false, false])
  }
})

test('draft/app read policy never retries any HTTP 4xx, even with network-like text', () => {
  for (let status = 400; status < 500; status++) {
    expect(retryReadQuery(0, new ORPCError('CLIENT_ERROR', { status, message: 'Failed to fetch' }))).toBe(false)
    expect(retryReadQuery(0, new ConsoleApiError(status, { error: 'client_error', message: 'Failed to fetch' }))).toBe(false)
  }
})

test.each([
  new ConsoleApiError(0, undefined),
  new TypeError('Failed to fetch'),
  new TypeError('NetworkError when attempting to fetch resource.'),
  new TypeError('Load failed'),
  new DOMException('The operation timed out.', 'TimeoutError'),
])('draft/app read policy retries network failures and read timeouts five times: %s', (error) => {
  expect([0, 1, 2, 3, 4, 5].map((count) => retryReadQuery(count, error))).toEqual([true, true, true, true, true, false])
})

test.each([
  new ConsoleApiError(501, undefined),
  new ORPCError('NOT_IMPLEMENTED', { status: 501 }),
  new TypeError("Cannot read properties of undefined (reading 'data')"),
  new DOMException('The operation was aborted.', 'AbortError'),
  new Error('Invalid response'),
  undefined,
])('draft/app read policy does not retry unrelated errors: %s', (error) => {
  expect(retryReadQuery(0, error)).toBe(false)
})

test('draft/app read backoff starts at three seconds, doubles and caps at thirty seconds', () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(readRetryDelay)).toEqual([3000, 6000, 12000, 24000, 30000, 30000, 30000])
  expect(appQuery('app-1').retry).toBe(retryReadQuery)
  expect(appQuery('app-1').retryDelay).toBe(readRetryDelay)
})
