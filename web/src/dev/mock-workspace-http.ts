// Dev-only stand-in for the workspace HTTP preview (APT-798, design §4/§5):
// the Platform side (`httpEndpoints` on the workspace read, the credential
// exchange `POST …/dev-workspaces/{id}/http-sessions`) and the preview origin
// itself (the leaf's reserved `/__appthrust/session/{publishUID}` exchange and
// ready check, then the app behind its session Cookie). The wire follows the
// mirrored contract (src/api/contracts/platform/workspace-http-wire.ts); the
// grant is an opaque random string here, not the Platform's signed JWS.
//
// The preview origin is a real, separate HTTPS host: `https://pv-<32 hex>.<domain>`
// with no port, as the contract requires. `mock-server.ts` serves it on its own
// TLS port (CONSOLE_MOCK_PREVIEW_PORT, default mock port + 1); a browser reaches
// it by mapping the host to that port (Chromium `--host-resolver-rules`, see
// e2e/stories/preview-hosts.ts). The Console must likewise be opened as
// `https://console.<domain>`, the only embedder and Origin this mock accepts.
//
// Toggle: `POST /api/v1/__mock/workspace-http {endpoint?, sessions?, host?}`
// - endpoint: `auto` (Ready once the workspace is Ready; default), `pending`,
//   `conflict` (Unavailable HostnameConflict), `sleeping` (Unavailable
//   WorkspaceSleeping), `none` (no `httpEndpoints` at all: an unmigrated
//   workspace keeps the legacy same-origin `previewUrl`, a moved one shows
//   none — see `publishedWorkspace`), `absent` (no `httpEndpoints` and no
//   `previewUrl`: a workspace with no preview of either kind);
// - sessions: `ok` (default), `unavailable` (503 workspace_session_unavailable),
//   `revoked` (403 workspace_access_denied), `credential-not-allowed` (403
//   workspace_session_credential_not_allowed), `verifier-unavailable` (412
//   workspace_session_verifier_unavailable), `origin-unavailable` (412
//   preview_origin_unavailable: the Platform guard is not enforcing yet);
//   applies to every later grant request;
// - host: where the Ready endpoint (and its grants) point: `preview` (default,
//   `pv-<32 hex>.<project>.appthrust.test`), `sibling` (another app of the
//   Project, `mitsumori.<project>.appthrust.test`) or `other-domain`
//   (`pv-<32 hex>.<project>.preview-isolation.test`). The Console must refuse
//   the last two: it embeds nothing and asks for no grant.
import { createHash, randomBytes } from 'node:crypto'
import type { DevWorkspaceRead } from '@appthrust/api-schema/platform-api'
import { CreateWorkspaceHTTPSessionRequest, type DevWorkspaceHTTPEndpoint, type WorkspaceHTTPSessionResponse } from '../api/contracts/platform/workspace-http-wire'

export type EndpointMode = 'auto' | 'pending' | 'conflict' | 'sleeping' | 'none' | 'absent'
export type SessionsMode = 'ok' | 'unavailable' | 'revoked' | 'credential-not-allowed' | 'verifier-unavailable' | 'origin-unavailable'
export type HostMode = 'preview' | 'sibling' | 'other-domain'

const SAME_SITE = 'appthrust.test'
const OTHER_DOMAIN = 'preview-isolation.test'
export const SESSION_COOKIE = '__Host-apth-workspace-session'
/** The grant's lifetime (design §3: issued for 55 s). */
const GRANT_LIFETIME_MS = 55_000

type Grant = { workspaceId: string; publishUID: string; host: string; expiresAt: number }

const fresh = () => ({
  endpoint: 'auto' as EndpointMode,
  sessions: 'ok' as SessionsMode,
  host: 'preview' as HostMode,
  grants: new Map<string, Grant>(),
})
let mock = fresh()

export function resetWorkspaceHttp(): void {
  mock = fresh()
}

/** `POST /api/v1/__mock/workspace-http`. */
export function setWorkspaceHttp(input: { endpoint?: EndpointMode; sessions?: SessionsMode; host?: HostMode }) {
  if (input.endpoint) mock.endpoint = input.endpoint
  if (input.sessions) mock.sessions = input.sessions
  if (input.host) mock.host = input.host
  return { endpoint: mock.endpoint, sessions: mock.sessions, host: mock.host }
}

/** The only embedder the Platform accepts: the installation's Console origin. */
export const consoleOrigin = (projectId: string) => `https://console.${projectId}.${SAME_SITE}`

const hex = (input: string) => createHash('sha256').update(input).digest('hex')
/** Fixed for the workspace's life (design §1): it does not change on sleep, wake or restart. */
function previewHost(workspace: Pick<DevWorkspaceRead, 'projectId' | 'id'>): string {
  const label = `pv-${hex(`${workspace.projectId}/${workspace.id}/preview`).slice(0, 32)}`
  switch (mock.host) {
    case 'preview': return `${label}.${workspace.projectId}.${SAME_SITE}`
    case 'sibling': return `mitsumori.${workspace.projectId}.${SAME_SITE}`
    case 'other-domain': return `${label}.${workspace.projectId}.${OTHER_DOMAIN}`
  }
}
/** A canonical, non-zero UUID per workspace (and per host, as a re-created publication would get). */
function publishUID(workspace: Pick<DevWorkspaceRead, 'projectId' | 'id'>): string {
  const digest = hex(`publication/${workspace.projectId}/${workspace.id}/${mock.host}`)
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

/** The workspace's preview endpoint as the Platform reports it; undefined when this Platform reports none. */
export function previewEndpoint(workspace: DevWorkspaceRead): DevWorkspaceHTTPEndpoint | undefined {
  if (mock.endpoint === 'none' || mock.endpoint === 'absent') return undefined
  const base = {
    target: 'preview' as const,
    publishUID: publishUID(workspace),
    sessionPath: `/api/v1/projects/${workspace.projectId}/dev-workspaces/${workspace.id}/http-sessions`,
  }
  const asleep = workspace.phase === 'Sleeping' || workspace.phase === 'Stopping' || workspace.phase === 'Stopped' || mock.endpoint === 'sleeping'
  if (mock.endpoint === 'conflict') return { ...base, state: 'Unavailable', reason: 'HostnameConflict' }
  if (asleep) return { ...base, state: 'Unavailable', reason: 'WorkspaceSleeping' }
  if (mock.endpoint === 'pending' || workspace.phase !== 'Ready') return { ...base, state: 'Pending', reason: 'ProjectionPending' }
  return { ...base, state: 'Ready', url: `https://${previewHost(workspace)}/` }
}

/**
 * A workspace read as the Platform answers it during the migration. The first Ready endpoint records the sticky
 * receipt `DirectPreviewActivated=True` in the workspace's conditions (the workspace controller's job, design §7);
 * it is never cleared, whatever the endpoint does later. `previewUrl` is the Ready endpoint's URL; otherwise it
 * stays the legacy relative proxy path the Platform has always set (served by the legacy `/proxy/preview/` route
 * until migration stage 5; none under `absent`), which the Console uses only for a workspace without an endpoint and
 * without the receipt.
 */
export function publishedWorkspace(workspace: DevWorkspaceRead): DevWorkspaceRead & { httpEndpoints?: DevWorkspaceHTTPEndpoint[] } {
  const endpoint = previewEndpoint(workspace)
  if (endpoint?.state === 'Ready' && !workspace.conditions.some((condition) => condition.type === 'DirectPreviewActivated')) {
    workspace.conditions.push({ type: 'DirectPreviewActivated', status: 'True', reason: 'PreviewEndpointReady', lastTransitionTime: new Date().toISOString() })
  }
  const { previewUrl: _stored, ...rest } = workspace
  const previewUrl = endpoint?.url ?? (mock.endpoint === 'absent' ? undefined : `/api/v1/projects/${workspace.projectId}/dev-workspaces/${workspace.id}/proxy/preview/`)
  const read = { ...rest, conditions: [...workspace.conditions], ...(previewUrl ? { previewUrl } : {}) }
  return endpoint ? { ...read, httpEndpoints: [endpoint] } : read
}

const noStore = { 'Cache-Control': 'no-store' }
const refusal = (status: number, code: string, reason: string, message: string) =>
  Response.json({ error: { code, message, details: { reason } } }, { status, headers: noStore })

/** `POST /api/v1/projects/{projectId}/dev-workspaces/{id}/http-sessions`: a new grant on every call (no Idempotency-Key, no replay). */
export async function issueSession(workspace: DevWorkspaceRead | undefined, request: Request): Promise<Response> {
  if (!workspace) return refusal(404, 'not_found', 'workspace_not_found', 'workspace not found')
  const body = CreateWorkspaceHTTPSessionRequest.safeParse(await request.json().catch(() => undefined))
  if (!body.success || body.data.embedderOrigin !== consoleOrigin(workspace.projectId)) {
    return refusal(400, 'invalid_argument', 'invalid_workspace_session_request', 'target, publishUID or embedderOrigin is invalid')
  }
  switch (mock.sessions) {
    case 'unavailable': return refusal(503, 'unavailable', 'workspace_session_unavailable', 'workspace sessions are unavailable')
    case 'revoked': return refusal(403, 'permission_denied', 'workspace_access_denied', 'project.compute.read is required')
    case 'credential-not-allowed': return refusal(403, 'permission_denied', 'workspace_session_credential_not_allowed', 'A verified OIDC user token is required for workspace HTTP sessions.')
    case 'verifier-unavailable': return refusal(412, 'failed_precondition', 'workspace_session_verifier_unavailable', 'this workspace runtime cannot offer a separate-origin preview')
    case 'origin-unavailable': return refusal(412, 'failed_precondition', 'preview_origin_unavailable', 'preview origin is not enforced yet')
    case 'ok': break
  }
  const endpoint = previewEndpoint(workspace)
  if (endpoint?.state === 'Unavailable' && endpoint.reason === 'WorkspaceSleeping') return refusal(409, 'conflict', 'workspace_not_running', 'workspace is not running')
  if (!endpoint?.url) return refusal(412, 'failed_precondition', 'preview_origin_unavailable', 'preview origin is not ready')
  if (endpoint.publishUID !== body.data.publishUID) return refusal(409, 'conflict', 'workspace_endpoint_changed', 'publication changed')
  const grant = randomBytes(32).toString('base64url')
  const host = previewHost(workspace)
  const expiresAt = Date.now() + GRANT_LIFETIME_MS
  mock.grants.set(grant, { workspaceId: workspace.id, publishUID: endpoint.publishUID, host, expiresAt })
  const origin = `https://${host}`
  const answer: WorkspaceHTTPSessionResponse = {
    resource: { target: 'preview', origin, publishUID: endpoint.publishUID, exchangeUrl: `${origin}/__appthrust/session/${endpoint.publishUID}`, grant, expiresAt: new Date(expiresAt).toISOString(), renewAfterSeconds: 30 },
  }
  return Response.json(answer, { headers: noStore })
}

// ---------------------------------------------------------------- the preview origin (leaf + app)

const SESSION_PATH = /^\/__appthrust\/session\/([0-9a-f-]{36})(\/ready)?$/

function leafError(status: number, reason: string, extra: Record<string, string> = {}) {
  return Response.json({ error: { code: reason, details: { reason } } }, { status, headers: { ...noStore, 'X-Content-Type-Options': 'nosniff', ...extra } })
}

function cookieGrant(request: Request): string | undefined {
  const pairs = (request.headers.get('cookie') ?? '').split(';').map((pair) => pair.trim().split('='))
  const values = pairs.filter(([name]) => name === SESSION_COOKIE).map(([, value]) => value ?? '')
  return values.length === 1 ? values[0] : undefined
}

function validGrant(grant: string | undefined, host: string, publishUID?: string): Grant | undefined {
  const found = grant ? mock.grants.get(grant) : undefined
  if (!found || found.expiresAt <= Date.now() || found.host !== host) return undefined
  return publishUID === undefined || found.publishUID === publishUID ? found : undefined
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!)

/** The headers the edge forces on every preview response (design §7). */
function edgeHeaders(projectId: string): Record<string, string> {
  return {
    'Content-Security-Policy': `sandbox allow-scripts allow-same-origin allow-forms; frame-ancestors ${consoleOrigin(projectId)}; base-uri 'self'; object-src 'none'; worker-src 'none'; form-action 'self'`,
    'Origin-Agent-Cluster': '?1',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...noStore,
  }
}

/** The work-in-progress app: a heading, a button, a saved note in its own storage and an HMR-like WebSocket to its own origin. */
function appPage(workspace: DevWorkspaceRead): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>プレビュー</title>
<style>body{margin:0;padding:24px;font-family:system-ui,sans-serif;color:#1c1917;background:#fff}h1{margin:0 0 8px;font-size:20px}p{margin:8px 0;font-size:14px;color:#57534e}button{margin-top:8px;padding:8px 14px;border:1px solid #d6d3d1;border-radius:6px;background:#fff;font-size:14px}</style></head>
<body><h1>プレビュー: ${escapeHtml(workspace.displayName)}</h1><p>作業中のアプリです。</p>
<p id="hmr" data-state="connecting">更新の通知: つないでいます</p>
<button type="button" id="save">保存する</button><p id="saved" hidden>保存しました</p>
<script>
localStorage.setItem('preview-note', 'written by the preview origin')
const hmr = document.getElementById('hmr')
const socket = new WebSocket('wss://' + location.host + '/__hmr')
socket.onopen = () => { hmr.dataset.state = 'open'; hmr.textContent = '更新の通知: つながりました' }
socket.onclose = () => { if (hmr.dataset.state !== 'open') { hmr.dataset.state = 'closed'; hmr.textContent = '更新の通知: つながりません' } }
document.getElementById('save').onclick = () => { document.getElementById('saved').hidden = false }
</script></body></html>`
}

export interface PreviewOriginServer {
  upgrade(request: Request): boolean
}

/**
 * The preview origin's whole surface, by request Host: CORS-limited exchange and ready check for the
 * Console origin only, the app behind the session Cookie, and its WebSocket (exact preview Origin).
 * A top-level navigation is refused: the preview opens only inside the Console viewer.
 */
export async function previewOriginFetch(request: Request, server: PreviewOriginServer, workspaces: Iterable<DevWorkspaceRead>): Promise<Response | undefined> {
  const url = new URL(request.url)
  const host = (request.headers.get('host') ?? '').toLowerCase()
  const workspace = [...workspaces].find((item) => previewHost(item) === host)
  if (!workspace) return leafError(404, 'not_found')
  const embedder = consoleOrigin(workspace.projectId)
  const origin = request.headers.get('origin')
  const session = SESSION_PATH.exec(url.pathname)
  if (url.pathname.startsWith('/__appthrust/')) {
    if (!session) return leafError(404, 'not_found')
    const cors = { 'Access-Control-Allow-Origin': embedder, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin', 'Referrer-Policy': 'no-referrer' }
    if (origin === null) return leafError(403, 'request_origin_required')
    if (origin !== embedder) return leafError(403, 'request_origin_not_allowed')
    if (url.search) return leafError(400, 'workspace_session_invalid', cors)
    const [, uid, ready] = session
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, ...noStore, 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '60' } })
    }
    if (ready) {
      if (request.method !== 'GET') return leafError(405, 'method_not_allowed', cors)
      const found = validGrant(cookieGrant(request), host, uid)
      if (!found) return leafError(401, 'workspace_session_invalid', cors)
      return Response.json({ state: 'Ready', publishUID: found.publishUID, expiresAt: new Date(found.expiresAt).toISOString() }, { headers: { ...cors, ...noStore, 'X-Content-Type-Options': 'nosniff' } })
    }
    if (request.method !== 'POST') return leafError(405, 'method_not_allowed', cors)
    const body = await request.json().catch(() => undefined) as { grant?: unknown } | undefined
    const grant = typeof body?.grant === 'string' ? body.grant : undefined
    const known = grant ? mock.grants.get(grant) : undefined
    if (!known || known.expiresAt <= Date.now()) return leafError(401, 'workspace_session_invalid', cors)
    if (known.host !== host || known.publishUID !== uid) return leafError(403, 'workspace_session_scope_mismatch', cors)
    const maxAge = Math.floor((known.expiresAt - Date.now()) / 1_000)
    if (maxAge < 1) return leafError(401, 'workspace_session_invalid', cors)
    return new Response(null, { status: 204, headers: { ...cors, ...noStore, 'Set-Cookie': `${SESSION_COOKIE}=${grant}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` } })
  }
  const found = validGrant(cookieGrant(request), host)
  if (!found || found.workspaceId !== workspace.id) return leafError(401, 'workspace_session_invalid')
  if (url.pathname === '/__hmr') {
    if (origin !== `https://${host}`) return leafError(403, 'request_origin_not_allowed')
    return server.upgrade(request) ? undefined : leafError(400, 'websocket_required')
  }
  if (request.headers.get('sec-fetch-dest') === 'document') return leafError(403, 'workspace_viewer_required')
  if (url.pathname !== '/' || request.method !== 'GET') return leafError(404, 'not_found', edgeHeaders(workspace.projectId))
  return new Response(appPage(workspace), { headers: { 'Content-Type': 'text/html; charset=utf-8', ...edgeHeaders(workspace.projectId) } })
}
