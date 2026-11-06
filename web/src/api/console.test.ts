import { describe, expect, test } from 'bun:test'
import {
  avatarUrl,
  buildGroupTree,
  canManageGroup,
  ConsoleApiError,
  createConsoleApi,
  directoryLinks,
  flattenGroupTree,
  isValidSlug,
  membershipRoots,
  pathPrefixes,
  screenshotUrl,
  subtreeIds,
  type Group,
} from './console'
import { copy } from '../copy'

const group = (id: string, parentId: string | null, name: string, path: string): Group => ({
  id,
  parentId,
  name,
  slug: path.split('/').at(-1) ?? path,
  path,
  description: '',
  about: '',
  aboutUpdatedBy: null,
  aboutUpdatedAt: null,
  subgroupCount: 0,
  memberCount: 0,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
})

const groups = [
  group('a', null, '営業本部', 'sales'),
  group('b', 'a', '営業1部', 'sales/east'),
  group('c', 'b', '営業1課', 'sales/east/team-a'),
  group('d', null, '総務部', 'soumu'),
]

type Call = { input: string; init: RequestInit }

function recorder(responses: Response[]) {
  const calls: Call[] = []
  const api = createConsoleApi(
    async (input, init) => {
      calls.push({ input, init })
      return responses.shift() ?? new Response(null, { status: 500 })
    },
    () => false,
  )
  return { api, calls }
}

describe('createConsoleApi', () => {
  test('builds same-origin URLs with encoded query and path segments', async () => {
    const { api, calls } = recorder([
      Response.json({ items: [] }),
      Response.json({ kind: 'group', id: 'c', currentPath: 'sales/east/team-a' }),
      Response.json({}),
    ])
    expect(await api.apps.list({ scope: 'all', q: '見積 書' })).toEqual([])
    await api.resolve('/sales/east/team-a')
    await api.apps.byPath('sales/east/team-a', 'mitsumori')
    expect(calls.map((call) => call.input)).toEqual([
      '/api/console/apps?scope=all&q=%E8%A6%8B%E7%A9%8D+%E6%9B%B8',
      '/api/console/resolve?path=%2Fsales%2Feast%2Fteam-a',
      '/api/console/apps/by-path/sales/east/team-a/mitsumori',
    ])
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.body).toBeUndefined()
  })

  test('sends JSON bodies for mutations and returns undefined for 204', async () => {
    const { api, calls } = recorder([Response.json({ id: 'x' }, { status: 201 }), new Response(null, { status: 204 })])
    await api.apps.create({ displayName: '見積', slug: 'mitsumori', groupId: 'b' })
    expect(await api.apps.remove('x')).toBeUndefined()
    expect(calls[0].init.method).toBe('POST')
    expect(new Headers(calls[0].init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ displayName: '見積', slug: 'mitsumori', groupId: 'b' })
    expect(calls[1]).toMatchObject({ input: '/api/console/apps/x', init: { method: 'DELETE' } })
  })

  test('surfaces the contract error code', async () => {
    const { api } = recorder([Response.json({ error: 'already_bound', message: 'already bound' }, { status: 409 })])
    const error = await api.apps.bind('a', { stackId: 's', appName: 'a' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConsoleApiError)
    expect(error).toMatchObject({ status: 409, code: 'already_bound', message: 'already bound' })
  })

  test('falls back to not_found when a 404 has no JSON body', async () => {
    const { api } = recorder([new Response('nope', { status: 404 })])
    await expect(api.resolve('/missing')).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  test('a 5xx without a contract envelope (gateway) is transient, with no raw status text', async () => {
    const { api } = recorder([new Response('upstream connect error or disconnect/reset before headers', { status: 500 })])
    const error = (await api.apps.create({ displayName: 'x', slug: 'x', groupId: 'g' }).catch((caught: unknown) => caught)) as ConsoleApiError
    expect(error).toMatchObject({ status: 500, code: 'unknown', transient: true, message: copy.errors.transient })
    expect(error.message).not.toContain('console api')
  })

  test('a contract 5xx envelope is not transient; a network failure is', async () => {
    const { api } = recorder([Response.json({ error: 'upstream_unavailable', message: 'platform down' }, { status: 502 })])
    await expect(api.me()).rejects.toMatchObject({ status: 502, code: 'upstream_unavailable', transient: false, message: 'platform down' })

    const offline = createConsoleApi(async () => Promise.reject(new TypeError('Failed to fetch')), () => false)
    await expect(offline.me()).rejects.toMatchObject({ status: 0, transient: true, message: copy.errors.transient })
  })

  test('screenshot upload posts multipart without a JSON content type; reorder, remove, the catalog and tools use the contract paths', async () => {
    const shot = { id: 's/1', caption: '一覧', width: 1280, height: 800 }
    const tools = { available: true, tools: [{ slug: 'q', name: '見積の承認', description: '', url: 'https://tools.pj-1.example.test/t/q', liveReleaseNumber: 2 }] }
    const { api, calls } = recorder([
      Response.json(shot, { status: 201 }),
      Response.json(shot, { status: 201 }),
      Response.json([shot]),
      new Response(null, { status: 204 }),
      Response.json({ items: [] }),
      Response.json({}),
      Response.json(tools),
    ])
    const file = new File([new Uint8Array([1, 2, 3])], 'screen.png', { type: 'image/png' })
    expect(await api.screenshots.upload('a/1', file, '一覧')).toEqual(shot)
    await api.screenshots.upload('a/1', file)
    expect(await api.screenshots.reorder('a/1', ['s/1'])).toEqual([shot])
    expect(await api.screenshots.remove('a/1', 's/1')).toBeUndefined()
    expect(await api.apps.directory({ groupId: 'g', ownerId: 'p 1' })).toEqual([])
    await api.apps.directoryEntry('a/1')
    expect(await api.apps.tools('a/1')).toEqual(tools)
    expect(calls.map((call) => `${call.init.method} ${call.input}`)).toEqual([
      'POST /api/console/apps/a%2F1/screenshots',
      'POST /api/console/apps/a%2F1/screenshots',
      'PATCH /api/console/apps/a%2F1/screenshots',
      'DELETE /api/console/apps/a%2F1/screenshots/s%2F1',
      'GET /api/console/apps?scope=directory&group=g&ownerId=p+1',
      'GET /api/console/apps/a%2F1/directory-entry',
      'GET /api/console/apps/a%2F1/tools',
    ])
    const form = calls[0].init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect((form.get('file') as File).name).toBe('screen.png')
    expect(form.get('caption')).toBe('一覧')
    expect(new Headers(calls[0].init.headers).get('Content-Type')).toBeNull()
    expect((calls[1].init.body as FormData).has('caption')).toBe(false)
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ order: ['s/1'] })
    expect(screenshotUrl('a/1', 's/1')).toBe('/api/console/apps/a%2F1/screenshots/s%2F1')
  })

  test('Directory calls go through the same-origin proxy; empty batches make no call; >100 ids are split', async () => {
    const person = { id: 'p/1', subject: null, pending: true, email: 'new@example.com', displayName: 'New', avatarVersion: null }
    const { api, calls } = recorder([
      Response.json({ items: [] }),
      Response.json({ items: [person] }),
      Response.json({ items: [] }),
      Response.json({ items: [person] }),
      Response.json({ person, memberships: [] }),
      Response.json(person, { status: 201 }),
      Response.json({ items: [] }),
      Response.json({ items: [] }),
      Response.json({ items: [] }),
      Response.json({ imported: { people: 1, groups: 0, memberships: 0 }, conflicts: [] }),
    ])
    expect(await api.directory.people([])).toEqual([])
    await api.directory.searchPeople('new@example.com')
    expect(await api.directory.people(['p/1', 'p 2'])).toEqual([person])
    const many = Array.from({ length: 101 }, (_, index) => `p${index}`)
    expect(await api.directory.people(many)).toEqual([person])
    await api.directory.person('p/1')
    expect(await api.directory.createPerson({ email: 'new@example.com', displayName: 'New' })).toEqual(person)
    await api.directory.groups()
    await api.directory.members('g/1')
    await api.directory.users('山田')
    expect(await api.admin.directoryMigrate()).toEqual({ imported: { people: 1, groups: 0, memberships: 0 }, conflicts: [] })
    expect(calls.map((call) => `${call.init.method} ${call.input}`)).toEqual([
      'GET /api/console/directory/people?q=new%40example.com',
      'GET /api/console/directory/people?ids=p%2F1%2Cp+2',
      `GET /api/console/directory/people?ids=${many.slice(0, 100).join('%2C')}`,
      'GET /api/console/directory/people?ids=p100',
      'GET /api/console/directory/people/p%2F1',
      'POST /api/console/directory/people',
      'GET /api/console/directory/groups',
      'GET /api/console/directory/groups/g%2F1/members',
      'GET /api/console/directory/directory-users?q=%E5%B1%B1%E7%94%B0',
      'POST /api/console/admin/directory-migrate',
    ])
    expect(JSON.parse(String(calls[5].init.body))).toEqual({ email: 'new@example.com', displayName: 'New' })
  })

  test('avatars and pages live on the Directory public origin; the avatar URL carries the version', () => {
    const base = 'https://directory.pj-1.example.test/'
    expect(avatarUrl(base, 'p/1', '2026-10-13T00:00:00+09:00')).toBe(
      'https://directory.pj-1.example.test/api/directory/v1/people/p%2F1/avatar?v=2026-10-13T00%3A00%3A00%2B09%3A00',
    )
    expect(directoryLinks.person(base, 'p/1')).toBe('https://directory.pj-1.example.test/people/p%2F1')
    expect(directoryLinks.you(base)).toBe('https://directory.pj-1.example.test/people/me')
    expect(directoryLinks.groups(base)).toBe('https://directory.pj-1.example.test/groups')
    expect(directoryLinks.group(base, 'g 1')).toBe('https://directory.pj-1.example.test/groups/g%201')
  })
})

describe('group helpers', () => {
  test('buildGroupTree nests by parentId with depth', () => {
    const flat = flattenGroupTree(buildGroupTree(groups))
    expect(Object.fromEntries(flat.map((node) => [node.id, node.depth]))).toEqual({ a: 0, b: 1, c: 2, d: 0 })
    // Depth-first: every child directly follows its ancestor chain.
    const ids = flat.map((node) => node.id)
    expect(ids.indexOf('b')).toBe(ids.indexOf('a') + 1)
    expect(ids.indexOf('c')).toBe(ids.indexOf('b') + 1)
  })

  test('subtreeIds includes the group and every descendant', () => {
    expect([...subtreeIds(groups, 'a')].sort()).toEqual(['a', 'b', 'c'])
    expect([...subtreeIds(groups, 'd')]).toEqual(['d'])
  })

  test('pathPrefixes lists ancestors root first', () => {
    expect(pathPrefixes('sales/east/team-a')).toEqual(['sales', 'sales/east', 'sales/east/team-a'])
  })

  test('isValidSlug enforces the contract rules', () => {
    expect(isValidSlug('team-a')).toBe(true)
    expect(isValidSlug('a')).toBe(true)
    for (const bad of ['', '-a', 'a-', 'Team', 'mine', 'new', 'help', '-', 'a_b', 'x'.repeat(64)]) {
      expect(isValidSlug(bad)).toBe(false)
    }
    expect(isValidSlug('constructor')).toBe(true)
  })

  test('canManageGroup honours console admins and the managed set from me', () => {
    const base = { isConsoleAdmin: false, managedGroupIds: ['b', 'c'] }
    expect(canManageGroup(base, 'c')).toBe(true)
    expect(canManageGroup(base, 'd')).toBe(false)
    expect(canManageGroup(base, 'a')).toBe(false)
    expect(canManageGroup({ ...base, isConsoleAdmin: true }, 'a')).toBe(true)
  })

  test('membershipRoots keeps effective groups whose parent is not effective', () => {
    expect(membershipRoots({ effectiveGroupIds: ['b', 'c', 'd'] }, groups).map((group) => group.id)).toEqual(['b', 'd'])
    expect(membershipRoots({ effectiveGroupIds: ['c'] }, groups).map((group) => group.id)).toEqual(['c'])
    expect(membershipRoots({ effectiveGroupIds: ['missing'] }, groups)).toEqual([])
  })
})
