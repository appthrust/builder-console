// Mirror of the Platform workspace HTTP session contract (APT-798, design
// `preview-origin-isolation-design.md` §4). The published `@appthrust/api-schema`
// does not contain it yet; this file copies, field for field, the shapes of
// appthrust/platform `dashboard/packages/api-schema/src/schemas/platform-api/dev-workspaces.ts`
// (`DevWorkspaceHTTPEndpoint`, `CreateWorkspaceHTTPSessionRequest`,
// `WorkspaceHTTPSession`, `WorkspaceHTTPSessionResponse`, `WorkspaceHTTPSessionErrorReason`)
// and its router entry `platformApiCreateDevWorkspaceHTTPSession`
// (`platform-api-router-projects.ts`), as of branch feat/apt-798-preview-origin-stage1
// (slice A 8d4407c46f plus the working-tree reason `workspace_session_verifier_unavailable`).
//
// Follow-up: once an `@appthrust/api-schema` release contains the operation,
// delete this file, import these schemas from the package and drop the mirror
// from `platformRouter` (../define.ts). Nothing else may define them.
import { ErrorEnvelope, ProjectChildParams } from '@appthrust/api-schema/platform-api'
import { oc } from '@orpc/contract'
import { z } from 'zod'

/** Per-operation transport properties (read by the Platform transport, ../../client.ts). */
export type PlatformOperationMeta = {
  /**
   * A non-idempotent credential exchange: every call is a fresh authorization
   * that mints a new credential. The transport sends no Idempotency-Key and
   * nothing retries or replays it; the next attempt asks for a new grant.
   */
  credentialExchange?: true
}

export const WorkspaceHTTPTarget = z.literal('preview')
export const WorkspaceHTTPPublishUID = z.string().regex(
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
)
/** Exact HTTPS origin, without path, query, fragment, credentials or port. */
export const WorkspaceHTTPOrigin = z.string().max(261).regex(
  /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
)
export const DevWorkspaceHTTPEndpointState = z.enum(['Pending', 'Ready', 'Unavailable'])
export const DevWorkspaceHTTPEndpoint = z.object({
  target: WorkspaceHTTPTarget,
  state: DevWorkspaceHTTPEndpointState,
  url: z.url({ protocol: /^https$/ }).optional(),
  publishUID: WorkspaceHTTPPublishUID,
  sessionPath: z.string().regex(/^\/api\/v1\/projects\/[^/]+\/dev-workspaces\/[^/]+\/http-sessions$/),
  reason: z.string().max(256).nullable().optional(),
})
export type DevWorkspaceHTTPEndpoint = z.infer<typeof DevWorkspaceHTTPEndpoint>

export const CreateWorkspaceHTTPSessionRequest = z.object({
  target: WorkspaceHTTPTarget,
  publishUID: WorkspaceHTTPPublishUID,
  embedderOrigin: WorkspaceHTTPOrigin,
})
export type CreateWorkspaceHTTPSessionRequest = z.infer<typeof CreateWorkspaceHTTPSessionRequest>

export const WorkspaceHTTPSession = z.object({
  target: WorkspaceHTTPTarget,
  origin: WorkspaceHTTPOrigin,
  /** origin + /__appthrust/session/<publishUID> */
  exchangeUrl: z.url({ protocol: /^https$/ }),
  /** Sensitive signed endpoint capability. Memory only; never persist, log or put in a URL. */
  grant: z.string().min(1).max(4096),
  expiresAt: z.iso.datetime(),
  renewAfterSeconds: z.literal(30),
  publishUID: WorkspaceHTTPPublishUID,
})
export type WorkspaceHTTPSession = z.infer<typeof WorkspaceHTTPSession>
export const WorkspaceHTTPSessionResponse = z.object({ resource: WorkspaceHTTPSession })
export type WorkspaceHTTPSessionResponse = z.infer<typeof WorkspaceHTTPSessionResponse>

export const WorkspaceHTTPSessionErrorReason = z.enum([
  'invalid_workspace_session_request',
  'unauthenticated', 'workspace_access_denied', 'workspace_not_found',
  'workspace_session_credential_not_allowed',
  'workspace_not_running', 'workspace_endpoint_changed', 'preview_origin_unavailable',
  'workspace_runtime_unavailable', 'workspace_session_unavailable',
  'workspace_session_verifier_unavailable',
])
export type WorkspaceHTTPSessionErrorReason = z.infer<typeof WorkspaceHTTPSessionErrorReason>

/** `platformApiCreateDevWorkspaceHTTPSession`, as the Platform router declares it. */
export const workspaceHTTPSessionRouter = {
  platformApiCreateDevWorkspaceHTTPSession: oc
    .$meta<PlatformOperationMeta>({})
    .meta({ credentialExchange: true })
    .route({
      method: 'POST',
      path: '/api/v1/projects/{projectId}/dev-workspaces/{id}/http-sessions',
      summary: 'Issue a short-lived workspace HTTP session grant',
      successStatus: 200,
    })
    .input(ProjectChildParams.extend(CreateWorkspaceHTTPSessionRequest.shape))
    .output(WorkspaceHTTPSessionResponse)
    .errors({
      BAD_REQUEST: { status: 400, data: ErrorEnvelope },
      UNAUTHORIZED: { status: 401, data: ErrorEnvelope },
      FORBIDDEN: { status: 403, data: ErrorEnvelope },
      NOT_FOUND: { status: 404, data: ErrorEnvelope },
      CONFLICT: { status: 409, data: ErrorEnvelope },
      PRECONDITION_FAILED: { status: 412, data: ErrorEnvelope },
      UNAVAILABLE: { status: 503, data: ErrorEnvelope },
    }),
}
