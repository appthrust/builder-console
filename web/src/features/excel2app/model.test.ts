import { describe, expect, test } from 'bun:test'
import type { ExcelAnalysisEntity } from '@appthrust/api-schema/platform-api'
import { analysisFrom } from '../../api/testing/excel-domain'
import { entityRows, findHeaderRow, humanizeFormula, planApp, readWorkbook, type WorkbookGrid } from './model'
import { SAMPLE_SETS } from './samples'
import { isDateFormat, parseCellValue, parseRangeReference, serialToDate, shiftFormula, workbookPartPath } from './xlsx'

const kinds = (workbook: WorkbookGrid, sheet: string) => Object.fromEntries(readWorkbook(workbook).sheets.find((item) => item.name === sheet)!.columns.map((column) => [column.header, column.kind]))

describe('readWorkbook', () => {
  test('a title row above the header is skipped', () => {
    expect(findHeaderRow([['2026年度 点検表', null, null], [null, null, null], ['点検日', '設備', '結果'], [new Date(), 'HT-01', '○']])).toBe(2)
  })

  test('column kinds come from values, headers and validation lists', () => {
    const workbook: WorkbookGrid = {
      fileName: 'x.xlsx',
      sheets: [{
        name: '記録',
        rows: [
          ['No', '日付', '担当者', '完了', '区分', '金額', '写真', '品番', '担当課'],
          [1, new Date('2026-01-01T00:00:00Z'), '佐藤', '○', 'A', 1200, null, 'EX-1', '品証'],
          [2, '2026-01-02', '鈴木', '×', 'B', '3,400', null, 'EX-2', '製造'],
        ],
        validations: { 4: ['A', 'B', 'C'] },
      }],
    }
    expect(kinds(workbook, '記録')).toEqual({ No: 'id', 日付: 'date', 担当者: 'person', 完了: 'boolean', 区分: 'choice', 金額: 'number', 写真: 'attachment', 品番: 'text', 担当課: 'text' })
  })

  test('values that all exist on a master sheet are a reference, also when fed by a validation list', () => {
    const workbook: WorkbookGrid = {
      fileName: 'x.xlsx',
      sheets: [
        { name: '台帳', rows: [['設備', '得意先'], ['HT-01', 'A社'], ['PR-12', 'B社']], validations: { 1: ['A社', 'B社', 'C社'] } },
        { name: '設備マスタ', rows: [['設備コード', '設備名'], ['HT-01', '炉 1 号'], ['PR-12', 'プレス']] },
        { name: '得意先マスタ', rows: [['得意先'], ['A社'], ['B社'], ['C社']] },
      ],
    }
    const reading = readWorkbook(workbook)
    const ledger = reading.sheets[0]
    expect(ledger.columns.map((column) => [column.kind, column.referenceSheet])).toEqual([['reference', '設備マスタ'], ['reference', '得意先マスタ']])
    // A master never references itself.
    expect(kinds(workbook, '設備マスタ')).toEqual({ 設備コード: 'text', 設備名: 'text' })
    expect(reading.sheets.map((sheet) => sheet.role)).toEqual(['records', 'master', 'master'])
  })

  test('formulas become humanized rules; a formula-dominated sheet is a summary', () => {
    const workbook: WorkbookGrid = {
      fileName: 'x.xlsx',
      sheets: [
        {
          name: '受注',
          rows: [['数量', '単価', '金額'], [2, 100, 200], [3, 50, 150]],
          formulas: [{ row: 1, column: 2, formula: 'A2*B2' }, { row: 2, column: 2, formula: 'A3*B3' }],
        },
        {
          name: '集計',
          rows: [['件数', '合計'], [null, null]],
          formulas: [{ row: 1, column: 0, formula: "COUNTA('受注'!A:A)" }, { row: 1, column: 1, formula: 'SUM(受注!C:C)' }],
        },
      ],
    }
    const [orders, summary] = readWorkbook(workbook).sheets
    expect(orders.columns[2].kind).toBe('formula')
    expect(orders.rules).toEqual([{ column: '金額', expression: '数量 × 単価', category: 'calc', rows: 2 }])
    expect(summary.role).toBe('summary')
    expect(summary.rules.map((rule) => rule.expression)).toEqual(['件数(受注の数量)', '合計(受注の金額)'])
    expect(summary.rules.every((rule) => rule.category === 'aggregate')).toBe(true)
  })

  test('a status choice column supplies workflow evidence and capabilities', () => {
    const reading = readWorkbook(SAMPLE_SETS[0].workbooks[0])
    expect(reading.sheets[0].workflow).toEqual({ column: '状態', stages: ['未着手', '対策中', '対策完了', '完了確認済'] })
    expect(reading.capabilities).toEqual(['entry', 'choices', 'calculation', 'lookup', 'aggregate', 'workflow', 'deadlines'])
  })

  test('sparse rows and columns preserve positions and count formula-only rows', () => {
    const rows: WorkbookGrid['sheets'][number]['rows'] = []
    rows[0] = ['年度別台帳']
    rows[3] = [null, '番号', null, '金額', '計算']
    rows[5] = [null, 1, null, 45000]
    const masterRows: WorkbookGrid['sheets'][number]['rows'] = [['コード', '名称']]
    masterRows[2] = ['X', '商品 X']
    const reading = readWorkbook({
      fileName: 'sparse.xlsx',
      sheets: [
        { name: '台帳', rows, formulas: [{ row: 7, column: 4, formula: 'D8*2' }] },
        { name: '商品マスタ', rows: masterRows },
      ],
    })
    expect(reading.sheets[0].headerRow).toBe(3)
    expect(reading.sheets[0].dataRows).toBe(2)
    expect(reading.sheets[0].columns.map(({ index, kind, fill }) => ({ index, kind, fill }))).toEqual([
      { index: 1, kind: 'id', fill: 0.5 },
      { index: 3, kind: 'number', fill: 0.5 },
      { index: 4, kind: 'formula', fill: 0 },
    ])
  })

  test('a wide header wins over a sparse title and dates require date evidence', () => {
    const rows = [['2026年度', null, '営業部'], [], ['番号', '金額', '受注日', '担当者'], [1, 46000, 46000, '佐藤']]
    expect(findHeaderRow(rows)).toBe(2)
    expect(kinds({ fileName: 'x.xlsx', sheets: [{ name: '受注', rows }] }, '受注')).toEqual({
      番号: 'id', 金額: 'number', 受注日: 'date', 担当者: 'person',
    })
  })

  test('formula grouping and categorization ignore strings and function prefixes', () => {
    const reading = readWorkbook({
      fileName: 'rules.xlsx',
      sheets: [{
        name: '台帳',
        rows: [['数量', '結果'], [2], [3], [4]],
        formulas: [
          { row: 1, column: 1, formula: '_xlfn.IFERROR(A2,"A2/*")' },
          { row: 2, column: 1, formula: 'IFERROR(A3,"A2/*")' },
          { row: 3, column: 1, formula: 'IFERROR(A4,"A3/*")' },
          { row: 4, column: 1, formula: "'A1'!A5+$A$1" },
          { row: 5, column: 1, formula: "'A2'!A6+$A$1" },
          { row: 6, column: 1, formula: "'A2'!A7+$A$2" },
        ],
      }],
    })
    expect(reading.sheets[0].rules.map(({ category, rows }) => [category, rows])).toEqual([['condition', 2], ['condition', 1], ['calc', 1], ['calc', 1], ['calc', 1]])
  })
})

describe('humanizeFormula', () => {
  const headers = (sheet: string | undefined) => (sheet === 'マスタ' ? ['コード', '名称'] : ['数量', '単価', '状態'])
  test('replaces references with headers and operators with words', () => {
    expect(humanizeFormula('IF(C2<>"完了",A2*B2,0)', headers)).toBe('もし(状態 ≠ "完了",数量 × 単価,0)')
    expect(humanizeFormula("VLOOKUP(A2,'マスタ'!A:B,2,FALSE)", headers)).toBe('参照(数量,マスタのコード〜名称,2,FALSE)')
  })

  test('nested prefixed functions and concatenation preserve literal operators and references', () => {
    expect(humanizeFormula('_xlfn.IFERROR(_xlfn.XLOOKUP(A2,マスタ!A:A,マスタ!B:B),"A2/*"&"  /  "&C2)', headers))
      .toBe('エラーなら(参照(数量,マスタのコード,マスタの名称),"A2/*" + "  /  " + 状態)')
    expect(humanizeFormula('LOG10(A2)&"say ""A2/B2"""', headers)).toBe('LOG10(数量) + "say ""A2/B2"""')
    expect(humanizeFormula('A2*1E10+1.2e-3', headers)).toBe('数量 × 1E10+1.2e-3')
    expect(humanizeFormula("'工程 A''s'!A2/B2", (sheet) => sheet ? ['測定値/基準'] : ['数量', '単価']))
      .toBe("工程 A'sの測定値/基準 ÷ 単価")
  })
})

describe('xlsx pure reader helpers', () => {
  test('shared formulas shift relative axes, ranges and sheet references but not literals or functions', () => {
    expect(shiftFormula('_xlfn.IFERROR(A2*$B2+C$1+$D$1,"A2/*")', 2, 1))
      .toBe('_xlfn.IFERROR(B4*$B4+D$1+$D$1,"A2/*")')
    expect(shiftFormula("SUM('工程 A''s'!A2:B4,$A:$C,B:D,2:4,$2:$4)+LOG10(A2)+Table1[数量]", 1, 2))
      .toBe("SUM('工程 A''s'!C3:D5,$A:$C,D:F,3:5,$2:$4)+LOG10(C3)+Table1[数量]")
    expect(shiftFormula('A1+$A$1+XFD1048576', -1, -1)).toBe('#REF!+$A$1+XFC1048575')
    expect(shiftFormula('XFD1048576', 1, 1)).toBe('#REF!')
    expect(shiftFormula('A2*1E10+1.2e-3', 1, 1)).toBe('B3*1E10+1.2e-3')
  })

  test('validation ranges accept dollar signs, whole columns and escaped sheet names', () => {
    expect(parseRangeReference("='工程 A''s'!$B$2:$C$9")).toEqual({
      sheetName: "工程 A's", fromColumn: 1, toColumn: 2, fromRow: 1, toRow: 8,
    })
    expect(parseRangeReference('$D:$F')).toEqual({ sheetName: undefined, fromColumn: 3, toColumn: 5, fromRow: 0, toRow: 1048575 })
    expect(parseRangeReference('A4')).toEqual({ sheetName: undefined, fromColumn: 0, toColumn: 0, fromRow: 3, toRow: 3 })
    for (const value of ['A0', 'B2:A1', 'A1:A1048577', 'XFE:XFE', 'not a range']) expect(parseRangeReference(value)).toBeUndefined()
  })

  test('relationship targets resolve package absolute and relative worksheet paths', () => {
    expect(workbookPartPath('/xl/worksheets/sheet2.xml')).toBe('xl/worksheets/sheet2.xml')
    expect(workbookPartPath('worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml')
    expect(workbookPartPath('../xl/worksheets/./sheet3.xml')).toBe('xl/worksheets/sheet3.xml')
  })

  test('builtin and custom date formats ignore numeric units, colors and literals', () => {
    for (const id of [14, 22, 27, 36, 45, 47, 50, 58]) expect(isDateFormat(id)).toBe(true)
    for (const format of ['yyyy/mm/dd', '[$-ja-JP]yyyy"年"m"月"d"日"', 'hh:mm:ss.000', '[h]:mm:ss', 'mm:ss.0']) expect(isDateFormat(164, format)).toBe(true)
    for (const format of ['General', '#,##0.00', '0" days"', '0\\m', '[Red][>=100]0.00', '0_m', '0*m']) expect(isDateFormat(164, format)).toBe(false)
    expect(serialToDate(1).toISOString()).toBe('1900-01-01T00:00:00.000Z')
    expect(serialToDate(60).toISOString()).toBe('1900-02-28T00:00:00.000Z')
    expect(serialToDate(0, true).toISOString()).toBe('1904-01-01T00:00:00.000Z')
    expect(serialToDate(25569.5).toISOString()).toBe('1970-01-01T12:00:00.000Z')
  })

  test('inline and cached string cells stay text; missing numeric caches stay blank', () => {
    expect(parseCellValue('inlineStr', '001 / 工程', [], false)).toBe('001 / 工程')
    expect(parseCellValue('str', '123', [], true)).toBe('123')
    expect(parseCellValue('s', '1', ['先頭', '共有文字列'], false)).toBe('共有文字列')
    expect(parseCellValue(null, '0', [], false)).toBe(0)
    expect(parseCellValue(null, '46000', [], true)).toEqual(serialToDate(46000))
    expect(parseCellValue('b', '0', [], false)).toBe(false)
    expect(parseCellValue('d', '2026-10-26', [], false)).toEqual(new Date('2026-10-26'))
    for (const raw of [undefined, null, '', ' ', 'NaN']) expect(parseCellValue(null, raw, [], true)).toBeNull()
    expect(parseCellValue('e', '#DIV/0!', [], false)).toBeNull()
  })
})

const records: ExcelAnalysisEntity = {
  name: '受注', kind: 'records',
  fields: [{ name: '番号', kind: 'id' }, { name: '名称', kind: 'text' }, { name: '拠点', kind: 'text' }],
  sources: [{ workbookId: 'wb-000000000001', sheet: '4月', headerRow: 1, dataRows: 2, columns: [{ index: 2, field: '番号' }, { index: 0, field: '名称' }], constants: [{ field: '拠点', value: '大阪' }] }],
  rules: [], importRows: 2, key: ['番号'],
}

/** An integrated analysis as Platform sends it, read by the production reader. */
const analysis = (entities: unknown[], capabilities: string[]) => analysisFrom({ summary: '', bullets: [], capabilities, flows: [], findings: [], workbooks: [{ workbookId: 'wb-000000000001', role: 'records', summary: '' }], entities })

describe('planApp', () => {
  test('uses integrated entity names and counts, retaining source mappings and business keys', () => {
    const master: ExcelAnalysisEntity = { ...records, name: '顧客', kind: 'master', importRows: 3, workflow: undefined }
    const workflowRecords: ExcelAnalysisEntity = { ...records, fields: [...records.fields, { name: '状態', kind: 'choice' }], workflow: { field: '状態', stages: ['受付', '出荷済'] } }
    const plan = planApp(analysis([workflowRecords, master], ['aggregate']), '営業の仕事')
    expect(plan.name).toBe('営業の仕事')
    expect(plan.entities[0]).toMatchObject({ sources: records.sources, key: ['番号'], workflow: { column: '状態', stages: ['受付', '出荷済'] } })
    expect(plan.screens).toEqual([
      { kind: 'list', entity: '受注' }, { kind: 'form', entity: '受注' }, { kind: 'detail', entity: '受注' },
      { kind: 'board', entity: '受注' }, { kind: 'master', entity: '顧客' }, { kind: 'dashboard', entity: '受注' },
    ])
    expect(plan.totalImportRows).toBe(5)
    expect(planApp(analysis([master], ['aggregate']), '顧客').screens).toEqual([{ kind: 'master', entity: '顧客' }])
    expect(planApp(analysis([{ ...records, workflow: undefined }], []), '受注').screens.map((screen) => screen.kind)).toEqual(['list', 'form', 'detail'])
  })

  test('an entity kind or capability a newer Platform sends is not guessed: no screens, no dashboard', () => {
    const plan = planApp(analysis([{ ...records, kind: 'archive' }, { ...records, name: '台帳' }], ['forecast']), '営業の仕事')
    expect(plan.entities.map((entity) => entity.kind)).toEqual([{ kind: 'unknown' }, { kind: 'known', value: 'records' }])
    expect(plan.screens).toEqual([{ kind: 'list', entity: '台帳' }, { kind: 'form', entity: '台帳' }, { kind: 'detail', entity: '台帳' }])
    // The unknown entity's rows still count: they are imported, only its screens are not decided here.
    expect(plan.totalImportRows).toBe(4)
  })
})

describe('entityRows', () => {
  const grids = new Map<string, WorkbookGrid>([
    ['wb-000000000001', { fileName: '4月.xlsx', sheets: [{ name: '4月', rows: [['表題'], ['名称', null, '番号'], ['甲', 'ignored', 1], [], [' ', 'ignored'], ['乙', null, 2]] }] }],
    ['wb-000000000002', { fileName: '5月.xlsx', sheets: [{ name: '5月', rows: [['番号', '名称'], [1, '重複'], [3, '丙'], [0, false]] }] }],
  ])
  const combined = {
    ...records,
    sources: [...records.sources, { workbookId: 'wb-000000000002', sheet: '5月', headerRow: 0, dataRows: 3, columns: [{ index: 0, field: '番号' }, { index: 1, field: '名称' }], constants: [{ field: '拠点', value: '東京' }] }],
  }

  test('maps reordered columns and constants, drops mapped blank rows, and keeps physical source keys', () => {
    expect(entityRows(combined, grids)).toEqual([
      { index: 0, key: 'wb-000000000001:4月:3', values: { 番号: 1, 名称: '甲', 拠点: '大阪' } },
      { index: 1, key: 'wb-000000000001:4月:6', values: { 番号: 2, 名称: '乙', 拠点: '大阪' } },
      { index: 2, key: 'wb-000000000002:5月:3', values: { 番号: 3, 名称: '丙', 拠点: '東京' } },
      { index: 3, key: 'wb-000000000002:5月:4', values: { 番号: 0, 名称: false, 拠点: '東京' } },
    ])
  })

  test('deduplication is opt-in and composite keys include source constants', () => {
    expect(entityRows({ ...combined, key: undefined }, grids)).toHaveLength(5)
    expect(entityRows({ ...combined, key: [] }, grids)).toHaveLength(5)
    expect(entityRows({ ...combined, key: ['番号', '拠点'] }, grids)).toHaveLength(5)
    expect(entityRows(combined, new Map())).toEqual([])
    expect(entityRows({ ...combined, sources: [{ ...combined.sources[0], sheet: 'missing' }] }, grids)).toEqual([])
  })

  test('unmapped union fields start blank and constants override mapped values without mutating grids', () => {
    const entity = { ...records, fields: [...records.fields, { name: '備考', kind: 'text' as const }], sources: [{ ...records.sources[0], constants: [{ field: '名称', value: '固定値' }] }] }
    expect(entityRows(entity, grids)[0]?.values).toEqual({ 番号: 1, 名称: '固定値', 拠点: null, 備考: null })
    expect(grids.get('wb-000000000001')?.sheets[0].rows[2][0]).toBe('甲')
  })
})
