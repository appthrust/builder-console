// Read-model loading (React Query). Raw API shapes only; interpretation lives in src/model.
// Every query is a `queryOptions()` factory so route loaders (`ensureQueryData`)
// and components (`useQuery` / `useSuspenseQuery`) share one key and fetcher.
import {
  ComponentReleaseState,
  GitHubSourceConnectionListResponse,
  type ComponentSummaryFactsV1,
  type DatabaseChange,
  type DatabaseTableSchema,
  type Domain,
  type GitHubSourceConnection,
  type RegistryConnection,
} from '@appthrust/api-schema/platform-api'
import {
  keepPreviousData,
  QueryClient,
  queryOptions,
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { client, type PlatformApiClient } from './client'
import {
  ProjectGitHubSourceConnectionListResponse,
  type RepositoryDestinationResolution,
  type RepositoryDestinationSettings,
} from './repository-destination'
import { ORPCError } from '@orpc/client'
import { ConsoleApiError, consoleApi, consoleKeys, isConsoleError, type AppListParams, type DirectoryAppsParams } from './console'
import { isPlatformNotFound, isTransientError, platformErrorEnvelope } from './platform-error'
import { useMemo } from 'react'
import { deriveCatalog, type Catalog } from '../model/data-catalog'
import { publishDomainPending } from '../model/create'

export const POLL_INTERVAL_MS = 5_000

/** Retries for a call nothing answered (rollout gap, network blip); backed off 1 s, 2 s, 4 s. */
const TRANSIENT_RETRIES = 3

/** 1 s, 2 s, 4 s … capped at 8 s. */
export const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 8000)

/** Only calls nothing answered are retried; any answer (a code, a 4xx, a coded 5xx) is final. */
export const retryTransient = (failureCount: number, error: unknown) => isTransientError(error) && failureCount < TRANSIENT_RETRIES

/**
 * Default: a call nothing answered gets three backed-off retries, so a Platform
 * API rollout reads as loading instead of a load failure; a 4xx answer is final;
 * anything else keeps the single generic retry.
 */
export const retryQuery = (failureCount: number, error: unknown) =>
  isTransientError(error)
    ? failureCount < TRANSIENT_RETRIES
    : !((error instanceof ORPCError || error instanceof ConsoleApiError) && error.status >= 400 && error.status < 500) && failureCount < 1

/**
 * Draft/app reads can fail with a coded 500 during a rollout, not just an
 * unanswered gateway call. Retry these reads five times; 4xx answers are final.
 */
export function retryReadQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 5) return false
  const status = error instanceof ORPCError || error instanceof ConsoleApiError
    ? error.status
    : platformErrorEnvelope(error)?.status
  if (status !== undefined) return status === 0 || status === 500 || status === 502 || status === 503 || status === 504
  return isTransientError(error)
}

/** Read retries wait 3 s, 6 s, 12 s, 24 s, then 30 s. */
export const readRetryDelay = (attempt: number) => Math.min(3_000 * 2 ** attempt, 30_000)

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchInterval: POLL_INTERVAL_MS, retry: retryQuery, retryDelay, staleTime: 2_000 },
  },
})

// ---------- console (`/api/console/*`) ----------

/** Not-found answers are final; a call nothing answered gets the transient retries, anything else two retries. */
const retryUnlessNotFound = (failureCount: number, error: unknown) =>
  isTransientError(error) ? failureCount < TRANSIENT_RETRIES : !isConsoleError(error, 'not_found') && failureCount < 2

export const meQuery = queryOptions({ queryKey: consoleKeys.me, queryFn: () => consoleApi.me(), staleTime: 60_000 })

/** Directory groups (the whole tree), through the console's proxy. */
export const groupsQuery = queryOptions({ queryKey: consoleKeys.groups, queryFn: () => consoleApi.directory.groups() })

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
  queryOptions({ queryKey: consoleKeys.comments(appId), queryFn: () => consoleApi.comments.list(appId) })

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

// ---------- platform (`/api/v1/*`) ----------

const configuredProjectId: string | undefined =
  import.meta.env?.DEV ? import.meta.env.VITE_CONSOLE_PROJECT_ID || undefined : undefined

export function useProjectId() {
  return useQuery({
    ...projectIdQuery(configuredProjectId),
  })
}

/** `GET /config` from cmd/server; `dashboardUrl` is the Dashboard's Team settings page. */
export interface ConsoleConfig {
  projectId: string
  dashboardUrl?: string
}

async function fetchConsoleConfig(): Promise<ConsoleConfig> {
  const response = await fetch('/config', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Console config request failed (${response.status})`)
  const config: unknown = await response.json()
  if (
    typeof config !== 'object' || config === null ||
    !('projectId' in config) || typeof config.projectId !== 'string' ||
    config.projectId.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(config.projectId)
  ) throw new Error('Console config contains an invalid projectId')
  const dashboardUrl = 'dashboardUrl' in config ? httpUrl(config.dashboardUrl) : undefined
  return dashboardUrl ? { projectId: config.projectId, dashboardUrl } : { projectId: config.projectId }
}

/** An absolute http(s) URL, else undefined: a link the config cannot vouch for is not rendered. */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
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

async function listAllComponentSummaries(projectId: string): Promise<ComponentSummaryFactsV1[]> {
  const items: ComponentSummaryFactsV1[] = []
  let cursor: string | undefined
  do {
    const page = await client.platformApiListComponentSummaries({
      params: { projectId },
      query: { limit: 100, ...(cursor ? { cursor } : {}) },
    })
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return items
}

export const keys = {
  applications: (projectId: string) => ['applications', projectId] as const,
  stacks: (projectId: string) => ['application-stacks', projectId] as const,
  publishes: (projectId: string) => ['publishes', projectId] as const,
  summaries: (projectId: string) => ['component-summaries', projectId] as const,
  releases: (projectId: string, applicationId: string, branchId: string) =>
    ['releases', projectId, applicationId, branchId] as const,
  releaseState: (projectId: string, applicationId: string, branchId: string, componentId: string) =>
    ['release-state', projectId, applicationId, branchId, componentId] as const,
  envVars: (projectId: string, applicationId: string, branchId: string, componentId: string) =>
    ['env-vars', projectId, applicationId, branchId, componentId] as const,
  logs: (projectId: string, componentId: string, branchId: string | undefined) =>
    ['logs', projectId, componentId, branchId] as const,
  sourceRepositories: (projectId: string) => ['application-source-repositories', projectId] as const,
  createConnections: (projectId: string) => ['create-connections', projectId] as const,
  repositoryDestinationSettings: (projectId: string) => ['repository-destination-settings', projectId] as const,
  creationTools: (projectId: string) => ['creation-tools', projectId] as const,
  githubRepositories: (projectId: string, connectionId: string, q: string) =>
    ['github-repositories', projectId, connectionId, q] as const,
  databaseTables: (projectId: string, databaseId: string) => ['database-tables', projectId, databaseId] as const,
  databaseTableSchema: (projectId: string, databaseId: string, schema: string, table: string) =>
    ['database-table-schema', projectId, databaseId, schema, table] as const,
  /** Prefix of every rows page of one table (`[...prefix, params]`), so a write invalidates them all. */
  databaseRows: (projectId: string, databaseId: string, schema: string, table: string) =>
    ['database-rows', projectId, databaseId, schema, table] as const,
  databaseChanges: (projectId: string, databaseId: string) => ['database-changes', projectId, databaseId] as const,
}

/** Project-wide read models that every screen derives ConsoleApp from. */
export function useProjectReadModels(projectId: string) {
  const [applications, stacks, publishes, summaries] = useQueries({
    queries: [
      {
        queryKey: keys.applications(projectId),
        queryFn: () =>
          client.platformApiListApplications({ params: { projectId }, query: { limit: 200 } }),
      },
      {
        queryKey: keys.stacks(projectId),
        queryFn: () => client.platformApiListApplicationStacks({ projectId }),
      },
      {
        queryKey: keys.publishes(projectId),
        queryFn: () => client.platformApiListProjectPublishes({ params: { projectId } }),
      },
      {
        queryKey: keys.summaries(projectId),
        queryFn: () => listAllComponentSummaries(projectId),
      },
    ],
  })
  return { applications, stacks, publishes, summaries }
}

export function releasesQuery(projectId: string, applicationId: string, branchId: string) {
  return {
    queryKey: keys.releases(projectId, applicationId, branchId),
    queryFn: () =>
      client.platformApiListApplicationReleases({
        params: { projectId, applicationId },
        query: { branchId },
      }),
  }
}

export function useApplicationReleases(
  projectId: string,
  targets: readonly { applicationId: string; branchId: string }[]
) {
  return useQueries({
    queries: targets.map((target) => releasesQuery(projectId, target.applicationId, target.branchId)),
  })
}

export interface ComponentScope {
  projectId: string
  applicationId: string
  branchId: string
  componentId: string
}

export function useReleaseState(scope: ComponentScope | undefined) {
  return useQuery({
    queryKey: scope
      ? keys.releaseState(scope.projectId, scope.applicationId, scope.branchId, scope.componentId)
      : ['release-state', 'none'],
    // The contract types this output as ZodTypeAny; validate at the boundary.
    queryFn: scope
      ? async () =>
          ComponentReleaseState.parse(
            await client.platformApiGetApplicationBranchComponentReleaseState({ params: scope })
          )
      : skipToken,
  })
}

export function useEnvVars(scope: ComponentScope | undefined) {
  return useQuery({
    queryKey: scope
      ? keys.envVars(scope.projectId, scope.applicationId, scope.branchId, scope.componentId)
      : ['env-vars', 'none'],
    queryFn: scope
      ? () => client.platformApiGetApplicationBranchComponentConfig({ params: scope })
      : skipToken,
  })
}

export function isLogsForbidden(error: unknown): boolean {
  return error instanceof ORPCError && error.status === 403
}

/** Count cached failed reads, not transport retries or the lifetime of a mounted tab. */
export function logsPollInterval(state: { error: unknown; errorUpdateCount: number }): number | false {
  return isLogsForbidden(state.error) || (state.error !== null && state.errorUpdateCount >= 3) ? false : POLL_INTERVAL_MS
}

export interface ComponentLogsQuery {
  data?: {
    lines: ReadonlyArray<{ timestamp?: string; text: string }>
    pods: ReadonlyArray<{ name: string }>
    message?: string
  }
  error: unknown
  isError: boolean
  isPending: boolean
  isFetching: boolean
  dataUpdatedAt: number
  pollingStopped: boolean
  refetch: () => Promise<unknown>
}

export function componentLogsQuery(
  projectId: string,
  componentId: string | undefined,
  branchId: string | undefined,
  api: Pick<PlatformApiClient, 'platformApiGetComponentLogs'> = client,
) {
  return queryOptions({
    queryKey: componentId ? keys.logs(projectId, componentId, branchId) : ['logs', 'none'],
    queryFn: componentId
      ? () => api.platformApiGetComponentLogs({
          params: { projectId, id: componentId },
          query: { branchId, tailLines: 100 },
        })
      : skipToken,
    retry: false,
    refetchInterval: (query) => logsPollInterval(query.state),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retryOnMount: false,
    refetchOnMount: false,
  })
}

export function useComponentLogs(projectId: string, componentId: string | undefined, branchId: string | undefined, enabled = true) {
  const cache = useQueryClient()
  const options = componentLogsQuery(projectId, componentId, branchId)
  const query = useQuery({ ...options, enabled })
  return { ...query, pollingStopped: logsPollInterval({ error: query.error, errorUpdateCount: cache.getQueryState(options.queryKey)?.errorUpdateCount ?? 0 }) === false }
}

/** Ready-or-not GitHub source connections, registry connections and project domains the create paths need. */
export interface CreateConnections {
  sources: GitHubSourceConnection[]
  registries: RegistryConnection[]
  domains: Domain[]
  /** Where new repositories go; undefined when the answer carries no valid resolution. */
  destination: RepositoryDestinationResolution | undefined
}

export const CREATE_CONNECTIONS_POLL_MS = 10_000

/**
 * The project's GitHub source connections and the platform's resolved
 * repository destination (contract output is ZodTypeAny, so both are validated
 * at the boundary; a missing resolution leaves adoption and image creation
 * usable), the reusable registry connections (the Platform API has no
 * project-scoped registry-connections route) and the project's domain
 * inventory (the publish base for the app URL).
 */
export function createConnectionsQuery(
  projectId: string,
  api: Pick<
    PlatformApiClient,
    'platformApiListProjectGitHubSourceConnections' | 'platformApiListRegistryConnections' | 'platformApiListDomains'
  > = client
) {
  return {
    queryKey: keys.createConnections(projectId),
    queryFn: async (): Promise<CreateConnections> => {
      const [sources, registries, domains] = await Promise.all([
        api.platformApiListProjectGitHubSourceConnections({ projectId }),
        api.platformApiListRegistryConnections(),
        api.platformApiListDomains({ projectId }),
      ])
      // Only the items matter here; the pagination envelope is not validated.
      const parsed = GitHubSourceConnectionListResponse.pick({ data: true }).parse(sources)
      const resolution = ProjectGitHubSourceConnectionListResponse.pick({ repositoryDestination: true }).safeParse(sources)
      return { sources: parsed.data, registries: registries.data, domains: domains.data, destination: resolution.success ? resolution.data.repositoryDestination : undefined }
    },
    refetchInterval: (query: { state: { data: CreateConnections | undefined } }) =>
      publishDomainPending(query.state.data?.domains ?? []) ? CREATE_CONNECTIONS_POLL_MS : false,
  }
}

export function useCreateConnections(projectId: string) {
  return useQuery(createConnectionsQuery(projectId))
}

/** The Project's declared default destination and the ETag its PUT must send back as `If-Match`. */
export interface RepositoryDestinationSettingsRead {
  settings: RepositoryDestinationSettings
  etag: string | undefined
}

export function repositoryDestinationSettingsQuery(
  projectId: string,
  api: Pick<PlatformApiClient, 'platformApiGetProjectRepositoryDestinationSettings'> = client
) {
  return queryOptions({
    queryKey: keys.repositoryDestinationSettings(projectId),
    queryFn: async (): Promise<RepositoryDestinationSettingsRead> => {
      let etag: string | undefined
      const settings = await api.platformApiGetProjectRepositoryDestinationSettings({ projectId }, {
        context: { onResponse: (response) => { etag = response.headers.get('ETag') ?? undefined } },
      })
      return { settings, etag }
    },
    refetchInterval: false,
  })
}

export function useSourceRepositories(projectId: string) {
  return useQuery({
    queryKey: keys.sourceRepositories(projectId),
    queryFn: () => client.platformApiListApplicationSourceRepositories({ projectId }),
  })
}

export function useCreateCatalog(projectId: string) {
  const [templates, definitions] = useQueries({
    queries: [
      {
        queryKey: ['application-templates', projectId],
        queryFn: () => client.platformApiListApplicationTemplates({ projectId }),
        refetchInterval: false as const,
      },
      {
        queryKey: ['application-stack-definitions'],
        queryFn: () => client.platformApiListApplicationStackDefinitions(),
        refetchInterval: false as const,
      },
    ],
  })
  return { templates, definitions }
}

/**
 * `codexAvailable` and its policy reason control whether the AI entry is enabled
 * or shown disabled with an explanation. A rollout gap stays pending through
 * transient retries instead of reading as "AI unavailable".
 */
export function creationToolsQuery(
  projectId: string,
  api: Pick<PlatformApiClient, 'platformApiGetApplicationDraftCreationTools'> = client
) {
  return queryOptions({
    queryKey: keys.creationTools(projectId),
    queryFn: () => api.platformApiGetApplicationDraftCreationTools({ projectId }),
    refetchInterval: false,
  })
}

export function useCreationTools(projectId: string) {
  return useQuery(creationToolsQuery(projectId))
}

/**
 * Repositories the GitHub source connection can see, filtered server-side by
 * `q` (substring); the previous answer stays while the next term loads.
 */
export function githubRepositoriesQuery(
  projectId: string,
  connectionId: string | undefined,
  q: string,
  api: Pick<PlatformApiClient, 'platformApiListGitHubSourceConnectionRepositories'> = client
) {
  const term = q.trim()
  return queryOptions({
    queryKey: keys.githubRepositories(projectId, connectionId ?? '', term),
    queryFn: connectionId
      ? () => api.platformApiListGitHubSourceConnectionRepositories({ projectId, id: connectionId, ...(term ? { q: term } : {}) })
      : skipToken,
    refetchInterval: false,
    placeholderData: keepPreviousData,
  })
}

export function useGitHubRepositories(projectId: string, connectionId: string | undefined, q: string) {
  return useQuery(githubRepositoriesQuery(projectId, connectionId, q))
}

// ---------- app data (データ tab) ----------

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
