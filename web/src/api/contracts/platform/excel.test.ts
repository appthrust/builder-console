// Wire variants (X2) and redaction (X4) of the Excel → app answers: the set's
// list and one stored grid (contracts/platform/excel.ts), and the deep
// structures a draft and its turns carry (the integrated analysis, the UI
// design, the staged analysis progress), read through the operations that
// carry them (contracts/platform/build.ts).
import { describe, expect, test } from 'bun:test'
import { isOneOf, knownValue, type BuildDraft, type BuildTurn } from '../../../model/contracts/build'
import { analysisComplete, completeUiDesign, partValue, type StoredWorkbook, type UiDesign, type WorkbookList } from '../../../model/contracts/excel'
import { assertWireContractCases, type WireContractCase } from '../../testing/wire-contract-cases'
import { createConversationTurnContract, draftFieldPolicies, getApplicationDraftContract } from './build'
import { getWorkbookContract, listWorkbooksContract } from './excel'

const SECRET = 'SENTINEL-excel-wire-5c2e'
const at = '2026-11-13T00:00:00Z'
const WB = 'wb-0123456789ab'

type Json = Record<string, unknown>
const without = (value: Json, key: string): Json => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
/** Nothing the wire said in a value this console does not know may reach the domain value. */
const noSecret = (value: unknown) => expect(JSON.stringify(value)).not.toContain(SECRET)

// ── Wire fixtures, as Platform marshals them ──
const summary = { id: WB, fileName: '受注台帳.xlsx', sheetCount: 1, rowCount: 3, truncated: false, bytes: 420, digest: 'a'.repeat(64), addedAt: at }
const column = { index: 0, header: '顧客', kind: 'text', fill: 1, samples: ['青葉商事'] }
const rule = { column: '金額', expression: '=B2*C2', category: 'calc', rows: 3 }
const sheet = { name: '受注', role: 'records', headerRow: 0, dataRows: 3, columns: [column], rules: [rule], mergedRanges: 0 }
const reading = { workbookId: WB, summary: '受注を一件ずつ記録しています', sheets: [sheet] }
const listWire = (entry: Json = { workbook: summary, reading }) => ({ data: [entry], meta: { total: 1 } })

const grid = { fileName: '受注台帳.xlsx', sheets: [{ name: '受注', rows: [['顧客', '金額'], ['青葉商事', 1200], [null, true]], validations: { 0: ['青葉商事', '緑川工業'] }, formulas: [{ row: 1, column: 1, formula: '=B2*C2' }], mergedRanges: 0 }] }

const field = { name: '顧客', kind: 'text' }
const entity = { name: '受注', kind: 'records', fields: [field, { name: '金額', kind: 'number' }], sources: [{ workbookId: WB, sheet: '受注', headerRow: 0, dataRows: 3, columns: [{ index: 0, field: '顧客' }] }], rules: [rule], importRows: 3 }
const finding = { kind: 'merged', message: '同じ顧客を一つにまとめました', workbookIds: [WB] }
const analysis = { summary: '受注を記録する仕事', bullets: ['受注を一覧で見る'], capabilities: ['entry', 'calculation'], workbooks: [{ workbookId: WB, role: 'records', summary: '受注の記録' }], entities: [entity], flows: [], findings: [finding] }

const list = { layout: 'table', columns: ['顧客', '金額'], searchable: true, filters: [] }
const form = { fields: ['顧客', '金額'], required: ['顧客'], twoColumns: false }
const card = { id: 'count', title: '受注の件数', kind: 'count' }
const design = {
  appName: '受注管理', accent: 'teal', density: 'comfortable',
  screens: [{ id: 'orders', kind: 'list', entity: '受注', title: '受注一覧', hidden: false }, { id: 'home', kind: 'dashboard', entity: '', title: 'ホーム', hidden: false }],
  lists: { 受注: list }, forms: { 受注: form }, dashboard: { cards: [card, { id: 'sum', title: '金額の合計', kind: 'sum', field: '金額' }] }, notes: [],
}
const progress = { stage: 'reading', workbooks: [{ workbookId: WB, state: 'read' }] }

const draftBase = {
  id: 'draft-excel', projectId: 'project-1', title: '受注台帳', intent: 'Excel から作る', phase: 'specifying', specMarkdown: '', architectureMarkdown: '',
  creationExecutions: [], ownerUserId: 'owner-1', createdAt: at, updatedAt: at, source: { kind: 'excel', revision: at, workbooks: [summary] },
}
const draftWire = (patch: Json = {}) => ({ ...draftBase, excelAnalysis: analysis, uiDesign: design, ...patch })
const withAnalysis = (value: unknown) => draftWire({ excelAnalysis: value })
const withDesign = (value: unknown) => draftWire({ uiDesign: value })

const turn = { id: 'turn-1', kind: 'ui-design', status: 'succeeded', startedAt: at, devWorkspaceId: 'ws-1', userMessage: '一覧をカードにして', uiDesign: design, excelProgress: progress }
const operation = { id: 'op-1', type: 'application-draft.conversation-turn', state: 'accepted', writeChannel: 'A', resource: { kind: 'ApplicationDraftConversationTurn', id: 'turn-1', projectId: 'project-1' }, createdAt: at, links: { self: '/api/v1/operations/op-1' } }
/** The turn POST's answer: the turn at the top level (legacy), the receipt and the written `resource`. */
const turnWire = (patch: Json = {}) => {
  const resource = { ...turn, ...patch }
  return { ...resource, operation, resource }
}
const turnWithout = (key: string) => {
  const resource = without(turn, key)
  return { ...resource, operation, resource }
}

/** The draft's registered omissions (absent reads as [], null fails): required by the checker on every case list of the draft read. */
const draftPolicyCases: WireContractCase<BuildDraft>[] = draftFieldPolicies.flatMap((policy) => {
  const key = policy.path.slice(1)
  return [
    { name: `${key} omitted is empty`, variant: 'absent' as const, path: policy.path, wire: without(draftWire(), key), expect: { accept: true as const } },
    { name: `${key} null is a failure`, variant: 'null' as const, path: policy.path, wire: draftWire({ [key]: null }), expect: { accept: false as const, issues: [{ path: policy.path, code: 'invalid_type' as const }] } },
  ]
})

const designOf = (draft: BuildDraft): UiDesign => {
  if (!draft.uiDesign) throw new Error('the draft carries no design')
  return draft.uiDesign
}

describe('workbook set (platformApiListApplicationDraftWorkbooks)', () => {
  test('wire variants', () => {
    assertWireContractCases<WorkbookList>(listWorkbooksContract, [
      {
        name: 'a member with its reading', variant: 'present', path: '/', wire: listWire(),
        expect: {
          accept: true, check: ({ data }) => {
            expect(data[0]?.workbook).toEqual(summary)
            const [read] = data[0]?.reading?.sheets ?? []
            expect(isOneOf(read?.role, 'records')).toBe(true)
            expect(isOneOf(read?.columns[0]?.kind, 'text')).toBe(true)
            expect(isOneOf(read?.rules[0]?.category, 'calc')).toBe(true)
          },
        },
      },
      { name: 'an empty set is []', variant: 'empty', path: '/data', wire: { data: [], meta: { total: 0 } }, expect: { accept: true, value: { data: [] } } },
      { name: 'data is required (the store answers an empty set as [])', variant: 'absent', path: '/data', wire: { meta: { total: 0 } }, expect: { accept: false, issues: [{ path: '/data', code: 'missing' }] } },
      { name: 'null data is a failure, not an empty set', variant: 'null', path: '/data', wire: { data: null, meta: { total: 0 } }, expect: { accept: false, issues: [{ path: '/data', code: 'invalid_type' }] } },
      { name: 'a member the analysis has not read yet', variant: 'absent', path: '/data/*/reading', wire: listWire({ workbook: summary }), expect: { accept: true, check: ({ data }) => expect(data[0]?.reading).toBeUndefined() } },
      { name: 'a null reading is broken, not "not read yet"', variant: 'null', path: '/data/*/reading', wire: listWire({ workbook: summary, reading: null }), expect: { accept: false, issues: [{ path: '/data/*/reading', code: 'invalid_type' }] } },
      { name: 'a reading without sheets is read as it is', variant: 'empty', path: '/data/*/reading/sheets', wire: listWire({ workbook: summary, reading: { ...reading, sheets: [] } }), expect: { accept: true, check: ({ data }) => expect(data[0]?.reading?.sheets).toEqual([]) } },
      { name: 'reading sheets are required', variant: 'absent', path: '/data/*/reading/sheets', wire: listWire({ workbook: summary, reading: without(reading, 'sheets') }), expect: { accept: false, issues: [{ path: '/data/*/reading/sheets', code: 'missing' }] } },
      {
        name: 'fields a newer Platform adds are dropped', variant: 'unknown', path: '/data/*',
        wire: listWire({ workbook: { ...summary, [SECRET]: SECRET }, reading: { ...reading, owner: SECRET, sheets: [{ ...sheet, color: SECRET }] }, hint: SECRET }),
        expect: { accept: true, check: (value) => { expect(value.data[0]?.workbook).toEqual(summary); noSecret(value) } },
      },
      {
        name: 'a sheet role, column kind or rule category this console does not know is unknown, not a known one', variant: 'unknown', path: '/data/*/reading/sheets/*/role',
        wire: listWire({ workbook: summary, reading: { ...reading, sheets: [{ ...sheet, role: SECRET, columns: [{ ...column, kind: SECRET }], rules: [{ ...rule, category: SECRET }] }] } }),
        expect: {
          accept: true, check: (value) => {
            const read = value.data[0]!.reading!.sheets[0]!
            expect([read.role, read.columns[0]!.kind, read.rules[0]!.category]).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }, { kind: 'unknown' }])
            noSecret(value)
          },
        },
      },
      { name: 'a sheet role that is not a string is broken, not unknown', variant: 'unknown', path: '/data/*/reading/sheets/*/role', wire: listWire({ workbook: summary, reading: { ...reading, sheets: [{ ...sheet, role: 3 }] } }), expect: { accept: false, issues: [{ path: '/data/*/reading/sheets/*/role', code: 'invalid_type' }] } },
      { name: 'a column without its kind is broken', variant: 'absent', path: '/data/*/reading/sheets/*/columns/*/kind', wire: listWire({ workbook: summary, reading: { ...reading, sheets: [{ ...sheet, columns: [without(column, 'kind')] }] } }), expect: { accept: false, issues: [{ path: '/data/*/reading/sheets/*/columns/*/kind', code: 'missing' }] } },
      { name: 'a member id outside the id format is broken', variant: 'unknown', path: '/data/*/workbook/id', wire: listWire({ workbook: { ...summary, id: SECRET } }), expect: { accept: false, issues: [{ path: '/data/*/workbook/id', code: 'invalid_value' }] } },
      { name: 'a member without its digest is broken', variant: 'absent', path: '/data/*/workbook/digest', wire: listWire({ workbook: without(summary, 'digest') }), expect: { accept: false, issues: [{ path: '/data/*/workbook/digest', code: 'missing' }] } },
      { name: 'a file name that is not a string is broken', variant: 'unknown', path: '/data/*/workbook/fileName', wire: listWire({ workbook: { ...summary, fileName: { text: SECRET } } }), expect: { accept: false, issues: [{ path: '/data/*/workbook/fileName', code: 'invalid_type' }] } },
      { name: 'a reading for another id format is broken', variant: 'unknown', path: '/data/*/reading/workbookId', wire: listWire({ workbook: summary, reading: { ...reading, workbookId: SECRET } }), expect: { accept: false, issues: [{ path: '/data/*/reading/workbookId', code: 'invalid_value' }] } },
    ])
  })
})

describe('stored grid (platformApiGetApplicationDraftWorkbook)', () => {
  const sheetWith = (patch: Json) => ({ ...grid, sheets: [{ ...grid.sheets[0], ...patch }] })
  const sheetWithout = (key: string) => ({ ...grid, sheets: [without(grid.sheets[0]!, key)] })

  test('wire variants', () => {
    assertWireContractCases<StoredWorkbook>(getWorkbookContract, [
      { name: 'the stored grid is read as it was uploaded', variant: 'present', path: '/', wire: grid, expect: { accept: true, value: grid as StoredWorkbook } },
      { name: 'no validations', variant: 'absent', path: '/sheets/*/validations', wire: sheetWithout('validations'), expect: { accept: true, check: (value) => expect(value.sheets[0]?.validations).toBeUndefined() } },
      { name: 'null validations are broken', variant: 'null', path: '/sheets/*/validations', wire: sheetWith({ validations: null }), expect: { accept: false, issues: [{ path: '/sheets/*/validations', code: 'invalid_type' }] } },
      { name: 'no formulas', variant: 'absent', path: '/sheets/*/formulas', wire: sheetWithout('formulas'), expect: { accept: true, check: (value) => expect(value.sheets[0]?.formulas).toBeUndefined() } },
      { name: 'null formulas are broken', variant: 'null', path: '/sheets/*/formulas', wire: sheetWith({ formulas: null }), expect: { accept: false, issues: [{ path: '/sheets/*/formulas', code: 'invalid_type' }] } },
      { name: 'a sheet without rows', variant: 'empty', path: '/sheets/*/rows', wire: sheetWith({ rows: [] }), expect: { accept: true, check: (value) => expect(value.sheets[0]?.rows).toEqual([]) } },
      { name: 'a grid without sheets is broken (a stored workbook has one)', variant: 'empty', path: '/sheets', wire: { ...grid, sheets: [] }, expect: { accept: false, issues: [{ path: '/sheets', code: 'invalid_value' }] } },
      { name: 'sheets are required', variant: 'absent', path: '/sheets', wire: without(grid, 'sheets'), expect: { accept: false, issues: [{ path: '/sheets', code: 'missing' }] } },
      { name: 'null sheets are broken', variant: 'null', path: '/sheets', wire: { ...grid, sheets: null }, expect: { accept: false, issues: [{ path: '/sheets', code: 'invalid_type' }] } },
      { name: 'fields a newer Platform adds are dropped', variant: 'unknown', path: '/sheets/*', wire: { ...sheetWith({ hiddenRows: [SECRET] }), owner: SECRET }, expect: { accept: true, value: grid as StoredWorkbook } },
      { name: 'a cell that is neither text, number, boolean nor empty is broken', variant: 'unknown', path: '/sheets/*/rows/*/*', wire: sheetWith({ rows: [[{ value: SECRET }]] }), expect: { accept: false } },
      { name: 'a validation keyed by something other than a column index is broken, and the key is not reported', variant: 'unknown', path: '/sheets/*/validations', wire: sheetWith({ validations: { [SECRET]: ['a'] } }), expect: { accept: false } },
      { name: 'a sheet without its name is broken', variant: 'absent', path: '/sheets/*/name', wire: sheetWithout('name'), expect: { accept: false, issues: [{ path: '/sheets/*/name', code: 'missing' }] } },
      { name: 'a file name that is not a string is broken', variant: 'unknown', path: '/fileName', wire: { ...grid, fileName: [SECRET] }, expect: { accept: false, issues: [{ path: '/fileName', code: 'invalid_type' }] } },
    ])
  })
})

describe('integrated analysis on the draft (platformApiGetApplicationDraft /excelAnalysis)', () => {
  test('wire variants', () => {
    assertWireContractCases<BuildDraft>(getApplicationDraftContract, [
      ...draftPolicyCases,
      {
        name: 'the analysis as Platform writes it', variant: 'present', path: '/excelAnalysis', wire: draftWire(),
        expect: {
          accept: true, check: ({ excelAnalysis: read }) => {
            expect(read && analysisComplete(read)).toBe(true)
            expect(read?.capabilities.map((item) => knownValue(item))).toEqual(['entry', 'calculation'])
            expect(isOneOf(read?.entities[0]?.fields[1]?.kind, 'number')).toBe(true)
          },
        },
      },
      { name: 'not analysed yet', variant: 'absent', path: '/excelAnalysis', wire: without(draftWire(), 'excelAnalysis'), expect: { accept: true, check: (draft) => expect(draft.excelAnalysis).toBeUndefined() } },
      { name: 'a null analysis is broken, not "not analysed"', variant: 'null', path: '/excelAnalysis', wire: withAnalysis(null), expect: { accept: false, issues: [{ path: '/excelAnalysis', code: 'invalid_type' }] } },
      { name: 'no entities, findings or capabilities', variant: 'empty', path: '/excelAnalysis/entities', wire: withAnalysis({ ...analysis, entities: [], findings: [], capabilities: [] }), expect: { accept: true, check: ({ excelAnalysis: read }) => expect([read?.entities, read?.findings, read?.capabilities]).toEqual([[], [], []]) } },
      { name: 'an analysis of no workbook is broken (one entry per member)', variant: 'empty', path: '/excelAnalysis/workbooks', wire: withAnalysis({ ...analysis, workbooks: [] }), expect: { accept: false, issues: [{ path: '/excelAnalysis/workbooks', code: 'invalid_value' }] } },
      { name: 'entities are required (Go never omits them)', variant: 'absent', path: '/excelAnalysis/entities', wire: withAnalysis(without(analysis, 'entities')), expect: { accept: false, issues: [{ path: '/excelAnalysis/entities', code: 'missing' }] } },
      { name: 'null findings are a failure, not "no findings"', variant: 'null', path: '/excelAnalysis/findings', wire: withAnalysis({ ...analysis, findings: null }), expect: { accept: false, issues: [{ path: '/excelAnalysis/findings', code: 'invalid_type' }] } },
      {
        name: 'fields a newer Platform adds are dropped', variant: 'unknown', path: '/excelAnalysis/entities/*',
        wire: withAnalysis({ ...analysis, confidence: SECRET, entities: [{ ...entity, owner: SECRET, fields: [{ ...field, [SECRET]: true }] }] }),
        expect: { accept: true, check: (draft) => { expect(draft.excelAnalysis?.entities[0]?.fields[0]).toEqual({ name: '顧客', kind: { kind: 'known', value: 'text' } }); noSecret(draft) } },
      },
      {
        name: 'a capability, workbook role, entity kind, field kind, rule category or finding kind this console does not know is unknown, and the analysis is not complete', variant: 'unknown', path: '/excelAnalysis/entities/*/kind',
        wire: withAnalysis({
          ...analysis, capabilities: ['entry', SECRET], workbooks: [{ workbookId: WB, role: SECRET, summary: '受注の記録' }],
          entities: [{ ...entity, kind: SECRET, fields: [{ ...field, kind: SECRET }], rules: [{ ...rule, category: SECRET }] }], findings: [{ ...finding, kind: SECRET }],
        }),
        expect: {
          accept: true, check: ({ excelAnalysis: read }) => {
            expect(read?.capabilities).toEqual([{ kind: 'known', value: 'entry' }, { kind: 'unknown' }])
            const [first] = read!.entities
            expect([read!.workbooks[0]!.role, first!.kind, first!.fields[0]!.kind, first!.rules[0]!.category, read!.findings[0]!.kind]).toEqual(Array(5).fill({ kind: 'unknown' }))
            expect(analysisComplete(read!)).toBe(false)
            noSecret(read)
          },
        },
      },
      { name: 'a capability that is not a string is broken, not unknown', variant: 'unknown', path: '/excelAnalysis/capabilities', wire: withAnalysis({ ...analysis, capabilities: [7] }), expect: { accept: false, issues: [{ path: '/excelAnalysis/capabilities/*', code: 'invalid_type' }] } },
      { name: 'an entity without fields is broken', variant: 'empty', path: '/excelAnalysis/entities/*/fields', wire: withAnalysis({ ...analysis, entities: [{ ...entity, fields: [] }] }), expect: { accept: false, issues: [{ path: '/excelAnalysis/entities/*/fields', code: 'invalid_value' }] } },
      { name: 'an entity without its name is broken', variant: 'absent', path: '/excelAnalysis/entities/*/name', wire: withAnalysis({ ...analysis, entities: [without(entity, 'name')] }), expect: { accept: false, issues: [{ path: '/excelAnalysis/entities/*/name', code: 'missing' }] } },
      { name: 'a workbook entry for an id outside the format is broken', variant: 'unknown', path: '/excelAnalysis/workbooks/*/workbookId', wire: withAnalysis({ ...analysis, workbooks: [{ workbookId: SECRET, role: 'records', summary: '' }] }), expect: { accept: false, issues: [{ path: '/excelAnalysis/workbooks/*/workbookId', code: 'invalid_value' }] } },
      { name: 'a summary that is not a string is broken', variant: 'unknown', path: '/excelAnalysis/summary', wire: withAnalysis({ ...analysis, summary: { text: SECRET } }), expect: { accept: false, issues: [{ path: '/excelAnalysis/summary', code: 'invalid_type' }] } },
    ])
  })
})

describe('UI design on the draft (platformApiGetApplicationDraft /uiDesign)', () => {
  test('wire variants', () => {
    assertWireContractCases<BuildDraft>(getApplicationDraftContract, [
      ...draftPolicyCases,
      { name: 'the design as Platform writes it is complete', variant: 'present', path: '/uiDesign', wire: draftWire(), expect: { accept: true, check: (draft) => expect(completeUiDesign(designOf(draft))).toEqual(design as never) } },
      { name: 'no design yet', variant: 'absent', path: '/uiDesign', wire: without(draftWire(), 'uiDesign'), expect: { accept: true, check: (draft) => expect(draft.uiDesign).toBeUndefined() } },
      { name: 'a null design is broken, not "no design"', variant: 'null', path: '/uiDesign', wire: withDesign(null), expect: { accept: false, issues: [{ path: '/uiDesign', code: 'invalid_type' }] } },
      {
        name: 'no screens, lists, forms, cards or notes', variant: 'empty', path: '/uiDesign/screens',
        wire: withDesign({ ...design, screens: [], lists: {}, forms: {}, dashboard: { cards: [] } }),
        expect: { accept: true, check: (draft) => { const read = designOf(draft); expect([read.screens, read.lists, read.forms, read.dashboard]).toEqual([[], {}, {}, { state: 'ok', value: [] }]) } },
      },
      { name: 'screens are required', variant: 'absent', path: '/uiDesign/screens', wire: withDesign(without(design, 'screens')), expect: { accept: false, issues: [{ path: '/uiDesign/screens', code: 'missing' }] } },
      { name: 'null screens are a failure', variant: 'null', path: '/uiDesign/screens', wire: withDesign({ ...design, screens: null }), expect: { accept: false, issues: [{ path: '/uiDesign/screens', code: 'invalid_type' }] } },
      { name: 'lists are required', variant: 'absent', path: '/uiDesign/lists', wire: withDesign(without(design, 'lists')), expect: { accept: false, issues: [{ path: '/uiDesign/lists', code: 'missing' }] } },
      { name: 'the dashboard\'s cards are required (presence is not a part\'s shape)', variant: 'absent', path: '/uiDesign/dashboard/cards', wire: withDesign({ ...design, dashboard: {} }), expect: { accept: false, issues: [{ path: '/uiDesign/dashboard/cards', code: 'missing' }] } },
      {
        name: 'fields a newer Platform adds are dropped', variant: 'unknown', path: '/uiDesign',
        wire: withDesign({ ...design, theme: SECRET, screens: [{ ...design.screens[0], icon: SECRET }], lists: { 受注: { ...list, pageSize: SECRET } }, dashboard: { cards: [{ ...card, color: SECRET }], layout: SECRET } }),
        expect: { accept: true, check: (draft) => { expect(completeUiDesign(designOf(draft))).toBeDefined(); noSecret(draft) } },
      },
      {
        name: 'an accent, density, screen kind, list layout or card kind this console does not know is unknown; the rest is kept and the design is not complete', variant: 'unknown', path: '/uiDesign/dashboard/cards/*/kind',
        wire: withDesign({ ...design, accent: SECRET, density: SECRET, screens: [{ ...design.screens[0], kind: SECRET }, design.screens[1]], lists: { 受注: { ...list, layout: SECRET } }, dashboard: { cards: [{ ...card, kind: SECRET }, design.dashboard.cards[1]] } }),
        expect: {
          accept: true, check: (draft) => {
            const read = designOf(draft)
            expect([read.accent, read.density, read.screens[0]!.kind, partValue(read.lists['受注'])!.layout, partValue(read.dashboard)![0]!.kind]).toEqual(Array(5).fill({ kind: 'unknown' }))
            expect(read.screens[1]).toEqual({ ...design.screens[1]!, kind: { kind: 'known', value: 'dashboard' } })
            expect(partValue(read.dashboard)![1]).toEqual({ id: 'sum', title: '金額の合計', kind: { kind: 'known', value: 'sum' }, field: '金額' })
            expect(completeUiDesign(read)).toBeUndefined()
            noSecret(draft)
          },
        },
      },
      {
        name: 'a list in a shape this console cannot read is broken on its own; the form and the dashboard stay readable', variant: 'unknown', path: '/uiDesign/lists',
        wire: withDesign({ ...design, lists: { 受注: { ...list, columns: SECRET }, 顧客: list } }),
        expect: {
          accept: true, check: (draft) => {
            const read = designOf(draft)
            expect(read.lists['受注']).toEqual({ state: 'broken' })
            expect(partValue(read.lists['顧客'])?.columns).toEqual(list.columns)
            expect(read.forms['受注']).toEqual({ state: 'ok', value: form })
            expect(read.dashboard.state).toBe('ok')
            expect(completeUiDesign(read)).toBeUndefined()
            noSecret(draft)
          },
        },
      },
      {
        name: 'a null form part is broken, not "no form"', variant: 'null', path: '/uiDesign/forms',
        wire: withDesign({ ...design, forms: { 受注: null } }),
        expect: { accept: true, check: (draft) => { expect(designOf(draft).forms['受注']).toEqual({ state: 'broken' }); expect(completeUiDesign(designOf(draft))).toBeUndefined() } },
      },
      {
        name: 'unreadable dashboard cards break the dashboard part only', variant: 'unknown', path: '/uiDesign/dashboard/cards',
        wire: withDesign({ ...design, dashboard: { cards: [{ ...card, title: { text: SECRET } }] } }),
        expect: {
          accept: true, check: (draft) => {
            const read = designOf(draft)
            expect(read.dashboard).toEqual({ state: 'broken' })
            expect(partValue(read.lists['受注'])?.columns).toEqual(list.columns)
            expect(read.screens).toHaveLength(2)
            noSecret(draft)
          },
        },
      },
      { name: 'an accent that is not a string is broken, not unknown', variant: 'unknown', path: '/uiDesign/accent', wire: withDesign({ ...design, accent: 1 }), expect: { accept: false, issues: [{ path: '/uiDesign/accent', code: 'invalid_type' }] } },
      { name: 'a screen without its id is broken', variant: 'absent', path: '/uiDesign/screens/*/id', wire: withDesign({ ...design, screens: [without(design.screens[0]!, 'id')] }), expect: { accept: false, issues: [{ path: '/uiDesign/screens/*/id', code: 'missing' }] } },
      { name: 'an app name that is not a string is broken', variant: 'unknown', path: '/uiDesign/appName', wire: withDesign({ ...design, appName: { text: SECRET } }), expect: { accept: false, issues: [{ path: '/uiDesign/appName', code: 'invalid_type' }] } },
    ])
  })
})

describe('UI design and analysis progress on a turn (platformApiCreateApplicationDraftConversationTurn /resource)', () => {
  test('wire variants', () => {
    assertWireContractCases<BuildTurn>(createConversationTurnContract, [
      {
        name: 'the written turn with its design and progress', variant: 'present', path: '/resource', wire: turnWire(),
        expect: {
          accept: true, check: (read) => {
            expect(read.uiDesign && completeUiDesign(read.uiDesign)).toEqual(design as never)
            expect(read.excelProgress).toEqual({ stage: { kind: 'known', value: 'reading' }, workbooks: [{ workbookId: WB, state: { kind: 'known', value: 'read' } }] })
          },
        },
      },
      { name: 'a turn without a design', variant: 'absent', path: '/resource/uiDesign', wire: turnWithout('uiDesign'), expect: { accept: true, check: (read) => expect(read.uiDesign).toBeUndefined() } },
      { name: 'a null design on a turn is broken', variant: 'null', path: '/resource/uiDesign', wire: turnWire({ uiDesign: null }), expect: { accept: false, issues: [{ path: '/resource/uiDesign', code: 'invalid_type' }] } },
      {
        name: 'a turn\'s design with an unknown card kind keeps its other cards', variant: 'unknown', path: '/resource/uiDesign/dashboard/cards/*/kind',
        wire: turnWire({ uiDesign: { ...design, dashboard: { cards: [{ ...card, kind: SECRET }, design.dashboard.cards[1]] } } }),
        expect: { accept: true, check: (read) => { expect(partValue(read.uiDesign!.dashboard)?.map((item) => item.kind)).toEqual([{ kind: 'unknown' }, { kind: 'known', value: 'sum' }]); noSecret(read) } },
      },
      { name: 'no progress (not a staged turn)', variant: 'absent', path: '/resource/excelProgress', wire: turnWithout('excelProgress'), expect: { accept: true, check: (read) => expect(read.excelProgress).toBeUndefined() } },
      { name: 'null progress is broken', variant: 'null', path: '/resource/excelProgress', wire: turnWire({ excelProgress: null }), expect: { accept: false, issues: [{ path: '/resource/excelProgress', code: 'invalid_type' }] } },
      { name: 'progress before any workbook is read', variant: 'empty', path: '/resource/excelProgress/workbooks', wire: turnWire({ excelProgress: { stage: 'syncing', workbooks: [] } }), expect: { accept: true, check: (read) => expect(read.excelProgress?.workbooks).toEqual([]) } },
      { name: 'progress workbooks are required', variant: 'absent', path: '/resource/excelProgress/workbooks', wire: turnWire({ excelProgress: { stage: 'syncing' } }), expect: { accept: false, issues: [{ path: '/resource/excelProgress/workbooks', code: 'missing' }] } },
      { name: 'null progress workbooks are a failure', variant: 'null', path: '/resource/excelProgress/workbooks', wire: turnWire({ excelProgress: { stage: 'syncing', workbooks: null } }), expect: { accept: false, issues: [{ path: '/resource/excelProgress/workbooks', code: 'invalid_type' }] } },
      {
        name: 'a stage or workbook state this console does not know is unknown, not a known one', variant: 'unknown', path: '/resource/excelProgress/stage',
        wire: turnWire({ excelProgress: { stage: SECRET, workbooks: [{ workbookId: WB, state: SECRET }], eta: SECRET } }),
        expect: { accept: true, check: (read) => { expect(read.excelProgress).toEqual({ stage: { kind: 'unknown' }, workbooks: [{ workbookId: WB, state: { kind: 'unknown' } }] }); noSecret(read) } },
      },
      { name: 'a stage that is not a string is broken, not unknown', variant: 'unknown', path: '/resource/excelProgress/stage', wire: turnWire({ excelProgress: { ...progress, stage: 2 } }), expect: { accept: false, issues: [{ path: '/resource/excelProgress/stage', code: 'invalid_type' }] } },
      { name: 'a progress entry for an id outside the format is broken', variant: 'unknown', path: '/resource/excelProgress/workbooks/*/workbookId', wire: turnWire({ excelProgress: { ...progress, workbooks: [{ workbookId: SECRET, state: 'read' }] } }), expect: { accept: false, issues: [{ path: '/resource/excelProgress/workbooks/*/workbookId', code: 'invalid_value' }] } },
      { name: 'a progress entry without its state is broken', variant: 'absent', path: '/resource/excelProgress/workbooks/*/state', wire: turnWire({ excelProgress: { ...progress, workbooks: [{ workbookId: WB }] } }), expect: { accept: false, issues: [{ path: '/resource/excelProgress/workbooks/*/state', code: 'missing' }] } },
    ])
  })
})
