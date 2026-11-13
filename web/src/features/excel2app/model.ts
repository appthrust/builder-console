// Excel → app: the workbook as read (grid, validations, formulas per sheet),
// what the analysis found in it (sheet roles, column kinds, relations, workflow,
// calculation rules, capabilities) and the app plan derived from that.
// Everything here is pure; `xlsx.ts` and `samples.ts` produce `WorkbookGrid`s,
// `spec.ts` writes the specification document, `page.tsx` renders.
import { isOneOf } from '../../model/contracts/build'
import type { AnalysisField, AnalysisRule, AnalysisSource, Capability, ColumnKind, EntityKind, ExcelAnalysis, RuleCategory, ScreenKind, SheetRole, StoredWorkbook } from '../../model/contracts/excel'
import type { OpenValue } from '../../api/boundary'

export type CellValue = string | number | boolean | Date | null

/** A formula cell: 0-based `row`/`column` and the formula text without `=`. */
export interface FormulaCell {
  row: number
  column: number
  formula: string
}

/** One sheet as cells; `validations` are data-validation lists keyed by 0-based column. */
export interface SheetGrid {
  name: string
  rows: CellValue[][]
  validations?: Record<number, string[]>
  formulas?: FormulaCell[]
  mergedRanges?: number
  /** Only the first 5,000 Excel rows were read; later populated cells were omitted. */
  truncated?: boolean
}

export interface WorkbookGrid {
  fileName: string
  sheets: SheetGrid[]
}

/**
 * Dates become `YYYY-MM-DD`; the API stores strings, numbers, booleans and nulls only.
 * The reader's grid is sparse (blank rows and cells are holes); the API requires every row to be
 * an array, so holes become `[]` and `null` here. `Array.from` visits holes, `map` would keep them.
 */
export function toDraftWorkbook(workbook: WorkbookGrid): StoredWorkbook {
  return {
    fileName: workbook.fileName,
    sheets: workbook.sheets.map((sheet) => ({
      name: sheet.name,
      rows: Array.from(sheet.rows, (row) => Array.from(row ?? [], (cell) => (cell instanceof Date ? cell.toISOString().slice(0, 10) : cell ?? null))),
      ...(sheet.validations ? { validations: Object.fromEntries(Object.entries(sheet.validations).map(([column, options]) => [String(column), options])) } : {}),
      ...(sheet.formulas ? { formulas: sheet.formulas } : {}),
      ...(sheet.mergedRanges !== undefined ? { mergedRanges: sheet.mergedRanges } : {}),
      ...(sheet.truncated ? { truncated: true } : {}),
    })),
  }
}

export function fromDraftWorkbook(workbook: StoredWorkbook): WorkbookGrid {
  return {
    fileName: workbook.fileName,
    sheets: workbook.sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows,
      ...(sheet.validations ? { validations: Object.fromEntries(Object.entries(sheet.validations).map(([column, options]) => [Number(column), options])) } : {}),
      ...(sheet.formulas ? { formulas: sheet.formulas } : {}),
      ...(sheet.mergedRanges !== undefined ? { mergedRanges: sheet.mergedRanges } : {}),
      ...(sheet.truncated ? { truncated: true } : {}),
    })),
  }
}

export interface ColumnReading {
  index: number
  header: string
  kind: ColumnKind
  /** Non-empty cells / data rows, 0..1. */
  fill: number
  samples: string[]
  /** `choice`: the options in first-seen order (validation list wins). */
  options?: string[]
  /** `reference`: the sheet this column points at. */
  referenceSheet?: string
}

/** One formula pattern of a sheet, humanized: `金額 = 数量 × 単価`. */
export interface Rule {
  column: string
  expression: string
  category: RuleCategory
  /** Rows that carry this pattern. */
  rows: number
}

export interface SheetReading {
  name: string
  role: SheetRole
  headerRow: number
  dataRows: number
  columns: ColumnReading[]
  rules: Rule[]
  mergedRanges: number
  /** Propagated from the reader so the UI/spec never imply a complete import. */
  truncated?: boolean
  /** A choice column named like 状態/ステータス: its options become the workflow. */
  workflow?: { column: string; stages: string[] }
}

export interface Reading {
  fileName: string
  sheets: SheetReading[]
  /** What the workbook does today, in the order the spec lists them. */
  capabilities: Capability[]
}

/** A field of the plan; its kind is the analysis's, which a newer Platform may name in a way this console does not know. */
export type PlannedField = AnalysisField

export interface PlannedEntity {
  name: string
  /** An entity of a kind this console does not know gets no screens. */
  kind: OpenValue<EntityKind>
  fields: PlannedField[]
  rules: AnalysisRule[]
  importRows: number
  workflow?: { column: string; stages: string[] }
  key?: string[]
  sources: AnalysisSource[]
}

export interface PlannedScreen {
  kind: ScreenKind
  entity: string
}

export interface AppPlan {
  name: string
  entities: PlannedEntity[]
  screens: PlannedScreen[]
  totalImportRows: number
}

const ID_HEADER = /^(no\.?|id|番号|管理番号|伝票番号|#)$|番号$|no$|id$/i
const PERSON_HEADER = /(担当(?!課|部|係)|氏名|報告者|承認者|点検者|作成者|確認者|記入者|責任者|起票者)/
const CODE_HEADER = /(品番|型番|コード|code)$/i
const DATE_HEADER = /(日|date|期限|年月|日時|日付)$/i
const ATTACHMENT_HEADER = /(写真|添付|図面|ファイル|画像)/
const STATUS_HEADER = /(状態|ステータス|進捗|status)/i
const LONG_TEXT_HEADER = /(内容|備考|対策|原因|メモ|コメント|説明|詳細|所見|処置)/
const SUMMARY_SHEET = /(集計|グラフ|サマリ|summary|chart|pivot|推移)/i
const MASTER_SHEET = /(マスタ|マスター|一覧表|リスト|区分|master|list)$/i
const BOOLEAN_VALUE: Record<string, true> = { '○': true, '〇': true, '×': true, '✓': true, '✔': true, 済: true, 未: true, OK: true, NG: true, yes: true, no: true, true: true, false: true, はい: true, いいえ: true, 有: true, 無: true }
const SERIAL_DATE_MIN = 25569 // 1970-01-01
const SERIAL_DATE_MAX = 73050 // 2099-12-31

const isBlank = (value: CellValue) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '')

export function cellText(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
  if (typeof value === 'boolean') return value ? '○' : '×'
  return value.trim()
}

/** Prefer the widest label row near the top, rather than a title above blank rows. */
export function findHeaderRow(rows: CellValue[][]): number {
  let best = -1
  let mostLabels = 0
  let firstNonBlank = 0
  let foundNonBlank = false
  for (let index = 0; index < Math.min(rows.length, 50); index += 1) {
    const row = rows[index] ?? []
    const present = row.filter((cell) => !isBlank(cell)).length
    if (present > 0 && !foundNonBlank) {
      firstNonBlank = index
      foundNonBlank = true
    }
    const labels = row.filter((cell) => typeof cell === 'string' && cell.trim() !== '').length
    if (labels >= 2 && labels >= present * 0.8 && labels > mostLabels) {
      best = index
      mostLabels = labels
    }
  }
  return best >= 0 ? best : firstNonBlank
}

/** Serial numbers need a date header; ordinary amounts must not become dates. */
const isDateLike = (value: CellValue, dateHeader: boolean) =>
  value instanceof Date ||
  (typeof value === 'string' && /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(value.trim())) ||
  (dateHeader && typeof value === 'number' && Number.isInteger(value) && value >= SERIAL_DATE_MIN && value <= SERIAL_DATE_MAX)

function inferColumn(header: string, values: CellValue[], validation: string[] | undefined, masters: Map<string, Set<string>>, ownSheet: string, formulaColumn: boolean): Omit<ColumnReading, 'index' | 'fill' | 'samples'> {
  const present = values.filter((value) => !isBlank(value))
  const texts = present.map(cellText)
  const distinct = [...new Set(texts)]
  const base = { header }

  if (formulaColumn) return { ...base, kind: 'formula' }
  if (ATTACHMENT_HEADER.test(header)) return { ...base, kind: 'attachment' }
  // A validation list drawn from a master sheet is a reference, not a fixed choice.
  const candidates = validation && validation.length > 0 ? [...new Set([...validation, ...distinct])] : distinct
  for (const [sheet, keys] of masters) {
    if (sheet !== ownSheet && candidates.length > 0 && candidates.every((value) => keys.has(value))) return { ...base, kind: 'reference', referenceSheet: sheet }
  }
  if (validation && validation.length > 0) return { ...base, kind: 'choice', options: validation }
  if (present.length > 0 && present.every((value) => isDateLike(value, DATE_HEADER.test(header)))) return { ...base, kind: 'date' }
  if (DATE_HEADER.test(header) && present.length === 0) return { ...base, kind: 'date' }
  if (present.length > 0 && distinct.every((value) => BOOLEAN_VALUE[value])) return { ...base, kind: 'boolean' }
  if (ID_HEADER.test(header) && distinct.length === present.length) return { ...base, kind: 'id' }
  if (present.length > 0 && present.every((value) => typeof value === 'number' || (typeof value === 'string' && /^-?[\d,]+(\.\d+)?$/.test(value.trim())))) return { ...base, kind: 'number' }
  if (PERSON_HEADER.test(header)) return { ...base, kind: 'person' }
  if (CODE_HEADER.test(header)) return { ...base, kind: 'text' }
  const repeated = present.length >= 6 && distinct.length <= 8 && present.length >= distinct.length * 2 && distinct.every((value) => value.length <= 12)
  if (repeated && distinct.length >= 2) return { ...base, kind: 'choice', options: distinct }
  const long = LONG_TEXT_HEADER.test(header) || texts.some((value) => value.length > 40)
  return { ...base, kind: long ? 'longText' : 'text' }
}

function masterKeys(sheets: SheetGrid[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const sheet of sheets) {
    if (!MASTER_SHEET.test(sheet.name)) continue
    const header = findHeaderRow(sheet.rows)
    const keys = new Set<string>()
    const keyColumns = (sheet.rows[header] ?? []).flatMap((cell, index) => isBlank(cell) ? [] : [index]).slice(0, 2)
    for (const row of sheet.rows.slice(header + 1)) {
      if (!row) continue
      // Blank spacer columns do not move a master's code/name out of consideration.
      for (const index of keyColumns) if (!isBlank(row[index])) keys.add(cellText(row[index]))
    }
    if (keys.size > 0) result.set(sheet.name, keys)
  }
  return result
}

/** `A` → 0, `AB` → 27. */
export function columnIndex(letters: string): number {
  let index = 0
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

const FUNCTION_CATEGORY: Record<string, RuleCategory> = {
  VLOOKUP: 'lookup', XLOOKUP: 'lookup', INDEX: 'lookup', MATCH: 'lookup', HLOOKUP: 'lookup',
  SUM: 'aggregate', SUMIF: 'aggregate', SUMIFS: 'aggregate', COUNT: 'aggregate', COUNTA: 'aggregate', COUNTIF: 'aggregate', COUNTIFS: 'aggregate', AVERAGE: 'aggregate', AVERAGEIF: 'aggregate', SUMPRODUCT: 'aggregate', MAX: 'aggregate', MIN: 'aggregate',
  TODAY: 'date', NOW: 'date', DATEDIF: 'date', EDATE: 'date', WORKDAY: 'date', NETWORKDAYS: 'date', DATE: 'date',
  IF: 'condition', IFS: 'condition', AND: 'condition', OR: 'condition', IFERROR: 'condition',
}

const FUNCTION_WORD: Record<string, string> = {
  SUM: '合計', SUMIF: '条件付き合計', SUMIFS: '条件付き合計', COUNT: '件数', COUNTA: '件数', COUNTIF: '条件付き件数', COUNTIFS: '条件付き件数', AVERAGE: '平均', AVERAGEIF: '条件付き平均', MAX: '最大', MIN: '最小', SUMPRODUCT: '積の合計',
  TODAY: '今日', NOW: '現在時刻', VLOOKUP: '参照', XLOOKUP: '参照', INDEX: '参照', MATCH: '位置', HLOOKUP: '参照', IF: 'もし', IFS: 'もし', IFERROR: 'エラーなら', AND: 'かつ', OR: 'または', DATEDIF: '日数差', EDATE: '月後', WORKDAY: '営業日後', NETWORKDAYS: '営業日数', DATE: '日付',
}

// Tokenize before rewriting: operators/references inside string literals, quoted
// sheet names, structured references and function names (LOG10) are not cells.
const REFERENCE_SOURCE = String.raw`(?:(?:'(?:[^']|'')*'|[\p{L}_\\][\p{L}\p{N}_.\\]*)!)?(?:\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)(?![\p{L}\p{N}_.(])`
const FORMULA_TOKEN = new RegExp(String.raw`"(?:[^"]|"")*"|[\p{L}_\\][\p{L}\p{N}_.\\]*(?=\s*\()|${REFERENCE_SOURCE}|(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?|\[[^\]]*\]|[\p{L}_\\][\p{L}\p{N}_.\\]*|<>|>=|<=|\s+|.`, 'giu')
const IS_REFERENCE = new RegExp(`^(?:${REFERENCE_SOURCE})$`, 'iu')
type FormulaTokenKind = 'literal' | 'reference' | 'function' | 'other'

/** Shared lexical boundary for formula display, grouping and shared-formula expansion. */
export function mapFormulaTokens(formula: string, replace: (token: string, kind: FormulaTokenKind) => string): string {
  return formula.replace(FORMULA_TOKEN, (token: string, offset: number) => {
    const kind: FormulaTokenKind = token.startsWith('"') || token.startsWith('[') ? 'literal'
      : /^[\p{L}_\\]/u.test(token) && /^\s*\(/.test(formula.slice(offset + token.length)) ? 'function'
        : IS_REFERENCE.test(token) ? 'reference'
          : 'other'
    return replace(token, kind)
  })
}

const functionName = (token: string) => token.replace(/^(?:(?:_xlfn|_xlws)\.)+/i, '').toUpperCase()
const OPERATOR_WORD: Record<string, string> = { '*': ' × ', '/': ' ÷ ', '&': ' + ', '<>': ' ≠ ', '>=': ' ≥ ', '<=': ' ≤ ' }

/** `D2*E2` → `数量 × 単価`; literals and sheet/header punctuation stay intact. */
export function humanizeFormula(formula: string, headersOf: (sheet: string | undefined) => string[]): string {
  return mapFormulaTokens(formula.replace(/^=/, ''), (token, kind) => {
    if (kind === 'function') return FUNCTION_WORD[functionName(token)] ?? functionName(token)
    if (kind === 'reference') {
      const separator = token.lastIndexOf('!')
      const rawSheet = separator < 0 ? undefined : token.slice(0, separator)
      const sheet = rawSheet?.startsWith("'") ? rawSheet.slice(1, -1).replace(/''/g, "'") : rawSheet
      const address = token.slice(separator + 1)
      const ends = address.split(':')
      const headers = headersOf(sheet)
      const label = (end: string) => {
        const letters = end.replace(/[$\d]/g, '').toUpperCase()
        return letters ? headers[columnIndex(letters)] || letters : end
      }
      const from = label(ends[0])
      const to = ends[1] ? label(ends[1]) : undefined
      return `${sheet ? `${sheet}の` : ''}${to && to !== from ? `${from}〜${to}` : from}`
    }
    if (kind === 'literal') return token
    return OPERATOR_WORD[token] ?? token
  }).trim()
}

function readRules(sheet: SheetGrid, headerRow: number, headers: string[], headersOf: (sheet: string | undefined) => string[]): Rule[] {
  const byPattern = new Map<string, Rule>()
  for (const cell of sheet.formulas ?? []) {
    if (cell.row <= headerRow) continue
    const column = headers[cell.column]
    if (!column) continue
    const pattern = mapFormulaTokens(cell.formula, (token, kind) => {
      if (kind === 'function') return functionName(token)
      if (kind !== 'reference') return token
      const separator = token.lastIndexOf('!')
      // Sheet names and fixed row numbers are semantic, not repeated-row offsets.
      return token.slice(0, separator + 1) + token.slice(separator + 1).replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/gi, (_match, column: string, fixed: string, row: string) => fixed ? `${column}$${row}` : column)
    })
    const key = `${cell.column}:${pattern}`
    const existing = byPattern.get(key)
    if (existing) {
      existing.rows += 1
      continue
    }
    const names: string[] = []
    mapFormulaTokens(cell.formula, (token, kind) => {
      if (kind === 'function') names.push(functionName(token))
      return token
    })
    const category = names.map((name) => FUNCTION_CATEGORY[name]).find((value) => value !== undefined) ?? 'calc'
    byPattern.set(key, { column, expression: humanizeFormula(cell.formula, headersOf), category, rows: 1 })
  }
  return [...byPattern.values()]
}

function readSheet(sheet: SheetGrid, masters: Map<string, Set<string>>, headersOf: (sheet: string | undefined) => string[]): SheetReading {
  const headerRow = findHeaderRow(sheet.rows)
  const headers = headersOf(sheet.name)
  const dataFormulas = (sheet.formulas ?? []).filter((cell) => cell.row > headerRow)
  const formulaRows = new Set(dataFormulas.map((cell) => cell.row))
  // A row counts when it has a value or a formula (uploaded files may carry formulas without cached values).
  const rowIndexes = new Set(formulaRows)
  sheet.rows.forEach((row, index) => {
    if (index > headerRow && row?.some((cell) => !isBlank(cell))) rowIndexes.add(index)
  })
  const body = [...rowIndexes].sort((a, b) => a - b).map((index) => sheet.rows[index] ?? [])
  const formulaColumns = new Set(dataFormulas.map((cell) => cell.column))
  const columns: ColumnReading[] = []
  headers.forEach((header, index) => {
    if (!header) return
    const values = body.map((row) => row[index] ?? null)
    const present = values.filter((value) => !isBlank(value))
    const inferred = inferColumn(header, values, sheet.validations?.[index], masters, sheet.name, formulaColumns.has(index))
    columns.push({
      index,
      fill: body.length === 0 ? 0 : present.length / body.length,
      samples: [...new Set(present.map(cellText))].slice(0, 3),
      ...inferred,
    })
  })
  const rules = readRules(sheet, headerRow, headers, headersOf)
  const formulaCells = rules.reduce((sum, rule) => sum + rule.rows, 0)
  const role: SheetRole =
    columns.length === 0 || body.length === 0
      ? 'empty'
      : SUMMARY_SHEET.test(sheet.name) || (formulaCells > 0 && formulaCells >= body.length * columns.length * 0.5)
        ? 'summary'
        : masters.has(sheet.name) || (MASTER_SHEET.test(sheet.name) && columns.length <= 4)
          ? 'master'
          : 'records'
  const status = role === 'records' ? columns.find((column) => column.kind === 'choice' && STATUS_HEADER.test(column.header)) : undefined
  return {
    name: sheet.name,
    role,
    headerRow,
    dataRows: body.length,
    columns,
    rules,
    mergedRanges: sheet.mergedRanges ?? 0,
    truncated: sheet.truncated,
    workflow: status?.options ? { column: status.header, stages: status.options } : undefined,
  }
}

export function readWorkbook(workbook: WorkbookGrid): Reading {
  const masters = masterKeys(workbook.sheets)
  const headerCache = new Map<string, string[]>()
  const headersOf = (name: string | undefined): string[] => {
    const sheet = name === undefined ? workbook.sheets[0] : workbook.sheets.find((item) => item.name === name)
    if (!sheet) return []
    let headers = headerCache.get(sheet.name)
    if (!headers) {
      headers = (sheet.rows[findHeaderRow(sheet.rows)] ?? []).map((cell) => (typeof cell === 'string' ? cell.trim() : ''))
      headerCache.set(sheet.name, headers)
    }
    return headers
  }
  const sheets = workbook.sheets.map((sheet) => readSheet(sheet, masters, (name) => headersOf(name ?? sheet.name)))
  return { fileName: workbook.fileName, sheets, capabilities: readingCapabilities(sheets) }
}

/** Shared by workbook reading and the design stage, which can reuse saved readings. */
export function readingCapabilities(sheets: SheetReading[]): Capability[] {
  const columns = sheets.flatMap((sheet) => sheet.columns)
  const rules = sheets.flatMap((sheet) => sheet.rules)
  const capabilities: Capability[] = []
  if (sheets.some((sheet) => sheet.role === 'records')) capabilities.push('entry')
  if (columns.some((column) => column.kind === 'choice')) capabilities.push('choices')
  if (rules.some((rule) => rule.category === 'calc' || rule.category === 'condition')) capabilities.push('calculation')
  if (columns.some((column) => column.kind === 'reference') || rules.some((rule) => rule.category === 'lookup')) capabilities.push('lookup')
  if (sheets.some((sheet) => sheet.role === 'summary') || rules.some((rule) => rule.category === 'aggregate')) capabilities.push('aggregate')
  if (sheets.some((sheet) => sheet.workflow)) capabilities.push('workflow')
  if (sheets.some((sheet) => sheet.role === 'records' && sheet.columns.some((column) => column.kind === 'person') && sheet.columns.some((column) => column.kind === 'date' && /期限|予定/.test(column.header)))) capabilities.push('deadlines')
  return capabilities
}

/** The screens the analysis implies. An entity of a kind this console does not know gets none (it is not guessed to be a ledger). */
export function planApp(analysis: Pick<ExcelAnalysis, 'entities' | 'capabilities'>, name: string): AppPlan {
  const entities: PlannedEntity[] = analysis.entities.map((entity) => ({
    ...entity,
    workflow: entity.workflow ? { column: entity.workflow.field, stages: entity.workflow.stages } : undefined,
  }))
  const screens: PlannedScreen[] = []
  for (const entity of entities) {
    if (isOneOf(entity.kind, 'master')) screens.push({ kind: 'master', entity: entity.name })
    if (!isOneOf(entity.kind, 'records')) continue
    screens.push({ kind: 'list', entity: entity.name }, { kind: 'form', entity: entity.name }, { kind: 'detail', entity: entity.name })
    if (entity.workflow) screens.push({ kind: 'board', entity: entity.name })
  }
  if (analysis.capabilities.some((capability) => isOneOf(capability, 'aggregate'))) {
    const first = entities.find((entity) => isOneOf(entity.kind, 'records'))
    if (first) screens.push({ kind: 'dashboard', entity: first.name })
  }
  return {
    name,
    entities,
    screens,
    totalImportRows: entities.reduce((sum, entity) => sum + entity.importRows, 0),
  }
}

export interface EntityRow {
  index: number
  key: string
  values: Record<string, CellValue>
}

/** Source order is stable; constants never turn an otherwise blank row into a record. */
export function entityRows(entity: { fields: readonly { name: string }[]; sources: readonly AnalysisSource[]; key?: readonly string[] }, grids: ReadonlyMap<string, WorkbookGrid>): EntityRow[] {
  const result: EntityRow[] = []
  const seen = new Set<string>()
  for (const source of entity.sources) {
    const sheet = grids.get(source.workbookId)?.sheets.find((item) => item.name === source.sheet)
    if (!sheet) continue
    for (let index = source.headerRow + 1; index < sheet.rows.length; index += 1) {
      const row = sheet.rows[index] ?? []
      if (source.columns.every((column) => isBlank(row[column.index]))) continue
      const values: Record<string, CellValue> = Object.fromEntries(entity.fields.map((field) => [field.name, null]))
      for (const column of source.columns) values[column.field] = row[column.index] ?? null
      for (const constant of source.constants ?? []) values[constant.field] = constant.value
      if (entity.key?.length) {
        const businessKey = JSON.stringify(entity.key.map((field) => values[field] ?? null))
        if (seen.has(businessKey)) continue
        seen.add(businessKey)
      }
      result.push({ index: result.length, key: `${source.workbookId}:${source.sheet}:${index + 1}`, values })
    }
  }
  return result
}
