// Dev-only row writes for the データ tab mock (POST/PATCH/DELETE
// `…/databases/{id}/tables/{schema}/{table}/rows[/{key}]`), applied to the
// tables seeded by ./mock-database-data.ts. Answers mirror the Platform API
// contract: 201/200 with the written row, 404 `row_not_found`, 409
// `row_changed` when `expected` no longer matches, 400/409
// `constraint_violation` with `sqlstate` and `column`/`constraint`, 412
// `table_read_only`.
//
// `POST /api/v1/__mock/data-write {mode}` (mock-platform.ts):
// - `conflict`: the next PATCH finds the row touched by someone else (its
//   `updated_at` moves) and answers 409 `row_changed`;
// - `constraint`: the next PATCH answers 400 `constraint_violation`
//   (23514, `column` = the first changed column);
// - `unavailable`: every write answers 412 `row_editing_unavailable` (an
//   older operator without the editor broker) until `ok`;
// - `ok`: clears the above.
import type { DatabaseRowsResponse, PublicOperation } from '@appthrust/api-schema/platform-api'
import { dataModeFailure, isTableReadOnly, state as dataState, type MockDataTable } from './mock-database-data'

/** The part of mock-database-data.ts's `state` the writes need (`tables` keyed `${schema}.${name}`). */
export interface MockDataState {
  tables: Map<string, MockDataTable>
}

export type DataWriteMode = 'ok' | 'conflict' | 'constraint' | 'unavailable'

export const DATA_WRITE_MODES: readonly DataWriteMode[] = ['ok', 'conflict', 'constraint', 'unavailable']

export type MockWriteResult =
  | { ok: true; status: 200 | 201; key: string; response: DatabaseRowsResponse }
  | { ok: false; status: number; code: string; message: string; details: Record<string, unknown> }

/**
 * The armed mode and the `tables` map it was armed for: a mock reset replaces
 * that map, which disarms the mode without a reset hook here.
 */
let armed: { tables: MockDataState['tables']; mode: DataWriteMode } | undefined

export function setDataWriteMode(state: MockDataState, mode: DataWriteMode): void {
  armed = mode === 'ok' ? undefined : { tables: state.tables, mode }
}

function armedMode(state: MockDataState): DataWriteMode {
  return armed && armed.tables === state.tables ? armed.mode : 'ok'
}

const failure = (status: number, code: string, message: string, details: Record<string, unknown>): MockWriteResult => ({ ok: false, status, code, message, details })

function rowsResponse(table: MockDataTable, row: Record<string, unknown>): DatabaseRowsResponse {
  return {
    columns: table.schema.columns.map((column) => ({ name: column.name, type: column.type })),
    rows: [row],
    rowCount: 1,
    limit: 1,
    offset: 0,
    truncated: false,
    fetchedAt: new Date().toISOString(),
  }
}

type Target = { table: MockDataTable; primaryKey: string } | MockWriteResult

function target(state: MockDataState, schema: string, name: string): Target {
  const table = state.tables.get(`${schema}.${name}`)
  if (!table) return failure(404, 'not_found', `table ${schema}.${name} not found`, { reason: 'table_not_found' })
  if (armedMode(state) === 'unavailable') {
    return failure(412, 'failed_precondition', 'row editing is not enabled for this database yet', { reason: 'row_editing_unavailable' })
  }
  const primaryKey = table.schema.primaryKey[0]
  if (!primaryKey || isTableReadOnly(table)) {
    return failure(412, 'failed_precondition', `table ${schema}.${name} is read-only`, { reason: 'table_read_only' })
  }
  return { table, primaryKey }
}

/** Unknown columns, NOT NULL and enum membership, as PostgreSQL would reject them. */
function checkValues(table: MockDataTable, values: Record<string, unknown>, complete: boolean): MockWriteResult | undefined {
  const columns = new Map(table.schema.columns.map((column) => [column.name, column]))
  for (const name of Object.keys(values)) {
    if (!columns.has(name)) return failure(400, 'invalid_argument', `column ${name} does not exist`, { reason: 'unknown_column', column: name })
  }
  for (const column of table.schema.columns) {
    const present = Object.hasOwn(values, column.name)
    const value = values[column.name]
    if ((present || complete) && !column.nullable && (value === null || value === undefined)) {
      return failure(400, 'invalid_argument', `null value in column "${column.name}" violates not-null constraint`, {
        reason: 'constraint_violation',
        sqlstate: '23502',
        column: column.name,
      })
    }
    if (present && value !== null && column.enumValues && !column.enumValues.includes(String(value))) {
      return failure(400, 'invalid_argument', `invalid input value for enum: "${String(value)}"`, {
        reason: 'constraint_violation',
        sqlstate: '22P02',
        column: column.name,
      })
    }
  }
  return undefined
}

const findIndex = (table: MockDataTable, primaryKey: string, key: string) => table.rows.findIndex((row) => String(row[primaryKey]) === key)

export function createRow(state: MockDataState, schema: string, tableName: string, values: Record<string, unknown>): MockWriteResult {
  const found = target(state, schema, tableName)
  if ('ok' in found) return found
  const { table, primaryKey } = found
  const now = new Date().toISOString()
  const row: Record<string, unknown> = {}
  for (const column of table.schema.columns) {
    if (Object.hasOwn(values, column.name)) row[column.name] = values[column.name]
    else if (!column.hasDefault) row[column.name] = null
    else if (column.name === primaryKey) row[column.name] = column.type === 'uuid' ? crypto.randomUUID() : table.nextId++
    else if (column.type.startsWith('timestamp')) row[column.name] = now
    else if (column.type === 'date') row[column.name] = now.slice(0, 10)
    else if (column.enumValues?.length) row[column.name] = column.enumValues[0]
    else if (column.type === 'boolean') row[column.name] = false
    else if (/^(?:smallint|integer|bigint|numeric|real|double)/.test(column.type)) row[column.name] = 0
    else row[column.name] = null
  }
  const invalid = checkValues(table, row, true) ?? checkValues(table, values, false)
  if (invalid) return invalid
  const key = String(row[primaryKey])
  if (findIndex(table, primaryKey, key) >= 0) {
    return failure(409, 'conflict', 'duplicate key value violates unique constraint', {
      reason: 'constraint_violation',
      sqlstate: '23505',
      constraint: `${tableName}_pkey`,
    })
  }
  table.rows.push(row)
  return { ok: true, status: 201, key, response: rowsResponse(table, row) }
}

export function updateRow(
  state: MockDataState,
  schema: string,
  tableName: string,
  key: string,
  values: Record<string, unknown>,
  expected: Record<string, unknown> | undefined
): MockWriteResult {
  const found = target(state, schema, tableName)
  if ('ok' in found) return found
  const { table, primaryKey } = found
  const index = findIndex(table, primaryKey, key)
  if (index < 0) return failure(404, 'not_found', `row ${key} not found`, { reason: 'row_not_found' })
  const row = table.rows[index]!
  const hasUpdatedAt = table.schema.columns.some((column) => column.name === 'updated_at')

  const mode = armedMode(state)
  if (mode === 'conflict' || mode === 'constraint') armed = undefined
  if (mode === 'conflict') {
    // Someone else saved first.
    if (hasUpdatedAt) row.updated_at = new Date(Date.now() + 1_000).toISOString()
    return failure(409, 'conflict', 'row changed since it was read', { reason: 'row_changed' })
  }
  if (mode === 'constraint') {
    const column = Object.keys(values)[0] ?? primaryKey
    return failure(400, 'invalid_argument', `new row violates check constraint "${tableName}_${column}_check"`, {
      reason: 'constraint_violation',
      sqlstate: '23514',
      column,
      constraint: `${tableName}_${column}_check`,
    })
  }

  for (const [column, value] of Object.entries(expected ?? {})) {
    if (JSON.stringify(row[column] ?? null) !== JSON.stringify(value ?? null)) {
      return failure(409, 'conflict', 'row changed since it was read', { reason: 'row_changed' })
    }
  }
  const invalid = checkValues(table, values, false)
  if (invalid) return invalid
  const next = { ...row, ...values, ...(hasUpdatedAt ? { updated_at: new Date().toISOString() } : {}) }
  table.rows[index] = next
  return { ok: true, status: 200, key, response: rowsResponse(table, next) }
}

export function deleteRow(state: MockDataState, schema: string, tableName: string, key: string): MockWriteResult {
  const found = target(state, schema, tableName)
  if ('ok' in found) return found
  const { table, primaryKey } = found
  const index = findIndex(table, primaryKey, key)
  if (index < 0) return failure(404, 'not_found', `row ${key} not found`, { reason: 'row_not_found' })
  // A row another table still points at cannot go (ON DELETE RESTRICT).
  for (const other of state.tables.values()) {
    for (const column of other.schema.columns) {
      const reference = column.references
      if (!reference || reference.schema !== schema || reference.table !== tableName) continue
      if (other.rows.some((candidate) => String(candidate[column.name]) === key)) {
        return failure(409, 'conflict', 'update or delete violates foreign key constraint', {
          reason: 'constraint_violation',
          sqlstate: '23503',
          constraint: `${other.schema.name}_${column.name}_fkey`,
        })
      }
    }
  }
  const [removed] = table.rows.splice(index, 1)
  return { ok: true, status: 200, key, response: rowsResponse(table, removed!) }
}

type Route = [method: string, pattern: RegExp, handler: (match: RegExpExecArray, request: Request) => Promise<Response>]

export interface DataWriteRouteDeps {
  /** The caller's Team role now (Viewer cannot write). */
  role: () => string
  /** An app database the mock knows (`<app>-db`); others answer 404 like the read routes. */
  hasDatabase: (databaseId: string) => boolean
  operation: (kind: string, id: string) => PublicOperation
}

const ROWS = '^/api/v1/projects/([^/]+)/databases/([^/]+)/tables/([^/]+)/([^/]+)/rows'

/**
 * The mock-platform route entries for row writes and the `__mock/data-write`
 * toggle, over the seeded tables; the data mode (`__mock/data`) answers first.
 */
export function dataWriteRoutes({ role, hasDatabase, operation }: DataWriteRouteDeps): Route[] {
  const send = (body: unknown, status: number, request: Request) => {
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    const idempotencyKey = request.headers.get('Idempotency-Key')
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)
    return Response.json(body, { status, headers })
  }
  const write = async (kind: string, m: RegExpExecArray, request: Request, run: () => MockWriteResult | Promise<MockWriteResult>) => {
    const precondition = dataModeFailure()
    const blocked = !hasDatabase(decodeURIComponent(m[2]!))
      ? failure(404, 'not_found', 'database not found', { reason: 'database_not_found' })
      : role() === 'Viewer'
        ? failure(403, 'forbidden', 'writing rows requires the Editor role', { reason: 'forbidden' })
        : precondition && failure(precondition.status, precondition.code, precondition.message, precondition.details)
    const result = blocked ?? (await run())
    if (!result.ok) return send({ error: { code: result.code, message: result.message, details: result.details } }, result.status, request)
    return send({ ...result.response, operation: operation(kind, result.key) }, result.status, request)
  }
  const body = async (request: Request) => ((await request.json().catch(() => ({}))) ?? {}) as { values?: Record<string, unknown>; expected?: Record<string, unknown> }

  return [
    [
      'POST',
      /^\/api\/v1\/__mock\/data-write$/,
      async (_, request) => {
        const { mode } = (await request.json()) as { mode?: string }
        const next = DATA_WRITE_MODES.find((candidate) => candidate === mode)
        if (!next) return Response.json({ error: { code: 'invalid_argument', message: `mode must be one of ${DATA_WRITE_MODES.join(', ')}` } }, { status: 400 })
        setDataWriteMode(dataState, next)
        return Response.json({ mode: next })
      },
    ],
    [
      'POST',
      new RegExp(`${ROWS}$`),
      (m, request) =>
        write('database.row.create', m, request, async () => createRow(dataState, decodeURIComponent(m[3]!), decodeURIComponent(m[4]!), (await body(request)).values ?? {})),
    ],
    [
      'PATCH',
      new RegExp(`${ROWS}/([^/]+)$`),
      (m, request) =>
        write('database.row.update', m, request, async () => {
          const input = await body(request)
          return updateRow(dataState, decodeURIComponent(m[3]!), decodeURIComponent(m[4]!), decodeURIComponent(m[5]!), input.values ?? {}, input.expected)
        }),
    ],
    [
      'DELETE',
      new RegExp(`${ROWS}/([^/]+)$`),
      (m, request) => write('database.row.delete', m, request, () => deleteRow(dataState, decodeURIComponent(m[3]!), decodeURIComponent(m[4]!), decodeURIComponent(m[5]!))),
    ],
  ]
}
