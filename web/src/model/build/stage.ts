import { isOneOf, jobState, knownValue, type BuildDraft, type BuildExecution, type BuildGeneration, type BuildTurn } from '../contracts/build'
import { buildCopy } from './copy'
import { isBuildPending, progressCard } from './progress'
import { conversationTurns, isKickoffReply, prepareAnswers } from './questions'
import type { BuildPhase, BuildPrimary, BuildStage, ProgressCard } from './types'

/** Publication belongs to the draft; a later implementation invalidates that published version. */
export function draftPublished(draft: Pick<BuildDraft, 'publishedAt' | 'implementationRuns'>): boolean {
  if (!draft.publishedAt) return false
  const publishedAt = Date.parse(draft.publishedAt)
  return !draft.implementationRuns.some((run) => Date.parse(run.startedAt) > publishedAt)
}

/**
 * updatedAt also changes during polling jobs; only spec/intent evidence invalidates a plan.
 * Once an execution exists the plan is in use: turns started from then on (and the 用意する
 * exchange, which survives cleanup) do not invalidate it.
 */
export function needsPlanRefresh(draft: BuildDraft | undefined, lastPlannedIntent?: string): boolean {
  if (!draft?.creationPlan || knownValue(draft.phase) === 'specifying') return true
  if (lastPlannedIntent !== undefined && draft.intent !== lastPlannedIntent) return true
  let generation: BuildGeneration | undefined
  for (const item of draft.creationPlanGenerations) {
    if (isOneOf(item.status, 'succeeded')) generation = item
  }
  if (!generation) return true
  const plannedAt = Date.parse(generation.startedAt)
  const executedAt = Math.min(...draft.creationExecutions.map((execution) => Date.parse(execution.startedAt)))
  const { turnIds } = prepareAnswers(draft.conversationTurns)
  return draft.conversationTurns.some((turn) => isOneOf(turn.status, 'succeeded') && turn.specMarkdown !== undefined && Date.parse(turn.finishedAt ?? turn.startedAt) > plannedAt
    && Date.parse(turn.startedAt) < executedAt && !turnIds.includes(turn.id))
}

/** The server's accepted kickoff survives missing session storage and OIDC round trips. An unknown phase never starts planning. */
export function hasUnplannedKickoff(draft: BuildDraft): boolean {
  return !draft.creationPlan && !draft.creationPlanGenerations.length && !draft.creationExecutions.length
    && !draft.createdApplicationStackId && draft.phase.kind === 'known' && draft.phase.value !== 'created'
    && conversationTurns(draft.conversationTurns).some((turn) => isOneOf(turn.status, 'succeeded') && isKickoffReply(turn.userMessage))
}

export interface StageInput {
  draft?: BuildDraft
  generation?: BuildGeneration
  turn?: BuildTurn
  execution?: BuildExecution
  lastPlannedIntent?: string
  /** `implemented`: at least one task was pushed, so the app is more than the template. */
  implementation?: { phase: string; done: boolean; implemented: boolean; activityTail?: string }
  appProgress?: ProgressCard
  published: boolean
  now: number
}

/** `unsupported`: the draft's phase or its latest job's state is unknown to this console; no stage action is offered. */
export interface StageResult { stage: BuildStage; build?: { phase: BuildPhase }; primary: BuildPrimary; progress?: ProgressCard; unsupported?: true }

export function deriveStage(input: StageInput): StageResult {
  const { draft } = input
  const generation = input.generation ?? draft?.creationPlanGenerations.at(-1)
  const turn = input.turn ?? draft?.conversationTurns.at(-1)
  const execution = input.execution ?? draft?.creationExecutions.at(-1)
  const result = knownStage({ ...input, generation, turn, execution })
  // The draft's phase or the state of its latest job is a value this console does not know:
  // keep showing what is known, but nothing that depends on that state can be started.
  const unsupported = draft?.phase.kind === 'unknown' || [generation, turn, execution].some((job) => jobState(job) === 'unknown')
  return unsupported ? { ...result, primary: { action: 'none', label: '', enabled: false }, unsupported: true } : result
}

function knownStage(input: StageInput): StageResult {
  const { draft, generation, turn, execution, implementation, published, now } = input
  const copy = buildCopy.primary
  const none: BuildPrimary = { action: 'none', label: '', enabled: false }
  if (published && !input.appProgress?.buildFailed) return { stage: 'publish', primary: { action: 'continue', label: copy.continue, enabled: true } }
  if (isBuildPending(execution)) return {
    stage: 'build', build: { phase: 'preparing' }, primary: none, progress: input.appProgress?.buildFailed ? input.appProgress : progressCard({ kind: 'prepare', operation: execution, execution, now }),
  }
  if (isOneOf(draft?.phase, 'created') || isOneOf(execution?.status, 'succeeded')) {
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
  const firstTurn = turn && !generation && !draft?.creationPlanGenerations.length
    && !draft?.conversationTurns.some((item) => item.id !== turn.id)
  const progress = isBuildPending(turn) ? progressCard({ kind: firstTurn ? 'workspace' : 'turn', operation: turn, now })
    : isBuildPending(generation) ? progressCard({ kind: 'plan', operation: generation, now })
      : isOneOf(execution?.status, 'failed') ? progressCard({ kind: 'prepare', operation: execution, execution, now })
        : isOneOf(generation?.status, 'failed') ? progressCard({ kind: 'plan', operation: generation, now }) : undefined
  const hasPlan = draft?.creationPlan || isOneOf(generation?.status, 'succeeded') || draft?.creationPlanGenerations.some((item) => isOneOf(item.status, 'succeeded'))
  if (!hasPlan && !isOneOf(execution?.status, 'failed')) {
    const canPlan = !generation && isOneOf(turn?.status, 'succeeded')
    return {
      stage: 'ask',
      primary: canPlan ? { action: 'plan', label: buildCopy.questions.kickoffReply, enabled: true } : none,
      ...(progress ? { progress } : {}),
    }
  }
  // The separately polled generation may reach success before the draft query catches up.
  const planningDraft = draft && generation && !draft.creationPlanGenerations.some((item) => item.id === generation.id && knownValue(item.status) === knownValue(generation.status))
    ? { ...draft, creationPlanGenerations: [...draft.creationPlanGenerations.filter((item) => item.id !== generation.id), generation] } : draft
  const ready = isOneOf(generation?.status, 'succeeded') && !needsPlanRefresh(planningDraft, input.lastPlannedIntent)
  return {
    stage: 'decide',
    primary: { action: ready ? 'prepare' : 'prepare-after-plan', label: ready ? copy.prepare : copy.afterPlan, enabled: !!draft && !isBuildPending(turn) },
    ...(progress ? { progress } : {}),
  }
}
