import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../test/language'
import { businessAppOf } from '../../api/testing/app-domain'
import type { AppView } from '../../model/app'
import type { BusinessApp, Group } from '../../model/contracts/console'
import { setLanguage } from '../../shell/language'
import { AppLaunchCard, cardLaunch, type CardLaunch } from './app-store-card'
import { usableFilters } from './home'

let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())

const owner = { id: 'owner', subject: 's', pending: false, displayName: '鈴木 一郎', email: 'suzuki@example.com', avatarVersion: null }
const noPermissions = { use: true, comment: true, propose: false, maintain: false, data: false }

function app(id: string, displayName: string, groupId: string, scope: 'private' | 'group' | 'company' | 'public', extra: Record<string, unknown> = {}) {
  return businessAppOf({
    id, slug: id, displayName, description: `${displayName}の説明\n二行目`, icon: '', tags: [],
    group: { id: groupId, path: groupId, name: groupId }, owners: [owner], createdBy: owner,
    stackId: `stack-${id}`, appName: id, share: { scope, groupIds: [], extraPersonIds: [] }, createdAt: '', updatedAt: '',
    guide: '', capabilities: ['一覧を出す'], screenshots: [], contribution: { scope: 'group' }, permissions: noPermissions,
    ...extra,
  })
}

function group(id: string, parentId: string | null, name: string): Group {
  return {
    id, parentId, name, slug: id, path: parentId ? `${parentId}/${id}` : id, description: '', about: '', aboutUpdatedBy: null,
    aboutUpdatedAt: null, subgroupCount: 0, memberCount: 0, createdAt: '', updatedAt: '',
  }
}

describe('usableFilters', () => {
  const groups = [group('hr', null, '人事部'), group('hr-pay', 'hr', '給与課'), group('acc', null, '経理部'), group('ga', null, '総務部')]
  const apps = [
    app('wage', '評価・賃金', 'hr', 'group'),
    app('payslip', '給与明細', 'hr-pay', 'private'),
    app('expense', '経費精算', 'acc', 'group'),
    app('kintai', '勤怠申請', 'ga', 'company'),
    app('room', '会議室予約', 'ga', 'public'),
    app('draft', '作りかけ', 'hr', 'group', { stackId: null }),
  ]

  test('one chip per membership (its subtree), then ほかの部署 and 全社; すべて keeps that order and leaves out drafts', () => {
    const filters = usableFilters(apps, [groups[0]], groups)
    expect(filters.map((filter) => filter.label)).toEqual(['すべて', '人事部', 'ほかの部署', '全社'])
    expect(filters.map((filter) => filter.apps.map((item) => item.id))).toEqual([
      ['payslip', 'wage', 'expense', 'room', 'kintai'],
      ['payslip', 'wage'],
      ['expense'],
      ['room', 'kintai'],
    ])
  })

  test('an app inside the membership is not repeated under 全社, and an empty chip is not offered', () => {
    const filters = usableFilters([app('kintai', '勤怠申請', 'hr', 'company')], [groups[0]], groups)
    expect(filters.map((filter) => filter.label)).toEqual(['すべて', '人事部'])
  })

  test('without a membership every app still lands in a chip', () => {
    const filters = usableFilters(apps, [], groups)
    expect(filters.map((filter) => filter.label)).toEqual(['すべて', 'ほかの部署', '全社'])
    expect(filters[0].apps).toHaveLength(5)
  })
})

describe('cardLaunch', () => {
  const view = (patch: Partial<AppView>): AppView => ({ status: 'live', label: '公開中', text: '', second: '最新の版 (v3・3 時間前) が動いています。', draft: false, url: 'https://wage.example.test', ...patch })
  const known = { loading: false, failed: false }

  test('a healthy app says nothing and opens with the primary button', () => {
    expect(cardLaunch(view({}), known)).toEqual({ url: 'https://wage.example.test', tone: 'primary' })
    expect(cardLaunch(view({ status: 'deploying' }), known)).toEqual({ url: 'https://wage.example.test', tone: 'primary' })
  })

  test('only unusual states speak; 問題あり and 停止中 stay openable with the quiet button', () => {
    expect(cardLaunch(view({ status: 'failed' }), known)).toEqual({ url: 'https://wage.example.test', tone: 'secondary', note: 'failed' })
    expect(cardLaunch(view({ status: 'unknown' }), known)).toEqual({ url: 'https://wage.example.test', tone: 'secondary', note: 'stopped' })
    expect(cardLaunch(view({ status: 'deploying', url: undefined }), known)).toEqual({ tone: 'primary', note: 'notReady' })
  })

  test('loading and unreadable statuses claim no state', () => {
    expect(cardLaunch(view({}), { loading: true, failed: false })).toEqual({ tone: 'primary', pending: true })
    expect(cardLaunch(view({ status: 'unknown' }), { loading: false, failed: true })).toEqual({ url: 'https://wage.example.test', tone: 'primary' })
    expect(cardLaunch(view({ status: 'unknown', unreadableStack: true }), known)).toEqual({ url: 'https://wage.example.test', tone: 'primary' })
  })
})

describe('AppLaunchCard', () => {
  async function render(item: BusinessApp, launch: CardLaunch) {
    const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ['/'] }), isServer: true })
    await router.load()
    return renderToStaticMarkup(<RouterContextProvider router={router}><AppLaunchCard app={item} launch={launch} /></RouterContextProvider>)
  }
  const hrefOf = (html: string, label: string) =>
    html.match(new RegExp(`<a[^>]*aria-label="${label}"[^>]*>`))?.[0].match(/href="([^"]*)"/)?.[1]

  test('the whole card opens the app in a new tab; 「くわしく」 goes to the intro page; no owner, version or status words', async () => {
    const html = await render(app('wage', '評価・賃金', 'hr', 'group'), { url: 'https://wage.example.test', tone: 'primary' })
    expect(html).toContain('href="https://wage.example.test" target="_blank"')
    expect(html).toContain('aria-label="評価・賃金（新しいタブで開きます）"')
    expect(html).toContain('開く ↗')
    expect(hrefOf(html, '評価・賃金をくわしく見る')).toBe('/hr/wage')
    expect(html).toContain('くわしく')
    expect(html).toContain('評価・賃金の説明')
    expect(html).not.toContain('二行目')
    for (const hidden of ['鈴木 一郎', 'v3', '最新の版', '公開中', '管理']) expect(html).not.toContain(hidden)
  })

  test('maintainers: 「くわしく」 previews the intro page as users see it, 「管理」 opens the page with tabs', async () => {
    const maintained = app('wage', '評価・賃金', 'hr', 'group', { permissions: { ...noPermissions, maintain: true } })
    const html = await render(maintained, { url: 'https://wage.example.test', tone: 'primary' })
    expect(hrefOf(html, '評価・賃金をくわしく見る')).toBe('/hr/wage?as=user')
    expect(hrefOf(html, '評価・賃金を管理する')).toBe('/hr/wage')
  })

  test('a card that cannot open yet is no link and says so', async () => {
    const notReady = await render(app('hire', '採用管理', 'hr', 'group'), { tone: 'primary', note: 'notReady' })
    expect(notReady).toContain('準備中です。まだ開けません')
    expect(notReady).not.toContain('target="_blank"')
  })

  test('without a description the first capability stands in', async () => {
    const html = await render(app('wage', '評価・賃金', 'hr', 'group', { description: '' }), { url: 'https://wage.example.test', tone: 'primary' })
    expect(html).toContain('一覧を出す')
  })
})
