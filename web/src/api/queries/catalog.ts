// What the create paths read: connections, repositories, templates, stack
// definitions and creation tools. Every answer is decoded at the boundary
// (contracts/platform/catalog.ts); a failed read is the query's error, never
// an empty list.
import { keepPreviousData, queryOptions, skipToken, useQueries, useQuery } from '@tanstack/react-query'
import type { CreateConnections } from '../../model/contracts/catalog'
import { publishDomainPending } from '../../model/create'
import { client } from '../client'
import {
  creationToolsContract,
  listDomainsContract,
  listGitHubRepositoriesContract,
  listRegistryConnectionsContract,
  listSourceConnectionsContract,
  listStackDefinitionsContract,
  listTemplatesContract,
} from '../contracts/platform/catalog'
import { apiGateway } from '../gateway'
import { keys } from './shared'

export const CREATE_CONNECTIONS_POLL_MS = 10_000

/**
 * The project's GitHub source connections, the reusable registry connections
 * (the Platform API has no project-scoped registry-connections route) and the
 * project's domain inventory (the publish base for the app URL). All three
 * must be read: one failed answer fails the query (the last good value stays).
 */
export function createConnectionsQuery(projectId: string) {
  return queryOptions({
    queryKey: keys.createConnections(projectId),
    queryFn: async (): Promise<CreateConnections> => {
      const [sources, registries, domains] = await Promise.all([
        apiGateway.platform(listSourceConnectionsContract, { projectId }),
        apiGateway.platform(listRegistryConnectionsContract, undefined),
        apiGateway.platform(listDomainsContract, { projectId }),
      ])
      return { sources: sources.data, registries: registries.data, domains: domains.data }
    },
    refetchInterval: (query) => (publishDomainPending(query.state.data?.domains ?? []) ? CREATE_CONNECTIONS_POLL_MS : false),
  })
}

export function useCreateConnections(projectId: string) {
  return useQuery(createConnectionsQuery(projectId))
}

/**
 * The project's source repositories for the app pages. Still the undecoded
 * list: its readers (features/app, features/build) switch to `SourceRepository`
 * (`createApi.sourceRepositories`, api/create.ts) with the app slice; create's
 * own readback already reads through the contract.
 */
export function useSourceRepositories(projectId: string) {
  return useQuery({
    queryKey: keys.sourceRepositories(projectId),
    queryFn: () => client.platformApiListApplicationSourceRepositories({ projectId }),
  })
}

export const catalogKeys = {
  templates: (projectId: string) => ['application-templates', projectId] as const,
  definitions: ['application-stack-definitions'] as const,
}

export function useCreateCatalog(projectId: string) {
  const [templates, definitions] = useQueries({
    queries: [
      {
        queryKey: catalogKeys.templates(projectId),
        queryFn: () => apiGateway.platform(listTemplatesContract, { projectId }),
        refetchInterval: false as const,
      },
      {
        queryKey: catalogKeys.definitions,
        queryFn: () => apiGateway.platform(listStackDefinitionsContract, undefined),
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
export function creationToolsQuery(projectId: string) {
  return queryOptions({
    queryKey: keys.creationTools(projectId),
    queryFn: () => apiGateway.platform(creationToolsContract, { projectId }),
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
export function githubRepositoriesQuery(projectId: string, connectionId: string | undefined, q: string) {
  const term = q.trim()
  return queryOptions({
    queryKey: keys.githubRepositories(projectId, connectionId ?? '', term),
    queryFn: connectionId
      ? () => apiGateway.platform(listGitHubRepositoriesContract, { projectId, id: connectionId, ...(term ? { q: term } : {}) })
      : skipToken,
    refetchInterval: false,
    placeholderData: keepPreviousData,
  })
}

export function useGitHubRepositories(projectId: string, connectionId: string | undefined, q: string) {
  return useQuery(githubRepositoriesQuery(projectId, connectionId, q))
}
