import { describe, expect, test } from 'bun:test'
import type { BusinessApp, DirectoryEntry } from '../../api/console-unverified'
import { matchesAppSearch, matchesDirectoryEntrySearch } from './search'

const owner = { id: 'owner', subject: 's', pending: false, displayName: 'Storage Proof', email: 'storage@example.com', avatarVersion: null }
const app: BusinessApp = {
  id: 'inventory', slug: 'inventory', displayName: '備品棚卸', description: '在庫と発注を確認', icon: '', tags: ['備品'],
  group: { id: 'team-a', path: 'sales/team-a', name: '営業1課' }, owners: [owner], createdBy: owner,
  stackId: null, appName: null, share: { scope: 'company', groupIds: [], extraPersonIds: [] }, createdAt: '', updatedAt: '',
  guide: '月末に集計してください', capabilities: ['PDF で一覧を出す', '注文書を作る'], screenshots: [],
}

describe('matchesAppSearch', () => {
  test('matches owner names without narrowing the authorized list through server q', () => {
    expect(matchesAppSearch(app, 'Storage')).toBe(true)
    expect(matchesAppSearch(app, 'proof')).toBe(true)
    expect(matchesAppSearch(app, 'ＳＴＯＲＡＧＥ')).toBe(true)
    expect(matchesAppSearch(app, 'storage@example.com')).toBe(true)
  })
  test('preserves app, description, tags, group and URL name search', () => {
    for (const term of ['備品棚卸', '発注', '備品', '営業1課', 'sales/team-a', 'inventory']) expect(matchesAppSearch(app, term)).toBe(true)
  })
  test('matches capabilities without searching the guide', () => {
    expect(matchesAppSearch(app, '注文書')).toBe(true)
    expect(matchesAppSearch(app, 'ｐｄｆ')).toBe(true)
    expect(matchesAppSearch(app, 'Storage PDF')).toBe(true)
    expect(matchesAppSearch(app, '月末')).toBe(false)
  })
  test('combines whitespace separated terms across fields and rejects unmatched terms', () => {
    expect(matchesAppSearch(app, ' Storage  営業1課 ')).toBe(true)
    expect(matchesAppSearch(app, 'Storage 総務')).toBe(false)
    expect(matchesAppSearch(app, 'nobody')).toBe(false)
    expect(matchesAppSearch({ ...app, owners: [] }, 'Storage')).toBe(false)
    expect(matchesAppSearch(app, '   ')).toBe(true)
  })
})

const entry: DirectoryEntry = {
  id: app.id, path: `${app.group.path}/${app.slug}`, displayName: app.displayName,
  description: app.description, icon: app.icon, tags: app.tags, capabilities: app.capabilities, screenshots: [],
  group: app.group, owners: app.owners, appName: 'inventory', stackId: 'stack-inventory',
  createdAt: app.createdAt, updatedAt: app.updatedAt, canOpen: false,
}

describe('matchesDirectoryEntrySearch', () => {
  test('matches all directory fields without requiring full app metadata', () => {
    for (const term of ['備品棚卸', '発注', '備品', '営業1課', 'sales/team-a', 'inventory', '注文書', 'Storage', 'storage@example.com']) {
      expect(matchesDirectoryEntrySearch(entry, term)).toBe(true)
    }
    expect(matchesDirectoryEntrySearch(entry, 'ＳＴＯＲＡＧＥ ｐｄｆ')).toBe(true)
    expect(matchesDirectoryEntrySearch(entry, '   ')).toBe(true)
  })
  test('rejects absent terms and does not depend on whether the app can be opened', () => {
    expect(matchesDirectoryEntrySearch(entry, 'Storage 総務')).toBe(false)
    expect(matchesDirectoryEntrySearch(entry, '月末')).toBe(false)
    expect(matchesDirectoryEntrySearch({ ...entry, owners: [] }, 'Storage')).toBe(false)
    expect(matchesDirectoryEntrySearch({ ...entry, canOpen: true }, '注文書')).toBe(true)
  })
})
