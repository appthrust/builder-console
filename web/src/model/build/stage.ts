import type {
  ApplicationDraft, ApplicationDraftConversationTurn, ApplicationDraftCreationExecution, ApplicationDraftCreationPlanGeneration,
} from '@appthrust/api-schema/platform-api'
import { buildCopy } from './copy'
import { isBuildPending, progressCard } from './progress'
import { prepareAnswers } from './questions'
import type { BuildPhase, BuildPrimary, BuildStage, ProgressCard } from './types'

/** Publication belongs to the draft; a later implementation invalidates that published version. */
export function draftPublished(draft: Pick<ApplicationDraft, 'publishedAt' | 'implementationRuns'>): boolean {
  if (!draft.publishedAt) return false
  const publishedAt = Date.parse(draft.publishedAt)
  return !draft.implementationRuns?.some((run) => Date.parse(run.startedAt) > publishedAt)
}

/**
 * updatedAt also changes during polling jobs; only spec/intent evidence invalidates a plan.
 * Once an execution exists the plan is in use: turns started from then on (and the 用意する
 * exchange, which survives cleanup) do not invalidate it.
 */
export function needsPlanRefresh(draft: ApplicationDraft | undefined, lastPlannedIntent?: string): boolean {
  if (!draft?.creationPlan || draft.phase === 'specifying') return true
  if (lastPlannedIntent !== undefined && draft.intent !== lastPlannedIntent) return true
  let generation: ApplicationDraftCreationPlanGeneration | undefined
  for (const item of draft.creationPlanGenerations ?? []) {
    if (item.status === 'succeeded') generation = item
  }
  if (!generation) return true
  const plannedAt = Date.parse(generation.startedAt)
  const executedAt = Math.min(...(draft.creationExecutions ?? []).map((execution) => Date.parse(execution.startedAt)))
  const { turnIds } = prepareAnswers(draft.conversationTurns)
  return (draft.conversationTurns ?? []).some((turn) => turn.status === 'succeeded' && turn.specMarkdown !== undefined && Date.parse(turn.finishedAt ?? turn.startedAt) > plannedAt
    && Date.parse(turn.startedAt) < executedAt && !turnIds.includes(turn.id))
}

export function deriveStage(input: {
  draft?: ApplicationDraft
  generation?: ApplicationDraftCreationPlanGeneration
  turn?: ApplicationDraftConversationTurn
  execution?: ApplicationDraftCreationExecution
  lastPlannedIntent?: string
  /** `implemented`: at least one task was pushed, so the app is more than the template. */
  implementation?: { phase: string; done: boolean; implemented: boolean; activityTail?: string }
  appProgress?: ProgressCard
  published: boolean
  now: number
}): { stage: BuildStage; build?: { phase: BuildPhase }; primary: BuildPrimary; progress?: ProgressCard } {
  const { draft, implementation, published, now } = input
  const generation = input.generation ?? draft?.creationPlanGenerations?.at(-1)
  const turn = input.turn ?? draft?.conversationTurns?.at(-1)
  const execution = input.execution ?? draft?.creationExecutions?.at(-1)
  const copy = buildCopy.primary
  const none: BuildPrimary = { action: 'none', label: '', enabled: false }
  if (published && !input.appProgress?.buildFailed) return { stage: 'publish', primary: { action: 'continue', label: copy.continue, enabled: true } }
  if (isBuildPending(execution)) return {
    stage: 'build', build: { phase: 'preparing' }, primary: none, progress: input.appProgress?.buildFailed ? input.appProgress : progressCard({ kind: 'prepare', operation: execution, execution, now }),
  }
  if (draft?.phase === 'created' || execution?.status === 'succeeded') {
    const publishing = implementation?.phase === 'publishing'
    const active = implementation && !implementation.done && ['starting-workspace', 'syncing', 'running', 'pushing'].includes(implementation.phase)
    // A checklist that was only skipped is not an app: 公開 waits for something pushed.
    const built = implementation?.done === true && implementation.implemented === true
    const phase: BuildPhase = input.appProgress ? 'preparing' : built ? 'done' : 'implementing'
    return {
      stage: 'build', build: { phase },
      primary: { action: 'publish', label: copy.publish, enabled: !publishing && phase === 'done' },
      ...(active ? { progress: progressCard({ kind: 'implement', now }) } : {}),
      ...(input.appProgress ? { progress: input.appProgress } : {}),
    }
  }
  // There is no turn sub-stage in the API. Only the first turn includes known
  // startup work; later turns must not be presented as a fresh runtime start.
  const firstTurn = turn && !generation && !draft?.creationPlanGenerations?.length
    && !draft?.conversationTurns?.some((item) => item.id !== turn.id)
  const progress = isBuildPending(turn) ? progressCard({ kind: firstTurn ? 'workspace' : 'turn', operation: turn, now })
    : isBuildPending(generation) ? progressCard({ kind: 'plan', operation: generation, now })
      : execution?.status === 'failed' ? progressCard({ kind: 'prepare', operation: execution, execution, now })
        : generation?.status === 'failed' ? progressCard({ kind: 'plan', operation: generation, now }) : undefined
  const hasPlan = draft?.creationPlan || generation?.status === 'succeeded' || draft?.creationPlanGenerations?.some((item) => item.status === 'succeeded')
  if (!hasPlan && execution?.status !== 'failed') return { stage: 'ask', primary: none, ...(progress ? { progress } : {}) }
  // The separately polled generation may reach success before the draft query catches up.
  const planningDraft = draft && generation && !draft.creationPlanGenerations?.some((item) => item.id === generation.id && item.status === generation.status)
    ? { ...draft, creationPlanGenerations: [...(draft.creationPlanGenerations ?? []).filter((item) => item.id !== generation.id), generation] } : draft
  const ready = generation?.status === 'succeeded' && !needsPlanRefresh(planningDraft, input.lastPlannedIntent)
  return {
    stage: 'decide',
    primary: { action: ready ? 'prepare' : 'prepare-after-plan', label: ready ? copy.prepare : copy.afterPlan, enabled: !!draft && !isBuildPending(turn) },
    ...(progress ? { progress } : {}),
  }
}
