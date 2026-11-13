// The typed Reply of a console-v1 conversation turn as the screen presents it
// (APT-753 S4-U2, design §6/§7/§13 and the error table). Pure functions over
// server values read through the boundary: nothing is parsed out of reply
// text, nothing is invented when a field is empty, and an unknown state or
// code is reported as unknown so the screen shows the known parts and stops
// only what depends on it.
import type { OpenValue } from '../../api/boundary'
import type { BuildError, BuildReply, BuildSession, BuildTurn } from '../contracts/console'

export type ConversationTurn = Extract<BuildTurn, { kind: 'conversation' }>
export type PlanTurn = Extract<BuildTurn, { kind: 'request_plan' }>

/**
 * Whether app creation may follow: `session.plan` is present once a plan generation succeeded, `stale` when
 * the confirmed revision moved on since (server-computed). Creation is offered only for a current plan; a
 * stale one asks for re-planning first; without a plan there is nothing to create from.
 */
export type PlanReadiness = { kind: 'none' } | { kind: 'current' | 'stale'; specRevision: number }

export function planReadiness(session: Pick<BuildSession, 'plan'>): PlanReadiness {
  return session.plan ? { kind: session.plan.stale ? 'stale' : 'current', specRevision: session.plan.specRevision } : { kind: 'none' }
}

/** A changed specification is a proposal until the user decides (§1): what changes, and the decision once made. */
export interface SpecProposal {
  summary: string
  changes: readonly string[]
  decision?: 'accept_spec' | 'keep_spec'
}

/**
 * The parts of a Reply, each in its own place. `answer` is always present: the user's question is visibly
 * answered (APT-752). `candidates` are concrete options (APT-792); `openDecisions` stay unresolved and never
 * become specification; `suggestedReplies` answer `nextQuestion` only.
 */
export interface ReplyView {
  answer: string
  candidates: BuildReply['candidates']
  openDecisions: BuildReply['openDecisions']
  nextQuestion?: string
  suggestedReplies: BuildReply['suggestedReplies']
  proposal?: SpecProposal
}

export function replyView(turn: ConversationTurn): ReplyView | undefined {
  const reply = turn.reply
  if (!reply) return undefined
  const decision = turn.resolution?.decision
  return {
    answer: reply.answer,
    candidates: reply.candidates,
    openDecisions: reply.openDecisions,
    ...(reply.nextQuestion !== null ? { nextQuestion: reply.nextQuestion } : {}),
    suggestedReplies: reply.suggestedReplies,
    ...(reply.specChanged ? { proposal: { summary: reply.summary, changes: reply.changes, ...(decision ? { decision } : {}) } } : {}),
  }
}

/** Why a turn, a write or a session stopped, grouped by what the user can do about it (design error table). */
export type FailureKind =
  | 'repair_exhausted' | 'timed_out' | 'agent_failed' | 'interaction_required' | 'integrity' | 'artifact_lost'
  | 'too_large' | 'busy' | 'needs_runtime' | 'status_unavailable' | 'unavailable' | 'storage'
  | 'unauthorized' | 'forbidden' | 'policy_pending' | 'policy_denied' | 'draft_conflict' | 'invalid'
  | 'key_conflict' | 'stale' | 'not_found' | 'conflict' | 'unknown'

/**
 * What follows a failure. `resend`: a new turn with the same words (a turn that failed is never resent as
 * itself). `retry`: the same request again (only for a write that may not have arrived). `confirm`: re-read.
 * `wait`: the server continues by itself. `rephrase`: change what is sent. `ask_admin`: nothing here fixes it.
 */
export type FailureNext = 'resend' | 'retry' | 'confirm' | 'wait' | 'rephrase' | 'sign_in' | 'ask_admin'

const KIND_BY_CODE: Record<string, FailureKind> = {
  reply_invalid: 'repair_exhausted',
  agent_timed_out: 'timed_out',
  agent_failed: 'agent_failed',
  agent_interaction_required: 'interaction_required',
  artifact_integrity_failed: 'integrity',
  artifact_lost: 'artifact_lost',
  artifact_path_changed: 'integrity',
  input_too_large: 'too_large',
  payload_too_large: 'too_large',
  session_busy: 'busy',
  workspace_busy: 'busy',
  needs_runtime: 'needs_runtime',
  status_unavailable: 'status_unavailable',
  service_unavailable: 'unavailable',
  artifact_store_unavailable: 'unavailable',
  artifact_uploads_busy: 'unavailable',
  artifact_upload_timeout: 'unavailable',
  artifact_store_unsupported: 'storage',
  insufficient_storage: 'storage',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  draft_spec_conflict: 'draft_conflict',
  invalid_argument: 'invalid',
  precondition_required: 'invalid',
  idempotency_conflict: 'key_conflict',
  version_conflict: 'stale',
  not_found: 'not_found',
  conflict: 'conflict',
}

export const failureNext: Record<FailureKind, FailureNext> = {
  repair_exhausted: 'resend', timed_out: 'resend', agent_failed: 'resend', interaction_required: 'resend',
  integrity: 'resend', artifact_lost: 'resend', too_large: 'rephrase', busy: 'wait', needs_runtime: 'wait',
  status_unavailable: 'confirm', unavailable: 'retry', storage: 'ask_admin', unauthorized: 'sign_in',
  forbidden: 'ask_admin', policy_pending: 'wait', policy_denied: 'ask_admin', draft_conflict: 'ask_admin',
  invalid: 'rephrase', key_conflict: 'confirm', stale: 'confirm', not_found: 'confirm', conflict: 'confirm', unknown: 'confirm',
}

/**
 * The kind of a failure from its code (an open value from a read, or the code of a refused write) and typed
 * details. AI policy refusals keep their reason: a pending approval is not a permanent denial (§error table).
 */
export function failureKind(code: OpenValue<string> | string, details?: Pick<NonNullable<BuildError['details']>, 'reason'>): FailureKind {
  const value = typeof code === 'string' ? code : code.kind === 'known' ? code.value : undefined
  if (value === undefined) return 'unknown'
  if (value === 'failed_precondition') return details?.reason === 'PolicyPending' ? 'policy_pending' : 'policy_denied'
  if (value === 'conflict' && details?.reason === 'AgentTurnActive') return 'busy'
  if (value === 'conflict' && details?.reason === 'WorkspaceNotRunning') return 'needs_runtime'
  return Object.hasOwn(KIND_BY_CODE, value) ? KIND_BY_CODE[value]! : 'unknown'
}

/**
 * Where a conversation turn stands. `working` covers every non-terminal step (`repair` while the one
 * allowed repair is pending or running, §7); `confirming` is a proposal waiting for 反映する／反映しない;
 * `unknown` is a state this console does not know (its reply, if any, is still shown).
 */
export type TurnPhase =
  | { kind: 'working'; repair: boolean }
  | { kind: 'confirming' }
  | { kind: 'answered' }
  | { kind: 'failed'; failure: FailureKind }
  | { kind: 'unknown' }

export function turnPhase(turn: ConversationTurn): TurnPhase {
  if (turn.state.kind === 'unknown') return { kind: 'unknown' }
  switch (turn.state.value) {
    case 'awaiting_confirmation': return turn.reply?.specChanged && !turn.resolution ? { kind: 'confirming' } : { kind: 'unknown' }
    case 'succeeded': return { kind: 'answered' }
    case 'failed': return { kind: 'failed', failure: turn.failure ? failureKind(turn.failure.error, turn.failure.details) : 'unknown' }
    case 'repair_required': return { kind: 'working', repair: true }
    default: {
      const stage = turn.progress?.stage
      return { kind: 'working', repair: turn.attempt === 1 || (stage?.kind === 'known' && (stage.value === 'repair_required' || stage.value === 'repairing')) }
    }
  }
}

/** What the screen says the server is waiting for (§13). An unknown stage is generic work, never an invented one. */
export type WaitingFor =
  | 'accepted' | 'preparing' | 'queued' | 'thinking' | 'validating' | 'repairing' | 'confirming'
  | 'saving_spec' | 'starting_plan' | 'planning' | 'needs_runtime' | 'needs_auth' | 'working'

const WAITING_BY_STAGE: Record<string, WaitingFor> = {
  accepted: 'accepted', dispatching: 'accepted', waking: 'preparing', runtime_starting: 'preparing', queued: 'queued',
  thinking: 'thinking', validating: 'validating', repair_required: 'repairing', repairing: 'repairing',
  awaiting_confirmation: 'confirming', syncing_spec: 'saving_spec', starting_plan: 'starting_plan',
  needs_runtime: 'needs_runtime', needs_auth: 'needs_auth',
}

/**
 * The waiting state of the active turn from its server stage. A conversation turn in repair is `repairing`
 * whatever the step (§7: one honest state). A plan turn past `starting_plan` with no stage is `planning`.
 */
export function waitingFor(turn: BuildTurn): WaitingFor {
  if (turn.kind === 'conversation') {
    const phase = turnPhase(turn)
    if (phase.kind === 'working' && phase.repair) return 'repairing'
  }
  const stage = turn.progress?.stage
  if (stage?.kind === 'known') return WAITING_BY_STAGE[stage.value] ?? 'working'
  if (!stage && turn.kind === 'request_plan' && turn.state.kind === 'known' && turn.state.value === 'planning') return 'planning'
  return 'working'
}

/** The plan request's hand-off (§9): saved, handed to planning, done, or stopped; unknown stays unknown. */
export type PlanPhase =
  | { kind: 'working'; waiting: WaitingFor }
  | { kind: 'handed_off' }
  | { kind: 'planned' }
  | { kind: 'failed'; failure: FailureKind }
  | { kind: 'unknown' }

export function planPhase(turn: PlanTurn): PlanPhase {
  if (turn.projection.state.kind === 'known' && turn.projection.state.value === 'conflict') return { kind: 'failed', failure: 'draft_conflict' }
  if (turn.state.kind === 'unknown') return { kind: 'unknown' }
  switch (turn.state.value) {
    case 'succeeded': return { kind: 'planned' }
    case 'failed': return { kind: 'failed', failure: turn.failure ? failureKind(turn.failure.error, turn.failure.details) : 'unknown' }
    case 'planning': return { kind: 'handed_off' }
    default: return { kind: 'working', waiting: waitingFor(turn) }
  }
}

/** The turn whose reply the user can act on now: the newest turn, if it is a conversation turn that is answered or confirming. */
export function actionableTurnId(turns: readonly BuildTurn[]): string | undefined {
  const last = turns.at(-1)
  if (!last || last.kind !== 'conversation') return undefined
  const phase = turnPhase(last)
  return phase.kind === 'answered' || phase.kind === 'confirming' ? last.id : undefined
}

/** Contract bounds of the publish name (design §12): nonblank, at most 40 Unicode scalars, one line. */
export const PUBLISH_NAME_MAX = 40
export type PublishNameProblem = 'empty' | 'too_long' | 'multiline'

export function publishNameProblem(name: string): PublishNameProblem | undefined {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  if (/[\r\n\u0085\u2028\u2029]/u.test(trimmed)) return 'multiline'
  if ([...trimmed].length > PUBLISH_NAME_MAX) return 'too_long'
  return undefined
}
