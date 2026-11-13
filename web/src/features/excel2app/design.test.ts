import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { ExcelAnalysis, ExcelWorkbookReading } from '@appthrust/api-schema/platform-api'
import { parseSpec } from '../../model/build/spec'
import { excelAnalysisOf } from '../../model/contracts/excel'
import { designFromReadings, readingOf, type DesignInput } from './design'
import { entityRows, planApp, toDraftWorkbook, type WorkbookGrid } from './model'
import { SAMPLE_SETS } from './samples'
import { excelSpecMarkdown } from './spec'

function inputOf(grid: WorkbookGrid, index = 0): DesignInput {
  const encoded = JSON.stringify(toDraftWorkbook(grid))
  return {
    grid,
    summary: {
      id: `wb-${index.toString(16).padStart(12, '0')}`, fileName: grid.fileName,
      sheetCount: grid.sheets.length, rowCount: grid.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0),
      bytes: Buffer.byteLength(encoded), digest: createHash('sha256').update(encoded).digest('hex'),
      truncated: grid.sheets.some((sheet) => sheet.truncated), addedAt: '2026-11-01T00:00:00Z',
    },
  }
}

const ledger = (fileName: string, headers: string[], values: (string | number)[]): WorkbookGrid => ({ fileName, sheets: [{ name: '台帳', rows: [headers, values] }] })

const orders = SAMPLE_SETS.find((sample) => sample.id === 'orders')!.workbooks.map(inputOf)

describe('designFromReadings', () => {
  test('monthly ledgers become one record entity with ordered sources and a cross-file master reference', () => {
    const analysis = designFromReadings(orders)
    expect(analysis.entities.map((entity) => [entity.name, entity.kind, entity.importRows])).toEqual([['受注台帳', 'records', 6], ['得意先マスタ', 'master', 3]])
    const records = analysis.entities[0]!
    expect(records.sources.map((source) => source.workbookId)).toEqual(orders.slice(0, 2).map((input) => input.summary.id))
    expect(records.fields.find((field) => field.name === '得意先コード')).toMatchObject({ kind: 'reference', referenceEntity: '得意先マスタ' })
    expect(records.rules).toEqual([{ column: '金額', expression: '数量 × 単価', category: 'calc', rows: 6 }])
    expect(records.workflow).toEqual({ field: '状態', stages: ['受付', '手配中', '出荷済'] })
    expect(analysis.workbooks.map((workbook) => workbook.role)).toEqual(['records', 'records', 'master'])
    expect(analysis.findings).toEqual([{ kind: 'merged', message: expect.any(String), workbookIds: orders.slice(0, 2).map((input) => input.summary.id) }])
    expect(analysis.flows).toEqual([])
    expect(analysis.capabilities).toEqual(expect.arrayContaining(['entry', 'calculation', 'workflow', 'lookup']))
    expect(entityRows(records, new Map(orders.map((input) => [input.summary.id, input.grid]))).map((row) => row.values['受注番号'])).toEqual(['ORD-0401', 'ORD-0402', 'ORD-0403', 'ORD-0501', 'ORD-0502', 'ORD-0503'])
  })

  test('80 percent normalized-header overlap merges with a first-seen header union and source mappings', () => {
    const inputs = [
      ledger('東.xlsx', ['ＩＤ', ' 名称 ', '数量', '単価', '備考'], [1, '品物', 2, 3, 'メモ']),
      ledger('西.xlsx', ['id', '名称', '数量', '単価', '担当'], [2, '別の品', 4, 5, '佐藤']),
    ].map(inputOf)
    const entity = designFromReadings(inputs).entities[0]!
    expect(entity.fields.map((field) => field.name)).toEqual(['ＩＤ', '名称', '数量', '単価', '備考', '担当'])
    expect(entity.sources).toHaveLength(2)
    expect(entity.sources[1]!.columns).toEqual([{ index: 0, field: 'ＩＤ' }, { index: 1, field: '名称' }, { index: 2, field: '数量' }, { index: 3, field: '単価' }, { index: 4, field: '担当' }])
    expect(entityRows(entity, new Map(inputs.map((input) => [input.summary.id, input.grid])))[1]?.values).toEqual({ 'ＩＤ': 2, 名称: '別の品', 数量: 4, 単価: 5, 備考: null, 担当: '佐藤' })
  })

  test('below-threshold sheets remain separate and every colliding sheet name is file-qualified', () => {
    const inputs = [ledger('東.xlsx', ['番号', '名称', '数量'], [1, '品物', 2]), ledger('西.xlsx', ['番号', '日付', '担当'], [2, '2026-05-01', '佐藤'])].map(inputOf)
    const analysis = designFromReadings(inputs)
    expect(analysis.entities.map((entity) => entity.name)).toEqual(['東・台帳', '西・台帳'])
    expect(analysis.findings).toEqual([])
    expect(analysis.entities.every((entity) => entity.sources.length === 1)).toBe(true)
  })

  test('saved readings are authoritative, keep workbook roles and never merge different sheet roles', () => {
    const inputs = [ledger('台帳.xlsx', ['コード', '名称'], ['A', '品物']), ledger('一覧.xlsx', ['コード', '名称'], ['A', '品物'])].map(inputOf)
    const reading = readingOf(inputs[1]!)
    reading.sheets[0]!.role = 'master'
    reading.summary = '共通の品物を管理'
    const before = structuredClone(reading)
    const analysis = designFromReadings(inputs, new Map([[reading.workbookId, reading]]))
    expect(analysis.entities.map((entity) => entity.kind)).toEqual(['records', 'master'])
    expect(analysis.workbooks[1]).toMatchObject({ role: 'master', summary: reading.summary })
    expect(analysis.entities[0]?.fields[0]?.referenceEntity).toBe('一覧・台帳')
    expect(reading).toEqual(before)
  })

  test('cross-file references require all nonblank ledger values to exist in a master', () => {
    const inputs = structuredClone(orders)
    inputs[0]!.grid.sheets[0]!.rows[1]![2] = 'UNKNOWN'
    const field = designFromReadings(inputs).entities[0]!.fields.find((item) => item.name === '得意先コード')!
    expect(field.kind).not.toBe('reference')
    expect(field.referenceEntity).toBeUndefined()
  })

  test('merged and truncated findings identify their members and the narrative remains bounded', () => {
    const inputs = structuredClone(orders)
    inputs[1]!.grid.sheets[0]!.truncated = true
    inputs[1]!.summary.truncated = true
    const analysis = designFromReadings(inputs)
    expect(analysis.findings.map((finding) => finding.kind)).toEqual(['merged', 'truncated'])
    expect(analysis.findings[1]!.workbookIds).toEqual([inputs[1]!.summary.id])
    expect(analysis.entities[0]!.sources[1]!.truncated).toBe(true)
    expect(analysis.bullets).toContain(analysis.findings[1]!.message)
    expect(ExcelAnalysis.safeParse(analysis).success).toBe(true)
  })

  test('empty and report-only files remain in the set but do not create entities', () => {
    const inputs = [
      { fileName: '空.xlsx', sheets: [{ name: '空', rows: [] }] },
      { fileName: '集計.xlsx', sheets: [{ name: '月次集計', rows: [['工程', '件数'], ['組立', 3]] }] },
    ].map(inputOf)
    const analysis = designFromReadings(inputs)
    expect(analysis.workbooks.map((workbook) => workbook.role)).toEqual(['unused', 'report'])
    expect(analysis.entities).toEqual([])
    expect(analysis.capabilities).toContain('aggregate')
    expect(ExcelAnalysis.safeParse(analysis).success).toBe(true)
  })

  test.each(SAMPLE_SETS)('every sample set has schema-valid readings and an integrated design: $id', (sample) => {
    const inputs = sample.workbooks.map(inputOf)
    const readings = new Map(inputs.map((input) => [input.summary.id, ExcelWorkbookReading.parse(readingOf(input))]))
    const analysis = ExcelAnalysis.parse(designFromReadings(inputs, readings))
    expect(analysis.workbooks.map((workbook) => workbook.workbookId)).toEqual(inputs.map((input) => input.summary.id))
    const names = new Set(analysis.entities.map((entity) => entity.name))
    expect(names.size).toBe(analysis.entities.length)
    for (const entity of analysis.entities) {
      for (const field of entity.fields) if (field.referenceEntity) expect(names.has(field.referenceEntity)).toBe(true)
      expect(entity.importRows).toBe(entityRows(entity, new Map(inputs.map((input) => [input.summary.id, input.grid]))).length)
    }
  })
})

test('the bounded offline model reports unrepresented tables rather than silently omitting them', () => {
  const sheets: WorkbookGrid['sheets'] = Array.from({ length: 51 }, (_, index) => ({ name: `記録${index}`, rows: [[`番号${index}`, `項目${index}`], [index, '値']] }))
  const inputs = [{ fileName: '前半.xlsx', sheets: sheets.slice(0, 26) }, { fileName: '後半.xlsx', sheets: sheets.slice(26) }].map(inputOf)
  const analysis = ExcelAnalysis.parse(designFromReadings(inputs))
  expect(analysis.entities).toHaveLength(50)
  expect(analysis.findings).toEqual([{ kind: 'unused', message: expect.any(String), workbookIds: [inputs[1]!.summary.id] }])
})

test('the specification describes file roles, merged records, migration findings and entity-based front matter', () => {
  const inputs = structuredClone(orders)
  inputs[1]!.summary.truncated = true
  const analysis = designFromReadings(inputs)
  const markdown = excelSpecMarkdown(analysis, planApp(excelAnalysisOf(analysis), '受注管理'), inputs.map((input) => input.summary))
  const { spec, body } = parseSpec(markdown)
  expect(spec).toMatchObject({ name: '受注管理', importFrom: 'excel' })
  expect(spec.records.map((record) => record.name)).toEqual(analysis.entities.map((entity) => entity.name))
  expect(body.match(/^## [1-8]\./gm)).toHaveLength(8)
  for (const input of inputs) expect(body).toContain(input.summary.fileName)
  for (const finding of analysis.findings) expect(body).toContain(finding.message)
  expect(spec.rules.some((rule) => rule.includes('数量 × 単価'))).toBe(true)
  expect(body).toContain('得意先マスタ')
})
