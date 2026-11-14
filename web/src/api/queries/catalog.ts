// What the create paths read: connections, repositories, templates, stack
// definitions and creation tools. Every answer is decoded at the boundary
// (contracts/platform/catalog.ts); a failed read is the query's error, never
// an empty list.
import { keepPreviousData, queryOptions, skipToken, useQueries, useQuery } from '@tanstack/react-query'
import type { CreateConnections, SourceRepositoryRequest } from '../../model/contracts/catalog'
import { publishDomainPending } from '../../model/create'
import {
  creationToolsContract,
  getRepositoryDestinationContract,
  listDomainsContract,
  listGitHubRepositoriesContract,
  listRegistryConnectionsContract,
  listSourceConnectionsContract,
  listSourceRepositoriesContract,
  listStackDefinitionsContract,
  listTemplatesContract,
  validateSourceRepositoryContract,
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
 * Where Platform creates a new repository (ひな形, AI). Not polled and not
 * re-read on focus: the destination shown is the one a create binds, and it is
 * re-read only when Platform says it changed (the wizard shows the new one
 * before anything is sent again). A failed read is the query's error, never
 * "not configured".
 */
export function repositoryDestinationQuery(projectId: string) {
  return queryOptions({
    queryKey: keys.repositoryDestination(projectId),
    queryFn: () => apiGateway.platform(getRepositoryDestinationContract, { projectId }),
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })
}

export function useRepositoryDestination(projectId: string, enabled = true) {
  return useQuery({ ...repositoryDestinationQuery(projectId), enabled })
}

/**
 * 作ったコードから: Platform's validation of the adoption request, read for the
 * image path Platform derives for it (the console never computes one). The
 * create validates again; this answer only informs the confirmation.
 */
export function adoptionValidationQuery(projectId: string, request: SourceRepositoryRequest | undefined) {
  const existing = request?.existing
  return queryOptions({
    queryKey: keys.adoptionValidation(projectId, request?.sourceConnectionId ?? '', existing?.repository ?? '', existing?.ref ?? ''),
    queryFn: request && existing ? () => apiGateway.platform(validateSourceRepositoryContract, { projectId, ...request }) : skipToken,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })
}

export function useAdoptionValidation(projectId: string, request: SourceRepositoryRequest | undefined) {
  return useQuery(adoptionValidationQuery(projectId, request))
}

/**
 * The project's source repositories for the app pages and the build session,
 * decoded at the boundary: a build or readiness state this console does not
 * know is an unknown value, never "failed" or "ready".
 */
export function useSourceRepositories(projectId: string) {
  return useQuery({
    queryKey: keys.sourceRepositories(projectId),
    queryFn: () => apiGateway.platform(listSourceRepositoriesContract, { projectId }),
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
