import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createPreviewSession, exchangePreviewSession, type PreviewExchange } from '../../../api/workspace'
import type { PreviewSession } from '../../../model/contracts/build'
import { exchangeFailure, issueFailure, type PreviewAvailability, type PreviewView } from './preview'

/**
 * The network and clock the session lifecycle uses. Production uses the Platform proxy and the preview
 * origin; tests replace them through `PreviewSessionDepsContext`.
 */
export interface PreviewSessionDeps {
  issue(projectId: string, workspaceId: string, publishUID: string): Promise<PreviewSession>
  exchange(session: PreviewSession): Promise<PreviewExchange>
  /** Milliseconds on this device's clock. Only differences are used; no Platform timestamp is compared with it. */
  now(): number
  /** Runs `run` after `ms`; returns the cancel. */
  schedule(ms: number, run: () => void): () => void
}

export const browserPreviewSessionDeps: PreviewSessionDeps = {
  issue: createPreviewSession,
  exchange: exchangePreviewSession,
  now: () => Date.now(),
  schedule: (ms, run) => {
    const timer = window.setTimeout(run, ms)
    return () => window.clearTimeout(timer)
  },
}

export const PreviewSessionDepsContext = createContext<PreviewSessionDeps>(browserPreviewSessionDeps)

export interface PreviewSessionTarget {
  projectId: string
  workspaceId: string
  availability: PreviewAvailability
}

export interface PreviewSessionHandle {
  view: PreviewView
  /** Asks for a new grant (never resends an old one). Offered for the states `canReconnect` names. */
  reconnect(): void
}

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
/** A first connection (grant, exchange, check) that has not finished by then has failed. */
const CONNECT_DEADLINE_MS = 20_000
/**
 * The grant's issued lifetime (design §3). Counted from when this device asked for the grant, so neither the
 * exchange's duration nor a skew between this device's clock and the Platform's can extend the session.
 */
const GRANT_LIFETIME_MS = 55_000

/**
 * One viewer's session with the workspace's preview origin (design §4, §7): live authorization → grant →
 * exchange → ready, then a fresh grant every `renewAfterSeconds` while the viewer is in the foreground.
 * The grant lives only in this effect's local variables until the exchange has used it; it never reaches
 * React state, the query cache, storage, a URL or a log. Any failure removes the frame (no frame is kept
 * alive by retrying), and nothing is retried automatically: `reconnect` asks for a new grant. Coming back
 * to the foreground after the renewal time re-authorizes before the frame is shown again. Each viewer
 * (each tab) holds its own session; there is no fallback to another preview address.
 */
export function usePreviewSession(target: PreviewSessionTarget | undefined, { enabled, onEndpointChanged }: { enabled: boolean; onEndpointChanged?: () => void }): PreviewSessionHandle {
  const deps = useContext(PreviewSessionDepsContext)
  const [attempt, setAttempt] = useState(0)
  const ready = target?.availability.kind === 'ready' ? target.availability : undefined
  const key = enabled && target && ready ? `${target.projectId}/${target.workspaceId}/${ready.publishUID}/${ready.origin}/${attempt}` : undefined
  const [session, setSession] = useState<{ key: string; view: PreviewView }>()
  const endpointChanged = useRef(onEndpointChanged)
  endpointChanged.current = onEndpointChanged

  useEffect(() => {
    if (!key || !target || !ready) return
    const { projectId, workspaceId } = target
    const { publishUID, origin } = ready
    let stopped = false
    let failed = false
    let inFlight = false
    let hidden = isHidden()
    let authorizedAt: number | undefined
    let renewAfterMs = 30_000
    let frame = 0
    let cancelRenew: (() => void) | undefined
    let cancelDeadline: (() => void) | undefined
    /** The current connection attempt; an attempt overtaken by its deadline is ignored when it settles. */
    let attempt = 0
    /** When the session in use stops being valid (deps clock); a renewal not done by then ends the preview. */
    let validUntil: number | undefined
    const show = (view: PreviewView) => { if (!stopped) setSession({ key, view }) }
    const fail = (view: PreviewView) => {
      failed = true
      cancelRenew?.()
      cancelRenew = undefined
      show(view)
    }
    const scheduleRenew = () => {
      cancelRenew?.()
      cancelRenew = undefined
      if (hidden || failed || authorizedAt === undefined) return
      cancelRenew = deps.schedule(Math.max(0, authorizedAt + renewAfterMs - deps.now()), () => {
        cancelRenew = undefined
        if (!hidden && !inFlight && !failed) void connect('renew')
      })
    }

    async function connect(reason: 'first' | 'renew' | 'resume') {
      inFlight = true
      const current = ++attempt
      const requestedAt = deps.now()
      const renewing = authorizedAt !== undefined
      // A stalled grant request or exchange never keeps the frame: by the shown session's end (or a bound for a
      // first connection) the attempt is abandoned and the preview stops.
      cancelDeadline?.()
      cancelDeadline = deps.schedule(reason === 'renew' && validUntil !== undefined ? Math.max(0, validUntil - deps.now()) : CONNECT_DEADLINE_MS, () => {
        cancelDeadline = undefined
        if (current !== attempt || !inFlight || stopped) return
        attempt += 1
        inFlight = false
        fail({ kind: renewing ? 'renew-failed' : 'failed' })
      })
      const settled = () => current === attempt && !stopped
      let grant: PreviewSession | undefined
      try {
        grant = await deps.issue(projectId, workspaceId, publishUID)
      } catch (error) {
        if (!settled()) return
        inFlight = false
        cancelDeadline?.()
        const view = issueFailure(error, renewing)
        if (view.kind === 'endpoint-changed') endpointChanged.current?.()
        return fail(view)
      }
      if (!settled()) return
      // A grant for another origin or publication is never handed anywhere: the endpoint moved.
      if (grant.origin !== origin || grant.publishUID !== publishUID) {
        inFlight = false
        cancelDeadline?.()
        endpointChanged.current?.()
        return fail({ kind: 'endpoint-changed' })
      }
      renewAfterMs = grant.renewAfterSeconds * 1_000
      // The grant's `expiresAt` is on the Platform's clock and is never compared with this device's clock.
      const result = await deps.exchange(grant)
      // The exchange used the grant; nothing keeps it.
      grant = undefined
      if (!settled()) return
      inFlight = false
      cancelDeadline?.()
      if (result.kind !== 'ready') return fail(exchangeFailure(result, renewing))
      authorizedAt = deps.now()
      validUntil = requestedAt + GRANT_LIFETIME_MS
      if (reason !== 'renew') frame += 1
      show({ kind: 'ready', src: `${origin}/`, frame })
      scheduleRenew()
    }

    const onVisibility = () => {
      hidden = isHidden()
      if (hidden) {
        cancelRenew?.()
        cancelRenew = undefined
        return
      }
      if (failed || inFlight) return
      if (authorizedAt === undefined) {
        show({ kind: 'connecting' })
        void connect('first')
      } else if (deps.now() - authorizedAt >= renewAfterMs) {
        // The session may have lapsed while hidden: authorize again before the frame is shown again.
        show({ kind: 'resuming' })
        void connect('resume')
      } else scheduleRenew()
    }
    document.addEventListener('visibilitychange', onVisibility)
    show({ kind: 'connecting' })
    // A viewer opened in the background waits for the foreground before asking for anything.
    if (!hidden) void connect('first')
    return () => {
      stopped = true
      cancelRenew?.()
      cancelDeadline?.()
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // `target`/`ready` are identified by `key`; a new object with the same identity is the same session.
  }, [key, deps])

  // No workspace read yet: nothing is known, so nothing is requested.
  const view: PreviewView = !target ? { kind: 'preparing' }
    // The legacy display has its own frame (./legacy-preview.tsx); this viewer has nothing to show for it.
    : !ready ? { kind: target.availability.kind === 'legacy' ? 'unpublished' : target.availability.kind as Exclude<PreviewAvailability['kind'], 'ready' | 'legacy'> }
      : session && session.key === key ? session.view : { kind: 'connecting' }
  return { view, reconnect: () => setAttempt((value) => value + 1) }
}
