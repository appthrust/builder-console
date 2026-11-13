// Form ⇄ row coercion for the データ tab (design/platform/builder-console-app-data.md,
// "model/data-record.ts"): every input is a string, every row value is what
// the Platform API returns. Per field kind this module parses and validates the
// form, computes the changed columns of an update and its optimistic-lock
// payload, and turns a save error envelope into field or form messages.
import type { PlatformErrorEnvelope } from '../api/platform-error'
import { writeText } from '../features/app/data/copy-write'
import type { Collection, DataRow, Field } from './data-catalog'

/** One string per field name (checkbox: 'true' | 'false'; '' = empty). */
export type FormValues = Record<string, string>
export type FormMode = 'create' | 'update'

export interface ParsedForm {
  values: Record<string, unknown>
  errors: Record<string, string>
}

/**
 * `editingUnavailable`: the database's editor broker is not rolled out yet
 * (412 `row_editing_unavailable`); the Sheet stays read-only from then on.
 */
export type SaveErrorKind = 'conflict' | 'constraint' | 'forbidden' | 'readOnly' | 'editingUnavailable' | 'other'

export interface SaveError {
  kind: SaveErrorKind
  /** Message per field name, when the failing column is one of the form's fields. */
  fieldErrors: Record<string, string>
  /** Form-level message (also set when a field message exists, for summaries). */
  message: string
}

/** The optimistic-lock column sent with every update when the row has it. */
export const UPDATED_AT = 'updated_at'
export const CREATED_AT = 'created_at'

const pad = (value: number) => String(value).padStart(2, '0')

function toDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/**
 * ISO 8601 with the local offset (`2026-10-08T14:02:00+09:00`): an instant for
 * `timestamptz`, and the wall time the user typed for `timestamp` (PostgreSQL
 * drops the offset there).
 */
function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** `YYYY/MM/DD HH:mm` in local time; the Sheet shows timestamps in full (the grid abbreviates). */
export function formatTimestampFull(value: unknown): string | undefined {
  const date = toDate(value)
  return date
    ? `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : undefined
}

function fieldFormValue(field: Field, value: unknown): string {
  // A value of a type this console does not know never reaches an input.
  if (value === null || value === undefined || field.kind === 'unsupported') return ''
  switch (field.kind) {
    case 'boolean':
      return value === true ? 'true' : value === false ? 'false' : ''
    case 'json':
      return JSON.stringify(value, null, 2)
    case 'timestamp': {
      const date = toDate(value)
      // `YYYY-MM-DDTHH:mm` in local time: the `datetime-local` input format.
      return date
        ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
        : String(value)
    }
    case 'date':
      return typeof value === 'string' ? value.slice(0, 10) : String(value)
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
}

/**
 * Input strings for a row (`null` = create). On create every field starts
 * empty, except a NOT NULL boolean without a default, which starts 「いいえ」
 * because a checkbox has no empty state.
 */
export function toFormValues(collection: Collection, row: DataRow | null): FormValues {
  const form: FormValues = {}
  for (const field of collection.fields) {
    if (row) form[field.name] = fieldFormValue(field, row.values[field.name])
    else form[field.name] = field.kind === 'boolean' && !field.nullable && !field.hasDefault ? 'false' : ''
  }
  return form
}

const INTEGER = /^[-+]?\d+$/
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/
const DATE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/
const TIMESTAMP = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Full-width digits and thousands separators are what people type (`１２０,０００`). */
const numeric = (raw: string) => raw.normalize('NFKC').replace(/[,\s]/g, '')

/** The calendar day, rejecting rollovers like 2026-02-30. */
function calendarDate(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0): Date | undefined {
  const date = new Date(year, month - 1, day, hours, minutes, seconds)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hours && date.getMinutes() === minutes
    ? date
    : undefined
}

type Parsed = { value: unknown } | { error: string }

function parseValue(field: Field, raw: string): Parsed {
  const v = writeText.validation
  const trimmed = raw.trim()
  switch (field.kind) {
    case 'text':
    case 'longtext':
      return { value: raw }
    case 'integer': {
      const text = numeric(trimmed)
      if (!INTEGER.test(text)) return { error: v.integer(field.label) }
      const value = Number(text)
      // Beyond 2^53 the digits travel as text; PostgreSQL parses bigint/numeric from it.
      return { value: Number.isSafeInteger(value) ? value : text.replace(/^\+/, '') }
    }
    case 'number': {
      const text = numeric(trimmed)
      const value = Number(text)
      return NUMBER.test(text) && Number.isFinite(value) ? { value } : { error: v.number(field.label) }
    }
    case 'boolean':
      return trimmed === 'true' ? { value: true } : trimmed === 'false' ? { value: false } : { error: v.boolean(field.label) }
    case 'date': {
      const match = DATE.exec(numeric(trimmed))
      const date = match ? calendarDate(Number(match[1]), Number(match[2]), Number(match[3])) : undefined
      return date ? { value: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` } : { error: v.date(field.label) }
    }
    case 'timestamp': {
      const match = TIMESTAMP.exec(trimmed.normalize('NFKC'))
      const date = match
        ? calendarDate(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0))
        : undefined
      return date ? { value: localIso(date) } : { error: v.timestamp(field.label) }
    }
    case 'enum':
      return !field.enumValues || field.enumValues.includes(trimmed) ? { value: trimmed } : { error: v.enum(field.label) }
    case 'json':
      try {
        return { value: JSON.parse(trimmed) as unknown }
      } catch {
        return { error: v.json(field.label) }
      }
    case 'uuid':
      return UUID.test(trimmed) ? { value: trimmed.toLowerCase() } : { error: v.uuid(field.label) }
    case 'reference':
      return { value: trimmed }
    case 'unsupported':
      return { error: v.unsupported(field.label) }
  }
}

/**
 * Form → row values. Read-only fields (auto-filled keys and timestamps) are
 * never emitted. An empty input means: on create, leave it to the column
 * default when there is one; otherwise null when the column allows it, else
 * 「○○ は必須です」. A column of a type this console does not know is never
 * emitted: an update leaves it as stored, and a new row cannot be made
 * without it (the column would be dropped unseen).
 */
export function parseFormValues(collection: Collection, form: FormValues, mode: FormMode): ParsedForm {
  const values: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const field of collection.fields) {
    if (field.readOnly) continue
    if (field.kind === 'unsupported') {
      if (mode === 'create') errors[field.name] = writeText.validation.unsupported(field.label)
      continue
    }
    const raw = form[field.name] ?? ''
    if (raw.trim() === '') {
      if (mode === 'create' && field.hasDefault) continue
      if (field.nullable) values[field.name] = null
      else errors[field.name] = writeText.validation.required(field.label)
      continue
    }
    const parsed = parseValue(field, raw)
    if ('error' in parsed) errors[field.name] = parsed.error
    else values[field.name] = parsed.value
  }
  return { values, errors }
}

/** Key-order independent JSON, so `{a,b}` and `{b,a}` compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Same stored value: null and undefined match each other only; scalars compare
 * by their text (a reference key typed as `"3"` equals the stored `3`),
 * objects structurally.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  const aEmpty = a === null || a === undefined
  const bEmpty = b === null || b === undefined
  if (aEmpty || bEmpty) return aEmpty && bEmpty
  if (typeof a === 'object' || typeof b === 'object') return canonical(a) === canonical(b)
  return String(a) === String(b)
}

/** The entries of `after` that differ from `before`: an update sends only these columns. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(after)) {
    if (!sameValue(before[name], value)) changed[name] = value
  }
  return changed
}

/**
 * The optimistic-lock payload of an update: the values the user last saw for
 * each changed column, plus `updated_at` when the row has one. JSON columns
 * are left out: PostgreSQL has no equality for `json`, and `updated_at` or the
 * other columns still detect the concurrent write.
 */
export function expectedFor(collection: Collection, row: DataRow, changed: Record<string, unknown>): Record<string, unknown> {
  const expected: Record<string, unknown> = {}
  for (const name of Object.keys(changed)) {
    if (!(name in row.values)) continue
    if (collection.fields.find((field) => field.name === name)?.kind === 'json') continue
    expected[name] = row.values[name] ?? null
  }
  const updatedAt = row.values[UPDATED_AT]
  if (updatedAt !== null && updatedAt !== undefined) expected[UPDATED_AT] = updatedAt
  return expected
}

/**
 * After a conflict reload: the latest row's inputs, with the user's own edits
 * (inputs that differ from the row they started from) kept on top.
 */
export function rebaseForm(collection: Collection, startedFrom: DataRow, latest: DataRow, form: FormValues): FormValues {
  const original = toFormValues(collection, startedFrom)
  const next = toFormValues(collection, latest)
  for (const field of collection.fields) {
    if (!field.readOnly && form[field.name] !== original[field.name]) next[field.name] = form[field.name] ?? ''
  }
  return next
}

/** Fields whose stored value differs between two versions of a row (what another writer changed). */
export function changedFields(collection: Collection, before: DataRow, after: DataRow): Field[] {
  return collection.fields.filter((field) => !sameValue(before.values[field.name], after.values[field.name]))
}

/** Field for a PostgreSQL constraint named by its default convention (`products_name_key`, `…_fkey`, `…_check`). */
function fieldForConstraint(collection: Collection, constraint: string): Field | undefined {
  const prefix = `${collection.name}_`
  if (!constraint.startsWith(prefix)) return undefined
  const column = constraint.slice(prefix.length).replace(/_(?:key|fkey|check|not_null)$/, '')
  return collection.fields.find((field) => field.name === column)
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/**
 * A failed create/update/delete as the Sheet shows it. Constraint violations
 * land on the field when the column is known (from `details.column` or the
 * constraint name), otherwise on the form.
 */
export function mapSaveError(envelope: PlatformErrorEnvelope | undefined, collection: Collection, op: 'save' | 'delete' = 'save'): SaveError {
  const e = writeText.errors
  const details = envelope?.details ?? {}
  const reason = text(details.reason)
  const other = (message: string): SaveError => ({ kind: 'other', fieldErrors: {}, message })

  if (envelope?.status === 403) return { kind: 'forbidden', fieldErrors: {}, message: e.forbidden }
  switch (reason) {
    case 'row_changed':
      return { kind: 'conflict', fieldErrors: {}, message: e.conflict }
    case 'table_read_only':
      return { kind: 'readOnly', fieldErrors: {}, message: e.readOnly }
    case 'row_editing_unavailable':
      return { kind: 'editingUnavailable', fieldErrors: {}, message: e.editingUnavailable }
    case 'row_not_found':
      return other(e.notFound)
    case 'database_suspended':
    case 'database_waking':
      return other(e.stopped)
    case 'database_data_unsupported':
      return other(e.unsupported)
    case 'constraint_violation':
      break
    default:
      return other(envelope?.status === 404 ? e.notFound : op === 'delete' ? e.deleteOther : e.other)
  }

  const sqlstate = text(details.sqlstate) ?? ''
  const column = text(details.column)
  const constraint = text(details.constraint)
  const field = column
    ? collection.fields.find((candidate) => candidate.name === column)
    : constraint
      ? fieldForConstraint(collection, constraint)
      : undefined
  const forField = (message: (label: string) => string): SaveError =>
    ({ kind: 'constraint', fieldErrors: { [field!.name]: message(field!.label) }, message: message(field!.label) })
  const forForm = (message: string): SaveError => ({ kind: 'constraint', fieldErrors: {}, message })

  if (sqlstate === '23503') {
    if (op === 'delete') return forForm(e.inUse)
    return field ? forField(e.reference) : forForm(e.referenceAny)
  }
  if (sqlstate === '23505') return field ? forField(e.unique) : forForm(e.uniqueAny)
  if (sqlstate === '23502') return field ? forField(e.notNull) : forForm(e.invalidAny)
  if (sqlstate === '23514') return field ? forField(e.check) : forForm(e.checkAny)
  return field ? forField(e.invalidValue) : forForm(e.invalidAny)
}
