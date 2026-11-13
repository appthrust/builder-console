// Project-wide Platform read models (applications, stacks, publishes,
// summaries), releases, env vars and logs.
import {
  ComponentReleaseState,
  type ComponentSummaryFactsV1,
} from '@appthrust/api-schema/platform-api'
import { queryOptions, skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { ORPCError } from '@orpc/client'
import { client, type PlatformApiClient } from '../client'
import { keys, POLL_INTERVAL_MS } from './shared'

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
