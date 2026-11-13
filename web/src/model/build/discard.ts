// What 「やめる」 on an AI build session has to do, derived from the draft the
// Platform API returns (handler/application_draft.go `delete`): the API refuses
// while a job runs, and refuses while creation resources remain until
// `creation-cleanups` has removed them.
import { isOneOf, jobState, type BuildDraft } from '../contracts/build'

const CREATE_TOOLS: Record<string, true> = { 'appthrust.applicationSourceRepository.create': true, 'appthrust.applicationStack.create': true }

/**
 * A turn, plan generation or creation execution is still running (DELETE and cleanup answer 409).
 * A phase or job state this console does not know counts as busy: deleting is offered only when it is known to be safe.
 */
export function isDraftBusy(draft: BuildDraft): boolean {
  return draft.phase.kind === 'unknown' || draft.phase.value === 'creating'
    || [...draft.conversationTurns, ...draft.creationPlanGenerations, ...draft.creationExecutions].some((job) => jobState(job) !== 'settled')
}

/**
 * 用意する left a source repository or an ApplicationStack behind, so deleting
 * the draft also deletes them (through cleanup). The API skips steps it has
 * already cleaned up, so a stale `true` costs one no-op cleanup, never data;
 * a create step in a state this console does not know may have made one.
 */
export function hasCreationResources(draft: BuildDraft): boolean {
  if (draft.createdApplicationStackId || draft.createdApplicationId) return true
  return draft.creationExecutions.some((execution) => execution.steps.some((step) => Object.hasOwn(CREATE_TOOLS, step.tool) && (step.status.kind === 'unknown' || isOneOf(step.status, 'done'))))
}
