// Query defaults shared by every read model (React Query): poll interval,
// retry policies, the app QueryClient and the platform query keys. Every
// query is a `queryOptions()` factory so route loaders (`ensureQueryData`) and
// components (`useQuery` / `useSuspenseQuery`) share one key and fetcher; the
// factories live in the sibling files by area.
import { ORPCError } from '@orpc/client'
import { QueryClient } from '@tanstack/react-query'
import { isResponseContractError } from '../boundary'
import { ConsoleApiError } from '../console'
import { isTransientError, platformErrorEnvelope } from '../platform-error'

export const POLL_INTERVAL_MS = 5_000

/** Retries for a call nothing answered (rollout gap, network blip); backed off 1 s, 2 s, 4 s. */
export const TRANSIENT_RETRIES = 3

/** 1 s, 2 s, 4 s … capped at 8 s. */
export const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 8000)

/** Only calls nothing answered are retried; any answer (a code, a 4xx, a coded 5xx) is final. */
export const retryTransient = (failureCount: number, error: unknown) => isTransientError(error) && failureCount < TRANSIENT_RETRIES

/**
 * Default: a call nothing answered gets three backed-off retries, so a Platform
 * API rollout reads as loading instead of a load failure; a 4xx answer is final;
 * anything else keeps the single generic retry. A response that broke its
 * contract is never retried: the next poll tick may read a repaired answer, but
 * re-reading the same one in a burst cannot help.
 */
export const retryQuery = (failureCount: number, error: unknown) =>
  !isResponseContractError(error) && (isTransientError(error)
    ? failureCount < TRANSIENT_RETRIES
    : !((error instanceof ORPCError || error instanceof ConsoleApiError) && error.status >= 400 && error.status < 500) && failureCount < 1)

/**
 * Draft/app reads can fail with a coded 500 during a rollout, not just an
 * unanswered gateway call. Retry these reads five times; 4xx answers and
 * contract failures are final.
 */
export function retryReadQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 5 || isResponseContractError(error)) return false
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
  repositoryDestination: (projectId: string) => ['repository-destination', projectId] as const,
  adoptionValidation: (projectId: string, connectionId: string, repository: string, ref: string) =>
    ['adoption-validation', projectId, connectionId, repository, ref] as const,
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
