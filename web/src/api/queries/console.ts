// Console server reads (`/api/console/*`, `/config`) and the app screens'
// Console writes. Every answer is decoded at the boundary
// (api/contracts/console/*); nothing here reads an unchecked body.
import { queryOptions, useQuery, useSuspenseQuery, type QueryClient } from '@tanstack/react-query'
import { isResponseContractError } from '../boundary'
import { isConsoleError } from '../console'
import { listCommentsContract, postCommentContract, removeCommentContract } from '../contracts/console/comments'
import { configContract } from '../contracts/console/config'
import { groupsContract } from '../contracts/console/groups'
import { meContract } from '../contracts/console/me'
import {
  appAccessRequestsContract,
  appContract,
  appsContract,
  approveAccessRequestContract,
  createAccessRequestContract,
  createPersonContract,
  declineAccessRequestContract,
  directoryAppsContract,
  directoryEntryContract,
  directoryUsersContract,
  membersContract,
  migrateDirectoryContract,
  myAccessRequestContract,
  pendingAccessRequestsContract,
  peopleContract,
  personContract,
  removeAppContract,
  removeScreenshotContract,
  reorderScreenshotsContract,
  resolveContract,
  settingsContract,
  toolsContract,
  updateAppContract,
  uploadScreenshotContract,
  type AppListInput,
  type DirectoryAppsInput,
  type UpdateAppInput,
} from '../contracts/console/operations'
import { conversationSettingApi } from '../conversation-setting'
import { apiGateway } from '../gateway'
import { isTransientError } from '../platform-error'
import type { BusinessApp, Person } from '../../model/contracts/console'
import { POLL_INTERVAL_MS, readRetryDelay, retryReadQuery, retryTransient, TRANSIENT_RETRIES } from './shared'

export type AppListParams = AppListInput
export type DirectoryAppsParams = DirectoryAppsInput
export type { UpdateAppInput }

export const consoleKeys = {
  me: ['console', 'me'] as const,
  groups: ['console', 'directory', 'groups'] as const,
  members: (groupId: string) => ['console', 'directory', 'groups', groupId, 'members'] as const,
  apps: (params: AppListParams) => ['console', 'apps', params] as const,
  app: (appId: string) => ['console', 'app', appId] as const,
  directoryApps: (params: DirectoryAppsParams) => ['console', 'directory-apps', params] as const,
  directoryEntry: (appId: string) => ['console', 'directory-entry', appId] as const,
  appTools: (appId: string) => ['console', 'app-tools', appId] as const,
  comments: (appId: string) => ['console', 'comments', appId] as const,
  person: (personId: string) => ['console', 'directory', 'people', personId] as const,
  people: (ids: readonly string[]) => ['console', 'directory', 'people', 'ids', ids] as const,
  peopleSearch: (query: string) => ['console', 'directory', 'people', 'search', query] as const,
  accessRequestMine: (appName: string) => ['console', 'access-requests', 'mine', appName] as const,
  accessRequestsPending: ['console', 'access-requests', 'pending'] as const,
  accessRequestsOfApp: (appId: string) => ['console', 'access-requests', 'app', appId] as const,
  resolve: (path: string) => ['console', 'resolve', path] as const,
  directoryUsers: (query: string) => ['console', 'directory', 'users', query] as const,
  platform: ['console', 'admin', 'platform'] as const,
  conversationSetting: ['console', 'admin', 'conversation'] as const,
}

/** Not-found answers and contract failures are final; a call nothing answered gets the transient retries, anything else two retries. */
const retryUnlessNotFound = (failureCount: number, error: unknown) =>
  !isResponseContractError(error) && (isTransientError(error) ? failureCount < TRANSIENT_RETRIES : !isConsoleError(error, 'not_found') && failureCount < 2)

export const meQuery = queryOptions({ queryKey: consoleKeys.me, queryFn: () => apiGateway.console(meContract, undefined), staleTime: 60_000 })

/** Directory groups (the whole tree), through the console's proxy. */
export const groupsQuery = queryOptions({ queryKey: consoleKeys.groups, queryFn: () => apiGateway.console(groupsContract, undefined) })

export const membersQuery = (groupId: string) =>
  queryOptions({ queryKey: consoleKeys.members(groupId), queryFn: () => apiGateway.console(membersContract, groupId) })

export const appsQuery = (params: AppListParams) =>
  queryOptions({ queryKey: consoleKeys.apps(params), queryFn: () => apiGateway.console(appsContract, params) })

export const appQuery = (appId: string) =>
  queryOptions({ queryKey: consoleKeys.app(appId), queryFn: () => apiGateway.console(appContract, appId), retry: retryReadQuery, retryDelay: readRetryDelay })

/**
 * The one way a write's answer enters the app cache: the decoded `BusinessApp`
 * an update, bind, publish or approve answered, the same shape `appQuery`
 * reads. A read of the app that started before the write could land later
 * with the old record, so it is cancelled first.
 */
export async function writeAppCache(queryClient: QueryClient, app: BusinessApp): Promise<void> {
  const { queryKey } = appQuery(app.id)
  await queryClient.cancelQueries({ queryKey, exact: true })
  queryClient.setQueryData(queryKey, app)
}

export const directoryAppsQuery = (params: DirectoryAppsParams = {}) =>
  queryOptions({ queryKey: consoleKeys.directoryApps(params), queryFn: () => apiGateway.console(directoryAppsContract, params) })

export const directoryEntryQuery = (appId: string) =>
  queryOptions({ queryKey: consoleKeys.directoryEntry(appId), queryFn: () => apiGateway.console(directoryEntryContract, appId), retry: retryUnlessNotFound })

export const commentsQuery = (appId: string) =>
  queryOptions({ queryKey: consoleKeys.comments(appId), queryFn: () => apiGateway.console(listCommentsContract, appId) })

/** Published tools change on a minutes scale; a Tools built-in app that is still installing keeps the regular poll. */
export const APP_TOOLS_POLL_MS = 60_000

/** Tools published by the Tools built-in app, built on this app (Built-in app Connect); `pending` keeps the regular poll until Tools is installed. */
export const appToolsQuery = (appId: string) =>
  queryOptions({
    queryKey: consoleKeys.appTools(appId),
    queryFn: () => apiGateway.console(toolsContract, appId),
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data && !query.state.data.available && query.state.data.pending ? POLL_INTERVAL_MS : APP_TOOLS_POLL_MS),
  })

export const personQuery = (personId: string) =>
  queryOptions({ queryKey: consoleKeys.person(personId), queryFn: () => apiGateway.console(personContract, personId), retry: retryUnlessNotFound })

/** The Directory answers at most 100 ids per call. */
const PEOPLE_BATCH = 100

/** Directory people by id (batches of 100; no call for an empty list); unknown ids are simply absent. */
export async function peopleByIds(ids: readonly string[]): Promise<Person[]> {
  const batches: string[][] = []
  for (let start = 0; start < ids.length; start += PEOPLE_BATCH) batches.push(ids.slice(start, start + PEOPLE_BATCH))
  const pages = await Promise.all(batches.map((batch) => apiGateway.console(peopleContract, { ids: batch })))
  return pages.flat()
}

export const peopleQuery = (ids: readonly string[]) =>
  queryOptions({ queryKey: consoleKeys.people(ids), queryFn: () => peopleByIds(ids) })

export const myAccessRequestQuery = (appName: string) =>
  queryOptions({ queryKey: consoleKeys.accessRequestMine(appName), queryFn: () => apiGateway.console(myAccessRequestContract, appName) })

export const pendingAccessRequestsQuery = queryOptions({
  queryKey: consoleKeys.accessRequestsPending,
  queryFn: () => apiGateway.console(pendingAccessRequestsContract, undefined),
})

export const appAccessRequestsQuery = (appId: string) =>
  queryOptions({ queryKey: consoleKeys.accessRequestsOfApp(appId), queryFn: () => apiGateway.console(appAccessRequestsContract, appId) })

/** `path` is the console URL path ("/sales/east"); follows the server's redirect table. */
export const resolveQuery = (path: string) =>
  queryOptions({
    queryKey: consoleKeys.resolve(path),
    queryFn: () => apiGateway.console(resolveContract, path),
    staleTime: 30_000,
    retry: retryTransient,
    refetchInterval: false,
  })

/** Realm accounts for the person pickers; idle until something is typed. */
export const directoryUsersQuery = (q: string) =>
  queryOptions({ queryKey: consoleKeys.directoryUsers(q), queryFn: () => apiGateway.console(directoryUsersContract, q), enabled: q.length > 0 })

export const platformSettingsQuery = queryOptions({ queryKey: consoleKeys.platform, queryFn: () => apiGateway.console(settingsContract, undefined) })

/** The NEW-APP conversation setting (Console administrators only). */
export const conversationSettingQuery = queryOptions({ queryKey: consoleKeys.conversationSetting, queryFn: () => conversationSettingApi.get() })

/** The caller; the root route's beforeLoad has loaded it before any page renders. */
export function useMe() {
  return useSuspenseQuery(meQuery)
}

/** Every group the caller can see; loaded by the root route's beforeLoad. */
export function useGroups() {
  return useSuspenseQuery(groupsQuery)
}

export function useApps(params: AppListParams, enabled = true) {
  return useQuery({ ...appsQuery(params), enabled })
}

/** Posts a comment; its answer is decoded like any read. */
export const postComment = (appId: string, body: string) => apiGateway.console(postCommentContract, { appId, body })

export const removeComment = (appId: string, commentId: string) => apiGateway.console(removeCommentContract, { appId, commentId })

// Console writes of the app screens. A 2xx answer that breaks its contract
// rejects with a typed failure: nothing is cached from it, and callers read the
// state back instead of resending.
export const updateApp = (appId: string, input: UpdateAppInput): Promise<BusinessApp> => apiGateway.console(updateAppContract, { appId, input })
export const removeApp = (appId: string): Promise<void> => apiGateway.console(removeAppContract, appId)
/** Registered people matching a name or email. */
export const searchPeople = (q: string): Promise<Person[]> => apiGateway.console(peopleContract, { q })
/** Pre-registers a person by email; 409 when the email is known. */
export const createPerson = (input: { email: string; displayName: string }): Promise<Person> => apiGateway.console(createPersonContract, input)
export const uploadScreenshot = (appId: string, file: File, caption?: string) => apiGateway.console(uploadScreenshotContract, { appId, file, caption })
export const removeScreenshot = (appId: string, screenshotId: string) => apiGateway.console(removeScreenshotContract, { appId, screenshotId })
export const reorderScreenshots = (appId: string, order: string[]) => apiGateway.console(reorderScreenshotsContract, { appId, order })
export const createAccessRequest = (input: { appName: string; message: string }) => apiGateway.console(createAccessRequestContract, input)
export const approveAccessRequest = (appId: string, requestId: string) => apiGateway.console(approveAccessRequestContract, { appId, requestId })
export const declineAccessRequest = (appId: string, requestId: string) => apiGateway.console(declineAccessRequestContract, { appId, requestId })
/** Console admin only; pushes the console's people, groups and memberships into the Directory (release N only). */
export const migrateDirectory = () => apiGateway.console(migrateDirectoryContract, undefined)

const fetchConsoleConfig = () => apiGateway.console(configContract, undefined)

const configuredProjectId: string | undefined =
  import.meta.env?.DEV ? import.meta.env.VITE_CONSOLE_PROJECT_ID || undefined : undefined

export function useProjectId() {
  return useQuery({
    ...projectIdQuery(configuredProjectId),
  })
}

const fixedConfig = {
  retry: false,
  refetchInterval: false as const,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
}

export function projectIdQuery(projectIdOverride?: string) {
  return {
    queryKey: ['project-id', projectIdOverride],
    queryFn: async (): Promise<string> => projectIdOverride || (await fetchConsoleConfig()).projectId,
    ...fixedConfig,
  }
}

export const consoleConfigQuery = queryOptions({ queryKey: ['console-config'], queryFn: fetchConsoleConfig, ...fixedConfig })

/** The Dashboard's Team settings page, or undefined while unknown or when the server does not name one. */
export function useDashboardSettingsUrl(): string | undefined {
  return useQuery(consoleConfigQuery).data?.dashboardUrl
}
