// App domain values that arrive through the response boundary
// (api/contracts/platform/app.ts): the Platform read models the app screens
// derive their status from, and the release / settings / logs panels. Feature
// and model code reads these types, never the wire.
//
// Each type keeps only the fields the console reads (the reader drops the
// rest). Server enums a newer Platform may extend are open values: an unknown
// value is `{ kind: 'unknown' }`, never mapped onto a known one, and never
// reads as live, succeeded, applied or editable.
import type {
  ApplicationBranchComponentConfigEntry,
  ApplicationSourceKind as CanonicalApplicationSourceKind,
  ApplicationTemplateSourceKind,
  ComponentSummaryStatusKey,
  ComponentSummaryStatusReasonKey,
  PublishAccessRequest,
  PublishPhase as CanonicalPublishPhase,
  ReleasePhase as CanonicalReleasePhase,
} from '@appthrust/api-schema/platform-api'
import type { OpenValue } from '../../api/boundary'

export type ReleasePhase = CanonicalReleasePhase
export type PublishPhase = CanonicalPublishPhase
export type ComponentStatusKey = ComponentSummaryStatusKey
export type ComponentReasonKey = ComponentSummaryStatusReasonKey
export type StackSourceKind = ApplicationTemplateSourceKind
export type ApplicationSourceKind = CanonicalApplicationSourceKind
export type PublishAccessMode = 'Public' | 'Authenticated'
export type EnvVariableState = ApplicationBranchComponentConfigEntry['state']
export type EnvVariableSource = ApplicationBranchComponentConfigEntry['source']
/** The PUT body of an access change (a request, built by model/access.ts). */
export type PublishAccessChange = PublishAccessRequest

/** A Platform Application as the app screens read it. */
export interface PlatformApplication {
  id: string
  name: string
  /** Empty while deleting or while the list could not resolve it (`status.reason`). */
  defaultBranchId: string
  deleting?: boolean
  sourceKind?: OpenValue<ApplicationSourceKind>
  sourceId?: string
  /** A per-item projection failure; present (known or not) means the item cannot be read as a working application. */
  status: { reason?: OpenValue<'default_branch_unresolved'> }
}

/** The observed access policy of a Publish; desired metadata alone is never proof. */
export interface PublishAccess {
  mode?: OpenValue<PublishAccessMode>
  authorization?: { external?: { appInstallation: string; path: string } }
  pending?: { reason: string }
}

export interface AppPublish {
  id: string
  applicationId: string
  branchId: string
  componentId: string
  publicUrl?: string
  tailnetUrl?: string
  phase?: OpenValue<PublishPhase>
  access?: PublishAccess
}

/** The server's record of a failed source build on a stack. */
export interface StackBuildFailure { lines: string[] }

export interface AppStack {
  id: string
  projectId: string
  templateId: string
  /** The running image reference (「詳しい人向け」). */
  imageRef?: string
  applicationId?: string
  branchId?: string
  webComponentId?: string
  databaseComponentId?: string
  sourceKind: OpenValue<StackSourceKind>
  sourceRepositoryRefName?: string
  /** Creation-time copy of the web publish; the publishes list wins. */
  publish?: AppPublish
  buildFailure?: StackBuildFailure
}

/** One component's status facts. A known status with a reason this console does not know keeps the status. */
export interface ComponentSummary {
  id: string
  applicationId: string
  port?: number
  status: OpenValue<ComponentStatusKey>
  reason: OpenValue<ComponentReasonKey>
}

export interface AppRelease {
  id: string
  applicationId: string
  branchId: string
  componentId: string
  version: string
  phase: OpenValue<ReleasePhase>
  failureReason?: string
  createdAt?: string
  startedAt?: string
  finishedAt?: string
}

export interface ReleaseComponent {
  id: string
  latestRelease?: AppRelease
  releases: AppRelease[]
}

/** An application's release overview for one branch. */
export interface ReleaseOverview {
  applicationId: string
  branchId: string
  components: ReleaseComponent[]
}

export interface RollbackCandidate {
  transitionId: string
  imageTag?: string
  imageDigest: string
  createdAt?: string
}

/** Release state of one component: the running target and the versions it may roll back to. */
export interface ReleaseState {
  targetImageTag?: string
  targetImageDigest?: string
  activeTransitionId?: string
  rollbackCandidates: RollbackCandidate[]
}

/** The rollback the Platform accepted. */
export interface RollbackStarted { transitionId: string; targetTransitionId: string }

export interface EnvVariableEntry {
  key: string
  state: OpenValue<EnvVariableState>
  source: OpenValue<EnvVariableSource>
  sensitive: boolean
  /** Present only for a user variable that is not sensitive. */
  value?: string
  updatedAt?: string
}

export interface ComponentConfig {
  revision: string
  variables: EnvVariableEntry[]
}

export interface ComponentLogs {
  pods: { name: string }[]
  lines: { timestamp?: string; text: string }[]
  message?: string
}

/** A delete the Platform accepted (the written resource's id). */
export interface DeletionAccepted { id: string }
