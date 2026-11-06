import { expect, test } from 'bun:test'
import { ApplicationDraftWorkbook } from '@appthrust/api-schema/platform-api'
import { toDraftWorkbook } from './model'
import { readXlsx } from './xlsx'

test('real workbooks preserve coordinates, formulas and separate-file grids through the API contract', async () => {
  // happy-dom 20.8.4 parses XML, but its namespace lookup compares "*" literally.
  // This fixture has unprefixed elements, so tag lookup supplies the missing wildcard
  // semantics without replacing the ZIP reader, XML parser or workbook extraction.
  class WorkbookDOMParser extends window.DOMParser {
    override parseFromString(input: string, type: DOMParserSupportedType) {
      const doc = super.parseFromString(input, type)
      for (const node of [doc, ...doc.getElementsByTagName('*')]) {
        const lookup = node.getElementsByTagNameNS.bind(node)
        Object.defineProperty(node, 'getElementsByTagNameNS', {
          value: (namespace: string, tag: string) => namespace === '*' ? node.getElementsByTagName(tag) : lookup(namespace, tag),
        })
      }
      return doc
    }
  }
  // The shared preload exposes window but does not install DOMParser globally.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser')
  Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: WorkbookDOMParser })
  try {
    const bytes = await Bun.file(new URL('../../../e2e/stories/fixtures/excel2app-ledger.xlsx', import.meta.url)).arrayBuffer()
    const grid = await readXlsx(new File([bytes], 'excel2app-ledger.xlsx'))
    expect(grid.sheets.map((sheet) => sheet.name)).toEqual(['台帳'])
    expect(grid.sheets[0]!.rows[1]).toBeUndefined()
    const payload = JSON.parse(JSON.stringify(toDraftWorkbook(grid)))
    expect(ApplicationDraftWorkbook.safeParse(payload).success).toBe(true)
    expect(payload.sheets[0].rows).toEqual([
      ['部品管理台帳'],
      [],
      ['管理', null, '見積'],
      ['管理No', '状態', '数量', '単価', '金額'],
      ['P-001', '未着手', 3, 400, 1200],
      [],
      [],
      ['次の区分'],
      ['P-002', '完了', null, 250],
    ])
    expect(payload.sheets[0].rows.every(Array.isArray)).toBe(true)
    expect(payload.sheets[0].validations).toEqual({ '1': ['未着手', '完了'] })
    expect(payload.sheets[0].formulas).toEqual([{ row: 4, column: 4, formula: 'C5*D5' }])
    expect(payload.sheets[0].mergedRanges).toBe(3)
    const set = []
    for (const name of ['april', 'may', 'customers']) {
      const fileName = `excel2app-set-${name}.xlsx`
      const data = await Bun.file(new URL(`../../../e2e/stories/fixtures/${fileName}`, import.meta.url)).arrayBuffer()
      const parsed = toDraftWorkbook(await readXlsx(new File([data], fileName)))
      expect(ApplicationDraftWorkbook.safeParse(parsed).success).toBe(true)
      set.push(parsed)
    }
    expect(set.map((file) => file.sheets[0]!.name)).toEqual(['受注一覧', '受注一覧', '得意先マスタ'])
    expect(set[0]!.sheets[0]!.rows[0]).toEqual(set[1]!.sheets[0]!.rows[0])
    expect(set[0]!.sheets[0]!.rows[1]![0]).toBe('A-001')
    expect(set[1]!.sheets[0]!.rows[1]![0]).toBe('M-001')
    expect(set[2]!.sheets[0]!.rows[1]).toEqual(['C-001', '青空工業', '田中'])
    expect(set[0]!.sheets[0]!.formulas).toEqual([{ row: 1, column: 6, formula: 'E2*F2' }, { row: 2, column: 6, formula: 'E3*F3' }])
  } finally {
    if (original) Object.defineProperty(globalThis, 'DOMParser', original)
    else Reflect.deleteProperty(globalThis, 'DOMParser')
  }
})
