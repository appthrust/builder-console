import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { isResponseContractError } from '../../api/boundary'
import { createdAppAccessRetryDelay, applyAppShare, isCreatedAppSharePending, retryCreatedAppAccess } from '../../api/access'
import { keys } from '../../api/queries/shared'
import { knownValue } from '../../model/contracts/build'
import type { ShareScope } from '../../model/contracts/catalog'
import type { ConsoleValue } from '../../model/contracts/console'
import { matchesAccess } from '../../model/access'
import { sharingCopy } from '../../copy/sharing'
import { consoleKeys, writeAppCache } from '../../api/queries/console'

const pendingApps = new Set<string>()
const key = (id: string) => `builder-console:create-access:${id}`

/** Mark before binding: a failed/reloaded bind must not lose the access operation. */
export function queueCreatedAppAccess(id: string): void {
  pendingApps.add(id)
  try { sessionStorage.setItem(key(id), 'pending') } catch { /* In-memory state still owns the operation. */ }
}

export function hasCreatedAppAccess(id: string): boolean {
  if (pendingApps.has(id)) return true
  try { return sessionStorage.getItem(key(id)) === 'pending' } catch { return false }
}

/**
 * The created app whose access write is queued, as the app cache holds it (the
 * decoded Console app). An unknown share scope sends no access write.
 */
export interface CreatedApp {
  id: string
  share: { scope: ConsoleValue<ShareScope> }
  shareSync?: string
}

/** The app page's selected publish: its id and the observed access `matchesAccess` reads. */
export interface CreatedAppPublish {
  id: string
  access?: Parameters<typeof matchesAccess>[0]
}

/**
 * Uses the app page's selected publish, and Query's deduplication across
 * polls/remounts. The write reuses one idempotency key per app, publish and
 * scope, so a remount re-confirms instead of writing again; an unreadable
 * answer is never resent: the publish list is read back instead, and its
 * observed policy decides.
 */
export function useCreatedAppAccess(projectId: string, app: CreatedApp | undefined, publish: CreatedAppPublish | undefined) {
  const queryClient = useQueryClient()
  const queued = app ? hasCreatedAppAccess(app.id) : false
  const scope = app ? knownValue(app.share.scope) : undefined
  const queryKey = ['create-access', projectId, app?.id, publish?.id, scope]
  const request = useQuery({
    queryKey,
    queryFn: () => applyAppShare(app!.id, `console-create-access:${app!.id}:${publish!.id}:${scope}`),
    enabled: queued && Boolean(publish) && scope !== undefined,
    retry: retryCreatedAppAccess,
    retryDelay: createdAppAccessRetryDelay,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retryOnMount: isCreatedAppSharePending(queryClient.getQueryState(queryKey)?.error),
    staleTime: Infinity,
  })
  const observedAt = queryClient.getQueryState(keys.publishes(projectId))?.dataUpdatedAt ?? 0
  const shareSync = app?.shareSync ?? request.data?.shareSync
  const applied = scope !== undefined && matchesAccess(publish?.access, scope) && shareSync === 'applied'
  const settledAt = Math.max(request.dataUpdatedAt, request.errorUpdatedAt)
  const unconfirmed = isResponseContractError(request.error)
  useEffect(() => {
    // Read both halves back after success or a lost response; the edge alone
    // cannot confirm that the fixed binding was written.
    if (request.data) void writeAppCache(queryClient, request.data)
    if (request.isSuccess || unconfirmed) {
      void queryClient.invalidateQueries({ queryKey: keys.publishes(projectId) })
      if (app) void queryClient.invalidateQueries({ queryKey: consoleKeys.app(app.id) })
    }
  }, [request.data, request.isSuccess, unconfirmed, queryClient, projectId, app?.id])
  useEffect(() => {
    // A manual share edit may recover a rejected creation write. Its observed
    // policy, not the cached old error, decides when creation has finished.
    if (!app || !queued || !applied || !settledAt || observedAt <= settledAt) return
    pendingApps.delete(app.id)
    try { sessionStorage.removeItem(key(app.id)) } catch { /* Already cleared in memory. */ }
  }, [queued, applied, settledAt, observedAt, app?.id])
  const preparing = isCreatedAppSharePending(request.failureReason ?? request.error)
  return {
    error: shareSync === 'conflict' ? new Error(sharingCopy.divergence) : applied || publish?.access?.pending || preparing ? null : request.error,
    waitingForPublish: !applied && preparing && request.failureCount >= 4,
  }
}
