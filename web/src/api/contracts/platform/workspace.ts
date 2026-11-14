// The DevWorkspace behind an implementation run (preview endpoint, preview
// database, readiness conditions). The canonical read model with an open
// phase, open condition statuses and an open preview database engine: an
// unknown phase is not Ready, an unknown condition status is not True, and an
// unknown engine pauses only the preview database's own actions. `conditions`
// is required: Go never omits it, and null (a nil slice) is a failure, not
// "no conditions".
//
// The preview runs on the workspace's own origin (APT-798). The workspace
// reports it in `httpEndpoints`; a session for that origin comes from the
// credential exchange `platformApiCreateDevWorkspaceHTTPSession`. During the
// migration only (remove at stage 5), a workspace the Platform has never moved
// (no preview endpoint, no `DirectPreviewActivated=True`) keeps its relative,
// Console-proxied `previewUrl` as `legacyPreviewUrl`; any other `previewUrl`
// is dropped, so a moved workspace can never fall back to it.
//
// The Console's CSP has to admit `https://*.<project-domain>` (it cannot list
// the per-workspace hosts), which also admits the Project's other apps. The
// compensating control lives here: an endpoint or a grant is only usable when
// its origin is exactly `https://pv-<32 lowercase hex>.<project-domain>` for
// the Project domain of the Console's own origin `https://console.<project-domain>`.
// An endpoint elsewhere reads as an unknown state (nothing is embedded or
// requested); a grant elsewhere is a broken answer (its grant is never sent).
import { DevWorkspaceCondition, DevWorkspacePhase, DevWorkspacePreviewDatabase, DevWorkspacePreviewDatabaseEngine, DevWorkspaceRead } from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import { defineResponseContract, openUnion } from '../../boundary'
import type { PreviewEndpoint, PreviewSession, PreviewWorkspace } from '../../../model/contracts/build'
import { platformContract } from '../define'
import { openCanonical } from './build'
import { DevWorkspaceHTTPEndpoint, DevWorkspaceHTTPEndpointState, WorkspaceHTTPSession } from './workspace-http-wire'

const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * The pattern of a workspace preview origin beside `embedder` (the Console's own origin), or undefined when
 * the embedder is not `https://console.<project-domain>` (then no preview origin is trusted at all).
 * Matches the whole string: scheme https, the `pv-` label with exactly 32 lowercase hex digits, the Project
 * domain, no port, no userinfo; `path` admits what may follow the origin.
 */
function previewOriginPattern(embedder: string, path: '' | '(?:/.*)?'): RegExp | undefined {
  const domain = embedder.startsWith('https://console.') ? embedder.slice('https://console.'.length) : undefined
  if (!domain || !DNS_NAME.test(domain)) return undefined
  return new RegExp(`^(https://pv-[0-9a-f]{32}\\.${domain.replaceAll('.', '\\.')})${path}$`)
}

/** The Console's own origin: the page this code runs in. */
const consoleOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin)

/** Whether `origin` is a workspace preview origin of this Console's Project (exact string, nothing normalized). */
export function isPreviewOrigin(origin: string, embedder = consoleOrigin()): boolean {
  return previewOriginPattern(embedder, '')?.test(origin) ?? false
}

/** One `httpEndpoints[]` entry: the `preview` target read strictly, any other target kept out of the domain. */
const endpointReader = openUnion({
  discriminator: 'target',
  identity: z.object({}),
  variants: {
    preview: DevWorkspaceHTTPEndpoint.extend({ state: openCanonical(DevWorkspaceHTTPEndpointState) })
      // Only a Ready endpoint has its URL, and a Ready endpoint without one cannot be opened: broken, not "not ready".
      .refine((endpoint) => endpoint.state.kind !== 'known' || endpoint.state.value !== 'Ready' || endpoint.url !== undefined, { path: ['url'], message: 'Ready endpoint without url' })
      .transform(({ state, url, publishUID, reason }): PreviewEndpoint => {
        const origin = url === undefined ? undefined : previewOriginPattern(consoleOrigin(), '(?:/.*)?')?.exec(url)?.[1]
        // A URL outside this Project's preview origins is an endpoint this console cannot use: unknown, never Ready.
        if (url !== undefined && origin === undefined) return { state: { kind: 'unknown' }, publishUID }
        return { state, publishUID, ...(origin === undefined ? {} : { origin }), ...(reason ? { reason } : {}) }
      }),
  },
})

const workspaceReader: z.ZodType<PreviewWorkspace> = DevWorkspaceRead.extend({
  phase: openCanonical(DevWorkspacePhase),
  conditions: z.array(DevWorkspaceCondition.extend({ status: openCanonical(DevWorkspaceCondition.shape.status) })),
  previewDatabase: DevWorkspacePreviewDatabase.extend({ engine: openCanonical(DevWorkspacePreviewDatabaseEngine) }).optional(),
  httpEndpoints: z.array(endpointReader).optional(),
}).transform(({ httpEndpoints, previewUrl, ...workspace }, context): PreviewWorkspace => {
  const previews = (httpEndpoints ?? []).flatMap((endpoint) => endpoint.kind === 'supported' ? [endpoint.value] : [])
  // The Platform reports at most one preview endpoint; two are a broken answer, never "pick one".
  if (previews.length > 1) {
    context.addIssue({ code: 'custom', path: ['httpEndpoints'], message: 'more than one preview endpoint' })
    return z.NEVER
  }
  // Legacy same-origin preview (remove at migration stage 5): kept only for a workspace the Platform has never
  // moved to its own origin — no preview endpoint and no `DirectPreviewActivated=True` (a sticky receipt: its
  // generation and transition time do not matter) — and only as a path on the Platform API proxy.
  const moved = previews.length > 0 || workspace.conditions.some((condition) => condition.type === 'DirectPreviewActivated' && condition.status.kind === 'known' && condition.status.value === 'True')
  const legacy = !moved && previewUrl?.startsWith('/api/v1/') ? previewUrl : undefined
  return { ...workspace, ...(previews[0] ? { preview: previews[0] } : {}), ...(legacy ? { legacyPreviewUrl: legacy } : {}) }
})

const WORKSPACE = '/api/v1/projects/{projectId}/dev-workspaces/{id}'

export const getDevWorkspaceContract = platformContract({
  operationId: 'platformApiGetDevWorkspace',
  method: 'GET',
  routeTemplate: WORKSPACE,
  successStatuses: [200],
  reader: workspaceReader,
})

/** The restarted workspace (`resource` of the mutation answer). */
export const restartDevWorkspaceContract = platformContract({
  operationId: 'platformApiRestartDevWorkspace',
  method: 'POST',
  routeTemplate: `${WORKSPACE}/restart`,
  successStatuses: [202],
  reader: z.object({ resource: workspaceReader }).transform(({ resource }) => resource),
})

/** The reserved path of the preview origin a grant is exchanged at (design §4: `origin + /__appthrust/session/<publishUID>`). */
export const previewExchangePath = (publishUID: string) => `/__appthrust/session/${publishUID}`

/**
 * A grant for the workspace's preview origin. The origin must be a preview origin of this Console's Project and
 * the exchange URL the reserved path on that origin for the granted publication: a grant answered with anything
 * else is a broken answer and is never sent anywhere.
 */
export const createDevWorkspaceHTTPSessionContract = platformContract({
  operationId: 'platformApiCreateDevWorkspaceHTTPSession',
  method: 'POST',
  routeTemplate: `${WORKSPACE}/http-sessions`,
  successStatuses: [200],
  reader: z.object({
    resource: WorkspaceHTTPSession
      .refine((session) => isPreviewOrigin(session.origin), { path: ['origin'], message: 'origin outside this Project\'s preview origins' })
      .refine((session) => session.exchangeUrl === `${session.origin}${previewExchangePath(session.publishUID)}`, { path: ['exchangeUrl'], message: 'exchange URL outside the granted origin' }),
  }).transform(({ resource }): PreviewSession => ({
    origin: resource.origin, publishUID: resource.publishUID, exchangeUrl: resource.exchangeUrl,
    grant: resource.grant, expiresAt: resource.expiresAt, renewAfterSeconds: resource.renewAfterSeconds,
  })),
})

/** The preview origin's answer to `GET <exchangeUrl>/ready`: the session Cookie came back (not proof that the app works). */
export const previewSessionReadyContract = defineResponseContract({
  operationId: 'workspaceHTTPSessionReady',
  source: 'platform',
  method: 'GET',
  routeTemplate: '/__appthrust/session/{publishUID}/ready',
  successStatuses: [200],
  reader: z.object({ state: z.literal('Ready'), publishUID: z.string(), expiresAt: z.iso.datetime() }),
})
