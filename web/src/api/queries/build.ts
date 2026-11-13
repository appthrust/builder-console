import { isCancelledError, queryOptions, skipToken, useQuery, type QueryClient } from '@tanstack/react-query'
import { jobState, type BuildDraft } from '../../model/contracts/build'
import { getDraft, listDrafts } from '../build'
import { POLL_INTERVAL_MS, readRetryDelay, retryReadQuery } from './shared'

export const BUILD_POLL_MS = 3_000
export const buildKeys = {
  all: ['build'] as const,
  draft: (projectId: string, draftId: string) => ['build', draftId, projectId, 'draft'] as const,
  workspace: (projectId: string, draftId: string, workspaceId: string | undefined) => ['build', draftId, projectId, 'workspace', workspaceId] as const,
  workbooks: (projectId: string, draftId: string, version: string) => ['build', draftId, projectId, 'workbooks', version] as const,
  workbook: (projectId: string, draftId: string, workbookId: string) => ['build', draftId, projectId, 'workbook', workbookId] as const,
  drafts: (projectId: string) => ['build', 'drafts', projectId] as const,
}

/**
 * How often a draft is re-read: every three seconds while one of its jobs
 * runs; at the normal interval while its phase or the state of one of its
 * jobs is a value this client does not know (it can neither call that
 * finished nor running, and must notice when it becomes known); otherwise
 * not at all.
 */
export function draftPollInterval(draft: BuildDraft | undefined): number | false {
  if (!draft) return false
  const states = [...draft.conversationTurns, ...draft.creationPlanGenerations, ...draft.creationExecutions, draft.implementationRuns.at(-1)].map(jobState)
  if (states.includes('active')) return BUILD_POLL_MS
  return draft.phase.kind === 'unknown' || states.includes('unknown') ? POLL_INTERVAL_MS : false
}

export function buildDraftOptions(projectId: string, draftId: string) {
  return queryOptions({
    queryKey: buildKeys.draft(projectId, draftId),
    queryFn: projectId && draftId ? () => getDraft(projectId, draftId) : skipToken,
    retry: retryReadQuery,
    retryDelay: readRetryDelay,
    // This page drives the turn → plan handoff; hiding its tab must not suspend that writer.
    refetchIntervalInBackground: true,
    refetchInterval: (query) => draftPollInterval(query.state.data),
  })
}

/**
 * A read of the draft that a write in flight can still overrule: it runs as the draft query (never a bare
 * GET), so a write's answer cancels it like any poll and it cannot land afterwards with the older draft. A
 * cancelled read resolves with the cached draft, which is then that newer answer.
 */
export async function readDraft(client: QueryClient, projectId: string, draftId: string): Promise<BuildDraft> {
  const options = buildDraftOptions(projectId, draftId)
  try {
    return await client.fetchQuery({ ...options, staleTime: 0 })
  } catch (error) {
    const cached = isCancelledError(error) ? client.getQueryData<BuildDraft>(options.queryKey) : undefined
    if (cached) return cached
    throw error
  }
}

export function draftsOptions(projectId: string) {
  return queryOptions({
    queryKey: buildKeys.drafts(projectId),
    queryFn: projectId ? () => listDrafts(projectId) : skipToken,
    retry: retryReadQuery,
    retryDelay: readRetryDelay,
    refetchInterval: (query) => {
      const intervals = (query.state.data?.data ?? []).map(draftPollInterval).filter((interval) => interval !== false)
      return intervals.length ? Math.min(...intervals) : false
    },
  })
}

export function useBuildDraft(projectId: string, draftId: string, enabled = true) {
  return useQuery({ ...buildDraftOptions(projectId, draftId), enabled })
}
