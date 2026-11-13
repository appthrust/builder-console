// Row writes of the データ tab. The transport (api/client.ts) gives every
// write its own Idempotency-Key. Each success writes the returned row into the
// cached pages of its 表 (grid and Sheet show it at once) and then refetches
// them, since a write can move rows between pages, searches and sort orders.
// A write answered 2xx with an answer this console cannot read may have
// happened: nothing is cached, nothing is resent, and every write of the 表
// stays off until 「最新の状態を確認する」 has read its rows back (the latch
// outlives the Sheet, so closing and reopening it does not offer a resend).
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  createDatabaseRow,
  deleteDatabaseRow,
  updateDatabaseRow,
  writeRowToCache,
  type DatabaseRowTarget,
} from '../../../api/queries/data'
import { keys } from '../../../api/queries/shared'
import type { DatabaseRowsPage } from '../../../model/contracts/data'
import { rowKey, type Collection, type DataRow } from '../../../model/data-catalog'
import { isUnconfirmedWrite } from '../notices'

export interface UpdateRowInput {
  key: string
  /** Changed columns only (`diff`). */
  values: Record<string, unknown>
  /** Optimistic lock (`expectedFor`). */
  expected: Record<string, unknown>
}

/** A console-only flag per database or 表 (never fetched, never server data). */
const useFlag = (queryKey: readonly unknown[]) =>
  useQuery({ queryKey, queryFn: skipToken, initialData: false, staleTime: Infinity, gcTime: Infinity }).data

const unconfirmedKey = (target: DatabaseRowTarget) => ['database-row-write-unconfirmed', target.projectId, target.databaseId, target.schema, target.table] as const

/**
 * The 表's unconfirmed-write latch: `unconfirmed` while a row write of it may
 * have happened unseen; `confirm` reads the 表's pages back and lifts the
 * latch only when that read succeeded (resolving true). Never resends.
 */
export function useRowWriteConfirmation(projectId: string, databaseId: string, collection: Collection) {
  const queryClient = useQueryClient()
  const target: DatabaseRowTarget = { projectId, databaseId, schema: collection.schema, table: collection.name }
  const unconfirmed = useFlag(unconfirmedKey(target))
  const [confirming, setConfirming] = useState(false)
  const confirm = async (): Promise<boolean> => {
    setConfirming(true)
    try {
      await queryClient.refetchQueries({ queryKey: keys.databaseRows(projectId, databaseId, collection.schema, collection.name) }, { throwOnError: true })
      queryClient.setQueryData(unconfirmedKey(target), false)
      return true
    } catch {
      return false
    } finally {
      setConfirming(false)
    }
  }
  return { unconfirmed, confirming, confirm }
}

/**
 * Create / update / delete one row of `collection`; each resolves to the row
 * the database returned, verified at the boundary to be the row addressed (an
 * answer without it is unconfirmed: nothing is patched, dropped or reported saved).
 */
export function useDatabaseRowMutations(projectId: string, databaseId: string, collection: Collection) {
  const queryClient = useQueryClient()
  const target: DatabaseRowTarget = { projectId, databaseId, schema: collection.schema, table: collection.name }
  const prefix = keys.databaseRows(projectId, databaseId, collection.schema, collection.name)
  // 412 `row_editing_unavailable` (editor broker not rolled out): remembered per database, never fetched.
  const unavailableKey = ['database-row-editing-unavailable', projectId, databaseId] as const
  const editingUnavailable = useFlag(unavailableKey)
  const confirmation = useRowWriteConfirmation(projectId, databaseId, collection)
  /** Rows are addressed by the 表's single key column; a 表 without one has no row writes (nothing is sent). */
  const keyColumn = (): string => {
    if (!collection.primaryKey) throw new Error('a 表 without a single key column has no row writes')
    return collection.primaryKey
  }
  const onError = (error: unknown) => {
    if (isUnconfirmedWrite(error)) queryClient.setQueryData(unconfirmedKey(target), true)
  }

  const create = useMutation({
    mutationFn: (values: Record<string, unknown>): Promise<DataRow> => createDatabaseRow(target, keyColumn(), values),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: prefix }),
    onError,
  })

  const update = useMutation({
    mutationFn: ({ key, values, expected }: UpdateRowInput): Promise<DataRow> => updateDatabaseRow(target, keyColumn(), key, values, expected),
    onSuccess: async (row) => {
      await writeRowToCache(queryClient, target, collection, row.key, row.values)
      return queryClient.invalidateQueries({ queryKey: prefix })
    },
    onError,
  })

  const remove = useMutation({
    mutationFn: (key: string): Promise<DataRow> => deleteDatabaseRow(target, keyColumn(), key),
    onSuccess: async (row) => {
      await writeRowToCache(queryClient, target, collection, row.key, undefined)
      return queryClient.invalidateQueries({ queryKey: prefix })
    },
    onError,
  })

  /** Row `key` as the cached pages now hold it (undefined when no loaded page has it). */
  const cachedRow = (key: string): DataRow | undefined => {
    for (const [, page] of queryClient.getQueriesData<DatabaseRowsPage>({ queryKey: prefix })) {
      const values = page?.rows.find((candidate) => rowKey(collection, candidate) === key)
      if (values) return { key, values }
    }
    return undefined
  }

  /**
   * 「最新の内容を読み込む」 after a conflict: refetch the 表's pages and return
   * row `key` as they now hold it. Read from the cache, not props: the refetch
   * resolves before observers re-render. A read that failed rejects, so the
   * last good rows are never offered as the latest.
   */
  const reload = async (key: string): Promise<DataRow | undefined> => {
    await queryClient.invalidateQueries({ queryKey: prefix }, { throwOnError: true })
    return cachedRow(key)
  }

  /** 「最新の状態を確認する」: the 表 is read back, then this Sheet's failed writes are cleared. */
  const confirm = async (): Promise<boolean> => {
    if (!(await confirmation.confirm())) return false
    create.reset()
    update.reset()
    remove.reset()
    return true
  }

  return {
    create,
    update,
    remove,
    reload,
    cachedRow,
    /** Row editing is not enabled for this database yet: the Sheet hides 編集 and 削除. */
    editingUnavailable,
    markEditingUnavailable: () => queryClient.setQueryData(unavailableKey, true),
    /** A write of this 表 may have happened unseen: every write stays off until `confirm`. */
    unconfirmed: confirmation.unconfirmed,
    confirming: confirmation.confirming,
    confirm,
  }
}
