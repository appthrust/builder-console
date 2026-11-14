// Read models of the NEW-APP conversation (APT-753 S4-U1): the engine
// resolver, the console-v1 session, its turns and spec revisions. The session
// and its turns are server-owned; the browser keeps no second copy of them.
//
// Polling follows the conversation design §13: an observed session or turn is
// re-read 2 s after an answer, 3 s once its phase has lasted 10 s and 5 s after
// 30 s (±20 % jitter); a longer `pollAfterMs` wins; a hidden tab waits 15 s;
// failed reads back off 2/4/8/15/30 s, and a failed read's longer `Retry-After`
// (429/503) wins up to 60 s; `none`, `confirm` and `resume` stop it.
// A read never overwrites a newer answer: the caches keep the value with the
// higher session version, so a poll that started before a write cannot bring
// back the state the write replaced.
import { queryOptions, replaceEqualDeep, skipToken, type Query, type QueryClient } from '@tanstack/react-query'
import type { OpenValue } from '../boundary'
import { buildSessionsApi, type BuildSessionsApi } from '../build-sessions'
import { ConsoleApiError } from '../console'
import { sessionExpiryStore } from '../session-expiry'
import type { BuildSession, BuildTurn } from '../../model/contracts/console'

export const buildSessionKeys = {
  all: ['build-session'] as const,
  resolve: (draftId: string) => ['build-session', 'resolve', draftId] as const,
  session: (id: string) => ['build-session', id, 'session'] as const,
  turns: (id: string) => ['build-session', id, 'turns'] as const,
  turn: (id: string, turnId: string) => ['build-session', id, 'turn', turnId] as const,
}

type NextAction = BuildSession['nextAction']

const OBSERVE_STEPS = [{ after: 30_000, every: 5_000 }, { after: 10_000, every: 3_000 }, { after: 0, every: 2_000 }] as const
/** Failed reads wait 2/4/8/15/30 s; the first step is the shortest a failed read is retried. */
export const ERROR_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const
export const HIDDEN_POLL_MS = 15_000
/** The longest a server's `Retry-After` may hold the next read back; a longer one is read again at this pace. */
export const RETRY_AFTER_MAX_MS = 60_000

export interface PollInput {
  nextAction: NextAction
  pollAfterMs?: number
  /** How long the observed phase (state and stage) has lasted in this tab. */
  phaseElapsedMs: number
  hidden: boolean
  /** Reads that failed since the last good answer. */
  consecutiveErrors: number
  /** The last failed read's `Retry-After`; it only lengthens the backoff, within `RETRY_AFTER_MAX_MS`. */
  retryAfterMs?: number
  /** [0, 1); jitter source. */
  random: () => number
}

/** A server's `Retry-After`, bounded: never sooner than `floorMs` (the client's own wait), never later than `RETRY_AFTER_MAX_MS`. */
export function boundedRetryAfter(retryAfterMs: number | undefined, floorMs: number): number {
  return retryAfterMs === undefined ? floorMs : Math.max(floorMs, Math.min(retryAfterMs, RETRY_AFTER_MAX_MS))
}

/** Whether this next action is something to keep observing (an unknown one is: it must be noticed when it becomes known). */
export function isObserving(nextAction: NextAction): boolean {
  return nextAction.kind === 'unknown' || nextAction.value === 'observe' || nextAction.value === 'advance'
}

/** The delay before the next read, or false when nothing is to be observed (design §13). */
export function buildPollDelay(input: PollInput): number | false {
  if (!isObserving(input.nextAction)) return false
  const jitter = 0.8 + 0.4 * input.random()
  const delay = input.consecutiveErrors > 0
    ? boundedRetryAfter(input.retryAfterMs, ERROR_BACKOFF_MS[Math.min(input.consecutiveErrors, ERROR_BACKOFF_MS.length) - 1]!)
    : Math.round(OBSERVE_STEPS.find((step) => input.phaseElapsedMs >= step.after)!.every * jitter)
  const server = Math.max(delay, input.pollAfterMs ?? 0)
  return input.hidden ? Math.max(server, HIDDEN_POLL_MS) : server
}

interface PollTrack { phase: string; since: number; dataUpdatedAt: number; errorsAtData: number }
const tracks = new WeakMap<object, PollTrack>()

/** `refetchInterval` for a query whose data says what to observe next. */
function pollInterval<T>(observe: (data: T) => { nextAction: NextAction; pollAfterMs?: number; phase: string } | undefined) {
  return (query: Query<T, Error, T, readonly unknown[]>): number | false => {
    const { data, dataUpdatedAt, errorUpdateCount, error } = query.state
    const target = data === undefined ? undefined : observe(data)
    // Sign-in expired: every read would fail before the network; the full-page sign-in starts over.
    if (!target || sessionExpiryStore.state) return false
    const now = Date.now()
    const previous = tracks.get(query)
    const track: PollTrack = !previous || previous.phase !== target.phase
      ? { phase: target.phase, since: now, dataUpdatedAt, errorsAtData: errorUpdateCount }
      : previous.dataUpdatedAt !== dataUpdatedAt ? { ...previous, dataUpdatedAt, errorsAtData: errorUpdateCount } : previous
    tracks.set(query, track)
    const consecutiveErrors = errorUpdateCount - track.errorsAtData
    return buildPollDelay({
      nextAction: target.nextAction, pollAfterMs: target.pollAfterMs, phaseElapsedMs: now - track.since,
      hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden', consecutiveErrors,
      ...(consecutiveErrors > 0 && error instanceof ConsoleApiError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      random: Math.random,
    })
  }
}

const openText = (value: OpenValue<string> | undefined) => value === undefined ? '' : value.kind === 'known' ? value.value : '?'

/** Keeps the session with the higher version: an earlier read never replaces a write's answer. */
export function newerSession(previous: unknown, next: unknown): unknown {
  const old = previous as BuildSession | undefined
  const incoming = next as BuildSession
  return old && old.id === incoming.id && old.version > incoming.version ? old : replaceEqualDeep(previous, next)
}

/** The later observation of one turn: higher session version, then later `updatedAt`. */
export function laterTurn(old: BuildTurn | undefined, incoming: BuildTurn): BuildTurn {
  if (!old || old.id !== incoming.id) return incoming
  if (old.sessionVersion !== incoming.sessionVersion) return old.sessionVersion > incoming.sessionVersion ? old : incoming
  return Date.parse(old.updatedAt) > Date.parse(incoming.updatedAt) ? old : incoming
}

function newerTurn(previous: unknown, next: unknown): unknown {
  const kept = laterTurn(previous as BuildTurn | undefined, next as BuildTurn)
  return kept === previous ? previous : replaceEqualDeep(previous, next)
}

/** `turns` with `turn` in place (or appended), ordinal order, each turn its latest observation. */
export function mergeTurn(turns: readonly BuildTurn[], turn: BuildTurn): BuildTurn[] {
  const merged = turns.some((item) => item.id === turn.id) ? turns.map((item) => item.id === turn.id ? laterTurn(item, turn) : item) : [...turns, turn]
  return merged.sort((a, b) => a.ordinal - b.ordinal)
}

function mergeTurns(previous: unknown, next: unknown): unknown {
  // A list read that started before a turn write lacks that turn or shows it older; turns are never removed.
  const merged = ((previous as BuildTurn[] | undefined) ?? []).reduce(mergeTurn, (next as BuildTurn[]).slice())
  return replaceEqualDeep(previous, merged)
}

/** The engine of a draft. Opening a draft URL always asks again (no cached answer decides it). */
export function buildResolveOptions(draftId: string, api: BuildSessionsApi = buildSessionsApi) {
  return queryOptions({
    queryKey: buildSessionKeys.resolve(draftId),
    queryFn: draftId ? () => api.resolve(draftId) : skipToken,
    staleTime: 0,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })
}

export function buildSessionOptions(sessionId: string, api: BuildSessionsApi = buildSessionsApi) {
  return queryOptions({
    queryKey: buildSessionKeys.session(sessionId),
    queryFn: sessionId ? () => api.get(sessionId) : skipToken,
    retry: false,
    structuralSharing: newerSession,
    refetchIntervalInBackground: true,
    // A running turn is observed through its own read; the session is re-read when that turn moves its version.
    refetchInterval: pollInterval<BuildSession>((session) => session.activeTurnId ? undefined
      : { nextAction: session.nextAction, pollAfterMs: session.pollAfterMs, phase: `${openText(session.lifecycle)}/${openText(session.nextAction)}` }),
  })
}

export function buildTurnsOptions(sessionId: string, api: BuildSessionsApi = buildSessionsApi) {
  return queryOptions({
    queryKey: buildSessionKeys.turns(sessionId),
    queryFn: sessionId ? () => api.allTurns(sessionId) : skipToken,
    retry: false,
    structuralSharing: mergeTurns,
    refetchInterval: false,
  })
}

export function buildTurnOptions(sessionId: string, turnId: string | undefined, api: BuildSessionsApi = buildSessionsApi) {
  return queryOptions({
    queryKey: buildSessionKeys.turn(sessionId, turnId ?? ''),
    queryFn: sessionId && turnId ? () => api.getTurn(sessionId, turnId) : skipToken,
    retry: false,
    structuralSharing: newerTurn,
    refetchIntervalInBackground: true,
    refetchInterval: pollInterval<BuildTurn>((turn) =>
      ({ nextAction: turn.nextAction, pollAfterMs: turn.pollAfterMs, phase: `${openText(turn.state)}/${openText(turn.progress?.stage)}` })),
  })
}

/** A write's session answer: reads in flight are cancelled first, so they cannot land on top of it. */
export async function receiveSession(client: QueryClient, session: BuildSession): Promise<void> {
  const key = buildSessionKeys.session(session.id)
  await client.cancelQueries({ queryKey: key, exact: true })
  client.setQueryData(key, session)
}

/** A write's turn answer, into the turn and the turn list; a session it moved on is re-read. */
export async function receiveTurn(client: QueryClient, sessionId: string, turn: BuildTurn): Promise<void> {
  const turnKey = buildSessionKeys.turn(sessionId, turn.id)
  const listKey = buildSessionKeys.turns(sessionId)
  await Promise.all([client.cancelQueries({ queryKey: turnKey, exact: true }), client.cancelQueries({ queryKey: listKey, exact: true })])
  client.setQueryData(turnKey, turn)
  client.setQueryData<BuildTurn[]>(listKey, (turns) => mergeTurn(turns ?? [], turn))
  const session = client.getQueryData<BuildSession>(buildSessionKeys.session(sessionId))
  if (!session || session.version < turn.sessionVersion) await client.invalidateQueries({ queryKey: buildSessionKeys.session(sessionId), exact: true })
}

/**
 * Re-reads the session, its turns and its active turn (`最新の状態を確認する`, and the answer to a 412).
 * Earlier reads in flight are cancelled; rejects when a read fails.
 */
export async function rereadSession(client: QueryClient, sessionId: string): Promise<BuildSession> {
  await client.refetchQueries({ queryKey: buildSessionKeys.session(sessionId), exact: true }, { throwOnError: true })
  const session = client.getQueryData<BuildSession>(buildSessionKeys.session(sessionId))!
  const reads = [client.refetchQueries({ queryKey: buildSessionKeys.turns(sessionId), exact: true }, { throwOnError: true })]
  if (session.activeTurnId) reads.push(client.refetchQueries({ queryKey: buildSessionKeys.turn(sessionId, session.activeTurnId), exact: true }, { throwOnError: true }))
  await Promise.all(reads)
  return session
}
