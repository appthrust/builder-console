// Operations the create paths use (design W6): the connection catalog that
// decides whether an app may be created, the validations, and the writes that
// make it. Readers reuse the canonical api-schema leaf shapes and keep only the
// fields the create paths read (unknown fields are dropped):
// - every server enum is an open value: an unknown provider state, capability,
//   source kind or category never reads as ready / allowed / available;
// - nothing is defaulted: the collections read here are never omitted by
//   Platform (`data`, `sourceKinds`, `components`, `capabilities`, `sources`,
//   `conditions` have no `omitempty` in internal/api), and the optional ones
//   keep their meaning (`allowedRepositories` absent = every repository,
//   `versions` absent = no version to pin);
// - a write's answer is its `resource`; a malformed success answer never
//   becomes a value (the write may still have happened: callers read back).
import {
  ApplicationDraftCodexUnavailableReason,
  ApplicationDraftCreationToolRegistryResponse,
  ApplicationSourceRepository,
  ApplicationSourceRepositoryValidation,
  ApplicationStack,
  ApplicationStackDefinition,
  ApplicationStackDefinitionComponent,
  ApplicationStackDefinitionConnection,
  ApplicationStackDefinitionVersion,
  ApplicationStackValidation,
  ApplicationStackValidationSection,
  ApplicationTemplateAvailability,
  ApplicationTemplateComponent,
  ApplicationTemplateSourceAvailability,
  ApplicationTemplateSourceKind,
  ApplicationTemplateSummary,
  Domain,
  DomainSource,
  GitHubSourceConnection,
  GitHubSourceConnectionAccount,
  GitHubSourceConnectionCapability,
  GitHubSourceConnectionRepository,
  ProjectOnboardingConnectionStatus,
  Publish,
  PublishAccess,
  RegistryConnection,
} from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import type {
  ConfirmedPublishAccess,
  CreatedPublish,
  CreationTools,
  GitHubRepository,
  PublishDomain,
  RegistryConnection as RegistryConnectionValue,
  SourceConnection,
  SourceRepository,
  SourceRepositoryList,
  SourceRepositoryValidation,
  StackDefinition,
  StackIdentity,
  StackValidation,
  TemplateSummary,
} from '../../../model/contracts/catalog'
import { openEnum } from '../../boundary'
import { platformContract } from '../define'
import { openCanonical } from './build'

const list = <D>(item: z.ZodType<D>) => z.object({ data: z.array(item) })
/** A write's answer: the written resource (the envelope's operation receipt is not read). */
const resourceOf = <D>(reader: z.ZodType<D>) => z.object({ resource: reader }).transform(({ resource }) => resource)

const connectionStatus = openCanonical(ProjectOnboardingConnectionStatus)

export const sourceConnectionReader: z.ZodType<SourceConnection> = GitHubSourceConnection.pick({ id: true, allowedRepositories: true }).extend({
  account: GitHubSourceConnectionAccount.pick({ login: true }),
  capabilities: z.array(openCanonical(GitHubSourceConnectionCapability)),
  status: connectionStatus,
})

export const registryConnectionReader: z.ZodType<RegistryConnectionValue> = RegistryConnection.pick({ id: true, registryHost: true }).extend({ status: connectionStatus })

export const publishDomainReader: z.ZodType<PublishDomain> = Domain.pick({ name: true, usableForPublish: true, publishDnsManaged: true, publishUnavailableReason: true }).extend({
  source: openCanonical(DomainSource),
})

export const templateReader: z.ZodType<TemplateSummary> = ApplicationTemplateSummary.pick({ id: true, displayName: true, githubTemplate: true }).extend({
  category: openEnum(['business', 'framework']).optional(),
  sourceKinds: z.array(openCanonical(ApplicationTemplateSourceKind)),
  components: z.array(ApplicationTemplateComponent.pick({ id: true })),
  availability: ApplicationTemplateAvailability.pick({ available: true }).extend({
    sources: z.array(ApplicationTemplateSourceAvailability.pick({ available: true }).extend({ kind: openCanonical(ApplicationTemplateSourceKind) })),
  }),
})

export const stackDefinitionReader: z.ZodType<StackDefinition> = ApplicationStackDefinition.pick({ id: true, catalogSource: true }).extend({
  components: z.array(ApplicationStackDefinitionComponent.pick({ id: true })),
  versions: z.array(ApplicationStackDefinitionVersion.pick({ name: true, served: true, default: true })).optional(),
  connections: z.array(ApplicationStackDefinitionConnection.pick({ name: true })).optional(),
})

const creationToolsReader: z.ZodType<CreationTools> = ApplicationDraftCreationToolRegistryResponse.pick({ codexAvailable: true, codexPolicy: true }).extend({
  // An unknown reason is not kept: `codexAvailable` alone gates the AI entry.
  codexUnavailableReason: openCanonical(ApplicationDraftCodexUnavailableReason).optional().transform((reason) => (reason?.kind === 'known' ? reason.value : undefined)),
})

export const stackIdentityReader: z.ZodType<StackIdentity> = ApplicationStack.pick({ id: true, templateId: true, applicationName: true, sourceRepositoryRefName: true })

const repositoryShape = ApplicationSourceRepository.shape
const repositoryBuild = repositoryShape.build.unwrap()
const repositoryReadiness = repositoryShape.readiness.unwrap()
const repositoryDestination = repositoryShape.destination.unwrap()

export const sourceRepositoryReader: z.ZodType<SourceRepository> = ApplicationSourceRepository.extend({
  status: openCanonical(repositoryShape.status),
  destination: repositoryDestination.extend({ visibility: openCanonical(repositoryDestination.shape.visibility.unwrap()).optional() }).optional(),
  image: repositoryShape.image.extend({ versioningScheme: openCanonical(repositoryShape.image.shape.versioningScheme.unwrap()).optional() }),
  readiness: repositoryReadiness.extend({ dockerfile: openCanonical(repositoryReadiness.shape.dockerfile), workflow: openCanonical(repositoryReadiness.shape.workflow) }).optional(),
  build: repositoryBuild.extend({ mode: openCanonical(repositoryBuild.shape.mode.unwrap()).optional(), state: openCanonical(repositoryBuild.shape.state) }).optional(),
})

const validationSection = ApplicationStackValidationSection.pick({ valid: true, message: true })
const stackValidationReader: z.ZodType<StackValidation> = ApplicationStackValidation.pick({ valid: true, message: true }).extend({
  source: validationSection,
  runtime: validationSection,
  publish: validationSection.optional(),
})

const external = PublishAccess.shape.authorization.unwrap().shape.external
const confirmedAccessReader: z.ZodType<ConfirmedPublishAccess> = PublishAccess.pick({ pending: true }).extend({
  mode: openCanonical(PublishAccess.shape.mode.unwrap()).optional(),
  authorization: z.object({ external }).optional(),
})

const P = '/api/v1/projects/{projectId}'

export const listSourceConnectionsContract = platformContract({
  operationId: 'platformApiListProjectGitHubSourceConnections',
  method: 'GET',
  routeTemplate: `${P}/source-connections`,
  successStatuses: [200],
  reader: list(sourceConnectionReader),
})

export const listGitHubRepositoriesContract = platformContract({
  operationId: 'platformApiListGitHubSourceConnectionRepositories',
  method: 'GET',
  routeTemplate: `${P}/source-connections/{id}/repositories`,
  successStatuses: [200],
  reader: list(GitHubSourceConnectionRepository satisfies z.ZodType<GitHubRepository>),
})

export const listRegistryConnectionsContract = platformContract({
  operationId: 'platformApiListRegistryConnections',
  method: 'GET',
  routeTemplate: '/api/v1/registry-connections',
  successStatuses: [200],
  reader: list(registryConnectionReader),
})

export const listDomainsContract = platformContract({
  operationId: 'platformApiListDomains',
  method: 'GET',
  routeTemplate: `${P}/domains`,
  successStatuses: [200],
  reader: list(publishDomainReader),
})

export const listTemplatesContract = platformContract({
  operationId: 'platformApiListApplicationTemplates',
  method: 'GET',
  routeTemplate: `${P}/application-templates`,
  successStatuses: [200],
  reader: list(templateReader),
})

export const listStackDefinitionsContract = platformContract({
  operationId: 'platformApiListApplicationStackDefinitions',
  method: 'GET',
  routeTemplate: '/api/v1/application-stack-definitions',
  successStatuses: [200],
  reader: list(stackDefinitionReader),
})

export const creationToolsContract = platformContract({
  operationId: 'platformApiGetApplicationDraftCreationTools',
  method: 'GET',
  routeTemplate: `${P}/application-drafts/creation-tools`,
  successStatuses: [200],
  reader: creationToolsReader,
})

export const listStacksContract = platformContract({
  operationId: 'platformApiListApplicationStacks',
  method: 'GET',
  routeTemplate: `${P}/application-stacks`,
  successStatuses: [200],
  reader: list(stackIdentityReader),
})

export const listSourceRepositoriesContract = platformContract({
  operationId: 'platformApiListApplicationSourceRepositories',
  method: 'GET',
  routeTemplate: `${P}/application-source-repositories`,
  successStatuses: [200],
  reader: list(sourceRepositoryReader) satisfies z.ZodType<SourceRepositoryList>,
})

export const validateSourceRepositoryContract = platformContract({
  operationId: 'platformApiValidateApplicationSourceRepository',
  method: 'POST',
  routeTemplate: `${P}/application-source-repositories/validate`,
  successStatuses: [200],
  reader: ApplicationSourceRepositoryValidation satisfies z.ZodType<SourceRepositoryValidation>,
})

/** 202 with the mutation envelope (platform-api internal/handler/application_source_repository.go:1154). */
export const createSourceRepositoryContract = platformContract({
  operationId: 'platformApiCreateApplicationSourceRepository',
  method: 'POST',
  routeTemplate: `${P}/application-source-repositories`,
  successStatuses: [202],
  reader: resourceOf(sourceRepositoryReader),
})

export const validateStackContract = platformContract({
  operationId: 'platformApiValidateApplicationStack',
  method: 'POST',
  routeTemplate: `${P}/application-stacks/validate`,
  successStatuses: [200],
  reader: stackValidationReader,
})

/** 202 with the mutation envelope (platform-api internal/handler/application_stack_idempotency.go:288). */
export const createStackContract = platformContract({
  operationId: 'platformApiCreateApplicationStack',
  method: 'POST',
  routeTemplate: `${P}/application-stacks`,
  successStatuses: [202],
  reader: resourceOf(stackIdentityReader),
})

/** 202 with the mutation envelope (platform-api internal/handler/publish.go:1631). */
export const createPublishContract = platformContract({
  operationId: 'platformApiCreateProjectPublish',
  method: 'POST',
  routeTemplate: `${P}/publishes`,
  successStatuses: [202],
  reader: resourceOf(Publish.pick({ id: true, publicUrl: true }) satisfies z.ZodType<CreatedPublish>),
})

/** 200 with the observed access and the operation envelope (platform-api internal/handler/publish_access.go:184). */
export const putPublishAccessContract = platformContract({
  operationId: 'platformApiPutPublishAccess',
  method: 'PUT',
  routeTemplate: `${P}/publishes/{publishId}/access`,
  successStatuses: [200],
  reader: resourceOf(confirmedAccessReader),
})
