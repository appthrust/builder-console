import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { ResponseContractError } from '../../boundary'
import { groupsQuery, meQuery } from '../../queries/console'
import { queryClient } from '../../queries/shared'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import { configContract } from './config'
import { groupsContract } from './groups'
import { meContract } from './me'

const SECRET = 'SENTINEL-bootstrap-9d1e'
const person = { id: 'p-1', subject: 'sub-1', pending: false, email: 'yamada@example.test', displayName: '山田', avatarVersion: null }
const me = {
  person, isConsoleAdmin: false, canCreateApps: true, effectiveGroupIds: ['g-1'], managedGroupIds: [], projectId: 'commerce',
  directoryPublicURL: 'https://directory.example.test', migration: { pending: false, people: 0, groups: 0, memberships: 0 },
}
const group = {
  id: 'g-1', parentId: null, name: '営業', slug: 'sales', path: 'sales', description: '', about: '', aboutUpdatedBy: person,
  aboutUpdatedAt: '2026-11-01T00:00:00Z', subgroupCount: 0, memberCount: 1, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
}

test('me: missing roles or group lists are failures, never an empty grant', () => {
  assertWireContractCases(meContract, [
    { name: 'signed-in caller', variant: 'present', path: '/', wire: me, expect: { accept: true, value: me } },
    { name: 'optional notices absent', variant: 'absent', path: '/notMember', wire: me, expect: { accept: true, check: (value) => expect(value.notMember).toBeUndefined() } },
    { name: 'optional notice present', variant: 'present', path: '/platformUnavailable', wire: { ...me, platformUnavailable: true, teamSlug: 'team' }, expect: { accept: true, check: (value) => expect(value.platformUnavailable).toBe(true) } },
    { name: 'group list absent', variant: 'absent', path: '/effectiveGroupIds', wire: { ...me, effectiveGroupIds: undefined }, expect: { accept: false, issues: [{ path: '/effectiveGroupIds', code: 'missing' }] } },
    { name: 'managed list null', variant: 'null', path: '/managedGroupIds', wire: { ...me, managedGroupIds: null }, expect: { accept: false, issues: [{ path: '/managedGroupIds', code: 'invalid_type' }] } },
    { name: 'role flag absent', variant: 'absent', path: '/canCreateApps', wire: { ...me, canCreateApps: undefined }, expect: { accept: false, issues: [{ path: '/canCreateApps', code: 'missing' }] } },
    { name: 'caller without subject', variant: 'null', path: '/person/subject', wire: { ...me, person: { ...person, subject: null } }, expect: { accept: false } },
    { name: 'caller cannot be an unknown person', variant: 'unknown', path: '/person', wire: { ...me, person: { id: 'p-1', displayName: '', unknown: true } }, expect: { accept: false } },
    { name: 'unknown field dropped', variant: 'unknown', path: '/', wire: { ...me, roles: [SECRET] }, expect: { accept: true, value: me } },
  ])
})

test('groups: the Directory list envelope is required; people in it are always resolved', () => {
  assertWireContractCases(groupsContract, [
    { name: 'one group', variant: 'present', path: '/items', wire: { items: [group] }, expect: { accept: true, value: [group] } },
    { name: 'no groups', variant: 'empty', path: '/items', wire: { items: [] }, expect: { accept: true, value: [] } },
    { name: 'items null', variant: 'null', path: '/items', wire: { items: null }, expect: { accept: false, issues: [{ path: '/items', code: 'invalid_type' }] } },
    { name: 'items absent', variant: 'absent', path: '/items', wire: {}, expect: { accept: false, issues: [{ path: '/items', code: 'missing' }] } },
    { name: 'about never edited', variant: 'null', path: '/items/*/aboutUpdatedBy', wire: { items: [{ ...group, aboutUpdatedBy: null, aboutUpdatedAt: null }] }, expect: { accept: true } },
    { name: 'broken count', variant: 'unknown', path: '/items/*/memberCount', wire: { items: [{ ...group, memberCount: SECRET }] }, expect: { accept: false, issues: [{ path: '/items/*/memberCount', code: 'invalid_type' }] } },
  ])
})

test('config: the project id is a DNS label; an unvouched Dashboard link is dropped', () => {
  assertWireContractCases(configContract, [
    { name: 'project only', variant: 'absent', path: '/dashboardUrl', wire: { projectId: 'pj-1' }, expect: { accept: true, value: { projectId: 'pj-1' } } },
    { name: 'https link kept', variant: 'present', path: '/dashboardUrl', wire: { projectId: 'pj-1', dashboardUrl: 'https://dash.example.test/s' }, expect: { accept: true, value: { projectId: 'pj-1', dashboardUrl: 'https://dash.example.test/s' } } },
    { name: 'script link dropped', variant: 'unknown', path: '/dashboardUrl', wire: { projectId: 'pj-1', dashboardUrl: 'javascript:alert(1)' }, expect: { accept: true, value: { projectId: 'pj-1' } } },
    { name: 'project absent', variant: 'absent', path: '/projectId', wire: {}, expect: { accept: false, issues: [{ path: '/projectId', code: 'missing' }] } },
    { name: 'project null', variant: 'null', path: '/projectId', wire: { projectId: null }, expect: { accept: false, issues: [{ path: '/projectId', code: 'invalid_type' }] } },
    { name: 'project not a DNS label', variant: 'unknown', path: '/projectId', wire: { projectId: `x/${SECRET}` }, expect: { accept: false, issues: [{ path: '/projectId', code: 'invalid_value' }] } },
  ])
})

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('bootstrap: a malformed me or groups answer is a typed failure read once, never a shell built on guesses', async () => {
  const fetch = mock(async (input: RequestInfo | URL) => Response.json(String(input).endsWith('/me') ? { ...me, effectiveGroupIds: SECRET } : { items: [{ ...group, id: null }] }))
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  // The app's retry policy: a contract failure must not be re-read in a burst.
  const client = new QueryClient({ defaultOptions: { queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false } } })
  try {
    const meError = await client.fetchQuery(meQuery).catch((caught: unknown) => caught)
    const groupsError = await client.fetchQuery(groupsQuery).catch((caught: unknown) => caught)
    expect(meError).toBeInstanceOf(ResponseContractError)
    expect(meError).toMatchObject({ operationId: 'consoleGetMe', issues: [{ path: '/effectiveGroupIds', code: 'invalid_type' }] })
    expect(groupsError).toMatchObject({ operationId: 'consoleListDirectoryGroups', issues: [{ path: '/items/*/id', code: 'invalid_type' }] })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(client.getQueryData(meQuery.queryKey)).toBeUndefined()
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET)
  } finally {
    client.clear()
    warn.mockRestore()
  }
})
