// The typed view of a console-v1 NEW-APP session (APT-753 S4-U1): what the
// conversation screen (S4-U2) renders. Everything comes from server values
// read through the boundary; nothing is parsed out of message text. The plan
// is the latest `request_plan` turn by its typed kind, a confirmation is a
// conversation turn the server asks to confirm, and progress is the server's
// stage and observation time (design §13), never a fabricated activity log.
import type { OpenValue } from '../../api/boundary'
import { isObserving, mergeTurn } from '../../api/queries/build-sessions'
import type { BuildPublishResult, BuildSession, BuildTurn } from '../../model/contracts/console'
import type { ConsoleWriteFamily, ConsoleWriteIntent } from './console-session-state'

export type BuildConversationTurn = Extract<BuildTurn, { kind: 'conversation' }>
export type BuildPlanTurn = Extract<BuildTurn, { kind: 'request_plan' }>
export type BuildStage = NonNullable<BuildTurn['progress']>['stage']

/** Without a new server observation for this long the screen says the check is taking long (§13); never "failed". */
export const SLOW_OBSERVATION_MS = 60_000

/** A write this tab sent and what became of it. */
export interface ConsoleWriteState {
  family: ConsoleWriteFamily
  /**
   * `sending`: in flight. `interrupted`: sent before a reload or a transient failure; `retry` resends the same
   * request (same key, same version). `unconfirmed`: answered 2xx unreadably; only `confirm` (a re-read) follows.
   */
  status: 'sending' | 'interrupted' | 'unconfirmed'
}

/** A write the server refused, as the server described it (its message is product text). */
export interface ConsoleWriteFailure {
  family: ConsoleWriteFamily
  /** The error code (`session_busy`, `invalid_argument`, …), or `unknown` without one. */
  code: string
  message: string
  /** Nothing answered, or the server failed: `retry` resends the same intent. */
  retryable: boolean
}

/** A write refused with 412 because the session had moved on (another tab, a reload); the newer state is shown. */
export interface ConsoleConflict {
  /** What this tab tried, so a message can be offered again (as a new intent, never resent automatically). */
  rejected: ConsoleWriteIntent
  message: string
}

export interface ConsoleProgress {
  /** The server's stage; an unknown one is shown as generic work in progress. */
  stage: BuildStage
  observedAt: string
  /** Since the active turn was accepted (`createdAt`), for "first start takes longer" waits (§13). */
  elapsedMs: number
  /** At most three short, safe descriptions chosen by the server. */
  activity: readonly string[]
  /** No new observation for `SLOW_OBSERVATION_MS`. */
  slow: boolean
}

export interface ConsoleBuildView {
  engine: 'console-v1'
  session: BuildSession
  /** Every turn in ordinal order, each its latest observation (the active turn included). */
  turns: readonly BuildTurn[]
  /** The turn the session is working on, as last observed. */
  activeTurn?: BuildTurn
  /** The latest plan request (typed kind `request_plan`); message text never makes one. */
  plan?: BuildPlanTurn
  /** A conversation turn whose proposed change waits for 反映する／反映しない. */
  confirmation?: BuildConversationTurn
  /** The active turn's server progress; absent when nothing runs. */
  progress?: ConsoleProgress
  /** The server's capabilities, withheld while a write is open or the session is in a state this client does not know. */
  canSend: boolean
  canRequestPlan: boolean
  /** The server waits for an authenticated request (`resume`); polling stopped. */
  needsResume: boolean
  /** Lifecycle or next action this client does not know: reading stays, writes stop. */
  unsupported: boolean
  write?: ConsoleWriteState
  failure?: ConsoleWriteFailure
  conflict?: ConsoleConflict
  /**
   * The last accepted publish preferences and their sync state: the session's observation (so a reload has them),
   * or this tab's newer write answer until the session read catches up. Absent until the user saved them.
   */
  publish?: ConsolePublish
}

export interface ConsoleViewInput {
  session: BuildSession
  turns: readonly BuildTurn[] | undefined
  activeTurn: BuildTurn | undefined
  intent: ConsoleWriteIntent | undefined
  sending: boolean
  /** Sign-in has expired: no write can be sent until the page signs in again. */
  blocked: boolean
  failure?: ConsoleWriteFailure
  conflict?: ConsoleConflict
  /** This tab's last publish-preferences answer. */
  publish?: BuildPublishResult
  now: number
}

const known = <K extends string>(value: OpenValue<K>, ...values: K[]) => value.kind === 'known' && values.includes(value.value)

export type ConsolePublish = NonNullable<BuildSession['publish']>

export function deriveConsoleBuildView(input: ConsoleViewInput): ConsoleBuildView {
  const { session, intent } = input
  const turns = input.activeTurn ? mergeTurn(input.turns ?? [], input.activeTurn) : [...(input.turns ?? [])]
  const activeTurn = session.activeTurnId ? turns.find((turn) => turn.id === session.activeTurnId) : undefined
  const plan = turns.filter((turn): turn is BuildPlanTurn => turn.kind === 'request_plan').at(-1)
  const confirmation = turns.filter((turn): turn is BuildConversationTurn =>
    turn.kind === 'conversation' && (known(turn.state, 'awaiting_confirmation') || known(turn.nextAction, 'confirm'))).at(-1)
  const observing = activeTurn && isObserving(activeTurn.nextAction)
  const progress = activeTurn?.progress ? {
    stage: activeTurn.progress.stage,
    observedAt: activeTurn.progress.observedAt,
    elapsedMs: Math.max(0, input.now - Date.parse(activeTurn.createdAt)),
    activity: activeTurn.progress.activity,
    slow: Boolean(observing) && input.now - Date.parse(activeTurn.progress.observedAt) > SLOW_OBSERVATION_MS,
  } : undefined
  const unsupported = session.lifecycle.kind === 'unknown' || session.nextAction.kind === 'unknown'
  const open = input.sending || input.blocked || intent !== undefined || unsupported
  const write: ConsoleWriteState | undefined = input.sending && intent ? { family: intent.family, status: 'sending' }
    : intent ? { family: intent.family, status: intent.status === 'unconfirmed' ? 'unconfirmed' : 'interrupted' } : undefined
  // This tab's answer only while it is newer than the session read; otherwise the session says what was saved.
  const answered = input.publish && input.publish.sessionVersion > session.version ? input.publish : undefined
  const publish: ConsolePublish | undefined = answered ? { desired: answered.desired, sync: answered.sync } : session.publish
  return {
    engine: 'console-v1',
    session,
    turns,
    ...(activeTurn ? { activeTurn } : {}),
    ...(plan ? { plan } : {}),
    ...(confirmation ? { confirmation } : {}),
    ...(progress ? { progress } : {}),
    canSend: session.capabilities.canConverse && !open,
    canRequestPlan: session.capabilities.canRequestPlan && !open,
    needsResume: known(session.nextAction, 'resume') || Boolean(activeTurn && known(activeTurn.nextAction, 'resume')),
    unsupported,
    ...(write ? { write } : {}),
    ...(input.failure ? { failure: input.failure } : {}),
    ...(input.conflict ? { conflict: input.conflict } : {}),
    ...(publish ? { publish } : {}),
  }
}
