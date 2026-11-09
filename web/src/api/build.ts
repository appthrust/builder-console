import type {
  ApplicationDraft, ApplicationDraftWorkbook, ApplicationDraftWorkbookAddResponse, ApplicationDraftWorkbookListResponse, CreateApplicationDraftConversationTurnRequest,
  BeginApplicationDraftCreationExecutionRequest, CreateApplicationDraftCreationPlanGenerationRequest,
  CreateApplicationDraftImplementationRunRequest, CreateApplicationDraftRequest, CreatePublishRequest, UpdateApplicationDraftRequest,
} from '@appthrust/api-schema/platform-api'
import { client } from './client'

// Keep the stable mutation envelope intact. Ordinary mutations get a fresh key;
// resumable plan handoffs and publish repair explicitly reuse their attempt key.
export function createDraft(projectId: string, payload: CreateApplicationDraftRequest) {
  return client.platformApiCreateApplicationDraft({ projectId, ...payload })
}

export function listDrafts(projectId: string) {
  return client.platformApiListApplicationDrafts({ projectId })
}

export function getDraft(projectId: string, draftId: string) {
  return client.platformApiGetApplicationDraft({ projectId, id: draftId })
}

export function addWorkbook(projectId: string, draftId: string, workbook: ApplicationDraftWorkbook, idempotencyKey: string): Promise<ApplicationDraftWorkbookAddResponse> {
  return client.platformApiAddApplicationDraftWorkbook({ projectId, id: draftId, ...workbook }, { context: { idempotencyKey } })
}

export function listWorkbooks(projectId: string, draftId: string): Promise<ApplicationDraftWorkbookListResponse> {
  return client.platformApiListApplicationDraftWorkbooks({ projectId, id: draftId })
}

export function getWorkbook(projectId: string, draftId: string, workbookId: string): Promise<ApplicationDraftWorkbook> {
  return client.platformApiGetApplicationDraftWorkbook({ projectId, id: draftId, workbookId })
}

export function removeWorkbook(projectId: string, draftId: string, workbookId: string): Promise<ApplicationDraft> {
  return client.platformApiDeleteApplicationDraftWorkbook({ projectId, id: draftId, workbookId })
}

export function updateDraft(projectId: string, draftId: string, payload: Pick<UpdateApplicationDraftRequest, 'specMarkdown' | 'intent' | 'title' | 'publishPreferences' | 'markPublished' | 'creationPlan' | 'renameApplication'>) {
  return client.platformApiUpdateApplicationDraft({ projectId, id: draftId, ...payload })
}

/** 202; the API refuses (409) while a job runs or while creation resources remain (cleanupCreation first). */
export function deleteDraft(projectId: string, draftId: string) {
  return client.platformApiDeleteApplicationDraft({ projectId, id: draftId })
}

export function createTurn(projectId: string, draftId: string, payload: CreateApplicationDraftConversationTurnRequest) {
  return client.platformApiCreateApplicationDraftConversationTurn({ projectId, id: draftId, ...payload })
}

export function getTurn(projectId: string, draftId: string, turnId: string) {
  return client.platformApiGetApplicationDraftConversationTurn({ projectId, id: draftId, turnId })
}

export function createGeneration(projectId: string, draftId: string, payload: CreateApplicationDraftCreationPlanGenerationRequest = {}, idempotencyKey?: string) {
  return client.platformApiCreateApplicationDraftCreationPlanGeneration({ projectId, id: draftId, ...payload }, { context: { idempotencyKey } })
}

export function getGeneration(projectId: string, draftId: string, generationId: string) {
  return client.platformApiGetApplicationDraftCreationPlanGeneration({ projectId, id: draftId, generationId })
}


/** Empty input starts the remaining handoff tasks; the server owns the workspace and execution. */
export function createImplementationRun(projectId: string, draftId: string, payload?: CreateApplicationDraftImplementationRunRequest) {
  return client.platformApiCreateApplicationDraftImplementationRun({ projectId, id: draftId, ...payload })
}

export function cancelImplementationRun(projectId: string, draftId: string, runId: string) {
  return client.platformApiCancelApplicationDraftImplementationRun({ projectId, id: draftId, runId })
}
export function validatePlan(projectId: string, draftId: string) {
  return client.platformApiValidateApplicationDraftCreationPlan({ projectId, id: draftId })
}

/** Begin and run return the updated draft, including its authoritative executions. */
export function createExecution(projectId: string, draftId: string, payload: BeginApplicationDraftCreationExecutionRequest) {
  return client.platformApiBeginApplicationDraftCreationExecution({ projectId, id: draftId, ...payload })
}

export function runExecution(projectId: string, draftId: string, executionId: string) {
  return client.platformApiRunApplicationDraftCreationExecution({ projectId, id: draftId, executionId })
}

/** The API exposes execution reads through the draft, not a separate GET route. */
export async function getExecution(projectId: string, draftId: string, executionId: string) {
  const draft = await getDraft(projectId, draftId)
  const execution = draft.creationExecutions?.find((item) => item.id === executionId)
  if (!execution) throw new Error(`Creation execution not found: ${executionId}`)
  return execution
}

export function cleanupCreation(projectId: string, draftId: string) {
  return client.platformApiCleanupApplicationDraftCreationResources({ projectId, id: draftId })
}

export function creationTools(projectId: string) {
  return client.platformApiGetApplicationDraftCreationTools({ projectId })
}

export function createPublish(projectId: string, body: CreatePublishRequest) {
  return client.platformApiCreateProjectPublish({
    params: { projectId }, body,
  }, { context: { idempotencyKey: body.idempotencyKey } })
}
