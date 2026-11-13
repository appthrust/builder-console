import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ApplicationDraftSourceSummary } from '@appthrust/api-schema/platform-api'
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../test/language'
import type { BuildMessage, BuildSpec } from '../../model/build/types'
import { setLanguage } from '../../shell/language'
import { importedRowCount } from '../../model/build/questions'
import { analysisFrom, designFrom } from '../../api/testing/excel-domain'
import { uiDecisionItems, UiDecisions } from '../excel2app/ui-decisions'
import { SpecCard } from './artifact-pane'
import { AssistantMessage } from './conversation-pane'

let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())

const spec: BuildSpec = { name: '案件管理', users: ['営業'], screens: ['案件一覧'], records: [{ name: '案件', fields: ['状態'] }], rules: [], importFrom: 'csv' }
const workbook = { id: 'wb-000000000001', fileName: '案件台帳.xlsx', sheetCount: 3, rowCount: 28, truncated: false, bytes: 100, digest: 'a'.repeat(64), addedAt: '2026-10-26T00:00:00Z' }
const source: ApplicationDraftSourceSummary = { kind: 'excel', revision: workbook.addedAt, workbooks: [workbook] }
const analysis = analysisFrom({
  summary: '', bullets: [], capabilities: [], flows: [], findings: [],
  workbooks: [{ workbookId: workbook.id, role: 'mixed', summary: '' }],
  entities: (['records', 'master'] as const).map((kind, index) => ({
    name: kind, kind, fields: [{ name: '番号', kind: 'id' }], rules: [], importRows: [12, 8][index]!,
    sources: [{ workbookId: workbook.id, sheet: kind, headerRow: 0, dataRows: 25, columns: [{ index: 0, field: '番号' }] }],
  })),
})
const design = designFrom({
  appName: '案件管理', accent: 'teal', density: 'comfortable',
  screens: [
    { id: 'dashboard:案件', kind: 'dashboard', entity: '案件', title: 'ダッシュボード', hidden: false },
    { id: 'list:案件', kind: 'list', entity: '案件', title: '案件', hidden: false },
    { id: 'board:案件', kind: 'board', entity: '案件', title: '進捗ボード', hidden: true },
  ],
  lists: { 案件: { layout: 'cards', columns: ['件名', '状態'], colorField: '状態', groupBy: '担当', sortBy: '期限', searchable: true, filters: ['状態'] } },
  forms: { 案件: { fields: ['件名', '状態', '期限'], required: ['件名', '期限'], twoColumns: true }, 顧客: { fields: ['名前'], required: [], twoColumns: false } },
  dashboard: { cards: [{ id: 'count', title: '案件の件数', kind: 'count' }, { id: 'overdue', title: '期限切れ', kind: 'overdue', field: '期限' }] },
  notes: ['印刷用レイアウトを用意する'],
})

test('an Excel draft shows the uploaded workbook as 元のデータ and the screen decisions', () => {
  const html = renderToStaticMarkup(<SpecCard spec={spec} title="案件台帳.xlsx" source={source} uiDesign={design} excelAnalysis={analysis} />)
  expect(html).toContain('案件台帳.xlsx（3 シート）から 20 行を取り込む')
  expect(html).not.toContain('Excel・CSV がある')
  expect(html).toContain('data-testid="build-ui-decisions"')
  for (const word of ['画面の決定', '画面の順番', 'ダッシュボード → 案件', '作らない画面', '進捗ボード', '「案件」の一覧', 'カード表示／列: 件名、状態／「状態」で色分け／「担当」でグループ化', '「案件」の登録', '必須: 件名・期限', '案件の件数・期限切れ', '印刷用レイアウトを用意する']) expect(html).toContain(word)
  // Forms without required fields add nothing; the app name and look stay with the preview.
  expect(html).not.toContain('「顧客」の登録')
  expect(html).not.toContain('基調色')
})

test('import counts use only analyzed records and master rows, never workbook totals', () => {
  expect(importedRowCount(analysis)).toBe(20)
  expect(importedRowCount({ entities: [] })).toBe(0)
  expect(importedRowCount(undefined)).toBeUndefined()
  const html = renderToStaticMarkup(<SpecCard spec={spec} title="案件" source={source} />)
  expect(html).toContain('案件台帳.xlsx（3 シート）から取り込む')
  expect(html).not.toContain('28')
})

test('a draft without a workbook or UI design keeps the front-matter 元のデータ and no decisions', () => {
  const html = renderToStaticMarkup(<SpecCard spec={spec} title="案件管理" />)
  expect(html).toContain('Excel・CSV がある')
  expect(html).not.toContain('画面の決定')
  expect(html).not.toContain('build-ui-decisions')
  expect(renderToStaticMarkup(<SpecCard spec={{ ...spec, importFrom: 'excel' }} title="案件管理" />)).toContain('Excel から取り込む')
})

test('the spec panel decisions read in English around the workbook’s own names', () => {
  setLanguage('en')
  const html = renderToStaticMarkup(<SpecCard spec={spec} title="Deals" source={source} uiDesign={design} excelAnalysis={analysis} />)
  for (const word of ['Import 20 rows from 案件台帳.xlsx (3 sheets)', 'Screen decisions', 'Screen order', 'Screens left out', '“案件” list', 'Cards; columns: 件名, 状態; colored by “状態”; grouped by “担当”', '“案件” form', 'Required: 件名, 期限', 'Dashboard']) expect(html).toContain(word)
})

test('Excel → app step 5 keeps listing the exact items the build receives', () => {
  const items = uiDecisionItems(design).map((item) => item.title)
  expect(items[0]).toBe('アプリ名: 案件管理')
  expect(items).toContain('「進捗ボード」は作らない')
  const html = renderToStaticMarkup(<UiDecisions design={design} />)
  for (const item of items) expect(html).toContain(item)
})

function withRouter(node: ReactNode) {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ['/-/build/draft-1'] }), isServer: true })
  return renderToStaticMarkup(<RouterContextProvider router={router}>{node}</RouterContextProvider>)
}

test('the collapsed Excel line links back to its analysis and screens', () => {
  const message: Extract<BuildMessage, { role: 'assistant' }> = { role: 'assistant', text: 'Excel の解析と画面の決定は済んでいます', at: '2026-10-26T00:00:00Z', link: { kind: 'excel2app', draftId: 'draft-7a886b2a' } }
  const html = withRouter(<AssistantMessage message={message} active={false} />)
  expect(html).toContain('href="/-/excel2app?draft=draft-7a886b2a"')
  expect(html).toContain('解析と画面を見る')
  const { link: _link, ...plain } = message
  expect(withRouter(<AssistantMessage message={plain} active={false} />)).not.toContain('excel2app')
})

test.each(['ja', 'en'] as const)('several workbooks use total sheets and merged import rows, not source row totals (%s)', (language) => {
  setLanguage(language)
  const set = { ...source, workbooks: [workbook, { ...workbook, id: 'wb-000000000002', fileName: '次月.xlsx', sheetCount: 2 }] }
  const html = renderToStaticMarkup(<SpecCard spec={spec} title="案件" source={set} excelAnalysis={analysis} />)
  expect(html).toContain(language === 'ja' ? '案件台帳.xlsx ほか 1 ファイル（5 シート）から 20 行を取り込む' : 'Import 20 rows from 案件台帳.xlsx and 1 other file (5 sheets)')
  expect(html).not.toContain('56')
  const unknown = renderToStaticMarkup(<SpecCard spec={spec} title="案件" source={set} />)
  expect(unknown).not.toContain('20')
})
