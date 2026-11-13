// Platform operations behind the データ tab and 「データベースの変更」: the app
// database's table list, table descriptions, rows pages, row writes, the
// change list and the approve / retry writes. Readers keep only the fields
// the console reads (canonical leaf schemas; unknown fields dropped) and own
// three kinds of difference:
// - open enums: relation type, change phase, review risk and run phase read an
//   unknown value as `{ kind: 'unknown' }`;
// - registered omissions (Go `omitempty`): a column's `enumValues` and a
//   review's `findings` read as [];
// - Go scalars written with `omitempty` keep their Go meaning (`archived`
//   absent is false).
// Every other collection is required: Go always writes it, and null (a nil
// slice) is a failure, never "nothing". A column's `type` is the database's
// own type name, an open vocabulary interpreted by model/data-catalog.ts.
// A row write answers the written row as `rows[0]`; an answer without a row
// never becomes a value (the write may still have happened: callers read
// back, never resend).
import {
  DatabaseChange as CanonicalDatabaseChange,
  DatabaseChangeMutationResource,
  DatabaseChangePhase as CanonicalDatabaseChangePhase,
  DatabaseChangeReviewFinding,
  DatabaseChangeSource,
  DatabaseColumnReference,
  DatabaseRowsResponse,
  DatabaseTableColumn,
  DatabaseTableSchema,
  DatabaseTableSummary,
} from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import type {
  DatabaseChange, DatabaseChangeAccepted, DatabaseColumn, DatabaseRowsPage, DatabaseTable, DatabaseTableRef, RowValues,
} from '../../../model/contracts/data'
import { absentMeansEmpty, openEnum } from '../../boundary'
import { platformContract } from '../define'
import { openCanonical } from './build'

const DATABASE = '/api/v1/projects/{projectId}/databases/{id}'
const ROWS = `${DATABASE}/tables/{schema}/{table}/rows`
const DTO = 'platform-api internal/api'

const listOf = <D>(reader: z.ZodType<D>) => z.object({ data: z.array(reader) }).transform(({ data }) => data)

export const tableRefReader: z.ZodType<DatabaseTableRef> = DatabaseTableSummary.pick({ schema: true, name: true })

const enumValues = absentMeansEmpty(z.array(z.string()), {
  path: '/columns/*/enumValues',
  evidence: `${DTO}/dto_database_data.go:20 omits an empty list (omitempty)`,
})

export const columnReader: z.ZodType<DatabaseColumn> = DatabaseTableColumn.pick({
  name: true, type: true, nullable: true, hasDefault: true, primaryKey: true, description: true,
}).extend({
  enumValues: enumValues.schema,
  references: DatabaseColumnReference.optional(),
})

export const tableReader: z.ZodType<DatabaseTable> = DatabaseTableSchema.pick({
  schema: true, name: true, description: true, primaryKey: true, editable: true, rowCountEstimate: true,
}).extend({
  type: openEnum(['table', 'view']),
  columns: z.array(columnReader),
})

/** A row: column name → JSON value. The keys are the database's own column names (never named in an issue path). */
const rowReader: z.ZodType<RowValues> = z.record(z.string(), z.unknown())

export const rowsPageReader: z.ZodType<DatabaseRowsPage> = z.object({
  rows: z.array(rowReader),
  truncated: DatabaseRowsResponse.shape.truncated,
  totalEstimate: DatabaseRowsResponse.shape.totalEstimate,
})

/**
 * A row write's answer is the written (or deleted) row: Platform answers an
 * error instead of an empty `rows` (platform-api internal/k8s/database_rows_write.go:162),
 * so a success without one is broken.
 */
export const writtenRowReader: z.ZodType<RowValues> = z.object({ rows: z.array(rowReader).min(1) }).transform(({ rows }) => rows[0]!)

const findings = absentMeansEmpty(z.array(DatabaseChangeReviewFinding.pick({ message: true })), {
  path: '/data/*/review/findings',
  evidence: `${DTO}/dto_cache.go:251 omits an empty list (omitempty)`,
})

const phase = openCanonical(CanonicalDatabaseChangePhase)

export const changeReader: z.ZodType<DatabaseChange> = CanonicalDatabaseChange.pick({ id: true, createdAt: true }).extend({
  source: z.object({ path: DatabaseChangeSource.shape.path }).optional(),
  phase: phase.optional(),
  review: z.object({ risk: openEnum(['Low', 'Medium', 'High']).optional(), findings: findings.schema }).optional(),
  latestRun: z.object({
    phase: openEnum(['Pending', 'Running', 'Succeeded', 'Failed']).optional(),
    message: z.string().optional(),
    retryable: z.boolean().optional(),
  }).optional(),
  // Go writes `archived` with omitempty (dto_cache.go:215): absent is false.
  archived: z.boolean().optional(),
}).transform(({ source, review, archived, ...change }): DatabaseChange => ({
  ...change,
  ...(source?.path ? { path: source.path } : {}),
  ...(review?.risk ? { risk: review.risk } : {}),
  findings: (review?.findings ?? []).map((finding) => finding.message),
  archived: archived ?? false,
}))

const changeAcceptedReader: z.ZodType<DatabaseChangeAccepted> = z.object({
  resource: DatabaseChangeMutationResource.pick({ id: true }).extend({ phase: phase.optional() }),
}).transform(({ resource }) => resource)

/** 200 (platform-api internal/handler/database.go:2282). */
export const listDatabaseTablesContract = platformContract({
  operationId: 'platformApiListDatabaseTables',
  method: 'GET',
  routeTemplate: `${DATABASE}/schema/tables`,
  successStatuses: [200],
  reader: listOf(tableRefReader),
})

/** 200 (platform-api internal/handler/database_table_schema.go:65). */
export const describeDatabaseTableContract = platformContract({
  operationId: 'platformApiDescribeDatabaseTable',
  method: 'GET',
  routeTemplate: `${DATABASE}/schema/tables/{schema}/{table}`,
  successStatuses: [200],
  reader: tableReader,
  fieldPolicies: [enumValues.policy],
})

/** 200 (platform-api internal/handler/database.go:2700). */
export const getDatabaseRowsContract = platformContract({
  operationId: 'platformApiGetDatabaseRows',
  method: 'GET',
  routeTemplate: ROWS,
  successStatuses: [200],
  reader: rowsPageReader,
})

/** 201 (platform-api internal/handler/database_rows.go:36). */
export const createDatabaseRowContract = platformContract({
  operationId: 'platformApiCreateDatabaseRow',
  method: 'POST',
  routeTemplate: ROWS,
  successStatuses: [201],
  reader: writtenRowReader,
})

/** 200 (platform-api internal/handler/database_rows.go:59). */
export const updateDatabaseRowContract = platformContract({
  operationId: 'platformApiUpdateDatabaseRow',
  method: 'PATCH',
  routeTemplate: `${ROWS}/{key}`,
  successStatuses: [200],
  reader: writtenRowReader,
})

/** 200 with the deleted row (platform-api internal/handler/database_rows.go:72). */
export const deleteDatabaseRowContract = platformContract({
  operationId: 'platformApiDeleteDatabaseRow',
  method: 'DELETE',
  routeTemplate: `${ROWS}/{key}`,
  successStatuses: [200],
  reader: writtenRowReader,
})

/** 200 (platform-api internal/handler/database.go:1420). */
export const listDatabaseChangesContract = platformContract({
  operationId: 'platformApiListDatabaseChanges',
  method: 'GET',
  routeTemplate: `${DATABASE}/changes`,
  successStatuses: [200],
  reader: listOf(changeReader),
  fieldPolicies: [findings.policy],
})

/** 202 (platform-api internal/handler/database.go:2182). */
export const approveDatabaseChangeContract = platformContract({
  operationId: 'platformApiCreateDatabaseChangeApproval',
  method: 'POST',
  routeTemplate: `${DATABASE}/changes/{changeId}/approvals`,
  successStatuses: [202],
  reader: changeAcceptedReader,
})

/** 202 (platform-api internal/handler/database.go:2253). */
export const retryDatabaseChangeContract = platformContract({
  operationId: 'platformApiRetryDatabaseChange',
  method: 'POST',
  routeTemplate: `${DATABASE}/changes/{changeId}/retry`,
  successStatuses: [202],
  reader: changeAcceptedReader,
})
