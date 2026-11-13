// App data (データ tab): tables, schemas, rows, changes and the data-specific
// error classifications.
import type { DatabaseChange, DatabaseTableSchema } from '@appthrust/api-schema/platform-api'
import { ORPCError } from '@orpc/client'
import { queryOptions, skipToken, useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { client, type PlatformApiClient } from '../client'
import { isPlatformNotFound, platformErrorEnvelope } from '../platform-error'
import { deriveCatalog, type Catalog } from '../../model/data-catalog'
import { keys } from './shared'

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
export function databaseTablesQuery(
  projectId: string,
  databaseId: string | undefined,
  api: Pick<PlatformApiClient, 'platformApiListDatabaseTables'> = client,
) {
  return queryOptions({
    queryKey: databaseId ? keys.databaseTables(projectId, databaseId) : ['database-tables', 'none'],
    queryFn: databaseId ? () => api.platformApiListDatabaseTables({ params: { projectId, id: databaseId } }) : skipToken,
    refetchInterval: false,
  })
}

/** A change nothing more happens to without someone acting: applied, failed, refused, or put away. */
export function isDatabaseChangeSettled(change: DatabaseChange): boolean {
  return change.archived === true || change.phase === 'Succeeded' || change.phase === 'Failed' || change.phase === 'ReviewFailed' || change.phase === 'Rejected'
}

export const DATABASE_CHANGES_POLL_MS = 10_000

/** The app database's changes; polled every 10 s only while one is still moving. */
export function databaseChangesQuery(
  projectId: string,
  databaseId: string | undefined,
  api: Pick<PlatformApiClient, 'platformApiListDatabaseChanges'> = client,
) {
  return queryOptions({
    queryKey: databaseId ? keys.databaseChanges(projectId, databaseId) : ['database-changes', 'none'],
    queryFn: databaseId ? () => api.platformApiListDatabaseChanges({ params: { projectId, id: databaseId } }) : skipToken,
    refetchInterval: (query) => (query.state.data?.data.some((change) => !isDatabaseChangeSettled(change)) ? DATABASE_CHANGES_POLL_MS : false),
  })
}

/** The Platform API knows no such database (not created yet, or already gone). */
export const isDatabaseNotFound = isPlatformNotFound

export function databaseTableSchemaQuery(
  projectId: string,
  databaseId: string,
  schema: string,
  table: string,
  api: Pick<PlatformApiClient, 'platformApiDescribeDatabaseTable'> = client,
) {
  return queryOptions({
    queryKey: keys.databaseTableSchema(projectId, databaseId, schema, table),
    queryFn: () => api.platformApiDescribeDatabaseTable({ params: { projectId, id: databaseId, schema, table } }),
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
  api: Pick<PlatformApiClient, 'platformApiGetDatabaseRows'> = client,
) {
  const prefix = databaseId && schema && table ? keys.databaseRows(projectId, databaseId, schema, table) : undefined
  const q = params.q?.trim()
  return queryOptions({
    queryKey: prefix ? [...prefix, params] : ['database-rows', 'none'],
    queryFn: prefix
      ? () =>
          api.platformApiGetDatabaseRows({
            params: { projectId, id: databaseId!, schema: schema!, table: table! },
            query: {
              limit: params.limit,
              offset: params.offset,
              ...(params.orderBy ? { orderBy: params.orderBy, direction: params.direction ?? 'asc' } : {}),
              ...(q ? { q } : {}),
            },
          })
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

export interface DatabaseCatalogQuery {
  catalog: Catalog | undefined
  /** The first failure that leaves the catalog unusable (list, or a description other than 404). */
  error: unknown
  isPending: boolean
  isFetching: boolean
  /** When the table list was last read. */
  dataUpdatedAt: number
  refetch: () => void
}

type SchemaResult = { data?: DatabaseTableSchema; error: unknown; isPending: boolean; isFetching: boolean; refetch: () => unknown }

/** Module-level, so useQueries memoizes the combined value while the results are unchanged. */
function combineSchemas(results: SchemaResult[]) {
  return {
    schemas: results.flatMap((result) => result.data ?? []),
    // A table dropped between the list and its description is simply left out.
    error: results.find((result) => result.error && platformErrorEnvelope(result.error)?.status !== 404)?.error,
    isPending: results.some((result) => result.isPending && !result.error),
    isFetching: results.some((result) => result.isFetching),
    refetch: () => results.forEach((result) => void result.refetch()),
  }
}

/** The app database's tables, each described (labels, kinds, keys), as one Catalog. */
export function useDatabaseCatalog(projectId: string, databaseId: string | undefined): DatabaseCatalogQuery {
  const tables = useQuery(databaseTablesQuery(projectId, databaseId))
  const list = tables.data?.data
  const described = useQueries({
    queries: databaseId ? (list ?? []).map((table) => databaseTableSchemaQuery(projectId, databaseId, table.schema, table.name)) : [],
    combine: combineSchemas,
  })
  const catalog = useMemo(() => (list ? deriveCatalog(list, described.schemas) : undefined), [list, described.schemas])
  const error = tables.error ?? described.error
  return {
    catalog: error || described.isPending ? undefined : catalog,
    error,
    isPending: !error && (tables.isPending || described.isPending),
    isFetching: tables.isFetching || described.isFetching,
    dataUpdatedAt: tables.dataUpdatedAt,
    refetch: () => {
      void tables.refetch()
      described.refetch()
    },
  }
}
