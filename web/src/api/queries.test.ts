import { afterEach, expect, mock, test } from 'bun:test'
import { platformApiRouter } from '@appthrust/api-schema/platform-api-router'
import { createORPCClient, ORPCError } from '@orpc/client'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import { QueryClient, skipToken } from '@tanstack/react-query'
import type { PlatformApiClient } from './client'
import { ResponseContractError } from './boundary'
import { ConsoleApiError } from './console'
import { appQuery, consoleConfigQuery, projectIdQuery, resolveQuery } from './queries/console'
import { componentLogsQuery } from './queries/app'
import { dataPreconditionReason, isDataForbidden, membershipUnboundReason } from './queries/data'
import { readRetryDelay, retryDelay, retryQuery, retryReadQuery } from './queries/shared'

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
  await expect(client.fetchQuery(projectIdQuery())).rejects.toMatchObject({ status: 404, code: 'not_found' })
  expect(fetch).toHaveBeenCalledTimes(1)
  client.clear()
})

test.each([[{}, 'missing'], [{ projectId: '' }, 'invalid_value'], [{ projectId: 'wrong/project' }, 'invalid_value'], [{ projectId: 12 }, 'invalid_type']] as const)(
  'invalid config fails closed: %j', async (config, code) => {
    globalThis.fetch = mock(async () => Response.json(config)) as unknown as typeof fetch
    const error = await projectIdQuery().queryFn().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ResponseContractError)
    expect(error).toMatchObject({ operationId: 'consoleGetConfig', issues: [{ path: '/projectId', code }] })
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
