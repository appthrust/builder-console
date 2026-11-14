import { isResponseContractError } from '../../api/boundary'
import { createDraft, listDrafts } from '../../api/build'
import { buildSessionsApi, intentKeys, isVersionConflict, mintIdempotencyKey, type BuildSessionsApi } from '../../api/build-sessions'
import { ConsoleApiError } from '../../api/console'
import { boundedRetryAfter, buildPollDelay, ERROR_BACKOFF_MS } from '../../api/queries/build-sessions'
import { membershipRoots, type BuildError, type BuildSession, type Group, type Me } from '../../model/contracts/console'
import { findResumableDraft } from '../../model/build/resume'
import { currentLanguage } from '../../shell/language'
import { readConsoleStart, saveConsoleStart, type ConsoleStart } from './console-session-state'
import { initialSession, readBuildSession, saveBuildSession, titleFromIntent } from './session'
import { text } from './copy'

/**
 * The engine a NEW session is created with. The server decides it (the `/config` flag, resolved for the
 * caller from the Console administrator setting on 基盤の設定); it never changes the engine of a
 * session that exists: opening a draft always asks the resolver (routes/build.tsx).
 */
export type NewSessionEngine = 'console-v1' | 'platform-v1'

/** AI creation needs a membership, never an arbitrary visible directory group. */
export function resolveBuildGroup(me: Pick<Me, 'effectiveGroupIds'>, groups: readonly Group[], currentGroup?: Pick<Group, 'id'>): string | undefined {
  return currentGroup?.id ?? membershipRoots(me, groups)[0]?.id ?? me.effectiveGroupIds[0]
}

/**
 * Starts building from `intent` and answers the draft to open (`paths.build(id)`).
 * platform-v1 (the default): resumes the caller's unfinished draft with these exact words, otherwise creates one.
 * console-v1: creates a console session (see `startConsoleBuild`); legacy drafts are not looked up or adopted.
 */
export async function beginBuild(projectId: string, intent: string, options: { groupId: string; ownerSubject: string; newSessionEngine?: NewSessionEngine }): Promise<{ id: string }> {
  if (!options.groupId) throw new Error(text.page.noGroup.body)
  if (options.newSessionEngine === 'console-v1') return startConsoleBuild(intent, options.groupId)
  const existing = findResumableDraft((await listDrafts(projectId)).data, intent)
  if (existing) {
    if (!readBuildSession(existing.id)) saveBuildSession(existing.id, initialSession({ projectId, ownerSubject: options.ownerSubject, groupId: options.groupId, baseIntent: existing.intent }))
    return existing
  }
  const draft = await createDraft(projectId, { title: titleFromIntent(intent), intent: intent.trim() })
  saveBuildSession(draft.id, initialSession({ projectId, ownerSubject: options.ownerSubject, groupId: options.groupId, baseIntent: intent.trim() }))
  return draft
}

/** How long a start waits for the server to name the session's draft before handing back control. */
export const START_WAIT_MS = 90_000

/**
 * Why a console-v1 start stopped before its draft existed. Starting again with the same words, group and
 * language reuses the same create key and session: it replays or re-reads, never creates a second session.
 * `unconfirmed`: the create or advance answered 2xx unreadably; starting again replays the same key (create)
 * or re-reads the session, nothing else. `failed`/`archived`: the server recorded the session as stopped.
 * `timeout`: the bounded wait ended while the server still worked; starting again resumes observing.
 */
export class BuildStartError extends Error {
  readonly reason: 'unconfirmed' | 'failed' | 'archived' | 'timeout'
  readonly sessionId?: string
  readonly failure?: BuildError

  constructor(reason: BuildStartError['reason'], details: { sessionId?: string; failure?: BuildError } = {}) {
    super(details.failure?.message ?? `build start ${reason}`)
    this.name = 'BuildStartError'
    this.reason = reason
    if (details.sessionId !== undefined) this.sessionId = details.sessionId
    if (details.failure !== undefined) this.failure = details.failure
  }
}

export interface ConsoleStartDeps {
  api: BuildSessionsApi
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  sleep: (ms: number) => Promise<void>
  now: () => number
  random: () => number
}

const defaultDeps: ConsoleStartDeps = {
  api: buildSessionsApi,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  random: Math.random,
}

/**
 * Creates a console-v1 session for `intent` and follows the server's next action (`advance` / observe at
 * `pollAfterMs`) until its draft exists, then answers that draft. The create key is minted once for these
 * words and kept in this tab's storage with the session id, so a reload or a lost answer resumes the same
 * session. The wait is bounded (`START_WAIT_MS`); a stop is a typed `BuildStartError`.
 */
export async function startConsoleBuild(intent: string, groupId: string, deps: Partial<ConsoleStartDeps> = {}): Promise<{ id: string }> {
  const { api, storage, sleep, now, random } = { ...defaultDeps, ...deps }
  const words = intent.trim()
  const saved = readConsoleStart(storage)
  let start: ConsoleStart = saved && saved.intent === words && saved.groupId === groupId
    ? saved
    : { intent: words, groupId, locale: currentLanguage(), key: mintIdempotencyKey() }
  saveConsoleStart(start, storage)
  let session: BuildSession
  try {
    session = start.sessionId ? await api.get(start.sessionId) : await api.create({ kind: 'new-app', groupId, intent: words, locale: start.locale }, start.key)
  } catch (error) {
    // The create may have happened; the kept key replays it on the next start. Nothing else is sent.
    if (isResponseContractError(error)) throw new BuildStartError('unconfirmed', start.sessionId ? { sessionId: start.sessionId } : {})
    throw error
  }
  start = { ...start, sessionId: session.id }
  saveConsoleStart(start, storage)

  const began = now()
  let phase = ''
  let phaseSince = began
  while (session.draftId === undefined) {
    const lifecycle = session.lifecycle.kind === 'known' ? session.lifecycle.value : undefined
    const action = session.nextAction.kind === 'known' ? session.nextAction.value : undefined
    if (lifecycle === 'archived') throw new BuildStartError('archived', { sessionId: session.id, ...(session.failure ? { failure: session.failure } : {}) })
    if (session.failure && action === 'none') throw new BuildStartError('failed', { sessionId: session.id, failure: session.failure })
    if (now() - began >= START_WAIT_MS) throw new BuildStartError('timeout', { sessionId: session.id })
    const nextPhase = `${lifecycle ?? '?'}/${action ?? '?'}`
    if (nextPhase !== phase) { phase = nextPhase; phaseSince = now() }
    try {
      if (action === 'advance') {
        session = await api.advance(session.id, { key: intentKeys.advance(session.id, session.version), version: session.version })
        continue
      }
      // Anything else is observed at the server's pace, never longer than the remaining wait.
      const delay = buildPollDelay({ nextAction: { kind: 'known', value: 'observe' }, pollAfterMs: session.pollAfterMs, phaseElapsedMs: now() - phaseSince, hidden: false, consecutiveErrors: 0, random })
      await sleep(Math.min(delay || 0, Math.max(0, START_WAIT_MS - (now() - began))))
      session = await api.get(session.id)
    } catch (error) {
      if (isResponseContractError(error)) throw new BuildStartError('unconfirmed', { sessionId: session.id })
      // Another tab moved this session on: read it and continue from what the server has.
      if (isVersionConflict(error)) { session = await api.get(session.id); continue }
      // The server asked to come back later (429/503 with `Retry-After`): wait as asked, bounded, within the start wait.
      if (error instanceof ConsoleApiError && (error.status === 429 || error.status === 503) && error.retryAfterMs !== undefined) {
        await sleep(Math.min(boundedRetryAfter(error.retryAfterMs, ERROR_BACKOFF_MS[0]), Math.max(0, START_WAIT_MS - (now() - began))))
        continue
      }
      throw error
    }
  }
  saveConsoleStart(undefined, storage)
  return { id: session.draftId }
}
