import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { queryOptions, skipToken, useQuery } from '@tanstack/react-query'
import { isBuildPending } from '../model/build/progress'
import { creationTools, getDraft, getExecution, getGeneration, getTurn, getWorkbook, listDrafts, listWorkbooks } from './build'
import { readRetryDelay, retryReadQuery } from './queries'

export const BUILD_POLL_MS = 3_000
export const buildKeys = {
  all: ['build'] as const,
  draft: (projectId: string, draftId: string) => ['build', draftId, projectId, 'draft'] as const,
  turn: (projectId: string, draftId: string, turnId?: string) => ['build', draftId, projectId, 'turn', turnId] as const,
  generation: (projectId: string, draftId: string, generationId?: string) => ['build', draftId, projectId, 'generation', generationId] as const,
  execution: (projectId: string, draftId: string, executionId?: string) => ['build', draftId, projectId, 'execution', executionId] as const,
  workbooks: (projectId: string, draftId: string, version: string) => ['build', draftId, projectId, 'workbooks', version] as const,
  workbook: (projectId: string, draftId: string, workbookId: string) => ['build', draftId, projectId, 'workbook', workbookId] as const,
  drafts: (projectId: string) => ['build', 'drafts', projectId] as const,
  tools: (projectId: string) => ['build', 'tools', projectId] as const,
}

function draftPending(draft: ApplicationDraft | undefined): boolean {
  return !!draft && (
    (draft.conversationTurns ?? []).some(isBuildPending) ||
    (draft.creationPlanGenerations ?? []).some(isBuildPending) ||
    (draft.creationExecutions ?? []).some(isBuildPending) ||
    isBuildPending(draft.implementationRuns?.at(-1))
  )
}

export function buildDraftOptions(projectId: string, draftId: string) {
  return queryOptions({
    queryKey: buildKeys.draft(projectId, draftId),
    queryFn: projectId && draftId ? () => getDraft(projectId, draftId) : skipToken,
    retry: retryReadQuery,
    retryDelay: readRetryDelay,
    refetchInterval: (query) => draftPending(query.state.data) ? BUILD_POLL_MS : false,
  })
}

/** Membership and readings change with the set revision and analysis turn. */
export function draftWorkbooksOptions(projectId: string, draftId: string, version: string) {
  return queryOptions({
    queryKey: buildKeys.workbooks(projectId, draftId, version),
    queryFn: projectId && draftId ? () => listWorkbooks(projectId, draftId) : skipToken,
    retry: retryReadQuery,
    retryDelay: readRetryDelay,
  })
}

/** A member's parsed grid is immutable for its lifetime. */
export function draftWorkbookGridOptions(projectId: string, draftId: string, workbookId: string) {
  return queryOptions({
    queryKey: buildKeys.workbook(projectId, draftId, workbookId),
    queryFn: projectId && draftId && workbookId ? () => getWorkbook(projectId, draftId, workbookId) : skipToken,
    retry: retryReadQuery,
    retryDelay: readRetryDelay,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  })
}

export function draftsOptions(projectId: string) {
  return queryOptions({
    queryKey: buildKeys.drafts(projectId),
    queryFn: projectId ? () => listDrafts(projectId) : skipToken,
    retry: retryReadQuery,
    retryDelay: readRetryDelay,
    refetchInterval: (query) => query.state.data?.data.some(draftPending) ? BUILD_POLL_MS : false,
  })
}

export function buildTurnOptions(projectId: string, draftId: string, turnId?: string) {
  return queryOptions({
    queryKey: buildKeys.turn(projectId, draftId, turnId),
    queryFn: projectId && draftId && turnId ? () => getTurn(projectId, draftId, turnId) : skipToken,
    refetchInterval: (query) => isBuildPending(query.state.data) ? BUILD_POLL_MS : false,
  })
}

export function buildGenerationOptions(projectId: string, draftId: string, generationId?: string) {
  return queryOptions({
    queryKey: buildKeys.generation(projectId, draftId, generationId),
    queryFn: projectId && draftId && generationId ? () => getGeneration(projectId, draftId, generationId) : skipToken,
    refetchInterval: (query) => isBuildPending(query.state.data) ? BUILD_POLL_MS : false,
  })
}

export function buildExecutionOptions(projectId: string, draftId: string, executionId?: string) {
  return queryOptions({
    queryKey: buildKeys.execution(projectId, draftId, executionId),
    queryFn: projectId && draftId && executionId ? () => getExecution(projectId, draftId, executionId) : skipToken,
    refetchInterval: (query) => isBuildPending(query.state.data) ? BUILD_POLL_MS : false,
  })
}

export function buildToolsOptions(projectId: string) {
  return queryOptions({
    queryKey: buildKeys.tools(projectId),
    queryFn: projectId ? () => creationTools(projectId) : skipToken,
    refetchInterval: false,
  })
}

export function useBuildDraft(projectId: string, draftId: string, enabled = true) {
  return useQuery({ ...buildDraftOptions(projectId, draftId), enabled })
}

export function useBuildTurn(projectId: string, draftId: string, turnId?: string, enabled = true) {
  return useQuery({ ...buildTurnOptions(projectId, draftId, turnId), enabled })
}

export function useBuildGeneration(projectId: string, draftId: string, generationId?: string, enabled = true) {
  return useQuery({ ...buildGenerationOptions(projectId, draftId, generationId), enabled })
}

export function useBuildExecution(projectId: string, draftId: string, executionId?: string, enabled = true) {
  return useQuery({ ...buildExecutionOptions(projectId, draftId, executionId), enabled })
}
