// X2/X4 wire variants for the データ tab and 「データベースの変更」 operations
// (contracts/platform/data.ts). Fixtures are the shapes the Platform marshals
// (dto_database_data.go, dto_cache.go; the in-memory mock answers the same);
// each case varies one field. Every rejection is also checked for redaction by
// assertWireContractCases: database column names and row values are dynamic
// keys / payload and never appear in an issue path or report.
import { describe, expect, test } from 'bun:test'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import {
  approveDatabaseChangeContract,
  createDatabaseRowContract,
  deleteDatabaseRowContract,
  describeDatabaseTableContract,
  getDatabaseRowsContract,
  listDatabaseChangesContract,
  listDatabaseTablesContract,
  retryDatabaseChangeContract,
  updateDatabaseRowContract,
} from './data'

const SECRET = 'SENTINEL-data-contract-7e31'
const at = '2026-11-13T00:00:00Z'
const operation = { id: 'op-1', type: 'database.row.update', state: 'accepted', writeChannel: 'W', resource: { kind: 'Database', id: 'shop-db', projectId: 'commerce' }, createdAt: at, links: { self: '/api/v1/operations/op-1' } }
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
const leaksNothing = (value: unknown) => expect(JSON.stringify(value)).not.toContain(SECRET)

const column = { name: 'stock', type: 'integer', nullable: false, hasDefault: false, primaryKey: false, description: '在庫' }
const keyColumn = { name: 'id', type: 'integer', nullable: false, hasDefault: true, primaryKey: true }
const enumColumn = { name: 'category', type: 'public.item_category', nullable: true, hasDefault: false, primaryKey: false, enumValues: ['PC', '文具'] }
const table = { schema: 'public', name: 'products', type: 'table', description: '商品', primaryKey: ['id'], columns: [keyColumn, column, enumColumn], editable: true, rowCountEstimate: 12, fetchedAt: at }
const row = { id: 1, name: 'ノートPC', stock: 8, updated_at: at }
const page = { columns: [{ name: 'id', type: 'integer' }], rows: [row], rowCount: 1, limit: 50, offset: 0, truncated: false, totalEstimate: 12, fetchedAt: at }
const written = { ...page, limit: 1, totalEstimate: undefined, operation }
const change = {
  id: 'shop-db-0002-items', projectId: 'commerce', databaseId: 'shop-db', applyMode: 'Automatic', sourceType: 'InlineSQL',
  source: { type: 'InlineSQL', path: 'db/migrations/0002_create_items.sql' }, phase: 'AwaitingApproval',
  review: { passed: true, risk: 'Low', statementCount: 3 }, approval: { requiredCount: 1, approvedCount: 0 }, createdAt: at,
}
const failed = { ...change, id: 'shop-db-0003', phase: 'Failed', review: { passed: false, risk: 'High', findings: [{ code: 'drop', severity: 'Error', message: 'drops a column' }] }, latestRun: { id: 'r1', clusterId: 'c', phase: 'Failed', retryable: true, message: 'connection reset' } }

describe('table list (platformApiListDatabaseTables)', () => {
  test('wire variants', () => {
    assertWireContractCases(listDatabaseTablesContract, [
      { name: 'the marshalled list', variant: 'present', path: '/data', wire: { data: [{ schema: 'public', name: 'products', type: 'table_or_view' }], meta: { total: 1 } }, expect: { accept: true, value: [{ schema: 'public', name: 'products' }] } },
      { name: 'a database without tables is an empty list', variant: 'empty', path: '/data', wire: { data: [], meta: { total: 0 } }, expect: { accept: true, value: [] } },
      { name: 'an absent list is broken, never "no tables"', variant: 'absent', path: '/data', wire: { meta: { total: 0 } }, expect: { accept: false, issues: [{ path: '/data', code: 'missing' }] } },
      { name: 'a null list (a nil slice) is broken', variant: 'null', path: '/data', wire: { data: null }, expect: { accept: false, issues: [{ path: '/data', code: 'invalid_type' }] } },
      { name: 'an entry without its name is broken', variant: 'absent', path: '/data/*/name', wire: { data: [{ schema: 'public', type: 'table' }] }, expect: { accept: false, issues: [{ path: '/data/*/name', code: 'missing' }] } },
      { name: 'unknown fields are dropped', variant: 'unknown', path: '/', wire: { data: [{ schema: 'public', name: 'products', type: SECRET, owner: SECRET }], cursor: SECRET }, expect: { accept: true, check: (value) => leaksNothing(value) } },
    ])
  })
})

describe('table description (platformApiDescribeDatabaseTable)', () => {
  test('wire variants', () => {
    assertWireContractCases(describeDatabaseTableContract, [
      {
        name: 'the marshalled description', variant: 'present', path: '/columns', wire: table,
        expect: { accept: true, check: (value) => {
          expect(value.type).toEqual({ kind: 'known', value: 'table' })
          expect(value.columns.map((item) => [item.name, item.enumValues])).toEqual([['id', []], ['stock', []], ['category', ['PC', '文具']]])
          expect(value).toMatchObject({ primaryKey: ['id'], editable: true, rowCountEstimate: 12, description: '商品' })
        } },
      },
      { name: 'a table without columns', variant: 'empty', path: '/columns', wire: { ...table, columns: [], primaryKey: [] }, expect: { accept: true, check: (value) => expect([value.columns, value.primaryKey]).toEqual([[], []]) } },
      { name: 'absent columns are broken, never "no columns"', variant: 'absent', path: '/columns', wire: without(table, 'columns'), expect: { accept: false, issues: [{ path: '/columns', code: 'missing' }] } },
      { name: 'null columns are broken', variant: 'null', path: '/columns', wire: { ...table, columns: null }, expect: { accept: false, issues: [{ path: '/columns', code: 'invalid_type' }] } },
      { name: 'an absent key list is broken (Go always writes it, internal/k8s/database_table_schema.go:137)', variant: 'absent', path: '/primaryKey', wire: without(table, 'primaryKey'), expect: { accept: false, issues: [{ path: '/primaryKey', code: 'missing' }] } },
      { name: 'a null key list is broken, never "no key"', variant: 'null', path: '/primaryKey', wire: { ...table, primaryKey: null }, expect: { accept: false, issues: [{ path: '/primaryKey', code: 'invalid_type' }] } },
      { name: 'editable is required, never guessed', variant: 'absent', path: '/editable', wire: without(table, 'editable'), expect: { accept: false, issues: [{ path: '/editable', code: 'missing' }] } },
      { name: 'Go omits an empty enum list (omitempty): no labels', variant: 'absent', path: '/columns/*/enumValues', wire: { ...table, columns: [column] }, expect: { accept: true, check: (value) => expect(value.columns[0]?.enumValues).toEqual([]) } },
      { name: 'null enum values are broken', variant: 'null', path: '/columns/*/enumValues', wire: { ...table, columns: [{ ...enumColumn, enumValues: null }] }, expect: { accept: false, issues: [{ path: '/columns/*/enumValues', code: 'invalid_type' }] } },
      { name: 'a column without nullable is broken (a NOT NULL column would read as optional)', variant: 'absent', path: '/columns/*/nullable', wire: { ...table, columns: [without(column, 'nullable')] }, expect: { accept: false, issues: [{ path: '/columns/*/nullable', code: 'missing' }] } },
      { name: 'a column whose type is not a string is broken', variant: 'unknown', path: '/columns/*/type', wire: { ...table, columns: [{ ...column, type: 7 }] }, expect: { accept: false, issues: [{ path: '/columns/*/type', code: 'invalid_type' }] } },
      { name: 'a reference without its column is broken', variant: 'absent', path: '/columns/*/references/column', wire: { ...table, columns: [{ ...column, references: { schema: 'public', table: 'suppliers' } }] }, expect: { accept: false, issues: [{ path: '/columns/*/references/column', code: 'missing' }] } },
      {
        name: 'an unknown relation type is kept as unknown, never a table', variant: 'unknown', path: '/type', wire: { ...table, type: SECRET, owner: SECRET },
        expect: { accept: true, check: (value) => { expect(value.type).toEqual({ kind: 'unknown' }); leaksNothing(value) } },
      },
    ])
  })
})

describe('rows page (platformApiGetDatabaseRows)', () => {
  test('wire variants', () => {
    assertWireContractCases(getDatabaseRowsContract, [
      { name: 'the marshalled page', variant: 'present', path: '/rows', wire: page, expect: { accept: true, value: { rows: [row], truncated: false, totalEstimate: 12 } } },
      { name: 'an empty page (Go writes [], internal/k8s/database_postgrest.go:380)', variant: 'empty', path: '/rows', wire: { ...page, rows: [], rowCount: 0 }, expect: { accept: true, value: { rows: [], truncated: false, totalEstimate: 12 } } },
      { name: 'absent rows are broken, never an empty table', variant: 'absent', path: '/rows', wire: without(page, 'rows'), expect: { accept: false, issues: [{ path: '/rows', code: 'missing' }] } },
      { name: 'null rows are broken, never an empty table', variant: 'null', path: '/rows', wire: { ...page, rows: null }, expect: { accept: false, issues: [{ path: '/rows', code: 'invalid_type' }] } },
      { name: 'rows that are a string are broken', variant: 'unknown', path: '/rows', wire: { ...page, rows: SECRET }, expect: { accept: false, issues: [{ path: '/rows', code: 'invalid_type' }] } },
      { name: 'a row that is not an object is broken; its position is not named', variant: 'unknown', path: '/rows/*', wire: { ...page, rows: [row, SECRET] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_type' }] } },
      { name: 'a row that is an array is broken', variant: 'unknown', path: '/rows/*', wire: { ...page, rows: [[SECRET]] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_type' }] } },
      { name: 'truncated is required (paging rests on it)', variant: 'absent', path: '/truncated', wire: without(page, 'truncated'), expect: { accept: false, issues: [{ path: '/truncated', code: 'missing' }] } },
      { name: 'no estimate from the planner', variant: 'absent', path: '/totalEstimate', wire: without(page, 'totalEstimate'), expect: { accept: true, value: { rows: [row], truncated: false } } },
      { name: 'any column value is data, kept as the database wrote it', variant: 'present', path: '/rows/*', wire: { ...page, rows: [{ id: 2, [SECRET]: { nested: [1, null] } }] }, expect: { accept: true, check: (value) => expect(value.rows[0]).toEqual({ id: 2, [SECRET]: { nested: [1, null] } }) } },
      { name: 'unknown envelope fields are dropped', variant: 'unknown', path: '/', wire: { ...page, columns: SECRET, debug: SECRET }, expect: { accept: true, check: (value) => leaksNothing(value) } },
    ])
  })
})

describe('row writes (platformApiCreate/Update/DeleteDatabaseRow)', () => {
  const rowIs = (value: { key: string; values: unknown }) => expect(value).toEqual({ key: '1', values: row })
  test('the written row is rows[0] under the 表 key; an answer without it is unconfirmed, never success', () => {
    for (const contract of [createDatabaseRowContract('id'), updateDatabaseRowContract('id', '1'), deleteDatabaseRowContract('id', '1')]) {
      assertWireContractCases(contract, [
        { name: 'the written row', variant: 'present', path: '/rows', wire: written, expect: { accept: true, check: rowIs } },
        { name: 'no rows: Platform answers an error instead (internal/k8s/database_rows_write.go:162)', variant: 'empty', path: '/rows', wire: { ...written, rows: [] }, expect: { accept: false, issues: [{ path: '/rows', code: 'invalid_value' }] } },
        { name: 'absent rows', variant: 'absent', path: '/rows', wire: without(written, 'rows'), expect: { accept: false, issues: [{ path: '/rows', code: 'missing' }] } },
        { name: 'null rows', variant: 'null', path: '/rows', wire: { ...written, rows: null }, expect: { accept: false, issues: [{ path: '/rows', code: 'invalid_type' }] } },
        { name: 'a row that is a string', variant: 'unknown', path: '/rows/*', wire: { ...written, rows: [SECRET] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_type' }] } },
        { name: 'an empty row is no written row (it cannot be addressed)', variant: 'empty', path: '/rows/*', wire: { ...written, rows: [{}] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_value' }] } },
        { name: 'a row without its key column', variant: 'absent', path: '/rows/*', wire: { ...written, rows: [without(row, 'id')] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_value' }] } },
        { name: 'a null key', variant: 'null', path: '/rows/*', wire: { ...written, rows: [{ ...row, id: null }] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_value' }] } },
        { name: 'an empty key', variant: 'empty', path: '/rows/*', wire: { ...written, rows: [{ ...row, id: '' }] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_value' }] } },
        { name: 'a key that is an object', variant: 'unknown', path: '/rows/*', wire: { ...written, rows: [{ ...row, id: { value: SECRET } }] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_value' }] } },
        { name: 'the operation receipt is not read', variant: 'unknown', path: '/', wire: { ...written, operation: SECRET }, expect: { accept: true, check: rowIs } },
      ])
    }
  })

  test('an update or delete answering another row is unconfirmed; a text key is read as written', () => {
    for (const contract of [updateDatabaseRowContract('id', '1'), deleteDatabaseRowContract('id', '1')]) {
      assertWireContractCases(contract, [
        { name: 'another row', variant: 'unknown', path: '/rows/*', wire: { ...written, rows: [{ ...row, id: 2 }] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_value' }] } },
      ])
    }
    const code = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'
    assertWireContractCases(updateDatabaseRowContract('code', code), [
      { name: 'a uuid key', variant: 'present', path: '/rows/*', wire: { ...written, rows: [{ code, name: 'x' }] }, expect: { accept: true, value: { key: code, values: { code, name: 'x' } } } },
    ])
    assertWireContractCases(createDatabaseRowContract('code'), [
      { name: 'a new row under its text key', variant: 'present', path: '/rows/*', wire: { ...written, rows: [{ code, name: 'x' }] }, expect: { accept: true, value: { key: code, values: { code, name: 'x' } } } },
    ])
  })

  test('the key column is a database column name: it is never named in the issue or the report', () => {
    assertWireContractCases(updateDatabaseRowContract(SECRET, '1'), [
      { name: 'the addressed key column holds another row', variant: 'unknown', path: '/rows/*', wire: { ...written, rows: [{ [SECRET]: 2 }] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_value' }] } },
      { name: 'the addressed key column is missing', variant: 'absent', path: '/rows/*', wire: { ...written, rows: [{ [`${SECRET}-other`]: 1 }] }, expect: { accept: false, issues: [{ path: '/rows/*', code: 'invalid_value' }] } },
    ])
  })
})

describe('change list (platformApiListDatabaseChanges)', () => {
  test('wire variants', () => {
    assertWireContractCases(listDatabaseChangesContract, [
      {
        name: 'the marshalled list', variant: 'present', path: '/data', wire: { data: [change, failed], meta: { total: 2 } },
        expect: { accept: true, value: [
          { id: change.id, createdAt: at, path: 'db/migrations/0002_create_items.sql', phase: { kind: 'known', value: 'AwaitingApproval' }, risk: { kind: 'known', value: 'Low' }, findings: [], archived: false },
          {
            id: 'shop-db-0003', createdAt: at, path: 'db/migrations/0002_create_items.sql', phase: { kind: 'known', value: 'Failed' }, risk: { kind: 'known', value: 'High' },
            latestRun: { phase: { kind: 'known', value: 'Failed' }, message: 'connection reset', retryable: true }, findings: ['drops a column'], archived: false,
          },
        ] },
      },
      { name: 'a database without changes', variant: 'empty', path: '/data', wire: { data: [], meta: { total: 0 } }, expect: { accept: true, value: [] } },
      { name: 'an absent list is broken, never "no changes"', variant: 'absent', path: '/data', wire: { meta: { total: 0 } }, expect: { accept: false, issues: [{ path: '/data', code: 'missing' }] } },
      { name: 'a null list is broken', variant: 'null', path: '/data', wire: { data: null }, expect: { accept: false, issues: [{ path: '/data', code: 'invalid_type' }] } },
      { name: 'a change without its id is broken', variant: 'absent', path: '/data/*/id', wire: { data: [without(change, 'id')] }, expect: { accept: false, issues: [{ path: '/data/*/id', code: 'missing' }] } },
      { name: 'Go omits empty findings (omitempty): nothing found', variant: 'absent', path: '/data/*/review/findings', wire: { data: [change] }, expect: { accept: true, check: (value) => expect(value[0]?.findings).toEqual([]) } },
      { name: 'null findings are broken', variant: 'null', path: '/data/*/review/findings', wire: { data: [{ ...change, review: { passed: true, findings: null } }] }, expect: { accept: false, issues: [{ path: '/data/*/review/findings', code: 'invalid_type' }] } },
      { name: 'a finding without its message is broken', variant: 'absent', path: '/data/*/review/findings/*/message', wire: { data: [{ ...failed, review: { passed: false, findings: [{ code: 'x', severity: 'Error' }] } }] }, expect: { accept: false, issues: [{ path: '/data/*/review/findings/*/message', code: 'missing' }] } },
      { name: 'Go omits archived=false (omitempty)', variant: 'absent', path: '/data/*/archived', wire: { data: [change] }, expect: { accept: true, check: (value) => expect(value[0]?.archived).toBe(false) } },
      { name: 'an archived change', variant: 'present', path: '/data/*/archived', wire: { data: [{ ...change, archived: true }] }, expect: { accept: true, check: (value) => expect(value[0]?.archived).toBe(true) } },
      { name: 'an archived flag that is not a boolean is broken', variant: 'unknown', path: '/data/*/archived', wire: { data: [{ ...change, archived: 'yes' }] }, expect: { accept: false, issues: [{ path: '/data/*/archived', code: 'invalid_type' }] } },
      { name: 'a change without phase has not been reconciled yet', variant: 'absent', path: '/data/*/phase', wire: { data: [without(change, 'phase')] }, expect: { accept: true, check: (value) => expect(value[0]?.phase).toBeUndefined() } },
      {
        name: 'an unknown phase, risk and run phase stay unknown: never applied, approvable or retryable', variant: 'unknown', path: '/data/*/phase',
        wire: { data: [{ ...failed, phase: SECRET, review: { passed: true, risk: SECRET }, latestRun: { ...failed.latestRun, phase: SECRET, failureClass: SECRET } }] },
        expect: { accept: true, check: (value) => {
          expect([value[0]?.phase, value[0]?.risk, value[0]?.latestRun?.phase]).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }, { kind: 'unknown' }])
          leaksNothing(value)
        } },
      },
      { name: 'a phase that is not a string is broken', variant: 'unknown', path: '/data/*/phase', wire: { data: [{ ...change, phase: 3 }] }, expect: { accept: false, issues: [{ path: '/data/*/phase', code: 'invalid_type' }] } },
    ])
  })
})

describe('approve / retry (platformApiCreateDatabaseChangeApproval / platformApiRetryDatabaseChange)', () => {
  test('the accepted change is the resource; anything else is unconfirmed', () => {
    for (const contract of [approveDatabaseChangeContract, retryDatabaseChangeContract]) {
      const resource = { id: change.id, projectId: 'commerce', databaseId: 'shop-db', phase: 'ReadyToRun', createdAt: at }
      assertWireContractCases(contract, [
        { name: 'the envelope resource', variant: 'present', path: '/resource', wire: { ...change, resource, operation }, expect: { accept: true, value: { id: change.id, phase: { kind: 'known', value: 'ReadyToRun' } } } },
        { name: 'no resource', variant: 'absent', path: '/resource', wire: { ...change, operation }, expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
        { name: 'a null resource', variant: 'null', path: '/resource', wire: { operation, resource: null }, expect: { accept: false, issues: [{ path: '/resource', code: 'invalid_type' }] } },
        { name: 'a resource without its id', variant: 'empty', path: '/resource/id', wire: { operation, resource: {} }, expect: { accept: false, issues: [{ path: '/resource/id', code: 'missing' }] } },
        { name: 'an unknown phase stays unknown', variant: 'unknown', path: '/resource/phase', wire: { operation, resource: { ...resource, phase: SECRET } }, expect: { accept: true, check: (value) => { expect(value.phase).toEqual({ kind: 'unknown' }); leaksNothing(value) } } },
      ])
    }
  })
})
