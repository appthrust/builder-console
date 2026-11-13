// Create / connection-catalog domain values that arrive through the response
// boundary (api/contracts/platform/catalog.ts). Feature and model code reads
// these types, never the wire.
//
// They are evidence for whether an app may be created, so the readers keep
// only what the create paths read and open every server enum: a provider
// state, capability, source kind or template category this console does not
// know is `{ kind: 'unknown' }`, which is never "ready", never a capability and
// never an available source.
import type {
  ApplicationDraftCodexUnavailableReason,
  ApplicationSourceRepository as CanonicalSourceRepository,
  ApplicationTemplateSourceKind,
  CreateApplicationSourceRepositoryRequest,
  CreateApplicationStackRequest,
  DomainSource,
  GitHubSourceConnectionCapability,
  ProjectOnboardingConnectionStatus,
  PublishAccess as CanonicalPublishAccess,
} from '@appthrust/api-schema/platform-api'
import type { OpenValue } from '../../api/boundary'
import type { SharePolicy } from './console'

export type TemplateSourceKind = ApplicationTemplateSourceKind
export type TemplateCategory = 'business' | 'framework'
export type ConnectionStatus = ProjectOnboardingConnectionStatus
export type SourceCapability = GitHubSourceConnectionCapability
export type CodexUnavailableReason = ApplicationDraftCodexUnavailableReason
/** The four audiences of a console app (the Console server's share scope). */
export type ShareScope = Extract<SharePolicy['scope'], { kind: 'known' }>['value']
/** The share policy a create sends and the wizard edits: always a known scope. */
export interface ShareChoice { scope: ShareScope; groupIds: string[]; extraPersonIds: string[] }

/** One source kind of a template and whether this project can use it now. */
export interface TemplateSourceAvailability {
  kind: OpenValue<TemplateSourceKind>
  available: boolean
}

/** A template of the platform catalog (`GET application-templates`), as far as the create paths read it. */
export interface TemplateSummary {
  id: string
  displayName: string
  /** Absent: a framework template (canonical rule). An unknown category is neither business nor framework. */
  category?: OpenValue<TemplateCategory>
  sourceKinds: OpenValue<TemplateSourceKind>[]
  githubTemplate?: { repository: string; repositoryUrl: string; branch?: string }
  /** Only the count is read: it pairs the template with a stack definition. */
  components: { id: string }[]
  availability: { available: boolean; sources: TemplateSourceAvailability[] }
}

/** A platform-shipped (or marketplace, `catalogSource`) stack definition, as far as the pairing reads it. */
export interface StackDefinition {
  id: string
  catalogSource?: string
  components: { id: string }[]
  /** Platform omits `served: false` (Go `omitempty`): only an explicit `true` is served. */
  versions?: { name: string; served?: boolean; default?: boolean }[]
  connections?: { name: string }[]
}

/** A GitHub source connection: who owns new repositories and what the installation may do. */
export interface SourceConnection {
  id: string
  account: { login: string }
  capabilities: OpenValue<SourceCapability>[]
  /** Template allowlist; absent (Go omits an empty list) admits every repository. */
  allowedRepositories?: string[]
  status: OpenValue<ConnectionStatus>
}

export interface RegistryConnection {
  id: string
  registryHost: string
  status: OpenValue<ConnectionStatus>
}

/** A custom-domain base of the project, as far as choosing the publish base reads it. */
export interface PublishDomain {
  name: string
  source: OpenValue<DomainSource>
  usableForPublish: boolean
  publishDnsManaged: boolean
  /** Typed blocker; the canonical schema keeps it a plain string. */
  publishUnavailableReason?: string
}

/** What the create paths need from the platform before anything is made. */
export interface CreateConnections {
  sources: SourceConnection[]
  registries: RegistryConnection[]
  domains: PublishDomain[]
}

/**
 * Whether the AI entry is offered. Only `codexAvailable` gates it; a reason
 * this console does not know is not kept (the entry stays unavailable).
 */
export interface CreationTools {
  codexAvailable: boolean
  codexUnavailableReason?: CodexUnavailableReason
  codexPolicy?: string
}

/** A repository the GitHub source connection can see (picker row). */
export interface GitHubRepository {
  fullName: string
  defaultBranch: string
  private: boolean
}

/** A platform application stack, as far as name checks and the create readback read it. */
export interface StackIdentity {
  id: string
  templateId: string
  applicationName: string
  sourceRepositoryRefName?: string
}

type SourceRepositoryReadiness = NonNullable<CanonicalSourceRepository['readiness']>
type SourceRepositoryBuild = NonNullable<CanonicalSourceRepository['build']>

/** A project source repository; its server states are open values. */
export type SourceRepository = Omit<CanonicalSourceRepository, 'status' | 'build' | 'readiness' | 'destination' | 'image'> & {
  status: OpenValue<CanonicalSourceRepository['status']>
  destination?: Omit<NonNullable<CanonicalSourceRepository['destination']>, 'visibility'> & { visibility?: OpenValue<NonNullable<NonNullable<CanonicalSourceRepository['destination']>['visibility']>> }
  image: Omit<CanonicalSourceRepository['image'], 'versioningScheme'> & { versioningScheme?: OpenValue<NonNullable<CanonicalSourceRepository['image']['versioningScheme']>> }
  readiness?: Omit<SourceRepositoryReadiness, 'dockerfile' | 'workflow'> & { dockerfile: OpenValue<SourceRepositoryReadiness['dockerfile']>; workflow: OpenValue<SourceRepositoryReadiness['workflow']> }
  build?: Omit<SourceRepositoryBuild, 'mode' | 'state'> & { mode?: OpenValue<NonNullable<SourceRepositoryBuild['mode']>>; state: OpenValue<SourceRepositoryBuild['state']> }
}
export type SourceRepositoryList = { data: SourceRepository[] }

/** A platform validation answer (source repository): `valid: false` carries the server's reason. */
export interface SourceRepositoryValidation {
  valid: boolean
  message?: string
}

export interface StackValidationSection { valid: boolean; message: string }
/** A platform validation answer (stack): the failing sections say why. */
export interface StackValidation {
  valid: boolean
  message: string
  source: StackValidationSection
  runtime: StackValidationSection
  publish?: StackValidationSection
}

/** The observed URL access a write answered with; `pending` is not proof of enforcement, an unknown mode matches no share scope. */
export interface ConfirmedPublishAccess {
  mode?: OpenValue<NonNullable<CanonicalPublishAccess['mode']>>
  authorization?: { external?: { appInstallation: string; path: string } }
  pending?: { reason: string; message: string }
}

/** The publish a create/repair wrote (its identity and URL; readiness is read from the publish list). */
export interface CreatedPublish { id: string; publicUrl?: string }

/** Requests are built by model/create.ts; the gateway sends them as-is. */
export type SourceRepositoryRequest = CreateApplicationSourceRepositoryRequest
export type StackRequest = CreateApplicationStackRequest
export type StackSourceRequest = StackRequest['source']
export type StackDefinitionRef = StackRequest['definitionRef']
