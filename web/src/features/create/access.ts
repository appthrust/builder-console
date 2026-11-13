import type { BusinessApp } from '../../model/contracts/console'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { createdAppAccessRetryDelay, putAppAccess, retryCreatedAppAccess } from '../../api/access'
import { keys } from '../../api/queries/shared'
import { isPublishPreparationPending } from '../../api/publish-retry'
import { matchesAccess } from '../../model/access'
import { knownScope } from '../../model/share'

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

/** Uses the app page's selected publish, and Query's deduplication across polls/remounts. A share scope this console does not know is never written. */
export function useCreatedAppAccess(projectId: string, app: Pick<BusinessApp, 'id' | 'share'> | undefined, publish: { id: string; access?: Parameters<typeof matchesAccess>[0] } | undefined) {
  const queryClient = useQueryClient()
  const queued = app ? hasCreatedAppAccess(app.id) : false
  const scope = app ? knownScope(app.share.scope) : undefined
  const queryKey = ['create-access', projectId, app?.id, publish?.id, scope]
  const request = useQuery({
    queryKey,
    queryFn: () => putAppAccess(projectId, publish!.id, scope!, `console-create-access:${app!.id}:${publish!.id}:${scope!}`),
    enabled: queued && Boolean(publish) && scope !== undefined,
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
