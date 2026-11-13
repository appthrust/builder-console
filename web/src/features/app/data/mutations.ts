// Row writes of the データ tab. The transport (api/client.ts) gives every
// write its own Idempotency-Key. Each success writes the returned row into the
// cached pages of its 表 (grid and Sheet show it at once) and then refetches
// them, since a write can move rows between pages, searches and sort orders.
import type { DatabaseRowsMutationResponse, DatabaseRowsResponse } from '@appthrust/api-schema/platform-api'
import { skipToken, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { client } from '../../../api/client'
import { keys } from '../../../api/queries/shared'
import { rowKey, toDataRow, type Collection, type DataRow } from '../../../model/data-catalog'

export interface UpdateRowInput {
  key: string
  /** Changed columns only (`diff`). */
  values: Record<string, unknown>
  /** Optimistic lock (`expectedFor`). */
  expected: Record<string, unknown>
}

function isRowsPage(data: unknown): data is DatabaseRowsResponse {
  return !!data && typeof data === 'object' && Array.isArray((data as DatabaseRowsResponse).rows)
}

/** Replace (or, with `next` undefined, drop) the row `key` in every cached page of the 表. */
function patchCachedRows(queryClient: QueryClient, prefix: readonly unknown[], collection: Collection, key: string, next: Record<string, unknown> | undefined) {
  queryClient.setQueriesData<DatabaseRowsResponse>({ queryKey: prefix }, (page) => {
    if (!isRowsPage(page)) return page
    if (!page.rows.some((values) => rowKey(collection, values) === key)) return page
    const rows = next
      ? page.rows.map((values) => (rowKey(collection, values) === key ? next : values))
      : page.rows.filter((values) => rowKey(collection, values) !== key)
    return { ...page, rows, rowCount: rows.length }
  })
}

/** Create / update / delete one row of `collection`; each resolves to the row the database returned. */
export function useDatabaseRowMutations(projectId: string, databaseId: string, collection: Collection) {
  const queryClient = useQueryClient()
  const prefix = keys.databaseRows(projectId, databaseId, collection.schema, collection.name)
  const table = { projectId, id: databaseId, schema: collection.schema, table: collection.name }
  // 412 `row_editing_unavailable` (editor broker not rolled out): remembered per database, never fetched.
  const unavailableKey = ['database-row-editing-unavailable', projectId, databaseId] as const
  const editingUnavailable = useQuery({ queryKey: unavailableKey, queryFn: skipToken, initialData: false, staleTime: Infinity, gcTime: Infinity }).data
  const returned = (response: DatabaseRowsMutationResponse): DataRow | undefined => {
    const values = response.rows[0]
    return values ? toDataRow(collection, values) : undefined
  }

  const create = useMutation({
    mutationFn: async (values: Record<string, unknown>) =>
      returned(await client.platformApiCreateDatabaseRow({ params: table, body: { values } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: prefix }),
  })

  const update = useMutation({
    mutationFn: async ({ key, values, expected }: UpdateRowInput) =>
      returned(await client.platformApiUpdateDatabaseRow({ params: { ...table, key }, body: { values, expected } })),
    onSuccess: (row, input) => {
      if (row) patchCachedRows(queryClient, prefix, collection, input.key, row.values)
      return queryClient.invalidateQueries({ queryKey: prefix })
    },
  })

  const remove = useMutation({
    mutationFn: async (key: string) =>
      returned(await client.platformApiDeleteDatabaseRow({ params: { ...table, key } })),
    onSuccess: (_, key) => {
      patchCachedRows(queryClient, prefix, collection, key, undefined)
      return queryClient.invalidateQueries({ queryKey: prefix })
    },
  })

  /**
   * 「最新の内容を読み込む」 after a conflict: refetch the 表's pages and return
   * row `key` as they now hold it (undefined when no loaded page has it). Read
   * from the cache, not props: the refetch resolves before observers re-render.
   */
  const reload = async (key: string): Promise<DataRow | undefined> => {
    await queryClient.invalidateQueries({ queryKey: prefix })
    for (const [, page] of queryClient.getQueriesData<DatabaseRowsResponse>({ queryKey: prefix })) {
      const values = isRowsPage(page) ? page.rows.find((candidate) => rowKey(collection, candidate) === key) : undefined
      if (values) return { key, values }
    }
    return undefined
  }

  return {
    create,
    update,
    remove,
    reload,
    /** Row editing is not enabled for this database yet: the Sheet hides 編集 and 削除. */
    editingUnavailable,
    markEditingUnavailable: () => queryClient.setQueryData(unavailableKey, true),
  }
}
