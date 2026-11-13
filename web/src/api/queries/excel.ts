// Excel → app workbook reads: the set's members with their readings, and one
// member's stored grid. Both answers are decoded at the boundary
// (contracts/platform/excel.ts); the keys sit under the draft's build keys.
import { queryOptions, skipToken } from '@tanstack/react-query'
import type { StoredWorkbook, WorkbookList } from '../../model/contracts/excel'
import { getWorkbookContract, listWorkbooksContract } from '../contracts/platform/excel'
import { apiGateway } from '../gateway'
import { buildKeys } from './build'
import { readRetryDelay, retryReadQuery } from './shared'

export function listWorkbooks(projectId: string, draftId: string): Promise<WorkbookList> {
  return apiGateway.platform(listWorkbooksContract, { projectId, id: draftId })
}

export function getWorkbook(projectId: string, draftId: string, workbookId: string): Promise<StoredWorkbook> {
  return apiGateway.platform(getWorkbookContract, { projectId, id: draftId, workbookId })
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
