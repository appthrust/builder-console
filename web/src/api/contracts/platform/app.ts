// Platform operations behind the app screens: the project read models every
// app status derives from (applications, stacks, publishes, component
// summaries), an application's releases, a component's release state, env
// vars and logs, and the writes those panels make. Readers keep only the
// fields the console reads (canonical leaf schemas; unknown fields dropped)
// and own two kinds of difference:
// - open enums: release phase, publish phase, access mode, component status
//   and reason, stack/application source kind, env variable state/source;
// - one registered omission: `rollbackCandidates` (Go `omitempty`) reads as [].
// Every other collection is required: Go always writes it, and null (a nil
// slice) is a failure, never "nothing".
// Mutation answers carry the written resource under `resource`. A malformed
// success answer never becomes a value: the write may still have happened, so
// callers read back, never resend.
import {
  Application,
  ApplicationBranchComponentConfig,
  ApplicationBranchComponentConfigEntry,
  ApplicationRelease,
  ApplicationReleaseOverview,
  ApplicationSourceKind,
  ApplicationStack,
  ApplicationTemplateSourceKind,
  BuildFailure,
  ComponentLogLine,
  ComponentLogPod,
  ComponentReleaseState,
  ComponentRollbackCandidate,
  ComponentSummaryPageCursor,
  ComponentSummaryPort,
  ComponentSummaryStatusKey,
  ComponentSummaryStatusReasonKey,
  DnsLabelName,
  Publish,
  PublishAccess as CanonicalPublishAccess,
  PublishPhase,
  ReleasePhase,
  RollbackComponentResponse,
} from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import type {
  AppPublish, AppRelease, AppStack, ComponentConfig, ComponentLogs, ComponentSummary, DeletionAccepted, PlatformApplication,
  PublishAccess, ReleaseOverview, ReleaseState, RollbackStarted,
} from '../../../model/contracts/app'
import { absentMeansEmpty, openEnum } from '../../boundary'
import { platformContract } from '../define'
import { openCanonical } from './build'

const PROJECT = '/api/v1/projects/{projectId}'
const BRANCH_COMPONENT = `${PROJECT}/applications/{applicationId}/branches/{branchId}/components/{componentId}`

export const applicationReader: z.ZodType<PlatformApplication> = Application.pick({ id: true, name: true, defaultBranchId: true, deleting: true, sourceId: true }).extend({
  sourceKind: openCanonical(ApplicationSourceKind).optional(),
  status: z.object({ reason: openEnum(['default_branch_unresolved']).optional() }),
})

const authorization = CanonicalPublishAccess.shape.authorization.unwrap()
export const publishAccessReader: z.ZodType<PublishAccess> = z.object({
  mode: openCanonical(CanonicalPublishAccess.shape.mode.unwrap()).optional(),
  authorization: z.object({ external: authorization.shape.external }).optional(),
  pending: CanonicalPublishAccess.shape.pending.unwrap().pick({ reason: true }).optional(),
})

export const publishReader: z.ZodType<AppPublish> = Publish.pick({ id: true, applicationId: true, branchId: true, componentId: true, publicUrl: true, tailnetUrl: true }).extend({
  phase: openCanonical(PublishPhase).optional(),
  access: publishAccessReader.optional(),
})

export const stackReader: z.ZodType<AppStack> = ApplicationStack.pick({
  id: true, projectId: true, templateId: true, imageRef: true, applicationId: true, branchId: true, webComponentId: true, databaseComponentId: true, sourceRepositoryRefName: true,
}).extend({
  sourceKind: openCanonical(ApplicationTemplateSourceKind),
  publish: publishReader.optional(),
  buildFailure: BuildFailure.pick({ lines: true }).optional(),
})

export const summaryReader: z.ZodType<ComponentSummary> = z.object({
  id: DnsLabelName,
  applicationId: DnsLabelName,
  port: ComponentSummaryPort.optional(),
}).extend({ statusKey: openCanonical(ComponentSummaryStatusKey), reasonKey: openCanonical(ComponentSummaryStatusReasonKey) })
  .transform(({ statusKey, reasonKey, ...identity }) => ({ ...identity, status: statusKey, reason: reasonKey }))

export const releaseReader: z.ZodType<AppRelease> = ApplicationRelease.pick({
  id: true, applicationId: true, branchId: true, componentId: true, version: true, failureReason: true, createdAt: true, startedAt: true, finishedAt: true,
}).extend({ phase: openCanonical(ReleasePhase) })

export const overviewReader: z.ZodType<ReleaseOverview> = ApplicationReleaseOverview.pick({ applicationId: true, branchId: true }).extend({
  components: z.array(z.object({ id: DnsLabelName, latestRelease: releaseReader.optional(), releases: z.array(releaseReader) })),
})

const rollbackCandidates = absentMeansEmpty(z.array(ComponentRollbackCandidate.pick({ transitionId: true, imageTag: true, imageDigest: true, createdAt: true })), {
  path: '/rollbackCandidates',
  evidence: 'platform-api internal/api/dto_release.go:157 omits an empty list (omitempty)',
})
export const releaseStateReader: z.ZodType<ReleaseState> = ComponentReleaseState.pick({ targetImageTag: true, targetImageDigest: true, activeTransitionId: true }).extend({
  rollbackCandidates: rollbackCandidates.schema,
})

export const configReader: z.ZodType<ComponentConfig> = ApplicationBranchComponentConfig.pick({ revision: true }).extend({
  variables: z.array(ApplicationBranchComponentConfigEntry.extend({
    state: openCanonical(ApplicationBranchComponentConfigEntry.shape.state),
    source: openCanonical(ApplicationBranchComponentConfigEntry.shape.source),
  })),
})

export const logsReader: z.ZodType<ComponentLogs> = z.object({
  pods: z.array(ComponentLogPod.pick({ name: true })),
  lines: z.array(ComponentLogLine),
  message: z.string().optional(),
})

/** A write's answer: the written resource (the envelope's operation receipt is not read). */
const resourceOf = <D>(reader: z.ZodType<D>) => z.object({ resource: reader }).transform(({ resource }) => resource)
const listOf = <D>(reader: z.ZodType<D>) => z.object({ data: z.array(reader) }).transform(({ data }) => data)
const deletionReader: z.ZodType<DeletionAccepted> = resourceOf(z.object({ id: DnsLabelName }))

export const listApplicationsContract = platformContract({
  operationId: 'platformApiListApplications',
  method: 'GET',
  routeTemplate: `${PROJECT}/applications`,
  successStatuses: [200],
  reader: listOf(applicationReader),
})

export const listApplicationStacksContract = platformContract({
  operationId: 'platformApiListApplicationStacks',
  method: 'GET',
  routeTemplate: `${PROJECT}/application-stacks`,
  successStatuses: [200],
  reader: listOf(stackReader),
})

export const listProjectPublishesContract = platformContract({
  operationId: 'platformApiListProjectPublishes',
  method: 'GET',
  routeTemplate: `${PROJECT}/publishes`,
  successStatuses: [200],
  reader: listOf(publishReader),
})

/** One page of component summaries; the query follows `nextCursor` until it is absent. */
export const listComponentSummariesContract = platformContract({
  operationId: 'platformApiListComponentSummaries',
  method: 'GET',
  routeTemplate: `${PROJECT}/component-summaries`,
  successStatuses: [200],
  reader: z.object({ items: z.array(summaryReader), nextCursor: ComponentSummaryPageCursor.optional() }),
})

export const listApplicationReleasesContract = platformContract({
  operationId: 'platformApiListApplicationReleases',
  method: 'GET',
  routeTemplate: `${PROJECT}/applications/{applicationId}/releases`,
  successStatuses: [200],
  reader: overviewReader,
})

export const getReleaseStateContract = platformContract({
  operationId: 'platformApiGetApplicationBranchComponentReleaseState',
  method: 'GET',
  routeTemplate: `${BRANCH_COMPONENT}/release-state`,
  successStatuses: [200],
  reader: releaseStateReader,
  fieldPolicies: [rollbackCandidates.policy],
})

/** 202 (platform-api internal/handler/release_idempotency.go:148,155). */
export const rollbackComponentContract = platformContract({
  operationId: 'platformApiRollbackApplicationBranchComponent',
  method: 'POST',
  routeTemplate: `${BRANCH_COMPONENT}/rollback`,
  successStatuses: [202],
  reader: resourceOf<RollbackStarted>(RollbackComponentResponse.pick({ transitionId: true, targetTransitionId: true })),
})

export const getComponentConfigContract = platformContract({
  operationId: 'platformApiGetApplicationBranchComponentConfig',
  method: 'GET',
  routeTemplate: `${BRANCH_COMPONENT}/env-vars`,
  successStatuses: [200],
  reader: configReader,
})

/** 202 (platform-api internal/handler/application_branch_config.go:295,301). */
export const updateComponentConfigContract = platformContract({
  operationId: 'platformApiUpdateApplicationBranchComponentConfig',
  method: 'PUT',
  routeTemplate: `${BRANCH_COMPONENT}/env-vars`,
  successStatuses: [202],
  reader: resourceOf(configReader),
})

export const getComponentLogsContract = platformContract({
  operationId: 'platformApiGetComponentLogs',
  method: 'GET',
  routeTemplate: `${PROJECT}/components/{id}/logs`,
  successStatuses: [200],
  reader: logsReader,
})

/** 202, replayed with the recorded status (platform-api internal/handler/delete_idempotency_recovery.go:214). */
export const deleteApplicationStackContract = platformContract({
  operationId: 'platformApiDeleteApplicationStack',
  method: 'DELETE',
  routeTemplate: `${PROJECT}/application-stacks/{id}`,
  successStatuses: [202],
  reader: deletionReader,
})

/** 202 (platform-api internal/handler/application_source_repository.go:1147). */
export const deleteApplicationSourceRepositoryContract = platformContract({
  operationId: 'platformApiDeleteApplicationSourceRepository',
  method: 'DELETE',
  routeTemplate: `${PROJECT}/application-source-repositories/{id}`,
  successStatuses: [202],
  reader: deletionReader,
})
