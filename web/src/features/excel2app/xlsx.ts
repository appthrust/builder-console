// Browser-only .xlsx/.xlsm reader; VBA is never loaded or executed. Values,
// formulas, validations and merges stay on the page. At most the first 5,000
// row coordinates per sheet are retained (with a truncation warning).
import { columnIndex, mapFormulaTokens, type CellValue, type FormulaCell, type SheetGrid, type WorkbookGrid } from './model'

export class UnsupportedWorkbook extends Error {}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const decoder = new TextDecoder()
export const MAX_SHEET_ROWS = 5000
const MAX_COLUMN = 16383
const MAX_ROW = 1048575

/** ZIP central directory → member bytes by name (store and deflate only, which is all Excel writes). */
async function unzip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === EOCD) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new UnsupportedWorkbook('not a zip file')
  const count = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)
  const members = new Map<string, Uint8Array>()
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL) throw new UnsupportedWorkbook('bad central directory')
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength + extraLength + commentLength
    // Macro-enabled files can contain large embedded images/VBA; only XML is needed.
    if (!name.startsWith('xl/') || !/\.(xml|rels)$/i.test(name)) continue
    if (view.getUint32(localOffset, true) !== LOCAL) throw new UnsupportedWorkbook('bad local header')
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    const data = bytes.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) members.set(name, data)
    else if (method === 8) members.set(name, new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()))
    else throw new UnsupportedWorkbook(`unsupported compression ${method}`)
  }
  return members
}

function xml(members: Map<string, Uint8Array>, name: string): Document | undefined {
  const bytes = members.get(name)
  if (!bytes) return undefined
  return new DOMParser().parseFromString(decoder.decode(bytes), 'application/xml')
}

const children = (parent: Document | Element, tag: string): Element[] => [...parent.getElementsByTagNameNS('*', tag)]

/** Excel has two date epochs; serial 60 aliases February 28 (the fictitious leap day). */
export function serialToDate(serial: number, date1904 = false): Date {
  const epoch = date1904 ? 24107 : serial < 60 ? 25568 : 25569
  return new Date(Math.round((serial - epoch) * 86400000))
}

/** Strip literals, colors, locale codes and padding, but preserve elapsed-time tokens. */
export function isDateFormat(id: number, code = ''): boolean {
  if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return true
  const stripped = code.replace(/"[^"]*"|\\.|_.|\*.|\[(?![hms]+\])[^\]]*\]/gi, '')
  return /[ymdhs]/i.test(stripped.replace(/General/gi, ''))
}

/** Style indexes whose number format is a date/time. */
function dateStyles(styles: Document | undefined): Set<number> {
  const result = new Set<number>()
  if (!styles) return result
  const custom = new Map<number, string>()
  for (const numFmt of children(styles, 'numFmt')) custom.set(Number(numFmt.getAttribute('numFmtId')), numFmt.getAttribute('formatCode') ?? '')
  const cellXfs = children(styles, 'cellXfs')[0]
  if (!cellXfs) return result
  children(cellXfs, 'xf').forEach((xf, index) => {
    const id = Number(xf.getAttribute('numFmtId') ?? '0')
    if (isDateFormat(id, custom.get(id))) result.add(index)
  })
  return result
}

function sharedStrings(doc: Document | undefined): string[] {
  if (!doc) return []
  return children(doc, 'si').map((si) => children(si, 't').map((t) => t.textContent ?? '').join(''))
}

/** Shift relative A1 references only, preserving absolute axes, strings and names. */
export function shiftFormula(formula: string, rowDelta: number, columnDelta: number): string {
  return mapFormulaTokens(formula, (token, kind) => {
    if (kind !== 'reference') return token
    const separator = token.lastIndexOf('!')
    const prefix = token.slice(0, separator + 1)
    const shifted = token.slice(separator + 1).split(':').map((end) => {
      const match = /^(\$?)([A-Z]+)?(\$?)(\d+)?$/i.exec(end)
      if (!match) return end
      const [, columnAbsolute, letters, rowAbsolute, digits] = match
      let column = letters ? columnIndex(letters) + (columnAbsolute ? 0 : columnDelta) : undefined
      const row = digits ? Number(digits) - 1 + ((letters ? rowAbsolute : columnAbsolute) ? 0 : rowDelta) : undefined
      if ((column !== undefined && (column < 0 || column > MAX_COLUMN)) || (row !== undefined && (row < 0 || row > MAX_ROW))) return '#REF!'
      let shiftedLetters = ''
      if (column !== undefined) {
        for (column += 1; column > 0; column = Math.floor((column - 1) / 26)) shiftedLetters = String.fromCharCode(65 + (column - 1) % 26) + shiftedLetters
      }
      return `${columnAbsolute}${shiftedLetters}${letters ? rowAbsolute : ''}${row === undefined ? '' : row + 1}`
    })
    return `${prefix}${shifted.join(':')}`
  })
}

/** A1/range/whole-column validation references, including escaped quoted sheet names. */
export function parseRangeReference(reference: string): { sheetName?: string; fromColumn: number; toColumn: number; fromRow: number; toRow: number } | undefined {
  const match = /^(?:'((?:[^']|'')*)'!|([^!]+)!)?\$?([A-Z]+)(?:\$?(\d+))?(?::\$?([A-Z]+)(?:\$?(\d+))?)?$/i.exec(reference.trim().replace(/^=/, ''))
  if (!match) return undefined
  const fromColumn = columnIndex(match[3])
  const toColumn = match[5] ? columnIndex(match[5]) : fromColumn
  const fromRow = match[4] ? Number(match[4]) - 1 : 0
  const toRow = match[6] ? Number(match[6]) - 1 : match[5] || !match[4] ? MAX_ROW : fromRow
  if (fromColumn > toColumn || toColumn > MAX_COLUMN || fromRow < 0 || fromRow > toRow || toRow > MAX_ROW) return undefined
  return { sheetName: match[1]?.replace(/''/g, "'") ?? match[2], fromColumn, toColumn, fromRow, toRow }
}

/** Missing numeric/formula caches stay blank, never synthetic zeroes. */
export function parseCellValue(type: string | null, raw: string | null | undefined, strings: string[], dateStyle: boolean, date1904 = false): CellValue {
  if (raw === undefined || raw === null) return null
  if (type === 's') return raw.trim() ? strings[Number(raw)] ?? null : null
  if (type === 'str' || type === 'inlineStr') return raw
  if (type === 'e' || raw.trim() === '') return null
  if (type === 'b') return raw === '1'
  if (type === 'd') {
    const date = new Date(raw)
    return Number.isFinite(date.getTime()) ? date : null
  }
  const number = Number(raw)
  if (!Number.isFinite(number)) return null
  return dateStyle ? serialToDate(number, date1904) : number
}

interface ParsedSheet extends SheetGrid {
  /** `formula1` of list validations that point at a range, resolved after every sheet is read. */
  rangeValidations: { column: number; range: string }[]
}

function parseSheet(name: string, doc: Document, strings: string[], dates: Set<number>, date1904: boolean): ParsedSheet {
  const rows: CellValue[][] = []
  const formulas: FormulaCell[] = []
  const shared = new Map<string, FormulaCell>()
  const dependents: { cell: FormulaCell; id: string }[] = []
  let truncated = false
  for (const cell of children(doc, 'c')) {
    const ref = /^([A-Z]+)(\d+)$/i.exec(cell.getAttribute('r') ?? '')
    if (!ref) continue
    const column = columnIndex(ref[1])
    const row = Number(ref[2]) - 1
    if (row < 0 || column > MAX_COLUMN) continue
    const type = cell.getAttribute('t')
    const style = Number(cell.getAttribute('s') ?? '-1')
    const formulaElement = children(cell, 'f')[0]
    const raw = type === 'inlineStr' ? children(cell, 't').map((t) => t.textContent ?? '').join('') : children(cell, 'v')[0]?.textContent
    if (row >= MAX_SHEET_ROWS) {
      if (formulaElement || raw?.trim()) truncated = true
      continue
    }
    if (formulaElement) {
      const formula = formulaElement.textContent?.trim() ?? ''
      const entry = { row, column, formula }
      const id = formulaElement.getAttribute('si')
      if (formulaElement.getAttribute('t') === 'shared' && id !== null) {
        if (formula) shared.set(id, entry)
        else dependents.push({ cell: entry, id })
      }
      formulas.push(entry)
    }
    const value = parseCellValue(type, raw, strings, dates.has(style), date1904)
    if (value === null && !formulaElement) continue
    rows[row] ??= []
    rows[row][column] = value
  }
  for (const { cell, id } of dependents) {
    const anchor = shared.get(id)
    if (anchor) cell.formula = shiftFormula(anchor.formula, cell.row - anchor.row, cell.column - anchor.column)
  }
  const validations: Record<number, string[]> = {}
  const rangeValidations: { column: number; range: string }[] = []
  for (const validation of children(doc, 'dataValidation')) {
    if (validation.getAttribute('type') !== 'list') continue
    const formula1 = children(validation, 'formula1')[0]?.textContent?.trim()
    const sqref = validation.getAttribute('sqref') ?? ''
    if (!formula1 || !sqref) continue
    const columns = new Set<number>()
    for (const area of sqref.trim().split(/\s+/)) {
      const range = parseRangeReference(area)
      if (!range) continue
      for (let column = range.fromColumn; column <= range.toColumn; column += 1) columns.add(column)
    }
    for (const column of columns) {
      if (formula1.startsWith('"') && formula1.endsWith('"')) validations[column] = formula1.slice(1, -1).replace(/""/g, '"').split(',').map((item) => item.trim()).filter(Boolean)
      else rangeValidations.push({ column, range: formula1 })
    }
  }
  const mergeCells = children(doc, 'mergeCells')[0]
  return { name, rows, formulas: formulas.filter((cell) => cell.formula !== ''), validations, mergedRanges: mergeCells ? Number(mergeCells.getAttribute('count') ?? children(mergeCells, 'mergeCell').length) : 0, rangeValidations, truncated }
}

/** Resolve bounded ranges against visible or hidden list sheets without exposing hidden sheets. */
function rangeValues(reference: string, own: ParsedSheet, sheets: ParsedSheet[]): string[] {
  const range = parseRangeReference(reference)
  if (!range) return []
  const sheet = range.sheetName ? sheets.find((item) => item.name === range.sheetName) : own
  if (!sheet) return []
  const values = new Set<string>()
  for (let row = range.fromRow; row <= range.toRow && row < sheet.rows.length; row += 1) {
    for (let column = range.fromColumn; column <= range.toColumn; column += 1) {
      const value = sheet.rows[row]?.[column]
      if (value !== null && value !== undefined && String(value).trim() !== '') values.add(String(value))
    }
  }
  return [...values]
}

/** Relationship targets are package-absolute or relative to xl/workbook.xml. */
export function workbookPartPath(target: string): string {
  const parts: string[] = []
  for (const part of (target.startsWith('/') ? target.slice(1) : `xl/${target}`).split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

export async function readXlsx(file: File): Promise<WorkbookGrid> {
  if (!/\.(xlsx|xlsm)$/i.test(file.name)) throw new UnsupportedWorkbook(file.name)
  const members = await unzip(await file.arrayBuffer())
  const workbook = xml(members, 'xl/workbook.xml')
  const rels = xml(members, 'xl/_rels/workbook.xml.rels')
  if (!workbook || !rels) throw new UnsupportedWorkbook('no workbook part')
  const targets = new Map<string, string>()
  for (const rel of children(rels, 'Relationship')) {
    if (rel.getAttribute('TargetMode') === 'External') continue
    const target = rel.getAttribute('Target') ?? ''
    targets.set(rel.getAttribute('Id') ?? '', workbookPartPath(target))
  }
  const strings = sharedStrings(xml(members, 'xl/sharedStrings.xml'))
  const dates = dateStyles(xml(members, 'xl/styles.xml'))
  const date1904 = /^(1|true)$/.test(children(workbook, 'workbookPr')[0]?.getAttribute('date1904') ?? '')
  const sheets: ParsedSheet[] = []
  const visible: ParsedSheet[] = []
  for (const sheet of children(workbook, 'sheet')) {
    const state = sheet.getAttribute('state')
    const id = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? sheet.getAttribute('r:id') ?? ''
    const doc = xml(members, targets.get(id) ?? '')
    if (!doc) continue
    const parsed = parseSheet(sheet.getAttribute('name') ?? `Sheet${sheets.length + 1}`, doc, strings, dates, date1904)
    sheets.push(parsed)
    if (state !== 'hidden' && state !== 'veryHidden') visible.push(parsed)
  }
  if (visible.length === 0) throw new UnsupportedWorkbook('no sheets')
  for (const sheet of visible) {
    for (const { column, range } of sheet.rangeValidations) {
      const values = rangeValues(range, sheet, sheets)
      if (values.length > 0) sheet.validations![column] = values
    }
  }
  return {
    fileName: file.name,
    sheets: visible.map(({ rangeValidations: _ignored, ...sheet }) => sheet),
  }
}
