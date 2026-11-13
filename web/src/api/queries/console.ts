// Console server reads (`/api/console/*`, `/config`). Contracted operations
// (me, groups, comments, config) go through the gateway; the rest still use the
// unverified facade until their contracts land.
import { queryOptions, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { isResponseContractError } from '../boundary'
import { consoleApi, type AppListParams, type DirectoryAppsParams } from '../console-unverified'
import { isConsoleError } from '../console'
import { listCommentsContract, postCommentContract, removeCommentContract } from '../contracts/console/comments'
import { configContract } from '../contracts/console/config'
import { groupsContract } from '../contracts/console/groups'
import { meContract } from '../contracts/console/me'
import { apiGateway } from '../gateway'
import { isTransientError } from '../platform-error'
import { POLL_INTERVAL_MS, readRetryDelay, retryReadQuery, retryTransient, TRANSIENT_RETRIES } from './shared'

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
}

/** Not-found answers and contract failures are final; a call nothing answered gets the transient retries, anything else two retries. */
const retryUnlessNotFound = (failureCount: number, error: unknown) =>
  !isResponseContractError(error) && (isTransientError(error) ? failureCount < TRANSIENT_RETRIES : !isConsoleError(error, 'not_found') && failureCount < 2)

export const meQuery = queryOptions({ queryKey: consoleKeys.me, queryFn: () => apiGateway.console(meContract, undefined), staleTime: 60_000 })

/** Directory groups (the whole tree), through the console's proxy. */
export const groupsQuery = queryOptions({ queryKey: consoleKeys.groups, queryFn: () => apiGateway.console(groupsContract, undefined) })

export const membersQuery = (groupId: string) =>
  queryOptions({ queryKey: consoleKeys.members(groupId), queryFn: () => consoleApi.directory.members(groupId) })

export const appsQuery = (params: AppListParams) =>
  queryOptions({ queryKey: consoleKeys.apps(params), queryFn: () => consoleApi.apps.list(params) })

export const appQuery = (appId: string) =>
  queryOptions({ queryKey: consoleKeys.app(appId), queryFn: () => consoleApi.apps.get(appId), retry: retryReadQuery, retryDelay: readRetryDelay })

export const directoryAppsQuery = (params: DirectoryAppsParams = {}) =>
  queryOptions({ queryKey: consoleKeys.directoryApps(params), queryFn: () => consoleApi.apps.directory(params) })

export const directoryEntryQuery = (appId: string) =>
  queryOptions({ queryKey: consoleKeys.directoryEntry(appId), queryFn: () => consoleApi.apps.directoryEntry(appId), retry: retryUnlessNotFound })

export const commentsQuery = (appId: string) =>
  queryOptions({ queryKey: consoleKeys.comments(appId), queryFn: () => apiGateway.console(listCommentsContract, appId) })

/** Published tools change on a minutes scale; a Tools built-in app that is still installing keeps the regular poll. */
export const APP_TOOLS_POLL_MS = 60_000

/** Tools published by the Tools built-in app, built on this app (Built-in app Connect); `pending` keeps the regular poll until Tools is installed. */
export const appToolsQuery = (appId: string) =>
  queryOptions({
    queryKey: consoleKeys.appTools(appId),
    queryFn: () => consoleApi.apps.tools(appId),
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data && !query.state.data.available && query.state.data.pending ? POLL_INTERVAL_MS : APP_TOOLS_POLL_MS),
  })

export const personQuery = (personId: string) =>
  queryOptions({ queryKey: consoleKeys.person(personId), queryFn: () => consoleApi.directory.person(personId), retry: retryUnlessNotFound })

/** Directory people by id (batch); unknown ids are simply absent. */
export const peopleQuery = (ids: readonly string[]) =>
  queryOptions({ queryKey: consoleKeys.people(ids), queryFn: () => consoleApi.directory.people([...ids]) })

export const myAccessRequestQuery = (appName: string) =>
  queryOptions({ queryKey: consoleKeys.accessRequestMine(appName), queryFn: () => consoleApi.accessRequests.mine(appName) })

export const pendingAccessRequestsQuery = queryOptions({
  queryKey: consoleKeys.accessRequestsPending,
  queryFn: () => consoleApi.accessRequests.pending(),
})

export const appAccessRequestsQuery = (appId: string) =>
  queryOptions({ queryKey: consoleKeys.accessRequestsOfApp(appId), queryFn: () => consoleApi.accessRequests.ofApp(appId) })

/** `path` is the console URL path ("/sales/east"); follows the server's redirect table. */
export const resolveQuery = (path: string) =>
  queryOptions({
    queryKey: consoleKeys.resolve(path),
    queryFn: () => consoleApi.resolve(path),
    staleTime: 30_000,
    retry: retryTransient,
    refetchInterval: false,
  })

/** Realm accounts for the person pickers; idle until something is typed. */
export const directoryUsersQuery = (q: string) =>
  queryOptions({ queryKey: consoleKeys.directoryUsers(q), queryFn: () => consoleApi.directory.users(q), enabled: q.length > 0 })

export const platformSettingsQuery = queryOptions({ queryKey: consoleKeys.platform, queryFn: () => consoleApi.admin.platform() })

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
