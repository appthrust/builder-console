import type { Publish } from '@appthrust/api-schema/platform-api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { BusinessApp } from '../../api/console'
import { createdAppAccessRetryDelay, putAppAccess, retryCreatedAppAccess } from '../../api/access'
import { keys } from '../../api/queries'
import { isPublishPreparationPending } from '../../api/publish-retry'
import { matchesAccess } from '../../model/access'

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

/** Uses the app page's selected publish, and Query's deduplication across polls/remounts. */
export function useCreatedAppAccess(projectId: string, app: BusinessApp | undefined, publish: Publish | undefined) {
  const queryClient = useQueryClient()
  const queued = app ? hasCreatedAppAccess(app.id) : false
  const queryKey = ['create-access', projectId, app?.id, publish?.id, app?.share.scope]
  const request = useQuery({
    queryKey,
    queryFn: () => putAppAccess(projectId, publish!.id, app!.share.scope, `console-create-access:${app!.id}:${publish!.id}:${app!.share.scope}`),
    enabled: queued && Boolean(publish),
    retry: retryCreatedAppAccess,
    retryDelay: createdAppAccessRetryDelay,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retryOnMount: isPublishPreparationPending(queryClient.getQueryState(queryKey)?.error),
    staleTime: Infinity,
  })
  const observedAt = queryClient.getQueryState(keys.publishes(projectId))?.dataUpdatedAt ?? 0
  const applied = app ? matchesAccess(publish?.access, app.share.scope) : false
  const settledAt = Math.max(request.dataUpdatedAt, request.errorUpdatedAt)
  useEffect(() => {
    if (request.isSuccess) void queryClient.invalidateQueries({ queryKey: keys.publishes(projectId) })
  }, [request.isSuccess, queryClient, projectId])
  useEffect(() => {
    // A manual share edit may recover a rejected creation write. Its observed
    // policy, not the cached old error, decides when creation has finished.
    if (!app || !queued || !applied || !settledAt || observedAt <= settledAt) return
    pendingApps.delete(app.id)
    try { sessionStorage.removeItem(key(app.id)) } catch { /* Already cleared in memory. */ }
  }, [queued, applied, settledAt, observedAt, app?.id])
  const preparing = isPublishPreparationPending(request.failureReason ?? request.error)
  return {
    error: applied || publish?.access?.pending || preparing ? null : request.error,
    waitingForPublish: !applied && preparing && request.failureCount >= 4,
  }
}
