// A console-v1 NEW-APP session on the build screen (APT-753 S4-U1). The
// session and its turns are the server's: this hook reads them through the
// boundary, observes what the server says to observe (§13), and sends the
// writes the user decides on. It never derives a command from text: a plan is
// requested with the typed `request_plan` kind.
//
// Writes, one at a time:
// - the intent (key, the session version it was decided on, body) is kept in
//   this tab's storage before it is sent; a resend after a transient failure or
//   a reload reuses both, so the server replays instead of applying twice;
// - a second submit while one is open sends nothing;
// - an answer is written into the caches after reads in flight are cancelled,
//   and the caches keep the higher session version;
// - 412 `version_conflict` re-reads and shows the newer state; the intent is
//   dropped, never resent;
// - an unreadable 2xx is not cached and not resent; `confirm` (a re-read) is the
//   only way on;
// - 401 keeps the intent for after sign-in (the shell's session-expiry path).
// The legacy platform-v1 flow (`use-build-session.ts`) is separate and unchanged.
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useSelector } from '@tanstack/react-store'
import { useEffect, useRef, useState } from 'react'
import { isResponseContractError } from '../../api/boundary'
import { buildSessionsApi, intentKeys, isVersionConflict, mintIdempotencyKey, type BuildSessionsApi } from '../../api/build-sessions'
import { ConsoleApiError } from '../../api/console'
import {
  buildSessionKeys, buildSessionOptions, buildTurnOptions, buildTurnsOptions, isObserving, receiveSession, receiveTurn, rereadSession,
} from '../../api/queries/build-sessions'
import { isSessionExpiredError, sessionExpiryStore } from '../../api/session-expiry'
import { copy } from '../../copy'
import type { BuildPublishInput, BuildPublishResult, BuildResolutionInput, BuildSession, BuildTurn, BuildTurnInput } from '../../model/contracts/console'
import { readConsoleIntent, saveConsoleIntent, type ConsoleWriteIntent } from './console-session-state'
import { deriveConsoleBuildView, type ConsoleBuildView, type ConsoleConflict, type ConsoleWriteFailure } from './console-view'

export type BuildConversationIntent = Extract<BuildTurnInput, { kind: 'conversation' }>['intent']

/** Contract bounds of a conversation message (1–4000 Unicode scalars, at most 16 KiB UTF-8, not blank). */
const MAX_MESSAGE_SCALARS = 4000
const MAX_MESSAGE_BYTES = 16_384
const encoder = new TextEncoder()

export interface ConsoleBuildActions {
  /** Sends a conversation turn (free text is `auto`); false when nothing was sent. */
  send(message: string, intent?: BuildConversationIntent): boolean
  /** Requests a plan from the current specification revision (typed `request_plan`); false when nothing was sent. */
  requestPlan(): boolean
  /** 反映する (`accept_spec`) / 反映しない (`keep_spec`) for a turn awaiting confirmation. */
  resolve(turnId: string, decision: BuildResolutionInput['decision']): boolean
  setPublishPreferences(input: BuildPublishInput): boolean
  archive(): boolean
  /** Resends the interrupted write exactly (same key, same version). */
  retry(): void
  /** 「最新の状態を確認する」: re-reads the session; clears an unconfirmed write once the read succeeds. */
  confirm(): Promise<void>
  /** Re-reads after `resume` (an authenticated request lets the server continue). */
  resume(): Promise<void>
  dismissConflict(): void
}

export interface ConsoleBuildSession {
  /** The session read (first load, refresh failures) for the page's resource boundary. */
  query: UseQueryResult<BuildSession>
  /** The turn list read; a failed refresh keeps the last good list. */
  turnsQuery: UseQueryResult<BuildTurn[]>
  /** Undefined until the session has been read. */
  view?: ConsoleBuildView
  actions: ConsoleBuildActions
}

const knownAction = (value: BuildSession['nextAction'], action: 'advance' | 'resume') => value.kind === 'known' && value.value === action

export function useConsoleBuildSession(sessionId: string, options: { api?: BuildSessionsApi; storage?: Storage } = {}): ConsoleBuildSession {
  const api = options.api ?? buildSessionsApi
  const client = useQueryClient()
  const query = useQuery(buildSessionOptions(sessionId, api))
  const turnsQuery = useQuery(buildTurnsOptions(sessionId, api))
  const session = query.data
  const activeTurnQuery = useQuery({ ...buildTurnOptions(sessionId, session?.activeTurnId, api), enabled: Boolean(session?.activeTurnId) })
  const activeTurn = session?.activeTurnId && activeTurnQuery.data?.id === session.activeTurnId ? activeTurnQuery.data : undefined
  const expired = useSelector(sessionExpiryStore)
  const [intent, setIntent] = useState(() => readConsoleIntent(sessionId, options.storage))
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<ConsoleWriteFailure>()
  const [conflict, setConflict] = useState<ConsoleConflict>()
  const [publish, setPublish] = useState<BuildPublishResult>()
  const [now, setNow] = useState(Date.now)
  const inFlight = useRef(false)
  const intentRef = useRef(intent)
  const advanced = useRef(new Set<number>())
  const seenVersion = useRef<number | undefined>(undefined)

  function keep(next: ConsoleWriteIntent | undefined) {
    intentRef.current = next
    setIntent(next)
    saveConsoleIntent(sessionId, next, options.storage)
  }

  async function dispatch(next: ConsoleWriteIntent): Promise<void> {
    switch (next.family) {
      case 'turn': return receiveTurn(client, sessionId, await api.createTurn(sessionId, next.body, next))
      case 'resolution': return receiveTurn(client, sessionId, await api.resolveTurn(sessionId, next.turnId, next.body, next))
      case 'advance': return receiveSession(client, await api.advance(sessionId, next))
      case 'archive': return receiveSession(client, await api.archive(sessionId, next))
      case 'publish': {
        const result = await api.setPublishPreferences(sessionId, next.body, next)
        setPublish(result)
        const cached = client.getQueryData<BuildSession>(buildSessionKeys.session(sessionId))
        if (!cached || cached.version < result.sessionVersion) await client.invalidateQueries({ queryKey: buildSessionKeys.session(sessionId), exact: true })
        return
      }
    }
  }

  async function run(next: ConsoleWriteIntent): Promise<void> {
    keep(next)
    inFlight.current = true
    setSending(true)
    setFailure(undefined)
    try {
      await dispatch(next)
      keep(undefined)
    } catch (error) {
      // Not processed: after signing in again the same intent is resent with its key.
      if (isSessionExpiredError(error)) return
      if (isResponseContractError(error)) {
        keep({ ...next, status: 'unconfirmed' })
        return
      }
      if (isVersionConflict(error)) {
        keep(undefined)
        setConflict({ rejected: next, message: error.message })
        await rereadSession(client, sessionId).catch(() => undefined)
        return
      }
      const answered = error instanceof ConsoleApiError && !error.transient && error.status > 0 && error.status < 500
      if (answered) keep(undefined)
      setFailure({
        family: next.family,
        code: error instanceof ConsoleApiError ? error.code : 'unknown',
        message: error instanceof ConsoleApiError ? error.message : copy.errors.transient,
        retryable: !answered,
      })
      // A refusal (busy, invalid, key conflict) is final for this intent: show what the server has now.
      if (answered) await rereadSession(client, sessionId).catch(() => undefined)
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  /** Starts a new intent unless a write is open, the session is unknown or sign-in has expired. */
  function start(build: (session: BuildSession) => ConsoleWriteIntent | undefined): boolean {
    const current = client.getQueryData<BuildSession>(buildSessionKeys.session(sessionId))
    if (!current || inFlight.current || intentRef.current || sessionExpiryStore.state) return false
    if (current.lifecycle.kind === 'unknown' || current.nextAction.kind === 'unknown') return false
    const next = build(current)
    if (!next) return false
    void run(next)
    return true
  }

  const wantsAdvance = Boolean(session && (knownAction(session.nextAction, 'advance') || (activeTurn && knownAction(activeTurn.nextAction, 'advance'))))
  // `advance` moves the stored next step on (initialization, wake, the one repair); once per session version.
  useEffect(() => {
    if (!session || !wantsAdvance || advanced.current.has(session.version)) return
    if (start((current) => current.version === session.version ? { family: 'advance', key: intentKeys.advance(sessionId, current.version), version: current.version, status: 'pending' } : undefined)) {
      advanced.current.add(session.version)
    }
  }, [session?.version, wantsAdvance, sending, intent, expired])

  // A new session version can change the turns (another tab, an imported reply): re-read the list.
  useEffect(() => {
    if (!session) return
    if (seenVersion.current !== undefined && seenVersion.current !== session.version) void client.invalidateQueries({ queryKey: buildSessionKeys.turns(sessionId), exact: true })
    seenVersion.current = session.version
  }, [session?.version])

  // The observed turn moved the session on, or stopped needing observation: re-read the session.
  useEffect(() => {
    if (!session || !activeTurn) return
    if (activeTurn.sessionVersion > session.version || !isObserving(activeTurn.nextAction)) {
      void client.invalidateQueries({ queryKey: buildSessionKeys.session(sessionId), exact: true })
    }
  }, [activeTurn?.sessionVersion, activeTurn?.state, activeTurn?.nextAction])

  const observing = Boolean(activeTurn && isObserving(activeTurn.nextAction))
  useEffect(() => {
    if (!observing) return
    const timer = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [observing])

  const reread = async () => {
    await rereadSession(client, sessionId)
  }
  const actions: ConsoleBuildActions = {
    send: (message, kind = 'auto') => {
      const text = message.trim()
      if (!text || [...text].length > MAX_MESSAGE_SCALARS || encoder.encode(text).length > MAX_MESSAGE_BYTES) return false
      return start((current) => current.capabilities.canConverse ? {
        family: 'turn', key: mintIdempotencyKey(), version: current.version, status: 'pending',
        body: { kind: 'conversation', message: text, intent: kind, baseSpecRevision: current.specification.revision },
      } : undefined)
    },
    requestPlan: () => start((current) => current.capabilities.canRequestPlan ? {
      family: 'turn', key: mintIdempotencyKey(), version: current.version, status: 'pending',
      body: { kind: 'request_plan', specRevision: current.specification.revision },
    } : undefined),
    resolve: (turnId, decision) => start((current) => ({
      family: 'resolution', key: intentKeys.resolution(sessionId, current.version, turnId, decision), version: current.version, status: 'pending', turnId, body: { decision },
    })),
    setPublishPreferences: (input) => start((current) => ({ family: 'publish', key: mintIdempotencyKey(), version: current.version, status: 'pending', body: input })),
    archive: () => start((current) => ({ family: 'archive', key: intentKeys.archive(sessionId, current.version), version: current.version, status: 'pending' })),
    retry: () => {
      const pending = intentRef.current
      if (pending?.status === 'pending' && !inFlight.current && !sessionExpiryStore.state) void run(pending)
    },
    confirm: async () => {
      try {
        await reread()
      } catch {
        return // The failed read shows as the page's refresh notice; the write stays unconfirmed.
      }
      if (intentRef.current?.status === 'unconfirmed') keep(undefined)
      setFailure(undefined)
    },
    resume: () => reread().catch(() => undefined),
    dismissConflict: () => setConflict(undefined),
  }

  const view = session ? deriveConsoleBuildView({
    session, turns: turnsQuery.data, activeTurn, intent, sending, blocked: expired, failure, conflict, publish, now,
  }) : undefined
  return { query, turnsQuery, ...(view ? { view } : {}), actions }
}
