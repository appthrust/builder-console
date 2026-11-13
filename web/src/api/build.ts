import type {
  ApplicationDraftWorkbook, ApplicationDraftWorkbookListResponse, ApplicationDraftWorkbookSummary, CreateApplicationDraftConversationTurnRequest,
  BeginApplicationDraftCreationExecutionRequest, CreateApplicationDraftCreationPlanGenerationRequest,
  CreateApplicationDraftImplementationRunRequest, CreateApplicationDraftRequest, CreatePublishRequest, UpdateApplicationDraftRequest,
} from '@appthrust/api-schema/platform-api'
import type {
  BuildDraft, BuildDraftList, BuildGeneration, BuildTurn, CreationPlanValidation, DraftDeletion, ImplementationRun,
} from '../model/contracts/build'
import { client } from './client'
import {
  addWorkbookContract, beginCreationExecutionContract, cancelImplementationRunContract, cleanupCreationResourcesContract, createApplicationDraftContract,
  createConversationTurnContract, createImplementationRunContract, createPlanGenerationContract, deleteApplicationDraftContract, getApplicationDraftContract,
  listApplicationDraftsContract, removeWorkbookContract, runCreationExecutionContract, updateApplicationDraftContract, validateCreationPlanContract,
} from './contracts/platform/build'
import { apiGateway } from './gateway'

/** What an implementation run may be asked to do (all tasks left, chosen ones, skips, or one change). */
export type ImplementationRunRequest = CreateApplicationDraftImplementationRunRequest

// Every draft answer is decoded at the boundary (contracts/platform/build.ts).
// Ordinary mutations get a fresh key; resumable plan handoffs, workbook adds
// and publish repair explicitly reuse their attempt key.
export function createDraft(projectId: string, payload: CreateApplicationDraftRequest): Promise<BuildDraft> {
  return apiGateway.platform(createApplicationDraftContract, { projectId, ...payload })
}

export function listDrafts(projectId: string): Promise<BuildDraftList> {
  return apiGateway.platform(listApplicationDraftsContract, { projectId })
}

/** The authoritative draft. */
export function getDraft(projectId: string, draftId: string): Promise<BuildDraft> {
  return apiGateway.platform(getApplicationDraftContract, { projectId, id: draftId })
}

/** The draft with its new set, and the summary of the added (or replayed) workbook. */
export interface WorkbookAdded { draft: BuildDraft; workbook: ApplicationDraftWorkbookSummary }

export function addWorkbook(projectId: string, draftId: string, workbook: ApplicationDraftWorkbook, idempotencyKey: string): Promise<WorkbookAdded> {
  return apiGateway.platform(addWorkbookContract, { projectId, id: draftId, ...workbook }, { idempotencyKey })
}

export function listWorkbooks(projectId: string, draftId: string): Promise<ApplicationDraftWorkbookListResponse> {
  return client.platformApiListApplicationDraftWorkbooks({ projectId, id: draftId })
}

export function getWorkbook(projectId: string, draftId: string, workbookId: string): Promise<ApplicationDraftWorkbook> {
  return client.platformApiGetApplicationDraftWorkbook({ projectId, id: draftId, workbookId })
}

export function removeWorkbook(projectId: string, draftId: string, workbookId: string): Promise<BuildDraft> {
  return apiGateway.platform(removeWorkbookContract, { projectId, id: draftId, workbookId })
}

export function updateDraft(projectId: string, draftId: string, payload: Pick<UpdateApplicationDraftRequest, 'specMarkdown' | 'intent' | 'title' | 'publishPreferences' | 'markPublished' | 'creationPlan' | 'renameApplication'>): Promise<BuildDraft> {
  return apiGateway.platform(updateApplicationDraftContract, { projectId, id: draftId, ...payload })
}

/** 202; the API refuses (409) while a job runs or while creation resources remain (cleanupCreation first). */
export function deleteDraft(projectId: string, draftId: string): Promise<DraftDeletion> {
  return apiGateway.platform(deleteApplicationDraftContract, { projectId, id: draftId })
}

export function createTurn(projectId: string, draftId: string, payload: CreateApplicationDraftConversationTurnRequest): Promise<BuildTurn> {
  return apiGateway.platform(createConversationTurnContract, { projectId, id: draftId, ...payload })
}

export function createGeneration(projectId: string, draftId: string, payload: CreateApplicationDraftCreationPlanGenerationRequest = {}, idempotencyKey?: string): Promise<BuildGeneration> {
  return apiGateway.platform(createPlanGenerationContract, { projectId, id: draftId, ...payload }, { idempotencyKey })
}

/** Empty input starts the remaining handoff tasks; the server owns the workspace and execution. */
export function createImplementationRun(projectId: string, draftId: string, payload?: ImplementationRunRequest): Promise<ImplementationRun> {
  return apiGateway.platform(createImplementationRunContract, { projectId, id: draftId, ...payload })
}

export function cancelImplementationRun(projectId: string, draftId: string, runId: string): Promise<ImplementationRun> {
  return apiGateway.platform(cancelImplementationRunContract, { projectId, id: draftId, runId })
}

export function validatePlan(projectId: string, draftId: string): Promise<CreationPlanValidation> {
  return apiGateway.platform(validateCreationPlanContract, { projectId, id: draftId })
}

/** Begin and run return the updated draft, including its authoritative executions. */
export function createExecution(projectId: string, draftId: string, payload: BeginApplicationDraftCreationExecutionRequest): Promise<BuildDraft> {
  return apiGateway.platform(beginCreationExecutionContract, { projectId, id: draftId, ...payload })
}

export function runExecution(projectId: string, draftId: string, executionId: string): Promise<BuildDraft> {
  return apiGateway.platform(runCreationExecutionContract, { projectId, id: draftId, executionId })
}

export function cleanupCreation(projectId: string, draftId: string): Promise<BuildDraft> {
  return apiGateway.platform(cleanupCreationResourcesContract, { projectId, id: draftId })
}

export function creationTools(projectId: string) {
  return client.platformApiGetApplicationDraftCreationTools({ projectId })
}

export function createPublish(projectId: string, body: CreatePublishRequest) {
  return client.platformApiCreateProjectPublish({
    params: { projectId }, body,
  }, { context: { idempotencyKey: body.idempotencyKey } })
}
