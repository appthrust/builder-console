// Pure derivation from the Platform API's table descriptions to the console's
// App Data model (design/platform/builder-console-app-data.md §Domain model).
// This is the only module that interprets PostgreSQL vocabulary (type names,
// primary keys, comments and their `@` tags); the データ tab sees Catalog /
// Collection / Field / DataRow only.
import type { DatabaseTableColumn, DatabaseTableSchema, DatabaseTableSummary } from '@appthrust/api-schema/platform-api'
import { copy } from '../copy'
import { locale } from '../shell/language'

export type FieldKind = 'text' | 'longtext' | 'integer' | 'number' | 'boolean' | 'date' | 'timestamp' | 'enum' | 'reference' | 'json' | 'uuid'

export interface Field {
  name: string
  label: string
  kind: FieldKind
  /** NOT NULL without a default: a new row must carry a value. */
  required: boolean
  /** Filled by the database (generated key, created_at/updated_at with a default); never edited. */
  readOnly: boolean
  hasDefault: boolean
  nullable: boolean
  enumValues?: readonly string[]
  reference?: { schema: string; table: string; column: string }
}

export interface Collection {
  /** `${schema}.${name}` */
  id: string
  schema: string
  name: string
  label: string
  description?: string
  kind: 'table' | 'view'
  /** Rows can be added, changed and deleted (a table with exactly one key column). */
  editable: boolean
  /**
   * Left out of the 表 list: `_`-prefixed names, `@hidden` comments, or `pg_`-prefixed
   * PostgreSQL/extension relations such as `pg_stat_statements`.
   */
  hidden: boolean
  primaryKey?: string
  /** Visible columns only; `@hidden` columns are excluded from grid, search and forms. */
  fields: Field[]
  /** Column that names a row (sheet title, delete confirmation). */
  displayField: string
  rowCountEstimate?: number
}

/** One app database as the console sees it; hidden collections are included with `hidden: true`. */
export interface Catalog {
  collections: Collection[]
}

export interface DataRow {
  key: string
  values: Record<string, unknown>
}

const TRUNCATE_AT = 80

/** Leading `@tag` words of a comment, and the label / description text after them. */
interface Comment {
  tags: ReadonlySet<string>
  label?: string
  description?: string
}

function parseComment(comment: string | undefined): Comment {
  const tags = new Set<string>()
  let rest = (comment ?? '').trim()
  for (let tag = /^@([A-Za-z][\w-]*)\s*/.exec(rest); tag; tag = /^@([A-Za-z][\w-]*)\s*/.exec(rest)) {
    tags.add(tag[1]!.toLowerCase())
    rest = rest.slice(tag[0].length)
  }
  const newline = rest.indexOf('\n')
  const label = (newline === -1 ? rest : rest.slice(0, newline)).trim()
  const description = newline === -1 ? '' : rest.slice(newline + 1).trim()
  return { tags, ...(label ? { label } : {}), ...(description ? { description } : {}) }
}

/** `unit_price` → `Unit price`. */
function humanize(name: string): string {
  const words = name.split('_').filter(Boolean).join(' ').toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : name
}

/** PostgreSQL type names (modifier stripped) → kind; `timestamp…`, arrays, enums and references are decided in fieldKind. */
const TYPE_KIND: Record<string, FieldKind> = {
  text: 'text', 'character varying': 'text', varchar: 'text', citext: 'text', character: 'text', char: 'text', bpchar: 'text', name: 'text',
  smallint: 'integer', integer: 'integer', bigint: 'integer', int: 'integer', int2: 'integer', int4: 'integer', int8: 'integer',
  smallserial: 'integer', serial: 'integer', bigserial: 'integer',
  numeric: 'number', decimal: 'number', real: 'number', 'double precision': 'number', float4: 'number', float8: 'number', money: 'number',
  boolean: 'boolean', bool: 'boolean',
  date: 'date',
  json: 'json', jsonb: 'json',
  uuid: 'uuid',
}

function fieldKind(column: DatabaseTableColumn, long: boolean): FieldKind {
  if (column.references) return 'reference'
  if (column.enumValues?.length) return 'enum'
  // `character varying(40)` / `numeric(10,2)` carry a modifier the kind ignores.
  const type = column.type.trim().toLowerCase().replace(/\s*\(.*\)$/, '')
  if (type.endsWith('[]') || type === 'array') return 'json'
  if (type.startsWith('timestamp')) return 'timestamp'
  const kind = Object.hasOwn(TYPE_KIND, type) ? TYPE_KIND[type]! : 'text'
  return kind === 'text' && long ? 'longtext' : kind
}

const AUTO_TIMESTAMPS: Record<string, true> = { created_at: true, updated_at: true }

function deriveField(column: DatabaseTableColumn): Field | undefined {
  const comment = parseComment(column.description)
  if (comment.tags.has('hidden')) return undefined
  const kind = fieldKind(column, comment.tags.has('long'))
  return {
    name: column.name,
    label: comment.label ?? (column.name === 'id' ? copy.app.dataValue.idLabel : humanize(column.name)),
    kind,
    required: !column.nullable && !column.hasDefault,
    readOnly: column.hasDefault && (column.primaryKey || Object.hasOwn(AUTO_TIMESTAMPS, column.name)),
    hasDefault: column.hasDefault,
    nullable: column.nullable,
    ...(kind === 'enum' && column.enumValues ? { enumValues: column.enumValues } : {}),
    ...(column.references ? { reference: { ...column.references } } : {}),
  }
}

export function deriveCollection(schema: DatabaseTableSchema): Collection {
  const comment = parseComment(schema.description)
  const kind = schema.type.toLowerCase().includes('view') ? 'view' : 'table'
  const primaryKey = schema.primaryKey.length === 1 ? schema.primaryKey[0] : undefined
  const fields = schema.columns.flatMap((column) => deriveField(column) ?? [])
  const displayField =
    fields.find((field) => (field.kind === 'text' || field.kind === 'longtext') && field.name !== primaryKey)?.name ??
    primaryKey ??
    fields[0]?.name ??
    ''
  return {
    id: `${schema.schema}.${schema.name}`,
    schema: schema.schema,
    name: schema.name,
    label: comment.label ?? humanize(schema.name),
    ...(comment.description ? { description: comment.description } : {}),
    kind,
    editable: schema.editable && kind === 'table' && primaryKey !== undefined,
    hidden: schema.name.startsWith('_') || schema.name.startsWith('pg_') || comment.tags.has('hidden'),
    ...(primaryKey ? { primaryKey } : {}),
    fields,
    displayField,
    ...(schema.rowCountEstimate !== undefined ? { rowCountEstimate: schema.rowCountEstimate } : {}),
  }
}

/** The list order is the server's; a table whose description is not (yet) known is left out. */
export function deriveCatalog(tables: readonly DatabaseTableSummary[], schemas: readonly DatabaseTableSchema[]): Catalog {
  const described = new Map(schemas.map((schema) => [`${schema.schema}.${schema.name}`, schema]))
  const collections: Collection[] = []
  for (const table of tables) {
    const schema = described.get(`${table.schema}.${table.name}`)
    if (schema) collections.push(deriveCollection(schema))
  }
  return { collections }
}

/** The single key value as the `{key}` path segment; undefined without a single key column or value. */
export function rowKey(collection: Collection, values: Record<string, unknown>): string | undefined {
  if (!collection.primaryKey) return undefined
  const value = values[collection.primaryKey]
  return value === null || value === undefined || value === '' ? undefined : String(value)
}

export function toDataRow(collection: Collection, values: Record<string, unknown>): DataRow | undefined {
  const key = rowKey(collection, values)
  return key === undefined ? undefined : { key, values }
}

const pad = (value: number) => String(value).padStart(2, '0')

function truncate(text: string): string {
  const chars = Array.from(text)
  return chars.length > TRUNCATE_AT ? `${chars.slice(0, TRUNCATE_AT).join('')}…` : text
}

// Reuse the formatter across cells, rebuilding only when the language changes.
let numberFormat: Intl.NumberFormat | undefined
let numberLocale: string | undefined

function formatNumber(value: unknown): string {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  // A bigint beyond the safe range stays exact as the database wrote it.
  if (!Number.isFinite(number) || (typeof value === 'string' && !Number.isSafeInteger(Math.trunc(number)))) return truncate(String(value))
  const currentLocale = locale()
  if (!numberFormat || numberLocale !== currentLocale) {
    numberFormat = new Intl.NumberFormat(currentLocale, { maximumFractionDigits: 6 })
    numberLocale = currentLocale
  }
  return numberFormat.format(number)
}

/** `2026-10-08` → `2026/10/08`, without a time-zone shift. */
function formatDate(value: unknown): string {
  const text = String(value)
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  return parts ? `${parts[1]}/${parts[2]}/${parts[3]}` : truncate(text)
}

/** `MM/DD HH:mm` in the viewer's time zone; a value without an offset is read as local time. */
function formatTimestamp(value: unknown): string {
  const text = String(value)
  const at = new Date(text)
  if (Number.isNaN(at.getTime())) return truncate(text)
  return `${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** Grid text for one value in the current locale. The full value is the row sheet's job. */
export function formatValue(field: Field, value: unknown): string {
  if (value === null || value === undefined) return copy.app.dataValue.none
  switch (field.kind) {
    case 'boolean':
      if (typeof value === 'boolean') return value ? copy.app.dataValue.yes : copy.app.dataValue.no
      break
    case 'integer':
    case 'number':
      return formatNumber(value)
    case 'date':
      return formatDate(value)
    case 'timestamp':
      return formatTimestamp(value)
    case 'json':
      return copy.app.dataValue.json
  }
  return truncate(typeof value === 'object' ? JSON.stringify(value) : String(value))
}

/** Names a row for people: its display column, else its key. */
export function displayValue(collection: Collection, row: DataRow): string {
  const value = row.values[collection.displayField]
  const field = collection.fields.find((item) => item.name === collection.displayField)
  if (value === null || value === undefined || value === '' || !field) return row.key
  return formatValue(field, value)
}
