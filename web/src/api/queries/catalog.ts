// What the create paths read: connections, repositories, templates, stack
// definitions and creation tools.
import {
  GitHubSourceConnectionListResponse,
  type Domain,
  type GitHubSourceConnection,
  type RegistryConnection,
} from '@appthrust/api-schema/platform-api'
import { keepPreviousData, queryOptions, skipToken, useQueries, useQuery } from '@tanstack/react-query'
import { client, type PlatformApiClient } from '../client'
import { publishDomainPending } from '../../model/create'
import { keys } from './shared'

/** Ready-or-not GitHub source connections, registry connections and project domains the create paths need. */
export interface CreateConnections {
  sources: GitHubSourceConnection[]
  registries: RegistryConnection[]
  domains: Domain[]
}

export const CREATE_CONNECTIONS_POLL_MS = 10_000

/**
 * The project's GitHub source connections (contract output is ZodTypeAny, so it
 * is validated at the boundary), the reusable registry connections (the
 * Platform API has no project-scoped registry-connections route) and the
 * project's domain inventory (the publish base for the app URL).
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
      return { sources: parsed.data, registries: registries.data, domains: domains.data }
    },
    refetchInterval: (query: { state: { data: CreateConnections | undefined } }) =>
      publishDomainPending(query.state.data?.domains ?? []) ? CREATE_CONNECTIONS_POLL_MS : false,
  }
}

export function useCreateConnections(projectId: string) {
  return useQuery(createConnectionsQuery(projectId))
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
