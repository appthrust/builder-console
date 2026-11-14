// The development preview on the workspace's own origin (APT-798, design §7).
// Pure parts: what the workspace read says about its preview endpoint, and how
// a refused grant or exchange reads to the person. The session lifecycle that
// combines them is ./use-preview-session.ts.
import { isResponseContractError } from '../../../api/boundary'
import { platformErrorEnvelope } from '../../../api/platform-error'
import { devWorkspaceProxyUrl, type PreviewExchange } from '../../../api/workspace'
import { isOneOf, knownValue, type PreviewWorkspace } from '../../../model/contracts/build'

/**
 * What the workspace read allows. `ready`: the endpoint is Ready and its origin known; only then is a grant
 * requested. `unpublished`: the Platform reports no preview endpoint (and no legacy URL) for a workspace it has
 * never moved to its own origin. `unknown`: a state or phase this console does not know; nothing is requested.
 */
export type PreviewAvailability =
  | { kind: 'ready'; publishUID: string; origin: string }
  | { kind: 'preparing' | 'asleep' | 'unpublished' | 'conflict' | 'unavailable' | 'unknown' }
  /**
   * Legacy same-origin preview (remove at migration stage 5; ./legacy-preview.tsx): a never-moved workspace's
   * Console-proxied URL, set only once the workspace is Ready (as before APT-798).
   */
  | { kind: 'legacy'; url?: string }

/** Not-ready reasons of an endpoint that mean the workspace is sleeping or stopped (its compute is scaled down). */
const ASLEEP_REASONS: Record<string, true> = { WorkspaceSleeping: true, WorkspaceStopped: true }

/**
 * The Platform's record that this workspace has moved to its own origin (design §7: the first Ready endpoint sets
 * condition `DirectPreviewActivated=True`). Read from every workspace answer, never kept in the browser, so a
 * reload, sleep or failure cannot make it forget; an unknown status is not True.
 */
export function directPreviewActivated(workspace: PreviewWorkspace): boolean {
  return workspace.conditions.some((condition) => condition.type === 'DirectPreviewActivated' && isOneOf(condition.status, 'True'))
}

export function previewAvailability(workspace: PreviewWorkspace): PreviewAvailability {
  const endpoint = workspace.preview
  // The one branch point to the legacy display (remove at migration stage 5; ./legacy-preview.tsx). The reader
  // keeps `legacyPreviewUrl` only for a workspace the Platform has never moved: no preview endpoint and no
  // `DirectPreviewActivated=True`. Such a workspace is shown exactly as before, whatever its phase.
  if (workspace.legacyPreviewUrl !== undefined && !endpoint && !directPreviewActivated(workspace)) {
    if (!isOneOf(workspace.phase, 'Ready')) return { kind: 'legacy' }
    try {
      return { kind: 'legacy', url: devWorkspaceProxyUrl(workspace.legacyPreviewUrl) }
    } catch {
      // A URL outside the Platform API proxy is never framed: the workspace has no usable preview.
      return { kind: 'unpublished' }
    }
  }
  const phase = knownValue(workspace.phase)
  if (phase === undefined) return { kind: 'unknown' }
  if (phase === 'Sleeping' || phase === 'Stopping' || phase === 'Stopped') return { kind: 'asleep' }
  if (phase === 'Failed' || phase === 'Deleting') return { kind: 'unavailable' }
  // A moved workspace whose endpoint is gone is unavailable, never "not published yet" and never legacy.
  if (!endpoint) return { kind: directPreviewActivated(workspace) ? 'unavailable' : 'unpublished' }
  switch (knownValue(endpoint.state)) {
    case 'Ready': return endpoint.origin ? { kind: 'ready', publishUID: endpoint.publishUID, origin: endpoint.origin } : { kind: 'unknown' }
    case 'Pending': return { kind: 'preparing' }
    case 'Unavailable':
      if (endpoint.reason === 'HostnameConflict') return { kind: 'conflict' }
      return endpoint.reason && ASLEEP_REASONS[endpoint.reason] ? { kind: 'asleep' } : { kind: 'unavailable' }
    case undefined: return { kind: 'unknown' }
  }
}

/**
 * What the viewer shows. Only `ready` mounts the frame; every other state has no frame at all.
 * `frame` changes whenever the frame must load again (a first connection, or a re-authorization after the
 * viewer came back to the foreground), never on a background renewal.
 */
export type PreviewStatusKind =
  | 'connecting' | 'resuming' | 'preparing' | 'asleep' | 'unpublished' | 'conflict' | 'unavailable' | 'unknown'
  | 'cookie-refused' | 'renew-failed' | 'failed' | 'revoked' | 'denied' | 'credential-not-allowed' | 'verifier-unavailable' | 'not-found' | 'unconfirmed' | 'endpoint-changed'
export type PreviewView = { kind: 'ready'; src: string; frame: number } | { kind: PreviewStatusKind }

/** The viewer states the person can end by asking for a new grant. */
export function canReconnect(view: PreviewView): boolean {
  return view.kind === 'cookie-refused' || view.kind === 'renew-failed' || view.kind === 'failed' || view.kind === 'endpoint-changed'
}

/**
 * A refused grant request (`POST …/http-sessions`) as a viewer state. `renewing`: a session was already shown,
 * so a refusal ends it (a lost permission reads as revoked). An answer whose body cannot be read may have issued
 * a grant nobody holds: only reading the state back is offered.
 */
export function issueFailure(error: unknown, renewing: boolean): PreviewView {
  if (isResponseContractError(error)) return { kind: 'unconfirmed' }
  const envelope = platformErrorEnvelope(error)
  const reason = envelope?.details?.reason
  switch (envelope?.status) {
    case 403:
      if (reason === 'workspace_session_credential_not_allowed') return { kind: 'credential-not-allowed' }
      return { kind: renewing ? 'revoked' : 'denied' }
    case 404: return { kind: 'not-found' }
    case 409:
      if (reason === 'workspace_not_running') return { kind: 'asleep' }
      if (reason === 'workspace_endpoint_changed') return { kind: 'endpoint-changed' }
      break
    case 412:
      if (reason === 'preview_origin_unavailable') return { kind: 'unpublished' }
      if (reason === 'workspace_runtime_unavailable') return { kind: 'unavailable' }
      // This workspace's runtime cannot offer a separate-origin preview at all: permanent, nothing to retry.
      if (reason === 'workspace_session_verifier_unavailable') return { kind: 'verifier-unavailable' }
      break
  }
  return { kind: renewing ? 'renew-failed' : 'failed' }
}

/** A grant the preview origin did not turn into a working session. */
export function exchangeFailure(result: Exclude<PreviewExchange, { kind: 'ready' }>, renewing: boolean): PreviewView {
  return result.kind === 'cookie-refused' ? { kind: 'cookie-refused' } : { kind: renewing ? 'renew-failed' : 'failed' }
}
