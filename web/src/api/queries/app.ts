// Project-wide Platform read models (applications, stacks, publishes,
// summaries), releases, env vars and logs, and the app panels' Platform
// writes. Every answer is decoded at the boundary (contracts/platform/app.ts).
import { ORPCError } from '@orpc/client'
import { queryOptions, skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ComponentConfig, ComponentSummary, DeletionAccepted, RollbackStarted } from '../../model/contracts/app'
import {
  deleteApplicationSourceRepositoryContract,
  deleteApplicationStackContract,
  getComponentConfigContract,
  getComponentLogsContract,
  getReleaseStateContract,
  listApplicationReleasesContract,
  listApplicationsContract,
  listApplicationStacksContract,
  listComponentSummariesContract,
  listProjectPublishesContract,
  rollbackComponentContract,
  updateComponentConfigContract,
} from '../contracts/platform/app'
import { apiGateway, type ApiGateway } from '../gateway'
import { keys, POLL_INTERVAL_MS } from './shared'

async function listAllComponentSummaries(projectId: string, signal?: AbortSignal): Promise<ComponentSummary[]> {
  const items: ComponentSummary[] = []
  let cursor: string | undefined
  do {
    const page = await apiGateway.platform(listComponentSummariesContract, { params: { projectId }, query: { limit: 100, ...(cursor ? { cursor } : {}) } }, { signal })
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return items
}

export const applicationsQuery = (projectId: string) => queryOptions({
  queryKey: keys.applications(projectId),
  queryFn: ({ signal }) => apiGateway.platform(listApplicationsContract, { params: { projectId }, query: { limit: 200 } }, { signal }),
})

export const stacksQuery = (projectId: string) => queryOptions({
  queryKey: keys.stacks(projectId),
  queryFn: ({ signal }) => apiGateway.platform(listApplicationStacksContract, { projectId }, { signal }),
})

export const publishesQuery = (projectId: string) => queryOptions({
  queryKey: keys.publishes(projectId),
  queryFn: ({ signal }) => apiGateway.platform(listProjectPublishesContract, { params: { projectId } }, { signal }),
})

export const summariesQuery = (projectId: string) => queryOptions({
  queryKey: keys.summaries(projectId),
  queryFn: ({ signal }) => listAllComponentSummaries(projectId, signal),
})

/** Project-wide read models that every screen derives ConsoleApp from. */
export function useProjectReadModels(projectId: string) {
  const [applications, stacks, publishes, summaries] = useQueries({
    queries: [applicationsQuery(projectId), stacksQuery(projectId), publishesQuery(projectId), summariesQuery(projectId)],
  })
  return { applications, stacks, publishes, summaries }
}

export function releasesQuery(projectId: string, applicationId: string, branchId: string) {
  return queryOptions({
    queryKey: keys.releases(projectId, applicationId, branchId),
    queryFn: ({ signal }) => apiGateway.platform(listApplicationReleasesContract, { params: { projectId, applicationId }, query: { branchId } }, { signal }),
  })
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

export const releaseStateKey = (scope: ComponentScope | undefined) => scope
  ? keys.releaseState(scope.projectId, scope.applicationId, scope.branchId, scope.componentId)
  : ['release-state', 'none'] as const

export function useReleaseState(scope: ComponentScope | undefined) {
  return useQuery({
    queryKey: releaseStateKey(scope),
    queryFn: scope ? ({ signal }) => apiGateway.platform(getReleaseStateContract, { params: scope }, { signal }) : skipToken,
  })
}

/** 202: the rollback was accepted; the release state shows when it lands. */
export function rollbackComponent(scope: ComponentScope, targetTransitionId: string): Promise<RollbackStarted> {
  return apiGateway.platform(rollbackComponentContract, { params: scope, body: { targetTransitionId } })
}

export const envVarsKey = (scope: ComponentScope | undefined) => scope
  ? keys.envVars(scope.projectId, scope.applicationId, scope.branchId, scope.componentId)
  : ['env-vars', 'none'] as const

export function useEnvVars(scope: ComponentScope | undefined) {
  return useQuery({
    queryKey: envVarsKey(scope),
    queryFn: scope ? ({ signal }) => apiGateway.platform(getComponentConfigContract, { params: scope }, { signal }) : skipToken,
  })
}

/** The PUT body's shape: sensitive values are write-only, so retained secrets go without a value and the server keeps them. */
export type EnvVariable = { key: string; value?: string; sensitive: boolean }

/** Replaces the user-owned variables; answers the written configuration. */
export function updateEnvVars(scope: ComponentScope, variables: EnvVariable[]): Promise<ComponentConfig> {
  return apiGateway.platform(updateComponentConfigContract, { params: scope, body: { variables } })
}

export function deleteApplicationStack(projectId: string, id: string): Promise<DeletionAccepted> {
  return apiGateway.platform(deleteApplicationStackContract, { params: { projectId, id } })
}

export function deleteApplicationSourceRepository(projectId: string, id: string): Promise<DeletionAccepted> {
  return apiGateway.platform(deleteApplicationSourceRepositoryContract, { params: { projectId, id } })
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
  gateway: Pick<ApiGateway, 'platform'> = apiGateway,
) {
  return queryOptions({
    queryKey: componentId ? keys.logs(projectId, componentId, branchId) : ['logs', 'none'],
    queryFn: componentId
      ? ({ signal }) => gateway.platform(getComponentLogsContract, {
          params: { projectId, id: componentId },
          query: { branchId, tailLines: 100 },
        }, { signal })
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
