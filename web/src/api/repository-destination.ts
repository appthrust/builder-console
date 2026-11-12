// TEMPORARY MIRROR — delete this file when web/package.json moves
// `@appthrust/api-schema` past 0.1.4 to the release that contains the APT-799
// repository-destination contract (appthrust/platform c6d6b2dd85,
// dashboard/packages/api-schema/src/schemas/platform-api/repository-destinations.ts
// and platform-api-router-repository-destinations.ts). Every export below has
// the same name and shape there; importers switch to
// `@appthrust/api-schema/platform-api` and client.ts drops the router spread.
// Only the Project routes the console calls are mirrored; the environment
// settings routes are edited in the Dashboard, never here.
import {
  type ApplicationSourceRepositoryValidation as PublishedSourceRepositoryValidation,
  type CreateApplicationSourceRepositoryRequest as PublishedCreateSourceRepositoryRequest,
  DnsLabelName,
  ErrorEnvelope,
  GitHubSourceConnectionListResponse,
  ProjectScopedParams,
  PublicOperation,
} from '@appthrust/api-schema/platform-api'
import { oc } from '@orpc/contract'
import { z } from 'zod'

export const RepositoryDestination = z.object({
  connectionId: DnsLabelName,
  provider: z.string(),
  displayName: z.string(),
  repositoryNamespace: z.string(),
  registryNamespace: z.string(),
  imageAccessId: DnsLabelName.optional(),
})
export type RepositoryDestination = z.infer<typeof RepositoryDestination>

// Open string: clients must display unknown reasons using message and settingsUrl.
export const RepositoryDestinationBlockedReason = z.string()

export const RepositoryDestinationResolution = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('Resolved'),
    source: z.enum(['Project', 'Environment', 'SingleConnection']),
    revision: z.string(),
    destination: RepositoryDestination,
  }),
  z.object({
    state: z.literal('Blocked'),
    reason: RepositoryDestinationBlockedReason,
    message: z.string(),
    candidateIds: z.array(DnsLabelName).optional(),
    settingsUrl: z.string().optional(),
  }),
])
export type RepositoryDestinationResolution = z.infer<typeof RepositoryDestinationResolution>

export const RepositoryDestinationSelection = z.object({
  connectionId: DnsLabelName,
  imageAccessId: DnsLabelName.optional(),
})
export type RepositoryDestinationSelection = z.infer<typeof RepositoryDestinationSelection>

export const RepositoryDestinationSettings = z.object({
  defaultDestination: RepositoryDestinationSelection.nullable(),
})
export type RepositoryDestinationSettings = z.infer<typeof RepositoryDestinationSettings>

export const PutRepositoryDestinationSettingsRequest = RepositoryDestinationSettings
export type PutRepositoryDestinationSettingsRequest = z.infer<typeof PutRepositoryDestinationSettingsRequest>

export const RepositoryDestinationSettingsMutationResponse = z.object({
  resource: RepositoryDestinationSettings,
  operation: PublicOperation,
})
export type RepositoryDestinationSettingsMutationResponse = z.infer<typeof RepositoryDestinationSettingsMutationResponse>

export const ProjectGitHubSourceConnectionListResponse = GitHubSourceConnectionListResponse.extend({
  repositoryDestination: RepositoryDestinationResolution,
})
export type ProjectGitHubSourceConnectionListResponse = z.infer<typeof ProjectGitHubSourceConnectionListResponse>

/** The published request plus the new `destinationRevision`; `image.imagePath` is already optional there. */
export type CreateApplicationSourceRepositoryRequest = PublishedCreateSourceRepositoryRequest & {
  destinationRevision?: string
}

/** The published validation answer plus the server-computed destination fields. */
export type ApplicationSourceRepositoryValidation = PublishedSourceRepositoryValidation & {
  repositoryDestination: RepositoryDestinationResolution
  repositoryUrl?: string
  imagePath?: string
  tagFilter?: string
  versioningScheme?: 'Alphabetical' | 'SemVer'
}

const headers = z.object({
  'Idempotency-Key': z.string().min(1),
  'If-Match': z.string().min(1),
})
const errors = {
  BAD_REQUEST: { status: 400, data: ErrorEnvelope },
  UNAUTHORIZED: { status: 401, data: ErrorEnvelope },
  FORBIDDEN: { status: 403, data: ErrorEnvelope },
  NOT_FOUND: { status: 404, data: ErrorEnvelope },
  CONFLICT: { status: 409, data: ErrorEnvelope },
  PRECONDITION_FAILED: { status: 412, data: ErrorEnvelope },
  SERVICE_UNAVAILABLE: { status: 503, data: ErrorEnvelope },
} as const

export const platformApiRepositoryDestinationsRouter = {
  platformApiGetProjectRepositoryDestination: oc
    .route({ method: 'GET', path: '/api/v1/projects/{projectId}/repository-destination' })
    .input(ProjectScopedParams)
    .output(RepositoryDestinationResolution)
    .errors(errors),
  platformApiGetProjectRepositoryDestinationSettings: oc
    .route({ method: 'GET', path: '/api/v1/projects/{projectId}/repository-destination-settings' })
    .input(ProjectScopedParams)
    .output(RepositoryDestinationSettings)
    .errors(errors),
  platformApiPutProjectRepositoryDestinationSettings: oc
    .route({ method: 'PUT', path: '/api/v1/projects/{projectId}/repository-destination-settings', inputStructure: 'detailed' })
    .input(z.object({ params: ProjectScopedParams, headers, body: PutRepositoryDestinationSettingsRequest }))
    .output(RepositoryDestinationSettingsMutationResponse)
    .errors(errors),
}
