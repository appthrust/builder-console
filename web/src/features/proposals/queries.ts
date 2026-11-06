import type { SourceChangeProposal, SourceChangeProposalDecisionRequest, SourceChangeProposalListQuery } from '@appthrust/api-schema/platform-api'
import { queryOptions, skipToken, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { buildKeys } from '../../api/build-queries'
import { client } from '../../api/client'
import { consoleApi } from '../../api/console'
import { POLL_INTERVAL_MS, readRetryDelay, retryReadQuery } from '../../api/queries'
import { devWorkspaceProxyUrl, getWorkspace } from '../../api/workspace'
import { proposalTerminal } from './model'

export const proposalKeys = {
  all: ['proposals'] as const,
  list: (projectId: string, filters: SourceChangeProposalListQuery) => ['proposals', projectId, 'list', filters] as const,
  detail: (projectId: string, id?: string) => ['proposals', projectId, id] as const,
}

export const proposalsOptions = (projectId: string, filters: SourceChangeProposalListQuery = {}) => queryOptions({
  queryKey: proposalKeys.list(projectId, filters),
  queryFn: () => client.platformApiListSourceChangeProposals({ params: { projectId }, query: filters }),
  retry: retryReadQuery, retryDelay: readRetryDelay, refetchInterval: POLL_INTERVAL_MS,
})

export const proposalOptions = (projectId: string, id?: string) => queryOptions({
  queryKey: proposalKeys.detail(projectId, id),
  queryFn: id ? () => client.platformApiGetSourceChangeProposal({ params: { projectId, id } }) : skipToken,
  retry: retryReadQuery, retryDelay: readRetryDelay,
  refetchInterval: (query) => query.state.data && !proposalTerminal(query.state.data.phase) ? POLL_INTERVAL_MS : false,
})

export const proposalDiffOptions = (proposal: SourceChangeProposal) => queryOptions({
  queryKey: [...proposalKeys.detail(proposal.projectId, proposal.id), 'diff', proposal.headRevision],
  queryFn: () => client.platformApiGetSourceChangeProposalDiff({ params: { projectId: proposal.projectId, id: proposal.id } }),
  refetchInterval: false,
})

export const proposalPreviewOptions = (projectId: string, workspaceId?: string) => queryOptions({
  queryKey: ['proposal-preview', projectId, workspaceId],
  queryFn: workspaceId ? async ({ signal }) => {
    const workspace = await getWorkspace(projectId, workspaceId, signal)
    return workspace.previewUrl ? devWorkspaceProxyUrl(workspace.previewUrl) : null
  } : skipToken,
  refetchInterval: (query) => query.state.data ? false : POLL_INTERVAL_MS,
})

export function useProposalPeople(subjects: string[]) {
  const queries = useQueries({ queries: [...new Set(subjects)].map((subject) => queryOptions({
    queryKey: ['console', 'directory', 'subject', subject],
    queryFn: () => consoleApi.directory.personBySubject(subject),
    staleTime: 60_000, refetchInterval: false,
  })) })
  return queries.flatMap((query) => query.data ? [query.data] : [])
}

export function useProposalDecision(proposal: SourceChangeProposal) {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (body: SourceChangeProposalDecisionRequest) => client.platformApiDecideSourceChangeProposal({ params: { projectId: proposal.projectId, id: proposal.id }, body }),
    onSuccess: async (result) => {
      await cache.cancelQueries({ queryKey: proposalKeys.detail(proposal.projectId, proposal.id), exact: true })
      cache.setQueryData(proposalOptions(proposal.projectId, proposal.id).queryKey, result.resource)
      void cache.invalidateQueries({ queryKey: proposalKeys.all })
      void cache.invalidateQueries({ queryKey: buildKeys.drafts(proposal.projectId) })
    },
  })
}
