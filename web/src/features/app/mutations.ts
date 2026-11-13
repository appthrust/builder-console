import { ORPCError } from '@orpc/client'
import { useMutation, useQueryClient, type Query, type QueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useRef } from 'react'
import { client, type PlatformApiClient } from '../../api/client'
import { consoleApi, type BusinessApp, type DirectoryUser, type UpdateAppInput } from '../../api/console-unverified'
import { keys } from '../../api/queries/shared'
import { consoleKeys, postComment, removeComment } from '../../api/queries/console'
import { type Person } from '../../model/contracts/console'
import { platformErrorEnvelope } from '../../api/platform-error'
import type { AppView } from '../../model/app'
import { paths } from '../../routes/paths'
import { sourceRepositoryIdFor } from './platform'

/** Root of every console query key (`consoleKeys.*`): an app edit can change lists, group counts and resolved paths. */
const CONSOLE_ROOT = [consoleKeys.me[0]] as const

/** A realm account (or typed email) as a Directory person, pre-registered on first use, so it can be an owner or an extra viewer. */
export async function ensurePerson(entry: DirectoryUser): Promise<Person> {
  const email = entry.email.toLowerCase()
  const known = (await consoleApi.directory.searchPeople(entry.email)).find((person) => person.email.toLowerCase() === email)
  return known ?? (await consoleApi.directory.createPerson({ email: entry.email, displayName: entry.displayName }))
}

/** PATCH the console record; follow the app to its new path when the group or slug moved. */
export function useUpdateApp(app: BusinessApp) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: (input: UpdateAppInput) => consoleApi.apps.update(app.id, input),
    onSuccess: async (updated) => {
      queryClient.setQueryData(consoleKeys.app(app.id), updated)
      await queryClient.invalidateQueries({ queryKey: CONSOLE_ROOT })
      if (updated.group.path !== app.group.path || updated.slug !== app.slug) {
        await navigate({ href: paths.app(updated.group.path, updated.slug, 'settings'), replace: true })
      }
    },
  })
}

/** Guide edits also refresh the capabilities shown in app and directory lists. */
export function useSaveGuide(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: Pick<BusinessApp, 'guide' | 'capabilities'>) => consoleApi.apps.update(appId, input),
    onSuccess: async (updated) => {
      queryClient.setQueryData(consoleKeys.app(appId), updated)
      await queryClient.invalidateQueries({ queryKey: CONSOLE_ROOT })
    },
  })
}

// Comment writes are decoded at the boundary. The thread is read back after any outcome: an
// answer that could not be read says nothing about whether the write happened.
export function usePostComment(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: string) => postComment(appId, body),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: consoleKeys.comments(appId) })
    },
  })
}

export function useRemoveComment(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (commentId: string) => removeComment(appId, commentId),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: consoleKeys.comments(appId) })
    },
  })
}

/** Screenshots ride on the app and on every directory entry, so a change refreshes all console reads. */
function useScreenshotMutation<I, O>(mutationFn: (input: I) => Promise<O>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONSOLE_ROOT })
    },
  })
}

export function useUploadScreenshot(appId: string) {
  return useScreenshotMutation((input: { file: File; caption?: string }) => consoleApi.screenshots.upload(appId, input.file, input.caption))
}

export function useRemoveScreenshot(appId: string) {
  return useScreenshotMutation((screenshotId: string) => consoleApi.screenshots.remove(appId, screenshotId))
}

export function useReorderScreenshots(appId: string) {
  return useScreenshotMutation((order: string[]) => consoleApi.screenshots.reorder(appId, order))
}

export function useApproveAccessRequest(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (requestId: string) => consoleApi.accessRequests.approve(appId, requestId),
    onSuccess: async (response) => {
      queryClient.setQueryData(consoleKeys.app(appId), response.app)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: consoleKeys.accessRequestsOfApp(appId) }),
        queryClient.invalidateQueries({ queryKey: consoleKeys.accessRequestsPending }),
      ])
    },
  })
}

export function useDeclineAccessRequest(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (requestId: string) => consoleApi.accessRequests.decline(appId, requestId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: consoleKeys.accessRequestsOfApp(appId) }),
        queryClient.invalidateQueries({ queryKey: consoleKeys.accessRequestsPending }),
      ])
    },
  })
}

/** What one app delete removes; kept across retries once the stack delete is accepted. */
export interface AppDeletion {
  appId: string
  stackId?: string
  /** The ApplicationSourceRepository the console made for the stack (never the GitHub repository). */
  sourceRepositoryId?: string
  stackDeleted?: boolean
}

export interface AppDeletionDeps {
  platform: Pick<PlatformApiClient, 'platformApiDeleteApplicationStack' | 'platformApiDeleteApplicationSourceRepository'>
  removeApp: (appId: string) => Promise<unknown>
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

/** The deleted stack still references the binding: GitOps has not pruned it within the wait. */
export class SourceStillReferencedError extends Error {
  constructor() {
    super('source repository is still referenced by the deleted application stack')
  }
}

/** GitOps prunes the deleted stack asynchronously; until then the binding answers 409 referenced_by_stack. */
const SOURCE_RELEASE_WAIT_MS = 120_000
const SOURCE_RELEASE_POLL_MS = 3_000

/**
 * Stack → its source repository binding → console record. The console record
 * is the index, so it goes last: a running app or a stray binding never loses
 * the row that lets someone delete it again. 404s count as already deleted.
 */
export async function deleteAppResources(projectId: string, deletion: AppDeletion, deps: AppDeletionDeps): Promise<void> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  if (deletion.stackId && !deletion.stackDeleted) {
    try {
      await deps.platform.platformApiDeleteApplicationStack({ params: { projectId, id: deletion.stackId } })
    } catch (error) {
      if (!(error instanceof ORPCError && error.status === 404)) throw error
    }
    deletion.stackDeleted = true
  }
  if (deletion.sourceRepositoryId) {
    const deadline = now() + SOURCE_RELEASE_WAIT_MS
    for (;;) {
      try {
        await deps.platform.platformApiDeleteApplicationSourceRepository({ params: { projectId, id: deletion.sourceRepositoryId } })
        break
      } catch (error) {
        if (error instanceof ORPCError && error.status === 404) break
        const details = platformErrorEnvelope(error)?.details
        const blockers = details?.reason === 'referenced_by_stack' && Array.isArray(details.stackIds) ? details.stackIds : undefined
        // Another stack using the binding is not ours to wait for.
        if (!blockers || !deletion.stackId || !blockers.every((id) => id === deletion.stackId)) throw error
        if (now() >= deadline) throw new SourceStillReferencedError()
        await wait(SOURCE_RELEASE_POLL_MS)
      }
    }
  }
  await deps.removeApp(deletion.appId)
}

export function useDeleteApp(projectId: string, app: BusinessApp, view: AppView) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const deletion = useRef<AppDeletion>(undefined)
  return useMutation({
    mutationFn: async () => {
      // A retry after the stack delete was accepted keeps the ids: the stack has left the lists by then.
      if (!deletion.current?.stackDeleted) {
        deletion.current = { appId: app.id, stackId: view.stack?.id, sourceRepositoryId: sourceRepositoryIdFor(view) }
      }
      await deleteAppResources(projectId, deletion.current, { platform: client, removeApp: consoleApi.apps.remove })
    },
    onSuccess: async () => {
      const deleted = { appId: app.id, applicationId: view.platform?.id, stackId: deletion.current?.stackId, webComponentId: view.platform?.webComponentId }
      await forgetDeletedApp(queryClient, projectId, deleted)
      await navigate({ href: paths.group(app.group.path) })
      // Unobserved now: drop the deleted app's own reads instead of letting them refetch.
      queryClient.removeQueries({ predicate: (query) => readsDeletedApp(query, projectId, deleted) })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CONSOLE_ROOT }),
        ...[keys.applications, keys.stacks, keys.publishes, keys.summaries, keys.sourceRepositories]
          .map((key) => queryClient.invalidateQueries({ queryKey: key(projectId) })),
      ])
    },
  })
}

export interface DeletedApp {
  appId: string
  applicationId?: string
  stackId?: string
  webComponentId?: string
}

/** A query that reads only the deleted app: its console record/tools/comments or its Platform releases, env and logs. */
export function readsDeletedApp(query: Pick<Query, 'queryKey'>, projectId: string, deleted: DeletedApp): boolean {
  const key = query.queryKey
  if (key[0] === 'console') return key.slice(1).some((part) => part === deleted.appId)
  if (deleted.applicationId && (key[0] === 'releases' || key[0] === 'release-state' || key[0] === 'env-vars')) return key[1] === projectId && key[2] === deleted.applicationId
  if (deleted.webComponentId && key[0] === 'logs') return key[1] === projectId && key[2] === deleted.webComponentId
  return false
}

type Listed<T> = T[] | { data?: T[]; items?: T[] } | undefined

/**
 * After a delete, before leaving its page: stop the deleted app's in-flight reads
 * and take it out of the cached lists, so the next page derives nothing (no
 * releases, no screenshots) from an app that no longer exists.
 */
export async function forgetDeletedApp(queryClient: QueryClient, projectId: string, deleted: DeletedApp): Promise<void> {
  await queryClient.cancelQueries({ predicate: (query) => readsDeletedApp(query, projectId, deleted) })
  // Console lists are bare arrays; Platform lists are `{ data }` envelopes.
  const without = <T extends { id: string }>(list: Listed<T>, id: string | undefined): Listed<T> => {
    if (!list || !id) return list
    if (Array.isArray(list)) return list.filter((item) => item.id !== id)
    return { ...list, ...(list.data ? { data: list.data.filter((item) => item.id !== id) } : {}), ...(list.items ? { items: list.items.filter((item) => item.id !== id) } : {}) }
  }
  queryClient.setQueryData<Listed<{ id: string }>>(keys.applications(projectId), (list) => without(list, deleted.applicationId))
  queryClient.setQueryData<Listed<{ id: string }>>(keys.stacks(projectId), (list) => without(list, deleted.stackId))
  for (const prefix of [['console', 'apps'], ['console', 'directory-apps']]) {
    queryClient.setQueriesData<Listed<{ id: string }>>({ queryKey: prefix }, (list) => without(list, deleted.appId))
  }
}

/** 作りかけ「やめる」: a draft has no stack yet, so only the console record goes; the list stays where it is. */
export function useDiscardDraft(app: BusinessApp) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => consoleApi.apps.remove(app.id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: consoleKeys.app(app.id) })
      await queryClient.invalidateQueries({ queryKey: CONSOLE_ROOT })
    },
  })
}
