import { describe, expect, test } from 'bun:test'
import type { DirectoryEntry, Group, Person } from '../api/console'
import type { AppView } from './app'
import { groupDirectory, isFinished, makersOf, storeOrder, storeScore } from './directory'

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

const entry = (id: string, owner: Group, updatedAt: string): DirectoryEntry => ({
  id,
  path: `${owner.path}/${id}`,
  displayName: id,
  description: '',
  icon: '',
  tags: [],
  capabilities: [],
  screenshots: [],
  group: { id: owner.id, path: owner.path, name: owner.name },
  owners: [],
  appName: id,
  stackId: `stack-${id}`,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt,
  canOpen: false,
})

const shot = (id: string) => ({ id, caption: '', width: 1280, height: 800 })

const view = (overrides: Partial<AppView> = {}): AppView => ({
  status: 'live',
  label: '',
  text: '',
  second: '',
  draft: false,
  ...overrides,
})

describe('isFinished', () => {
  const statuses = [['live', true], ['failed', true], ['unknown', true], ['unfinished', true], ['deploying', false]] as const
  const builds: AppView['build'][] = [undefined, { draftId: 'draft-1', phase: 'implementing' }, { draftId: 'draft-1', phase: 'done' }]

  for (const [status, expected] of statuses) {
    test(`${status}: only non-drafts without a build or deployment are finished`, () => {
      expect(builds.map((build) => isFinished(view({ status, build })))).toEqual([expected, false, false])
      expect(builds.map((build) => isFinished(view({ status, build, draft: true })))).toEqual([false, false, false])
    })
  }
})

describe('groupDirectory', () => {
  const sales = group('sales', null, '営業本部', 'sales')
  const general = group('general', null, '総務部', 'general')
  const east = group('east', sales.id, '営業1部', 'sales/east')
  const team = group('team', east.id, '営業1課', 'sales/east/team-a')
  const sibling = group('salesman', null, '営業支援', 'salesman')

  test('counts only finished entries in the exact group path or its descendants', () => {
    const groups = [general, team, sibling, east, sales]
    const entries = [
      entry('older', sales, '2026-10-01T00:00:00Z'),
      entry('newest', team, '2026-10-05T00:00:00Z'),
      entry('unfinished', east, '2026-10-10T00:00:00Z'),
      entry('second', east, '2026-10-04T00:00:00Z'),
      { ...entry('third', sales, '2026-10-03T00:00:00Z'), capabilities: ['x'] },
      entry('sibling', sibling, '2026-10-09T00:00:00Z'),
      entry('different-path', { ...sales, path: 'elsewhere' }, '2026-10-11T00:00:00Z'),
    ]
    const cards = groupDirectory(groups, entries, (app) => app.id !== 'unfinished')
    expect(cards.map((card) => card.group.id)).toEqual([sales, sibling, general].sort((a, b) => a.name.localeCompare(b.name, 'ja')).map((item) => item.id))
    const card = cards.find((item) => item.group.id === sales.id)!
    expect(card.appCount).toBe(4)
    // Representatives follow storeOrder: richer introductions first, then name; never updatedAt.
    expect(card.apps.map((app) => app.id)).toEqual(['third', 'newest', 'older'])
    expect(card.children).toEqual([east])
    expect(card.moreChildren).toBe(0)
    expect(card.myDrafts).toBe(0)
    expect(card.apps.every((app) => !app.canOpen)).toBe(true)
    expect(cards.find((item) => item.group.id === general.id)).toMatchObject({ appCount: 0, apps: [], children: [], moreChildren: 0, myDrafts: 0 })
  })

  test('sorts direct children by Japanese name and shows five plus the remainder', () => {
    const children = ['か', 'あ', 'お', 'き', 'う', 'い', 'え'].map((name, index) => group(`child-${index}`, sales.id, name, `sales/child-${index}`))
    const grandchild = group('grandchild', children[0].id, '孫部署', `${children[0].path}/grandchild`)
    const cards = groupDirectory([grandchild, ...children, sales], [], () => true)
    expect(cards).toHaveLength(1)
    expect(cards[0].children.map((child) => child.name)).toEqual(['あ', 'い', 'う', 'え', 'お'])
    expect(cards[0].moreChildren).toBe(2)
    expect(cards[0].appCount).toBe(0)
  })

  test('honours presentation limits without changing counts or mutating the source arrays', () => {
    const groups = Object.freeze([general, team, east, sales])
    const entries = Object.freeze([
      entry('earlier', sales, '2026-10-01T00:00:00Z'),
      entry('later', team, '2026-10-02T00:00:00Z'),
    ])
    const card = groupDirectory(groups, entries, () => true, { maxApps: 1, maxChildren: 0 }).find((item) => item.group.id === sales.id)!
    expect(card).toMatchObject({ appCount: 2, children: [], moreChildren: 1 })
    expect(card.apps.map((app) => app.id)).toEqual(['earlier'])
    expect(entries.map((app) => app.id)).toEqual(['earlier', 'later'])
    expect(groups.map((item) => item.id)).toEqual(['general', 'team', 'east', 'sales'])
    expect(groupDirectory(groups, entries, () => true, { maxApps: 0 }).find((item) => item.group.id === sales.id)).toMatchObject({ appCount: 2, apps: [] })
  })

  test('picks representatives by store order, not by update time', () => {
    const entries = [
      { ...entry('trial-newest', sales, '2026-10-09T00:00:00Z'), displayName: '稟議申請' },
      { ...entry('described', sales, '2026-10-01T00:00:00Z'), displayName: '備品予約', capabilities: ['空きを確認'] },
      { ...entry('pictured', sales, '2026-10-02T00:00:00Z'), displayName: '経費精算', screenshots: [shot('s1')] },
      { ...entry('trial-older', sales, '2026-10-08T00:00:00Z'), displayName: '備品棚卸' },
    ]
    const trials = [entries[0], entries[3]].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'))
    expect(groupDirectory([sales], entries, () => true)[0].apps.map((app) => app.id)).toEqual(['pictured', 'described', trials[0].id])
  })

  test('returns only top-level groups, including empty groups', () => {
    expect(groupDirectory([], [], () => true)).toEqual([])
    expect(groupDirectory([east], [], () => true)).toEqual([])
    expect(groupDirectory([sales], [], () => true)).toEqual([
      { group: sales, children: [], moreChildren: 0, apps: [], appCount: 0, myDrafts: 0 },
    ])
  })
})

describe('storeScore', () => {
  test('weighs screenshots 4, capabilities 2 and a guide 1', () => {
    expect(storeScore({ screenshots: [], capabilities: [] })).toBe(0)
    expect(storeScore({ screenshots: [], capabilities: [], guide: '' })).toBe(0)
    expect(storeScore({ screenshots: [], capabilities: [], guide: '## 使いかた' })).toBe(1)
    expect(storeScore({ screenshots: [], capabilities: ['予約'] })).toBe(2)
    expect(storeScore({ screenshots: [shot('a'), shot('b')], capabilities: [] })).toBe(4)
    expect(storeScore({ screenshots: [shot('a')], capabilities: ['予約', '貸出'], guide: 'x' })).toBe(7)
  })
})

describe('storeOrder', () => {
  const app = (displayName: string, fields: { screenshots?: number; capabilities?: number; guide?: string } = {}) => ({
    displayName,
    screenshots: Array.from({ length: fields.screenshots ?? 0 }, (_, index) => shot(`${displayName}-${index}`)),
    capabilities: Array.from({ length: fields.capabilities ?? 0 }, (_, index) => `${displayName}-${index}`),
    guide: fields.guide,
  })

  test('sorts by score descending, then by Japanese name', () => {
    const entries = [
      app('稟議申請'),
      app('備品予約', { capabilities: 2 }),
      app('経費精算', { screenshots: 1 }),
      app('勤怠', { capabilities: 1, guide: 'x' }),
      app('あいさつ', { capabilities: 1 }),
      app('備品棚卸'),
    ]
    const expected = [
      '経費精算',
      '勤怠',
      ...['備品予約', 'あいさつ'].sort((a, b) => a.localeCompare(b, 'ja')),
      ...['稟議申請', '備品棚卸'].sort((a, b) => a.localeCompare(b, 'ja')),
    ]
    expect(storeOrder(entries).map((entry) => entry.displayName)).toEqual(expected)
  })

  test('does not mutate its input', () => {
    const entries = Object.freeze([app('b'), app('a', { screenshots: 1 })])
    expect(storeOrder(entries).map((entry) => entry.displayName)).toEqual(['a', 'b'])
    expect(entries.map((entry) => entry.displayName)).toEqual(['b', 'a'])
    expect(storeOrder([])).toEqual([])
  })
})

describe('makersOf', () => {
  const person = (id: string, displayName: string): Person => ({ id, subject: null, pending: false, email: `${id}@example.com`, displayName, avatarVersion: null })
  const yamada = person('p-yamada', '山田')
  const sato = person('p-sato', '佐藤')
  const abe = person('p-abe', '阿部')

  test('counts each owner once per app, most apps first, then by Japanese name', () => {
    const makers = makersOf([{ owners: [yamada, sato] }, { owners: [sato] }, { owners: [abe] }, { owners: [] }, { owners: [yamada] }])
    const tied = [yamada, sato].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'))
    expect(makers).toEqual([...tied.map((p) => ({ person: p, appCount: 2 })), { person: abe, appCount: 1 }])
  })

  test('is empty without owners', () => {
    expect(makersOf([])).toEqual([])
    expect(makersOf([{ owners: [] }])).toEqual([])
  })
})
