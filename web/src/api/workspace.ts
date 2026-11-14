import type { RestartDevWorkspaceRequest } from '@appthrust/api-schema/platform-api'
import { queryOptions, skipToken } from '@tanstack/react-query'
import type { PreviewSession, PreviewWorkspace } from '../model/contracts/build'
import { contractFailureReport, createConsoleWarnReporter, decodeResponse } from './boundary'
import { createDevWorkspaceHTTPSessionContract, getDevWorkspaceContract, previewSessionReadyContract, restartDevWorkspaceContract } from './contracts/platform/workspace'
import { apiGateway } from './gateway'

export function getWorkspace(projectId: string, workspaceId: string, signal: AbortSignal): Promise<PreviewWorkspace> {
  return apiGateway.platform(getDevWorkspaceContract, { projectId, id: workspaceId }, { signal })
}

/** The workspace a preview viewer shows (new-tab viewer, proposal links), outside a build session's own cache. */
export const workspaceOptions = (projectId: string, workspaceId: string | undefined) => queryOptions({
  queryKey: ['workspace', projectId, workspaceId],
  queryFn: workspaceId ? ({ signal }) => getWorkspace(projectId, workspaceId, signal) : skipToken,
})

/** Restarts the workspace runtime; `resetPreviewDatabase` also discards its preview database. */
export function restartWorkspace(projectId: string, workspaceId: string, body: RestartDevWorkspaceRequest): Promise<PreviewWorkspace> {
  return apiGateway.platform(restartDevWorkspaceContract, { projectId, id: workspaceId, ...body })
}

/**
 * Asks the Platform for a fresh grant to the workspace's preview origin, embedded by this page's own origin.
 * A credential exchange: every call is a new live authorization and a new grant; nothing caches, retries or replays it.
 */
export function createPreviewSession(projectId: string, workspaceId: string, publishUID: string): Promise<PreviewSession> {
  return apiGateway.platform(createDevWorkspaceHTTPSessionContract, { projectId, id: workspaceId, target: 'preview', publishUID, embedderOrigin: window.location.origin })
}

/**
 * How handing a grant to the preview origin ended. `ready`: the origin set its session Cookie and this browser
 * sent it back. `cookie-refused`: the exchange succeeded but the Cookie did not come back (the browser blocks it).
 * `refused`: the origin answered the exchange or the check with an error. `unreachable`: no answer.
 * `unreadable`: a success whose body is not the check's answer.
 */
export type PreviewExchange = { kind: 'ready' } | { kind: 'cookie-refused' } | { kind: 'refused'; status: number } | { kind: 'unreachable' } | { kind: 'unreadable' }

const reportUnreadable = createConsoleWarnReporter()

/** How long the preview origin may take to answer the exchange and the check together. */
const EXCHANGE_TIMEOUT_MS = 10_000

/**
 * Exchanges `session`'s grant at the preview origin's reserved endpoint, then checks the Cookie comes back.
 * The grant travels only in this POST body: never in a URL, a header, storage or a log line. Error bodies are not read.
 */
export async function exchangePreviewSession(session: PreviewSession): Promise<PreviewExchange> {
  // One bound for the exchange, the check and its body: a stalled answer is "unreachable", never a wait without end.
  const request = { mode: 'cors', credentials: 'include', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS) } as const
  let exchanged: Response
  try {
    exchanged = await fetch(session.exchangeUrl, { ...request, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant: session.grant }) })
  } catch {
    return { kind: 'unreachable' }
  }
  if (exchanged.status !== 204) return { kind: 'refused', status: exchanged.status }
  let ready: Response
  try {
    ready = await fetch(`${session.exchangeUrl}/ready`, { ...request, method: 'GET' })
  } catch {
    return { kind: 'unreachable' }
  }
  // The exchange set the Cookie; a check that does not see it means this browser would not store or send it.
  if (ready.status === 401) return { kind: 'cookie-refused' }
  if (ready.status !== 200) return { kind: 'refused', status: ready.status }
  let body: unknown
  try {
    body = await ready.json()
  } catch {
    body = undefined
  }
  const decoded = decodeResponse(previewSessionReadyContract, body)
  if (!decoded.ok) {
    reportUnreadable(contractFailureReport(decoded.error))
    return { kind: 'unreadable' }
  }
  return decoded.value.publishUID === session.publishUID ? { kind: 'ready' } : { kind: 'unreadable' }
}

// ---- Legacy same-origin preview (migration only; remove at migration stage 5 with the legacy route).
// Used solely for a workspace the Platform has never moved to its own origin: no `httpEndpoints` preview
// entry and no `DirectPreviewActivated=True` (features/build/implement/legacy-preview.tsx).

/** Runtime URLs stay on the console proxy. The edge, not JavaScript, adds Authorization. */
export function devWorkspaceProxyUrl(url: string): string {
  const parsed = new URL(url, window.location.origin)
  if (!parsed.pathname.startsWith('/api/v1/')) {
    throw new Error('DevWorkspace returned a URL outside the Platform API proxy')
  }
  return `${parsed.pathname}${parsed.search}`
}

/**
 * The HTTP status of the legacy preview page the iframe will load, or undefined when nothing answered.
 * Only the status is read: the page is the app's HTML, not an API answer.
 */
export async function previewStatus(url: string, signal: AbortSignal): Promise<number | undefined> {
  try {
    const response = await fetch(url, { method: 'GET', cache: 'no-store', signal })
    void response.body?.cancel().catch(() => {})
    return response.status
  } catch {
    // Network failures and request timeouts mean "not yet", just like a gateway 503.
    return undefined
  }
}
