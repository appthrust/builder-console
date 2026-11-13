// Source change proposals: list, detail, diff, preview, reviewer names and the
// decision mutation. Every answer is decoded at the boundary
// (contracts/platform/proposal.ts; reviewer names through the Console people
// contract).
import { queryOptions, skipToken, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import type { Person } from '../../model/contracts/console'
import type { Proposal, ProposalDecisionCommand, ProposalListFilters, ProposalRevision } from '../../model/contracts/proposal'
import { peopleContract } from '../contracts/console/operations'
import {
  decideSourceChangeProposalContract,
  getSourceChangeProposalContract,
  getSourceChangeProposalDiffContract,
  listSourceChangeProposalsContract,
} from '../contracts/platform/proposal'
import { apiGateway } from '../gateway'
import { buildKeys } from './build'
import { POLL_INTERVAL_MS, readRetryDelay, retryReadQuery } from './shared'
import { devWorkspaceProxyUrl, getWorkspace } from '../workspace'
// Pure phase rule owned by the proposals feature.
import { proposalTerminal } from '../../features/proposals/model'

export const proposalKeys = {
  all: ['proposals'] as const,
  list: (projectId: string, filters: ProposalListFilters) => ['proposals', projectId, 'list', filters] as const,
  detail: (projectId: string, id?: string) => ['proposals', projectId, id] as const,
}

export const proposalsOptions = (projectId: string, filters: ProposalListFilters = {}) => queryOptions({
  queryKey: proposalKeys.list(projectId, filters),
  queryFn: ({ signal }) => apiGateway.platform(listSourceChangeProposalsContract, { params: { projectId }, query: filters }, { signal }),
  retry: retryReadQuery, retryDelay: readRetryDelay, refetchInterval: POLL_INTERVAL_MS,
})

/**
 * One proposal, re-read until it is closed. A phase this console does not know
 * is not closed: it keeps the normal interval, so the screen notices when it
 * becomes known.
 */
export const proposalOptions = (projectId: string, id?: string) => queryOptions({
  queryKey: proposalKeys.detail(projectId, id),
  queryFn: id ? ({ signal }) => apiGateway.platform(getSourceChangeProposalContract, { params: { projectId, id } }, { signal }) : skipToken,
  retry: retryReadQuery, retryDelay: readRetryDelay,
  refetchInterval: (query) => query.state.data && !proposalTerminal(query.state.data.phase) ? POLL_INTERVAL_MS : false,
})

/** The diff changes only with the head revision; a revision kind this console does not know is keyed as such. */
const revisionKey = (revision: ProposalRevision | undefined) => revision?.kind === 'supported' ? revision.value.gitCommit.sha : revision?.kind ?? 'none'

export const proposalDiffOptions = (proposal: Proposal) => queryOptions({
  queryKey: [...proposalKeys.detail(proposal.projectId, proposal.id), 'diff', revisionKey(proposal.headRevision)],
  queryFn: ({ signal }) => apiGateway.platform(getSourceChangeProposalDiffContract, { params: { projectId: proposal.projectId, id: proposal.id } }, { signal }),
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

/**
 * The Directory person behind each principal subject that the Directory knows
 * (exact subject lookup). A subject it does not know, or whose lookup failed,
 * has no person here: the screen names it 「不明な利用者」 and never treats it
 * as anyone else.
 */
export function useProposalPeople(subjects: readonly string[]): Person[] {
  const queries = useQueries({ queries: [...new Set(subjects)].map((subject) => queryOptions({
    queryKey: ['console', 'directory', 'subject', subject],
    queryFn: async (): Promise<Person | null> =>
      (await apiGateway.console(peopleContract, { subject })).find((person) => person.subject === subject) ?? null,
    staleTime: 60_000, refetchInterval: false,
  })) })
  return queries.flatMap((query) => query.data ? [query.data] : [])
}

/**
 * A reviewer's decision. A decision answered 2xx unreadably is not cached and
 * not resent (no retry): `readBack` re-reads the proposal, the only way out of
 * that state.
 */
export function useProposalDecision(proposal: Proposal) {
  const cache = useQueryClient()
  const detail = proposalKeys.detail(proposal.projectId, proposal.id)
  const refreshRelated = () => {
    void cache.invalidateQueries({ queryKey: proposalKeys.all })
    void cache.invalidateQueries({ queryKey: buildKeys.drafts(proposal.projectId) })
  }
  const mutation = useMutation({
    mutationFn: (body: ProposalDecisionCommand) =>
      apiGateway.platform(decideSourceChangeProposalContract, { params: { projectId: proposal.projectId, id: proposal.id }, body }),
    onSuccess: async (result) => {
      // A poll that started before the decision must not overwrite the decided proposal.
      await cache.cancelQueries({ queryKey: detail, exact: true })
      cache.setQueryData(proposalOptions(proposal.projectId, proposal.id).queryKey, result)
      refreshRelated()
    },
  })
  return {
    ...mutation,
    /** Re-reads the proposal (an earlier poll in flight is cancelled); rejects when the read fails. */
    readBack: async () => {
      await cache.refetchQueries({ queryKey: detail, exact: true }, { throwOnError: true })
      refreshRelated()
    },
  }
}
