// App data (データ tab): tables, descriptions, rows, changes, their writes and
// the data-specific error classifications. Every answer is decoded at the
// boundary (contracts/platform/data.ts).
import { ORPCError } from '@orpc/client'
import { queryOptions, skipToken, useQueries, useQuery, type QueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { DatabaseChange, DatabaseChangeAccepted, DatabaseRowsPage, DatabaseTable, RowValues } from '../../model/contracts/data'
import { isOneOf } from '../../model/contracts/build'
import { deriveCatalog, rowKey, type Catalog, type Collection } from '../../model/data-catalog'
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
} from '../contracts/platform/data'
import { apiGateway, type ApiGateway } from '../gateway'
import { isPlatformNotFound, platformErrorEnvelope } from '../platform-error'
import { keys } from './shared'

type Gateway = Pick<ApiGateway, 'platform'>

/** One rows page: 50 rows from `offset`, optional single-column sort and search. */
export interface DatabaseRowsParams {
  limit: number
  offset: number
  orderBy?: string
  direction?: 'asc' | 'desc'
  q?: string
}

/** Preconditions the データ tab explains in words (Platform API 412 `details.reason`). */
export type DataPreconditionReason =
  | 'database_suspended'
  | 'database_waking'
  | 'database_data_unsupported'
  | 'table_read_only'
  | 'database_access_membership_unbound'

const DATA_PRECONDITIONS: Record<DataPreconditionReason, true> = {
  database_suspended: true,
  database_waking: true,
  database_data_unsupported: true,
  table_read_only: true,
  database_access_membership_unbound: true,
}

/**
 * Why the caller's Team membership grants no database access
 * (design/platform/team-membership-database-access-visibility.md): never signed
 * in with the membership's email, or a role from platform admin / a group with
 * no membership row behind it.
 */
export type MembershipUnboundReason = 'SubjectUnbound' | 'NotPersisted'

/** A data read or action the Platform API refused because the caller's Team membership grants no database access. */
export function isDataMembershipUnbound(error: unknown): boolean {
  return dataPreconditionReason(error) === 'database_access_membership_unbound'
}

/** `details.membershipReason` of a 412 `database_access_membership_unbound`; undefined for anything else. */
export function membershipUnboundReason(error: unknown): MembershipUnboundReason | undefined {
  if (!isDataMembershipUnbound(error)) return undefined
  const reason = platformErrorEnvelope(error)?.details?.membershipReason
  return reason === 'SubjectUnbound' || reason === 'NotPersisted' ? reason : undefined
}

/** The Platform API refused the caller (403): rendered with a lock and the owner contact, never retried. */
export function isDataForbidden(error: unknown): boolean {
  return platformErrorEnvelope(error)?.status === 403 || (error instanceof ORPCError && error.status === 403)
}

export function dataPreconditionReason(error: unknown): DataPreconditionReason | undefined {
  const envelope = platformErrorEnvelope(error)
  const reason = envelope?.details?.reason
  return envelope?.status === 412 && typeof reason === 'string' && Object.hasOwn(DATA_PRECONDITIONS, reason)
    ? (reason as DataPreconditionReason)
    : undefined
}

/** Data reads refresh on demand (「↻」) and on focus, not on the 5 s poll. */
export function databaseTablesQuery(projectId: string, databaseId: string | undefined, gateway: Gateway = apiGateway) {
  return queryOptions({
    queryKey: databaseId ? keys.databaseTables(projectId, databaseId) : ['database-tables', 'none'],
    queryFn: databaseId
      ? ({ signal }) => gateway.platform(listDatabaseTablesContract, { params: { projectId, id: databaseId } }, { signal })
      : skipToken,
    refetchInterval: false,
  })
}

/**
 * A change nothing more happens to without someone acting: applied, failed,
 * refused, or put away. A phase this console does not know is not settled
 * (the list keeps its usual 10 s poll; nothing is read as finished).
 */
export function isDatabaseChangeSettled(change: DatabaseChange): boolean {
  return change.archived || isOneOf(change.phase, 'Succeeded', 'Failed', 'ReviewFailed', 'Rejected')
}

export const DATABASE_CHANGES_POLL_MS = 10_000

/** The app database's changes; polled every 10 s only while one is still moving. */
export function databaseChangesQuery(projectId: string, databaseId: string | undefined, gateway: Gateway = apiGateway) {
  return queryOptions({
    queryKey: databaseId ? keys.databaseChanges(projectId, databaseId) : ['database-changes', 'none'],
    queryFn: databaseId
      ? ({ signal }) => gateway.platform(listDatabaseChangesContract, { params: { projectId, id: databaseId } }, { signal })
      : skipToken,
    refetchInterval: (query) => (query.state.data?.some((change) => !isDatabaseChangeSettled(change)) ? DATABASE_CHANGES_POLL_MS : false),
  })
}

export interface DatabaseChangeTarget {
  projectId: string
  databaseId: string
  changeId: string
}

/** Records the decision Approved for one change (202). */
export function approveDatabaseChange(target: DatabaseChangeTarget, gateway: Gateway = apiGateway): Promise<DatabaseChangeAccepted> {
  return gateway.platform(approveDatabaseChangeContract, {
    params: { projectId: target.projectId, id: target.databaseId, changeId: target.changeId },
    body: { decision: 'Approved' },
  })
}

/** Asks for one more run of a failed, retryable change (202). */
export function retryDatabaseChange(target: DatabaseChangeTarget, gateway: Gateway = apiGateway): Promise<DatabaseChangeAccepted> {
  return gateway.platform(retryDatabaseChangeContract, { params: { projectId: target.projectId, id: target.databaseId, changeId: target.changeId } })
}

/** The Platform API knows no such database (not created yet, or already gone). */
export const isDatabaseNotFound = isPlatformNotFound

export function databaseTableSchemaQuery(
  projectId: string,
  databaseId: string,
  schema: string,
  table: string,
  gateway: Gateway = apiGateway,
) {
  return queryOptions({
    queryKey: keys.databaseTableSchema(projectId, databaseId, schema, table),
    queryFn: ({ signal }) => gateway.platform(describeDatabaseTableContract, { params: { projectId, id: databaseId, schema, table } }, { signal }),
    refetchInterval: false,
    staleTime: 60_000,
  })
}

export function databaseRowsQuery(
  projectId: string,
  databaseId: string | undefined,
  schema: string | undefined,
  table: string | undefined,
  params: DatabaseRowsParams,
  gateway: Gateway = apiGateway,
) {
  const prefix = databaseId && schema && table ? keys.databaseRows(projectId, databaseId, schema, table) : undefined
  const q = params.q?.trim()
  return queryOptions({
    queryKey: prefix ? [...prefix, params] : ['database-rows', 'none'],
    queryFn: prefix
      ? ({ signal }) =>
          gateway.platform(getDatabaseRowsContract, {
            params: { projectId, id: databaseId!, schema: schema!, table: table! },
            query: {
              limit: params.limit,
              offset: params.offset,
              ...(params.orderBy ? { orderBy: params.orderBy, direction: params.direction ?? 'asc' } : {}),
              ...(q ? { q } : {}),
            },
          }, { signal })
      : skipToken,
    refetchInterval: false,
    // Paging, sorting and searching keep the current rows on screen; another table never shows them.
    placeholderData: (previous, previousQuery) =>
      prefix && previousQuery && prefix.every((part, index) => previousQuery.queryKey[index] === part) ? previous : undefined,
  })
}

export function useDatabaseRows(
  projectId: string,
  databaseId: string | undefined,
  schema: string | undefined,
  table: string | undefined,
  params: DatabaseRowsParams,
) {
  return useQuery(databaseRowsQuery(projectId, databaseId, schema, table, params))
}

/** The 表 a row write targets. */
export interface DatabaseRowTarget {
  projectId: string
  databaseId: string
  schema: string
  table: string
}

const rowParams = (target: DatabaseRowTarget) => ({ projectId: target.projectId, id: target.databaseId, schema: target.schema, table: target.table })

/** Inserts one row; answers the row as the database stored it (201). */
export function createDatabaseRow(target: DatabaseRowTarget, values: Record<string, unknown>, gateway: Gateway = apiGateway): Promise<RowValues> {
  return gateway.platform(createDatabaseRowContract, { params: rowParams(target), body: { values } })
}

/** Changes the columns in `values` of row `key`, locked on `expected`; answers the updated row. */
export function updateDatabaseRow(
  target: DatabaseRowTarget,
  key: string,
  values: Record<string, unknown>,
  expected: Record<string, unknown>,
  gateway: Gateway = apiGateway,
): Promise<RowValues> {
  return gateway.platform(updateDatabaseRowContract, { params: { ...rowParams(target), key }, body: { values, expected } })
}

/** Deletes row `key`; answers the deleted row. */
export function deleteDatabaseRow(target: DatabaseRowTarget, key: string, gateway: Gateway = apiGateway): Promise<RowValues> {
  return gateway.platform(deleteDatabaseRowContract, { params: { ...rowParams(target), key } })
}

/**
 * Puts a written row into every cached page of its 表 (`next` undefined: drops
 * it). Reads of those pages that started before the write are cancelled
 * first, so an older answer cannot land over the written row.
 */
export async function writeRowToCache(queryClient: QueryClient, target: DatabaseRowTarget, collection: Collection, key: string, next: RowValues | undefined): Promise<void> {
  const queryKey = keys.databaseRows(target.projectId, target.databaseId, target.schema, target.table)
  await queryClient.cancelQueries({ queryKey })
  queryClient.setQueriesData<DatabaseRowsPage>({ queryKey }, (page) => {
    if (!page || !page.rows.some((values) => rowKey(collection, values) === key)) return page
    const rows = next
      ? page.rows.map((values) => (rowKey(collection, values) === key ? next : values))
      : page.rows.filter((values) => rowKey(collection, values) !== key)
    return { ...page, rows }
  })
}

export interface DatabaseCatalogQuery {
  /** The last catalog read in full; kept while a refresh fails. */
  catalog: Catalog | undefined
  /** A failure that leaves no catalog to show (list, or a description other than 404, never read). */
  error: unknown
  /** A refresh failed while the shown catalog stays (when it was last read). */
  stale: { error: unknown; updatedAt: number } | undefined
  isPending: boolean
  isFetching: boolean
  refetch: () => void
}

type SchemaResult = { data?: DatabaseTable; error: unknown; isPending: boolean; isFetching: boolean; dataUpdatedAt: number; refetch: () => unknown }

/** Module-level, so useQueries memoizes the combined value while the results are unchanged. */
function combineSchemas(results: SchemaResult[]) {
  return {
    schemas: results.flatMap((result) => result.data ?? []),
    // A table dropped between the list and its description is simply left out.
    error: results.find((result) => result.error && !result.data && platformErrorEnvelope(result.error)?.status !== 404)?.error,
    stale: results.find((result) => result.error && result.data),
    isPending: results.some((result) => result.isPending && !result.error),
    isFetching: results.some((result) => result.isFetching),
    refetch: () => results.forEach((result) => void result.refetch()),
  }
}

/** The app database's tables, each described (labels, kinds, keys), as one Catalog. */
export function useDatabaseCatalog(projectId: string, databaseId: string | undefined): DatabaseCatalogQuery {
  const tables = useQuery(databaseTablesQuery(projectId, databaseId))
  const list = tables.data
  const described = useQueries({
    queries: databaseId ? (list ?? []).map((table) => databaseTableSchemaQuery(projectId, databaseId, table.schema, table.name)) : [],
    combine: combineSchemas,
  })
  const catalog = useMemo(() => (list ? deriveCatalog(list, described.schemas) : undefined), [list, described.schemas])
  const error = (list ? undefined : tables.error) ?? described.error
  const stale = list && tables.error
    ? { error: tables.error, updatedAt: tables.dataUpdatedAt }
    : described.stale ? { error: described.stale.error, updatedAt: described.stale.dataUpdatedAt } : undefined
  return {
    catalog: error || described.isPending ? undefined : catalog,
    error,
    stale: error ? undefined : stale,
    isPending: !error && (tables.isPending || described.isPending),
    isFetching: tables.isFetching || described.isFetching,
    refetch: () => {
      void tables.refetch()
      described.refetch()
    },
  }
}
