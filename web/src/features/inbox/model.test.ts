import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { preserveLanguage } from '../../../test/language'
import { businessAppOf } from '../../api/testing/app-domain'
import { proposalOf, proposalWire } from '../../api/testing/proposal-domain'
import { setLanguage } from '../../shell/language'
import { appPathHref, draftRow, orderInbox, problemRows, proposalRows, serverRows, type InboxItem } from './model'

let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())

const owner = { id: 'owner', subject: 's', pending: false, displayName: '山田 花子', email: 'yamada@example.com', avatarVersion: null }
const app = (id: string, displayName: string) => businessAppOf({
  id, slug: id, displayName, description: '', icon: '', tags: [], group: { id: 'hr', path: 'admin/hr', name: '人事部' },
  owners: [owner], createdBy: owner, stackId: `stack-${id}`, appName: id, share: { scope: 'group', groupIds: [], extraPersonIds: [] },
  createdAt: '', updatedAt: '', guide: '', capabilities: [], screenshots: [], contribution: { scope: 'group' },
  permissions: { use: true, comment: true, propose: true, maintain: true, data: true },
})

describe('inbox rows', () => {
  test('an app path splits into group path and slug', () => {
    expect(appPathHref('admin/hr/wage')).toBe('/admin/hr/wage')
  })

  test('console rows: 利用申請 opens the app page, コメント its 利用者の声; zero counts are dropped', () => {
    const rows = serverRows([
      { kind: 'accessRequest', app: { id: 'a', path: 'admin/hr/hire', displayName: '採用管理', icon: '' }, count: 2, since: '2026-11-19T01:00:00Z' },
      { kind: 'feedback', app: { id: 'b', path: 'admin/hr/wage', displayName: '評価・賃金', icon: '' }, count: 2, since: '2026-11-19T02:00:00Z' },
      { kind: 'feedback', app: { id: 'c', path: 'admin/hr/room', displayName: '会議室', icon: '' }, count: 0, since: '2026-11-19T02:00:00Z' },
    ])
    expect(rows.map((row) => [row.kind, row.href, row.count, row.note])).toEqual([
      ['accessRequest', '/admin/hr/hire', 2, '使いたい人が申請しています。'],
      ['feedback', '/admin/hr/wage#voices', 2, '利用者から新しいコメントが届いています。'],
    ])
  })

  test('proposals group per app: one names its proposer and opens it, several open the app’s proposal list', () => {
    const wage = app('wage', '評価・賃金')
    const proposals = [
      proposalOf(proposalWire({ id: 'p1', applicationId: 'app-wage', proposer: 'sub-sato', updatedAt: '2026-11-19T01:00:00Z' })),
      proposalOf(proposalWire({ id: 'p2', applicationId: 'app-room', proposer: 'sub-ito', updatedAt: '2026-11-19T03:00:00Z' })),
      proposalOf(proposalWire({ id: 'p3', applicationId: 'app-room', proposer: 'sub-ito', title: '予約の色を変える', updatedAt: '2026-11-19T02:00:00Z' })),
    ]
    const rows = proposalRows(proposals, (id) => (id === 'app-wage' ? wage : undefined), (subject) => (subject === 'sub-sato' ? '佐藤 次郎' : undefined))
    expect(rows.map((row) => [row.app.displayName, row.count, row.href, row.note, row.since])).toEqual([
      ['一覧に絞り込みを足す', 2, '/-/proposals?applicationId=app-room', '提案が確認を待っています。', '2026-11-19T03:00:00Z'],
      ['評価・賃金', 1, '/-/proposals/p1', '佐藤 次郎 さんの提案が確認を待っています。', '2026-11-19T01:00:00Z'],
    ])
    expect(rows[1].app).toEqual({ id: 'wage', path: 'admin/hr/wage', displayName: '評価・賃金', icon: '' })
  })

  test('order: problem, proposal, accessRequest, feedback, draft; each kind keeps its own order', () => {
    const wizard = app('memo', '面談メモ')
    const items: InboxItem[] = [
      draftRow({ kind: 'app', id: 'memo', name: '面談メモ', at: '', app: wizard }, '作り終えていません。続きから作れます。'),
      ...serverRows([
        { kind: 'feedback', app: { id: 'b', path: 'admin/hr/wage', displayName: '評価・賃金', icon: '' }, count: 1, since: '' },
        { kind: 'accessRequest', app: { id: 'a', path: 'admin/hr/hire', displayName: '採用管理', icon: '' }, count: 1, since: '' },
      ]),
      ...proposalRows([proposalOf(proposalWire())], () => undefined, () => undefined),
      ...problemRows([{ app: app('expense', '経費精算'), note: '新しい版の起動に失敗しました。' }, { app: app('kintai', '勤怠申請'), note: '' }]),
    ]
    const ordered = orderInbox(items)
    expect(ordered.map((item) => `${item.kind}:${item.app.displayName}`)).toEqual([
      'problem:経費精算', 'problem:勤怠申請', 'proposal:一覧に絞り込みを足す', 'accessRequest:採用管理', 'feedback:評価・賃金', 'draft:面談メモ',
    ])
    expect(ordered[0].href).toBe('/admin/hr/expense')
    expect(ordered.at(-1)?.href).toBe('/new?resume=memo')
  })
})
