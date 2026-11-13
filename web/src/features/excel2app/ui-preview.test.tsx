import { afterEach, beforeEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
import { isOneOf } from '../../model/contracts/build'
import { excelAnalysisOf, uiDesignOf, type CompleteUiDesign, type UiDesign } from '../../model/contracts/excel'
import { designFrom } from '../../api/testing/excel-domain'
import { designFromReadings } from './design'
import { planApp } from './model'
import { previewTextJa } from './preview-copy'
import { SAMPLE_SETS } from './samples'
import { defaultUiDesign, screenId } from './ui-design'
import { UiPreview } from './ui-preview'

let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())

const workbook = SAMPLE_SETS.find((sample) => sample.id === 'defects')!.workbooks[0]!
const summary = { id: 'wb-000000000001', fileName: workbook.fileName, sheetCount: 3, rowCount: 28, truncated: false, bytes: 100, digest: 'a'.repeat(64), addedAt: '2026-10-26T00:01:00Z' }
const grids = new Map([[summary.id, workbook]])
const plan = planApp(excelAnalysisOf(designFromReadings([{ summary, grid: workbook }])), '不具合管理台帳')
const ENTITY = '不具合一覧'

// No `today`: the page mounts the preview without one, so overdue counts use the default 2026-10-26.
// A design built here is read through the same constructor as the server's.
const render = (id: string, design: CompleteUiDesign = defaultUiDesign(plan)) =>
  renderToStaticMarkup(<UiPreview plan={plan} design={uiDesignOf(design)} grids={grids} screenId={id} onScreenChange={() => {}} />)

/** A design as a newer (or broken) Platform might send it: the local default with `change` applied, read by the production reader. */
const SECRET = 'SENTINEL-design-5c1e'
const served = (change: (wire: CompleteUiDesign) => unknown) => designFrom(change(structuredClone(defaultUiDesign(plan))))
const renderServed = (id: string, design: UiDesign, analysisPlan = plan) =>
  renderToStaticMarkup(<UiPreview plan={analysisPlan} design={design} grids={grids} screenId={id} onScreenChange={() => {}} />)

const count = (html: string, needle: string) => html.split(needle).length - 1

test('the list shows real rows, newest first, with a colored pill per 状態', () => {
  const html = render(screenId('list', ENTITY))
  expect(html).toContain('data-testid="excel2app-ui-preview-screen-list"')
  expect(html).toContain('data-layout="table"')
  // The screen scrolls inside the frame and is reachable by keyboard.
  expect(html).toMatch(/role="region" aria-label="不具合一覧[^"]*" tabindex="0" class="[^"]*overflow-y-auto/)
  expect(html).toContain(previewTextJa.address('不具合管理台帳'))
  for (const stage of ['未着手', '対策中', '対策完了']) expect(html).toContain(`data-pill="${stage}"`)
  expect(html).toContain('bg-stone-100 text-stone-700')
  expect(html).toContain('bg-amber-50 text-amber-800')
  // At most 8 of the 12 rows; the newest (2026-10-23, 穴位置ずれ) first.
  expect(count(html, '<tr class="text-stone-800')).toBe(8)
  expect(html.indexOf('2026/10/23')).toBeLessThan(html.indexOf('2026/10/20'))
  expect(html).toContain(previewTextJa.shown(8, 12))
  // Search box and the 状態/工程 filter chips with their options.
  expect(html).toContain(`placeholder="${previewTextJa.search}"`)
  expect(html).toContain(previewTextJa.filterAll('状態'))
  expect(html).toContain(previewTextJa.filterValue('工程', '熱処理'))
  // Overdue open deadlines are flagged; 対策中 #7 (10/16) is past 2026-10-26.
  expect(html).toContain(previewTextJa.overdueSince(10))
})

test('cards layout, grouping and accent follow the design', () => {
  const base = defaultUiDesign(plan)
  const design: CompleteUiDesign = { ...base, accent: 'blue', density: 'compact', lists: { ...base.lists, [ENTITY]: { ...base.lists[ENTITY], layout: 'cards', groupBy: '工程', searchable: false, filters: [] } } }
  const html = render(screenId('list', ENTITY), design)
  expect(html).not.toContain('<table')
  expect(html).toContain('data-layout="cards"')
  expect(html).toContain('bg-blue-600')
  expect(html).not.toContain('bg-teal-600')
  expect(html).not.toContain(`placeholder="${previewTextJa.search}"`)
  for (const process of ['熱処理', 'プレス']) expect(html).toContain(`<span class="font-semibold text-stone-800">${process}</span>`)
  expect(html).toContain('px-4 py-3.5')
})

test('the board has one column per workflow stage with the rows in it', () => {
  const html = render(screenId('board', ENTITY))
  const stages = [...html.matchAll(/data-stage="([^"]+)"/g)].map((match) => match[1])
  expect(stages).toEqual(['未着手', '対策中', '対策完了', '完了確認済'])
  expect(html).toContain('ダンパープレートの穴位置ずれ')
  expect(html).toContain('クラッチディスク ハブの焼入れ硬さ不足')
})

test('the dashboard computes count, 状態別, 数量の合計 and overdue from the rows', () => {
  const html = render(screenId('dashboard', ENTITY))
  expect([...html.matchAll(/data-card="([^"]+)"/g)].map((match) => match[1])).toEqual(['count', 'countBy', 'sum', 'overdue'])
  expect(html).toContain('>12</span>')
  expect(html).toContain(previewTextJa.doneOf(6, 12))
  expect([...html.matchAll(/data-count="(\d+)"/g)].map((match) => Number(match[1]))).toEqual([3, 3, 3, 3])
  expect(html).toContain('>559</span>')
  // Open rows past 期限 on 2026-10-26: #7 (10/16) and #8 (10/23).
  expect(html).toContain(previewTextJa.overdueSince(10))
  expect(html).toContain(previewTextJa.overdueSince(3))
  expect(html).toContain(previewTextJa.asOf('2026/10/26'))
})

test('the form renders inputs by field kind, required marks and the column layout', () => {
  const html = render(screenId('form', ENTITY))
  expect(html).toContain('type="date"')
  expect(html).toContain('<option value="HT-01">HT-01 — 連続浸炭炉 1 号</option>')
  expect(html).toContain('<option value="金型">金型</option>')
  expect(html).toContain('type="number"')
  expect(html).toContain('<textarea')
  expect(html).toContain('type="file"')
  expect(html).toContain(previewTextJa.personPlaceholder)
  expect(count(html, `（${previewTextJa.required}）`)).toBe(defaultUiDesign(plan).forms[ENTITY].required.length)
  expect(html).toContain('@lg:grid-cols-2')
  const base = defaultUiDesign(plan)
  const single = render(screenId('form', ENTITY), { ...base, forms: { [ENTITY]: { ...base.forms[ENTITY], twoColumns: false } } })
  expect(single).not.toContain('@lg:grid-cols-2')
})

test('detail shows the workbook first row; master lists the master sheet; hidden screens leave the nav', () => {
  const detail = render(screenId('detail', ENTITY))
  expect(detail).toContain('クラッチディスク ハブの焼入れ硬さ不足')
  expect(detail).not.toContain('ダンパープレートの穴位置ずれ')
  expect(detail).toContain('aria-current="step"')
  const master = render(screenId('master', '設備マスタ'))
  expect(master).toContain('800t トランスファープレス')
  const base = defaultUiDesign(plan)
  const hidden = render(screenId('board', ENTITY), { ...base, screens: base.screens.map((screen) => (screen.kind === 'board' ? { ...screen, hidden: true } : screen)) })
  expect(hidden).not.toContain('excel2app-ui-preview-nav-board')
  expect(hidden).toContain('data-testid="excel2app-ui-preview-screen-dashboard"')
})

test('preview chrome switches to English', () => {
  setLanguage('en')
  const html = render(screenId('list', ENTITY))
  expect(html).toContain('placeholder="Search by keyword"')
  expect(html).toContain('Showing 8 of 12')
})

test('merged entity rows and master labels come from every mapped workbook, not entity-named sheets', () => {
  const inputs = [
    { summary: { ...summary, id: 'wb-000000000002', fileName: 'April.xlsx' }, grid: { fileName: 'April.xlsx', sheets: [{ name: '台帳', rows: [['番号', '顧客コード', '内容'], ['A-1', 'C-1', 'April item']] }] } },
    { summary: { ...summary, id: 'wb-000000000003', fileName: 'May.xlsx' }, grid: { fileName: 'May.xlsx', sheets: [{ name: '台帳', rows: [['番号', '顧客コード', '内容'], ['M-1', 'C-2', 'May item']] }] } },
    { summary: { ...summary, id: 'wb-000000000004', fileName: 'Customers.xlsx' }, grid: { fileName: 'Customers.xlsx', sheets: [{ name: '顧客マスタ', rows: [['顧客コード', '顧客名'], ['C-1', 'April customer'], ['C-2', 'May customer']] }] } },
  ]
  const analysis = designFromReadings(inputs)
  const renamed = { ...analysis, entities: analysis.entities.map((entity) => ({
    ...entity, name: entity.kind === 'records' ? '受注' : '顧客',
    fields: entity.fields.map((field) => field.referenceEntity ? { ...field, referenceEntity: '顧客' } : field),
  })) }
  const plan = planApp(excelAnalysisOf(renamed), 'Orders')
  const entity = plan.entities.find((entity) => isOneOf(entity.kind, 'records'))!
  expect(entity.sources).toHaveLength(2)
  expect(entity.fields.find((field) => field.name === '顧客コード')?.referenceEntity).toBe('顧客')
  const grids = new Map(inputs.map((input) => [input.summary.id, input.grid]))
  const html = renderToStaticMarkup(<UiPreview plan={plan} design={uiDesignOf(defaultUiDesign(plan))} grids={grids} screenId={screenId('list', entity.name)} onScreenChange={() => {}} />)
  expect(html).toContain('April item')
  expect(html).toContain('May item')
  const form = renderToStaticMarkup(<UiPreview plan={plan} design={uiDesignOf(defaultUiDesign(plan))} grids={grids} screenId={screenId('form', entity.name)} onScreenChange={() => {}} />)
  expect(form).toContain('C-1 — April customer')
  expect(form).toContain('C-2 — May customer')
})

test('a screen of a kind this console does not know keeps its place with a fixed note; the other screens render', () => {
  const design = served((wire) => ({ ...wire, screens: [...wire.screens, { id: `calendar:${ENTITY}`, kind: 'calendar', entity: ENTITY, title: '予定表', hidden: false }] }))
  const unknown = renderServed(`calendar:${ENTITY}`, design)
  expect(unknown).toContain('data-testid="excel2app-ui-preview-nav-unsupported"')
  expect(unknown).toContain('data-testid="excel2app-ui-preview-screen-unsupported"')
  expect(unknown).toContain(previewTextJa.unsupported)
  expect(unknown).toContain('予定表')
  const list = renderServed(screenId('list', ENTITY), design)
  expect(list).toContain('data-layout="table"')
  expect(list).toContain(previewTextJa.shown(8, 12))
})

test('a dashboard in a shape this console cannot read shows the fixed error there only; no payload is shown', () => {
  const design = served((wire) => ({ ...wire, dashboard: { cards: SECRET } }))
  expect(design.dashboard).toEqual({ state: 'broken' })
  const dashboard = renderServed(screenId('dashboard', ENTITY), design)
  expect(dashboard).toContain('data-testid="excel2app-ui-preview-broken"')
  expect(dashboard).toContain(previewTextJa.broken)
  expect(dashboard).not.toContain(SECRET)
  expect(renderServed(screenId('list', ENTITY), design)).toContain(previewTextJa.shown(8, 12))
  expect(renderServed(screenId('form', ENTITY), design)).toContain('<form')
})

test('one broken list shows the fixed error on its screen; its form and detail stay usable', () => {
  const design = served((wire) => ({ ...wire, lists: { ...wire.lists, [ENTITY]: { ...wire.lists[ENTITY], columns: [SECRET, 3] } } }))
  const list = renderServed(screenId('list', ENTITY), design)
  expect(list).toContain(previewTextJa.broken)
  expect(list).not.toContain(SECRET)
  expect(list).not.toContain('<table')
  expect(renderServed(screenId('form', ENTITY), design)).toContain('<form')
  expect(renderServed(screenId('detail', ENTITY), design)).toContain('クラッチディスク ハブの焼入れ硬さ不足')
})

test('an unknown list layout or card kind is a local unsupported part, never read as a table or a count', () => {
  const design = served((wire) => ({
    ...wire,
    lists: { ...wire.lists, [ENTITY]: { ...wire.lists[ENTITY], layout: 'timeline' } },
    dashboard: { cards: [...wire.dashboard.cards, { id: 'forecast', title: '来月の見込み', kind: 'forecast' }] },
  }))
  const list = renderServed(screenId('list', ENTITY), design)
  expect(list).toContain(previewTextJa.unsupported)
  expect(list).not.toContain('data-layout')
  const dashboard = renderServed(screenId('dashboard', ENTITY), design)
  expect(dashboard).toContain('data-card="unsupported"')
  expect(dashboard).toContain('来月の見込み')
  expect(dashboard).toContain('data-card="count"')
})

test('a field of an unknown kind shows its cell text in lists and no guessed input in forms', () => {
  const analysis = excelAnalysisOf(designFromReadings([{ summary, grid: workbook }]))
  const entity = analysis.entities.find((item) => item.name === ENTITY)!
  const target = entity.fields.find((field) => isOneOf(field.kind, 'date'))!
  const unknownPlan = planApp({ ...analysis, entities: analysis.entities.map((item) => item === entity ? { ...item, fields: item.fields.map((field) => field === target ? { ...field, kind: { kind: 'unknown' as const } } : field) } : item) }, '不具合管理台帳')
  const design = uiDesignOf(defaultUiDesign(plan))
  const form = renderServed(screenId('form', ENTITY), design, unknownPlan)
  // The field keeps its place in the form; its control is the fixed note, not a guessed date input.
  const field = form.slice(form.indexOf(`data-field="${target.name}"`)).split('data-field=')[1]!
  expect(field).toContain('data-testid="excel2app-ui-preview-unsupported-field"')
  expect(field).not.toContain('type="date"')
  const list = renderServed(screenId('list', ENTITY), design, unknownPlan)
  expect(list).toContain(previewTextJa.shown(8, 12))
})
