import { expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { QueryClient } from '@tanstack/react-query'
import { openAPIDocument } from './schema/generate'
import { operations } from './schema/operations'
import { schemas } from './schema/schemas'
import { createConsoleApi } from '../../console-unverified'
import { createConsoleTransport, isConsoleError, type ConsoleRequest } from '../../console'
import { createApiGateway } from '../../gateway'
import { decodeResponse, isResponseContractError, type ResponseContract } from '../../boundary'
import { isSessionExpiredError } from '../../session-expiry'
import { retryReadQuery } from '../../queries/shared'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import { createPlatformTransport } from '../../client'
import { consoleContracts, createAppContract, uploadScreenshotContract } from './operations'
import type { ConsoleOperationContract } from '../define'

interface Fixture { name: string; schema: keyof typeof schemas; body: unknown }
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL('../../../../../cmd/server/internal/api/testdata/console-wire.json', import.meta.url), 'utf8'))
const SECRET = 'SENTINEL-console-contract-43f6'
const platformTransport = createPlatformTransport({ origin: () => 'https://console.test', fetch: async () => { throw new Error('Unexpected Platform request') } })
function fixture(schema: keyof typeof schemas): unknown {
  const found = fixtures.find((item) => item.schema === schema)
  if (!found) throw new Error(`No Go writer fixture for ${schema}`)
  return found.body
}

// Public HTTP contract, not source text: changing the generator without its
// embedded artifact fails here; Go validates the same document independently.
test('OpenAPI is generated from the canonical Zod schema', () => {
  const document = JSON.parse(readFileSync(new URL('../../../../../cmd/server/internal/api/console-spa.openapi.json', import.meta.url), 'utf8'))
  expect(document).toEqual(openAPIDocument())
  expect(document.paths['/apps'].get.operationId).toBe('listApps')
  expect(document.paths['/apps/{id}'].get.operationId).toBe('getApp')
})

for (const [key, operation] of Object.entries(operations)) {
  const contract: ResponseContract<unknown> = consoleContracts[key as keyof typeof consoleContracts]
  test(`${operation.operationId}: writer fixture, field policy, status and failure variants`, async () => {
    expect(contract.operationId).toBe(operation.operationId)
    expect(contract.successStatuses).toEqual(operation.successStatuses)
    expect(contract.fieldPolicies).toEqual([]) // No undocumented absent/null compatibility defaults.
    if (!operation.schema) {
      expect(contract.body).toBe('empty')
      expect(contract.successStatuses).toEqual([204])
      return
    }
    const cases = fixtures.filter((item) => item.schema === operation.schema)
    expect(cases.length).toBeGreaterThan(0)
    for (const item of cases) {
      expect(schemas[operation.schema].safeParse(item.body).success).toBe(true)
      assertWireContractCases(contract, [
        { name: item.name, path: '/', variant: 'present', wire: item.body, expect: { accept: true } },
        { name: 'null body', path: '/', variant: 'null', wire: null, expect: { accept: false } },
        { name: 'missing body', path: '/', variant: 'absent', wire: undefined, expect: { accept: false } },
        { name: 'wrong type', path: '/', variant: 'unknown', wire: SECRET, expect: { accept: false } },
      ])
      if (item.body && typeof item.body === 'object' && !Array.isArray(item.body)) {
        expect(decodeResponse(contract, { ...item.body, [SECRET]: SECRET })).toEqual(decodeResponse(contract, item.body))
      }
    }
  })
}

test('all SPA facade operations have a registered HTTP success contract', async () => {
  const seen: ConsoleRequest[] = []
  const api = createConsoleApi({ send: async (request) => {
    seen.push(request)
    // This test observes requests only; responses are never used as domain evidence.
    return { status: 200, body: { kind: 'json', value: { items: [] } } }
  } })
  const args: Record<string, unknown[]> = {
    resolve: ['/group/app'], 'apps.list': [{}], 'apps.byPath': ['group', 'app'],
    'apps.create': [{ displayName: 'App', groupId: 'group' }], 'apps.bind': ['app', { stackId: 'stack', appName: 'app' }],
    'apps.remove': ['app'], 'apps.directory': [{}], 'apps.directoryEntry': ['app'], 'apps.tools': ['app'],
    'directory.searchPeople': ['person'], 'directory.personBySubject': ['subject'], 'directory.people': [['person']],
    'directory.person': ['person'], 'directory.createPerson': [{ email: 'person@example.test', displayName: 'Person' }],
    'directory.members': ['group'], 'directory.users': ['person'],
    'screenshots.upload': ['app', new File(['bytes'], 'screen.png')], 'screenshots.remove': ['app', 'shot'], 'screenshots.reorder': ['app', []],
    'admin.directoryMigrate': [],
  }
  const invoked: string[] = []
  async function visit(object: object, prefix = '') {
    for (const [key, value] of Object.entries(object)) {
      const name = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'function') {
        expect(args[name], `new SPA operation needs an inventory fixture: ${name}`).toBeDefined()
        await value(...args[name]!)
        invoked.push(name)
      } else await visit(value, name)
    }
  }
  await visit(api)
  expect(invoked.sort()).toEqual(Object.keys(args).sort())
  // Already-migrated callers are exercised through their real query functions
  // in bootstrap.test; add their transport requests to the same inventory.
  for (const contract of [consoleContracts.me, consoleContracts.config, consoleContracts.groups]) seen.push(contract.request(undefined))
  seen.push(consoleContracts.comments.request('app'), consoleContracts.postComment.request({ appId: 'app', body: 'Hi' }), consoleContracts.removeComment.request({ appId: 'app', commentId: 'comment' }))
  // Operations whose facade calls are gone: the SPA sends their contract requests.
  seen.push(
    consoleContracts.app.request('app'), consoleContracts.updateApp.request({ appId: 'app', input: {} }),
    consoleContracts.myAccessRequest.request('app'), consoleContracts.createAccessRequest.request({ appName: 'app', message: '' }),
    consoleContracts.pendingAccessRequests.request(undefined), consoleContracts.appAccessRequests.request('app'),
    consoleContracts.approveAccessRequest.request({ appId: 'app', requestId: 'request' }), consoleContracts.declineAccessRequest.request({ appId: 'app', requestId: 'request' }),
    consoleContracts.settings.request(undefined),
  )
  const matched = new Set<string>()
  for (const request of seen) {
    const url = new URL(request.path, 'https://console.test')
    const found = Object.values(operations).filter((operation) => {
      if (request.method !== operation.method) return false
      if (operation === operations.apps && url.searchParams.get('scope') === 'directory') return false
      if (operation === operations.directoryApps && url.searchParams.get('scope') !== 'directory') return false
      return new RegExp(`^${operation.routeTemplate.replace(/\{path\}/g, '.+').replace(/\{[^}]+\}/g, '[^/]+')}$`).test(url.pathname)
    })
    expect(found.length, `${request.method} ${url.pathname}`).toBe(1)
    matched.add(found[0]!.operationId)
  }
  expect([...matched].sort()).toEqual(Object.values(operations).map((operation) => operation.operationId).sort())
})

test('Person variants retain identity without inventing contact or granting owner capabilities', () => {
  const app = fixture('App') as Record<string, unknown>
  const parsed = decodeResponse(consoleContracts.app, app)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return
  expect(parsed.value.owners[1]).toEqual({ unknown: true, id: 'removed' })
  expect(parsed.value.share.scope).toEqual({ kind: 'known', value: 'private' })
  assertWireContractCases(consoleContracts.app, [
    { name: 'unknown share scope is not public', path: '/share/scope', variant: 'unknown', wire: { ...app, share: { scope: SECRET, groupIds: [], extraPersonIds: [] } }, expect: { accept: true, check: (value) => expect(value.share.scope).toEqual({ kind: 'unknown' }) } },
    { name: 'known person missing email', path: '/owners/*/email', variant: 'absent', wire: { ...app, owners: [{ id: 'person', subject: null, pending: true, displayName: '', avatarVersion: null }] }, expect: { accept: false } },
    { name: 'missing owners', path: '/owners', variant: 'absent', wire: { ...app, owners: undefined }, expect: { accept: false } },
    { name: 'null owners', path: '/owners', variant: 'null', wire: { ...app, owners: null }, expect: { accept: false } },
    { name: 'empty owners', path: '/owners', variant: 'empty', wire: { ...app, owners: [] }, expect: { accept: true } },
  ])
})

test('unknown variants remain unsupported; broken known variants do not escape validation', () => {
  assertWireContractCases(consoleContracts.createAccessRequest, [
    { name: 'new state', variant: 'unknown', path: '/state', wire: { state: SECRET, secret: SECRET }, expect: { accept: true, value: { kind: 'unsupported', identity: {} } } },
    { name: 'pending requires receipt time', variant: 'absent', path: '/requestedAt', wire: { state: 'pending' }, expect: { accept: false } },
    { name: 'null state', variant: 'null', path: '/state', wire: { state: null }, expect: { accept: false } },
  ])
  assertWireContractCases(consoleContracts.resolve, [
    { name: 'new destination', variant: 'unknown', path: '/kind', wire: { kind: SECRET, id: 'resource', currentPath: '/resource', [SECRET]: SECRET }, expect: { accept: true, value: { kind: 'unsupported', identity: { id: 'resource', currentPath: '/resource' } } } },
    { name: 'known app without id', variant: 'absent', path: '/id', wire: { kind: 'app', currentPath: '/resource' }, expect: { accept: false } },
  ])
})

test('every write rejects malformed success before side effects and never resends (including multipart)', async () => {
  for (const contract of Object.values(consoleContracts).filter((value) => value.method !== 'GET' && value.body !== 'empty')) {
    const send = mock(async () => ({ status: contract.successStatuses[0]!, body: { kind: 'json' as const, value: { [SECRET]: SECRET } } }))
    const reports: unknown[] = []
    const gateway = createApiGateway({ platformTransport, consoleTransport: { send }, reportFailure: (report) => { reports.push(report) } })
    // The response side is uniform; the request seam is exercised separately by
    // the inventory and the multipart test below, not by casts to domain values.
    const responseContract: ConsoleOperationContract<undefined, unknown> = { ...contract, request: () => ({ method: contract.method, path: contract.routeTemplate }) }
    const success = mock(() => {})
    const failure = await gateway.console(responseContract, undefined).then(success).catch((error: unknown) => error)
    expect(isResponseContractError(failure)).toBe(true)
    expect(failure).toMatchObject({ outcome: 'write_unconfirmed', retryable: false })
    expect(isSessionExpiredError(failure)).toBe(false)
    expect(isConsoleError(failure)).toBe(false)
    expect(success).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify([failure, reports])).not.toContain(SECRET)
  }
  const request = uploadScreenshotContract.request({ appId: 'app', file: new File(['bytes'], 'screenshot.png'), caption: 'Screen' })
  expect(request.body).toBeInstanceOf(FormData)
  expect((request.body as FormData).get('caption')).toBe('Screen')
})

test('all contracts enforce successful status and JSON/204 body semantics through the transport', async () => {
  for (const contract of Object.values(consoleContracts)) {
    for (const status of [202, 204]) {
      if (contract.successStatuses.includes(status)) continue
      const gateway = createApiGateway({ platformTransport, consoleTransport: createConsoleTransport(async () => new Response(null, { status })), reportFailure: () => {} })
      const responseContract: ConsoleOperationContract<undefined, unknown> = { ...contract, request: () => ({ method: contract.method, path: contract.routeTemplate }) }
      await expect(gateway.console(responseContract, undefined)).rejects.toMatchObject({ code: 'response_contract_invalid' })
    }
    if (contract.body === 'json') {
      const gateway = createApiGateway({ platformTransport, consoleTransport: createConsoleTransport(async () => new Response('{', { status: contract.successStatuses[0], headers: { 'Content-Type': 'application/json' } })), reportFailure: () => {} })
      const responseContract: ConsoleOperationContract<undefined, unknown> = { ...contract, request: () => ({ method: contract.method, path: contract.routeTemplate }) }
      await expect(gateway.console(responseContract, undefined)).rejects.toMatchObject({ issues: [{ code: 'invalid_json', path: '/' }] })
    } else {
      const gateway = createApiGateway({ platformTransport, consoleTransport: createConsoleTransport(async () => new Response(null, { status: 204 })), reportFailure: () => {} })
      const responseContract: ConsoleOperationContract<undefined, unknown> = { ...contract, request: () => ({ method: contract.method, path: contract.routeTemplate }) }
      expect(await gateway.console(responseContract, undefined)).toBeUndefined()
    }
  }
})

test('write-unconfirmed keeps cached data and readback remains possible without replaying create', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: retryReadQuery, retryDelay: 0 } } })
  const key = ['console', 'app', 'app']
  let body: unknown = fixture('App')
  const send = mock(async (request: ConsoleRequest) => ({ status: request.method === 'POST' ? 201 : 200, body: { kind: 'json' as const, value: body } }))
  const gateway = createApiGateway({ platformTransport, consoleTransport: { send }, reportFailure: () => {} })
  const read = () => client.fetchQuery({ queryKey: key, queryFn: () => gateway.console(consoleContracts.app, 'app'), staleTime: 0 })
  try {
    const good = await read()
    const updatedAt = client.getQueryState(key)!.dataUpdatedAt
    body = { secret: SECRET }
    const mutation = client.getMutationCache().build(client, { mutationFn: () => gateway.console(createAppContract, { displayName: 'App', groupId: 'group' }), onSuccess: (value) => client.setQueryData(key, value) })
    await expect(mutation.execute(undefined)).rejects.toMatchObject({ outcome: 'write_unconfirmed' })
    expect(send).toHaveBeenCalledTimes(2)
    expect(client.getQueryData<unknown>(key)).toBe(good)
    expect(client.getQueryState(key)!.dataUpdatedAt).toBe(updatedAt)
    body = fixture('App')
    expect(await read()).toEqual(good)
    expect(send).toHaveBeenCalledTimes(3)
  } finally { client.clear() }
})
