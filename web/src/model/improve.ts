// Improvement sessions (design/platform/builder-console-app-improvement.md): an
// ApplicationDraft with `kind: 'improvement'`, bound from birth to an existing
// app. Pure derivations for the session page, the 作りかけ list and the app
// page entry; the server owns turns, runs and task identity.
import type { ApplicationDraft, ApplicationDraftConversationTurn, ApplicationDraftImplementationRun } from '@appthrust/api-schema/platform-api'
import { implementationTodoId } from '../features/build/implement/state'
import { isBuildPending } from './build/progress'
import { isProductLanguage } from './build/wording'

/**
 * - `asking`: talking; no change is waiting to be made;
 * - `proposed`: the AI's latest proposal has tasks the next run would make;
 * - `running`: a run is making them;
 * - `failed`: the latest run stopped and nothing was said since;
 * - `done`: the latest run finished and nothing was said since.
 */
export type ImprovePhase = 'asking' | 'proposed' | 'running' | 'failed' | 'done'
/** 聞く → 直す → 確認. */
export type ImproveStage = 'ask' | 'fix' | 'check'
export const improveStages: readonly ImproveStage[] = ['ask', 'fix', 'check']

export interface ImproveTask { id: string; title: string; detail?: string }

/** One finished run: the version it produced and what it changed. */
export interface ImproveVersion { runId: string; version?: string; tasks: string[]; at: string }

export interface ImproveState {
  phase: ImprovePhase
  stage: ImproveStage
  /** Tasks the next empty run would make (the server's rule: not done/skipped in the latest run). */
  proposal: ImproveTask[]
  /** The assistant turn the proposal is attached to while `proposed`. */
  proposalTurnId?: string
  run?: ApplicationDraftImplementationRun
  /** The version label of the latest finished run, when it reported one. */
  version?: string
  turnActive: boolean
  /** A turn or a run is in flight: nothing new can be sent. */
  busy: boolean
}

export function isImprovementDraft(draft: Pick<ApplicationDraft, 'kind'>): boolean {
  return draft.kind === 'improvement'
}

const time = (value: string | undefined) => (value ? Date.parse(value) : Number.NaN)

export function sortedTurns(draft: Pick<ApplicationDraft, 'conversationTurns'>): ApplicationDraftConversationTurn[] {
  return [...(draft.conversationTurns ?? [])].sort((a, b) => time(a.startedAt) - time(b.startedAt))
}

/** The first sentence of a task description, when it is business language. */
function detailOf(text: string): string | undefined {
  const sentence = text.split(/(?<=[。！？])|(?<=[.!?])(?=\s|$)|\n/)[0]?.trim() ?? ''
  return sentence && isProductLanguage(sentence) ? sentence : undefined
}

/** Handoff tasks the next run would make. Task identity follows `implementationTodoId`, like the server. */
export function pendingProposal(draft: Pick<ApplicationDraft, 'creationPlan' | 'implementationRuns'>): ImproveTask[] {
  const finished = new Set((draft.implementationRuns?.at(-1)?.tasks ?? []).filter((task) => task.status === 'done' || task.status === 'skipped').map((task) => task.id))
  return (draft.creationPlan?.implementationHandoff?.tasks ?? []).flatMap((task, index) => {
    const id = implementationTodoId(task.title, index)
    if (finished.has(id)) return []
    const detail = detailOf(task.description)
    return [{ id, title: task.title, ...(detail ? { detail } : {}) }]
  })
}

/** The label of the last task a run pushed, e.g. `v4`. */
export function runVersion(run: Pick<ApplicationDraftImplementationRun, 'tasks' | 'taskIds'> | undefined): string | undefined {
  const label = [...(run?.tasks ?? [])].reverse().find((task) => task.status === 'done' && run!.taskIds.includes(task.id) && task.versionLabel)?.versionLabel
  return label && isProductLanguage(label) ? label : undefined
}

/** Every run that finished, oldest first, with the version it produced. */
export function improveVersions(draft: Pick<ApplicationDraft, 'implementationRuns'>): ImproveVersion[] {
  return (draft.implementationRuns ?? []).filter((run) => run.status === 'succeeded').map((run) => {
    const version = runVersion(run)
    return {
      runId: run.id,
      ...(version ? { version } : {}),
      tasks: run.tasks.filter((task) => run.taskIds.includes(task.id) && task.status === 'done').map((task) => task.title),
      at: run.finishedAt ?? run.startedAt,
    }
  })
}

const STAGE: Record<ImprovePhase, ImproveStage> = { asking: 'ask', proposed: 'fix', running: 'fix', failed: 'fix', done: 'check' }

export function deriveImprove(draft: Pick<ApplicationDraft, 'conversationTurns' | 'creationPlan' | 'implementationRuns'>): ImproveState {
  const run = draft.implementationRuns?.at(-1)
  const turns = sortedTurns(draft)
  const latestTurn = turns.at(-1)
  const turnActive = isBuildPending(latestTurn)
  const runActive = isBuildPending(run)
  const proposal = pendingProposal(draft)
  const runEnded = run ? time(run.finishedAt ?? run.startedAt) : Number.NaN
  // Something was said after the run ended (the same instant counts): the conversation, not the run, is current.
  const talkedSince = run !== undefined && turns.some((turn) => time(turn.startedAt) >= runEnded)
  const lastAnswer = [...turns].reverse().find((turn) => turn.status === 'succeeded')
  const phase: ImprovePhase = runActive ? 'running'
    : run && (run.status === 'failed' || run.status === 'cancelled') && !talkedSince ? 'failed'
      : proposal.length && !turnActive && lastAnswer ? 'proposed'
        : run?.status === 'succeeded' && !talkedSince ? 'done'
          : 'asking'
  const version = runVersion([...(draft.implementationRuns ?? [])].reverse().find((item) => item.status === 'succeeded'))
  return {
    phase,
    stage: STAGE[phase],
    proposal,
    ...(phase === 'proposed' ? { proposalTurnId: lastAnswer!.id } : {}),
    ...(run ? { run } : {}),
    ...(version ? { version } : {}),
    turnActive,
    busy: turnActive || runActive,
  }
}

/** The newest open improvement session for one app (the console resumes it instead of starting another). */
export function improvementFor(drafts: readonly ApplicationDraft[] | undefined, stackId: string): ApplicationDraft | undefined {
  return (drafts ?? [])
    .filter((draft) => isImprovementDraft(draft) && draft.phase !== 'archived' && draft.createdApplicationStackId === stackId)
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0]
}

export type ImproveTimelineItem =
  | { kind: 'turn'; at: number; turn: ApplicationDraftConversationTurn }
  | { kind: 'run'; at: number; run: ApplicationDraftImplementationRun }

/** Turns and runs in the order they started. */
export function improveTimeline(draft: Pick<ApplicationDraft, 'conversationTurns' | 'implementationRuns'>): ImproveTimelineItem[] {
  return [
    ...sortedTurns(draft).map((turn) => ({ kind: 'turn' as const, at: time(turn.startedAt), turn })),
    ...(draft.implementationRuns ?? []).map((run) => ({ kind: 'run' as const, at: time(run.startedAt), run })),
  ].sort((a, b) => a.at - b.at)
}
