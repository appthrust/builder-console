import { describe, expect, test } from 'bun:test'
import { paths } from './paths'
import { nearestGroupAncestor, parseResourcePath } from './resource-path'

describe('parseResourcePath', () => {
  test('reserved first segments never fall through to resolve', () => {
    for (const splat of ['logout', 'api/x', 'oauth2/callback', 'mine/x', 'new/x', 'company/x', 'help/x', '-', '-/admin', '-/admin/other', '-/x', '']) {
      expect(parseResourcePath(splat)).toBeNull()
    }
  })

  test('other paths are resources with an optional /-/ sub-page', () => {
    expect(parseResourcePath('sales/east/team-a')).toEqual({ path: 'sales/east/team-a', sub: null })
    expect(parseResourcePath('sales/east/team-a/')).toEqual({ path: 'sales/east/team-a', sub: null })
    expect(parseResourcePath('sales/-/members')).toEqual({ path: 'sales', sub: 'members' })
    expect(parseResourcePath('sales/-/apps')).toEqual({ path: 'sales', sub: 'apps' })
    expect(parseResourcePath('sales/east/team-a/mitsumori/-/guide')).toEqual({
      path: 'sales/east/team-a/mitsumori',
      sub: 'guide',
    })
    expect(parseResourcePath('sales/east/team-a/mitsumori/-/releases')).toEqual({
      path: 'sales/east/team-a/mitsumori',
      sub: 'releases',
    })
    expect(parseResourcePath('sales/-/members/x')).toBeNull()
    expect(parseResourcePath('sales/-')).toBeNull()
  })

  test('segments are decoded; malformed escapes are 404, not a crash', () => {
    expect(parseResourcePath('sales/%E5%96%B6%E6%A5%AD')).toEqual({ path: 'sales/営業', sub: null })
    expect(parseResourcePath('sales/%E0%A4%A')).toBeNull()
  })
})

describe('paths', () => {
  test('round-trips through parseResourcePath', () => {
    expect(paths.group('sales/east')).toBe('/sales/east')
    expect(paths.group('sales/east', 'front')).toBe('/sales/east')
    expect(paths.group('sales/east', 'apps')).toBe('/sales/east/-/apps')
    expect(paths.group('sales/east', 'members')).toBe('/sales/east/-/members')
    expect(paths.app('sales/east/team-a', 'mitsumori')).toBe('/sales/east/team-a/mitsumori')
    expect(paths.app('sales/east/team-a', 'mitsumori', 'logs')).toBe('/sales/east/team-a/mitsumori/-/logs')
    expect(paths.app('sales/east/team-a', 'mitsumori', 'guide')).toBe('/sales/east/team-a/mitsumori/-/guide')
    expect(paths.new({ group: 'sales/east' })).toBe('/new?group=sales%2Feast')
    expect(paths.new()).toBe('/new')
    expect(paths.search('')).toBe('/')
    expect(paths.search('見積')).toBe('/?q=%E8%A6%8B%E7%A9%8D')
    expect(paths.directory).toBe('/company')
    expect(paths.directorySearch('')).toBe('/company')
    expect(paths.directorySearch('見積 & PDF')).toBe('/company?q=%E8%A6%8B%E7%A9%8D+%26+PDF')
    expect(paths.mine()).toBe('/mine')
    expect(paths.mine({ status: 'problem' })).toBe('/mine?status=problem')
    expect(paths.new({ group: 'sales', resume: 'a-1', template: 'biz-inventory-postgres', intent: '在庫 & 発注' })).toBe(
      '/new?group=sales&resume=a-1&template=biz-inventory-postgres&intent=%E5%9C%A8%E5%BA%AB+%26+%E7%99%BA%E6%B3%A8'
    )
    expect(paths.appById('a-1')).toBe('/-/apps/a-1')
    expect(paths.person('p-yamada')).toBe('/-/people/p-yamada')
    expect(paths.person('a/b c')).toBe('/-/people/a%2Fb%20c')
    expect(paths.account()).toBe('/-/account')
    expect(parseResourcePath(paths.account().slice(1))).toBeNull()
    expect(parseResourcePath(paths.app('sales/east/team-a', 'mitsumori', 'logs').slice(1))).toEqual({
      path: 'sales/east/team-a/mitsumori',
      sub: 'logs',
    })
    expect(parseResourcePath(paths.group('sales/east', 'members').slice(1))).toEqual({ path: 'sales/east', sub: 'members' })
    expect(parseResourcePath(paths.group('sales/east', 'front').slice(1))).toEqual({ path: 'sales/east', sub: null })
    expect(parseResourcePath(paths.group('sales/east', 'apps').slice(1))).toEqual({ path: 'sales/east', sub: 'apps' })
    expect(parseResourcePath(paths.app('sales/east/team-a', 'mitsumori', 'guide').slice(1))).toEqual({
      path: 'sales/east/team-a/mitsumori',
      sub: 'guide',
    })
  })
})

describe('404 recovery', () => {
  const groups = [{ path: 'sales' }, { path: 'sales/team-a' }, { path: '営業' }]
  test('returns the deepest visible ancestor, not a string prefix or sibling', () => {
    expect(nearestGroupAncestor('/sales/team-a/missing', groups)?.path).toBe('sales/team-a')
    expect(nearestGroupAncestor('/sales/nope', groups)?.path).toBe('sales')
    expect(nearestGroupAncestor('/sales/team-a/-/unknown', groups)?.path).toBe('sales/team-a')
    expect(nearestGroupAncestor('/salesman/nope', groups)).toBeUndefined()
    expect(nearestGroupAncestor('/-/nope', groups)).toBeUndefined()
    expect(nearestGroupAncestor('/nope', groups)).toBeUndefined()
    expect(nearestGroupAncestor('/sales', groups)).toBeUndefined()
  })
  test('decodes valid paths and rejects malformed escapes', () => {
    expect(nearestGroupAncestor('/%E5%96%B6%E6%A5%AD/nope', groups)?.path).toBe('営業')
    expect(nearestGroupAncestor('/sales/%E0%A4%A', groups)).toBeUndefined()
  })
})
