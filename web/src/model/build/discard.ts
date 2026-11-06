// What 「やめる」 on an AI build session has to do, derived from the draft the
// Platform API returns (handler/application_draft.go `delete`): the API refuses
// while a job runs, and refuses while creation resources remain until
// `creation-cleanups` has removed them.
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { isBuildPending } from './progress'

const CREATE_TOOLS: Record<string, true> = { 'appthrust.applicationSourceRepository.create': true, 'appthrust.applicationStack.create': true }

/** A turn, plan generation or creation execution is still running (DELETE and cleanup answer 409). */
export function isDraftBusy(draft: ApplicationDraft): boolean {
  return draft.phase === 'creating'
    || (draft.conversationTurns ?? []).some(isBuildPending)
    || (draft.creationPlanGenerations ?? []).some(isBuildPending)
    || (draft.creationExecutions ?? []).some(isBuildPending)
}

/**
 * 用意する left a source repository or an ApplicationStack behind, so deleting
 * the draft also deletes them (through cleanup). The API skips steps it has
 * already cleaned up, so a stale `true` costs one no-op cleanup, never data.
 */
export function hasCreationResources(draft: ApplicationDraft): boolean {
  if (draft.createdApplicationStackId || draft.createdApplicationId) return true
  return (draft.creationExecutions ?? []).some((execution) => execution.steps.some((step) => step.status === 'done' && Object.hasOwn(CREATE_TOOLS, step.tool)))
}
