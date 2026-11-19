// Application draft operations used by the build and improve sessions (and
// Excel → app's draft writes). Readers reuse the canonical api-schema shapes
// (unknown fields are dropped) and own two kinds of difference:
// - open enums: the draft phase and every job status (and the job hints a
//   newer Platform may extend) read an unknown value as `{ kind: 'unknown' }`;
// - registered omissions: Platform omits an empty job collection (Go
//   `omitempty`), which reads as `[]`. Nothing else is defaulted: an execution
//   without `steps`, a run without `tasks` or a verification without
//   `criteria` cannot be guessed and fails the whole answer.
// Mutation answers carry the written resource under `resource`; that is the
// domain value. A malformed success answer never becomes a value (the write
// may still have happened: callers read back, never resend).
import {
  ApplicationDraft,
  ApplicationDraftConversationTurn,
  ApplicationDraftConversationTurnKind,
  ApplicationDraftConversationTurnStatus,
  ApplicationDraftCreatedSourceRepository,
  ApplicationDraftCreationExecution,
  ApplicationDraftCreationExecutionStatus,
  ApplicationDraftCreationExecutionStep,
  ApplicationDraftCreationExecutionStepStatus,
  ApplicationDraftCreationPlanGeneration,
  ApplicationDraftCreationPlanGenerationStatus,
  ApplicationDraftCreationPlanValidation,
  DnsLabelName,
  ApplicationDraftImplementationFailure,
  ApplicationDraftImplementationFailureReason,
  ApplicationDraftImplementationRun,
  ApplicationDraftImplementationRunStatus,
  ApplicationDraftImplementationStep,
  ApplicationDraftImplementationTask,
  ApplicationDraftImplementationTaskStatus,
  ApplicationDraftPhase,
  ApplicationDraftWorkbookSummary,
} from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import {
  RUN_FAILURE_REASONS,
  type BuildDraft, type BuildDraftList, type BuildExecution, type BuildExecutionStep, type BuildGeneration, type BuildTurn, type CreationPlanValidation, type DraftDeletion, type ImplementationRun, type ImplementationTask,
} from '../../../model/contracts/build'
import { absentMeansEmpty, appendResponseIssues, independentRows, openEnum, unreadableRowIssues, type ResponseIssue } from '../../boundary'
import { platformContract } from '../define'
import { excelAnalysisReader, excelProgressReader, uiDesignReader } from './excel'
import { creationApprovalReader, creationPlanReader } from './stored-plan'

// A present but unreadable value is not an absent one. No part of it escapes the reader.
const unreadable = z.unknown().transform(() => ({ kind: 'unknown' as const }))
const storedPlan = z.union([creationPlanReader.transform((value) => ({ kind: 'known' as const, value })), unreadable])
const storedApproval = z.union([creationApprovalReader.transform((value) => ({ kind: 'known' as const, value })), unreadable])

export function draftRecoveries(draft: BuildDraft, prefix = ''): ResponseIssue[] {
  const issues: ResponseIssue[] = []
  if (draft.creationPlanUnreadable) issues.push({ path: `${prefix}/creationPlan`, code: 'invalid_value' })
  if (draft.creationExecutions.some((execution) => execution.approvalUnreadable)) issues.push({ path: `${prefix}/creationExecutions/*/approval`, code: 'invalid_value' })
  if (draft.implementationRuns.some((run) => run.failureUnreadable)) issues.push({ path: `${prefix}/implementationRuns/*/failure`, code: 'invalid_value' })
  return issues
}

/** Platform projection fields whose missing reference is sent as "", otherwise a DNS label. */
export const dnsLabelOrEmpty = z.union([z.literal(''), DnsLabelName])

/** The canonical enum's values, read as an open enum (shared by this file and workspace.ts). */
export function openCanonical<K extends string>(canonical: { options: readonly K[] }) {
  return openEnum(canonical.options as readonly [K, ...K[]])
}

const DRAFT_OMITS = 'platform-api internal/api/dto_application_draft.go'

// The retired workspace a turn or plan generation replaced (APT-1264): present only on the record that switched to a new
// workspace. Restated here until the published api-schema carries it; an older Platform never sends it.
const replacedDevWorkspaceId = z.string().optional()

export const turnReader: z.ZodType<BuildTurn> = ApplicationDraftConversationTurn.extend({
  // A turn without `kind` predates the field and is a conversation turn (canonical default).
  kind: openCanonical(ApplicationDraftConversationTurnKind).default({ kind: 'known', value: 'conversation' }),
  status: openCanonical(ApplicationDraftConversationTurnStatus),
  excelProgress: excelProgressReader.optional(),
  uiDesign: uiDesignReader.optional(),
  replacedDevWorkspaceId,
})

export const generationReader: z.ZodType<BuildGeneration> = ApplicationDraftCreationPlanGeneration.extend({
  status: openCanonical(ApplicationDraftCreationPlanGenerationStatus),
  stage: openCanonical(ApplicationDraftCreationPlanGeneration.shape.stage.unwrap()).optional(),
  replacedDevWorkspaceId,
})

const stepReader: z.ZodType<BuildExecutionStep> = ApplicationDraftCreationExecutionStep.extend({
  status: openCanonical(ApplicationDraftCreationExecutionStepStatus),
  phase: openCanonical(ApplicationDraftCreationExecutionStep.shape.phase.unwrap()).optional(),
})

export const executionReader: z.ZodType<BuildExecution> = ApplicationDraftCreationExecution.extend({
  status: openCanonical(ApplicationDraftCreationExecutionStatus),
  steps: z.array(stepReader).max(20),
  approval: storedApproval.optional(),
}).transform(({ approval, ...execution }) => ({
  ...execution,
  ...(approval?.kind === 'known' ? { approval: approval.value } : approval ? { approvalUnreadable: true as const } : {}),
}))

export const taskReader: z.ZodType<ImplementationTask> = ApplicationDraftImplementationTask.extend({
  status: openCanonical(ApplicationDraftImplementationTaskStatus),
  failureReason: openCanonical(ApplicationDraftImplementationFailureReason).optional(),
})

// A failed run's `failure` (APT-1158) is absent on an older Platform; its `reason` is an open value. A present but
// unreadable one is reported and dropped: the run then reads as one from an older Platform (`failureReason` only).
const runFailureReason = openEnum(RUN_FAILURE_REASONS)
const runFailure = z.union([
  ApplicationDraftImplementationFailure.transform((failure) => ({ kind: 'known' as const, value: { ...failure, reason: runFailureReason.parse(failure.reason) } })),
  unreadable,
])

// A `failure` beside another status is never used (only a failed run is classified by it).
export const runReader: z.ZodType<ImplementationRun> = ApplicationDraftImplementationRun.extend({
  status: openCanonical(ApplicationDraftImplementationRunStatus),
  step: openCanonical(ApplicationDraftImplementationStep).optional(),
  failureReason: openCanonical(ApplicationDraftImplementationFailureReason).optional(),
  failure: runFailure.optional(),
  tasks: z.array(taskReader),
}).transform(({ failure, ...run }) => ({
  ...run,
  ...(failure?.kind === 'known' ? { failure: failure.value } : failure ? { failureUnreadable: true as const } : {}),
}))

const creationExecutions = absentMeansEmpty(z.array(executionReader).max(20), { path: '/creationExecutions', evidence: `${DRAFT_OMITS}:830 omits an empty list (omitempty); APT-748` })
const creationPlanGenerations = absentMeansEmpty(z.array(generationReader), { path: '/creationPlanGenerations', evidence: `${DRAFT_OMITS}:818 omits an empty list (omitempty)` })
const conversationTurns = absentMeansEmpty(z.array(turnReader).max(50), { path: '/conversationTurns', evidence: `${DRAFT_OMITS}:819 omits an empty list (omitempty)` })
const implementationRuns = absentMeansEmpty(z.array(runReader).max(20), { path: '/implementationRuns', evidence: `${DRAFT_OMITS}:820 omits an empty list (omitempty)` })
const createdSourceRepositories = absentMeansEmpty(z.array(ApplicationDraftCreatedSourceRepository), { path: '/createdSourceRepositories', evidence: `${DRAFT_OMITS}:834 omits an empty list (omitempty)` })

/** The draft policies, registered on every operation whose answer contains a draft at the root. */
export const draftFieldPolicies = [creationExecutions.policy, creationPlanGenerations.policy, conversationTurns.policy, implementationRuns.policy, createdSourceRepositories.policy]
const nested = (prefix: string) => draftFieldPolicies.map((policy) => ({ ...policy, path: `${prefix}${policy.path}` }))

export const draftReader: z.ZodType<BuildDraft> = ApplicationDraft.extend({
  phase: openCanonical(ApplicationDraftPhase),
  excelAnalysis: excelAnalysisReader.optional(),
  uiDesign: uiDesignReader.optional(),
  creationPlan: storedPlan.optional(),
  creationExecutions: creationExecutions.schema,
  creationPlanGenerations: creationPlanGenerations.schema,
  conversationTurns: conversationTurns.schema,
  implementationRuns: implementationRuns.schema,
  createdSourceRepositories: createdSourceRepositories.schema,
}).transform(({ creationPlan, ...draft }) => ({
  ...draft,
  ...(creationPlan?.kind === 'known' ? { creationPlan: creationPlan.value } : creationPlan ? { creationPlanUnreadable: true as const } : {}),
}))

/** A write's answer: the written resource (the envelope's operation receipt is not read). */
const resourceOf = <D>(reader: z.ZodType<D>) => z.object({ resource: reader }).transform(({ resource }) => resource)

const DRAFTS = '/api/v1/projects/{projectId}/application-drafts'
const DRAFT = `${DRAFTS}/{id}`

export const getApplicationDraftContract = platformContract({
  operationId: 'platformApiGetApplicationDraft',
  method: 'GET',
  routeTemplate: DRAFT,
  successStatuses: [200],
  reader: draftReader,
  fieldPolicies: draftFieldPolicies,
  recoveries: draftRecoveries,
})

export const listApplicationDraftsContract = platformContract({
  operationId: 'platformApiListApplicationDrafts',
  method: 'GET',
  routeTemplate: DRAFTS,
  successStatuses: [200],
  reader: independentRows(draftReader, DnsLabelName) satisfies z.ZodType<BuildDraftList>,
  recoveries: (rows) => {
    const issues = [...unreadableRowIssues(rows)]
    for (const draft of rows.data) appendResponseIssues(issues, draftRecoveries(draft, '/data/*'))
    return issues
  },
})

export const createApplicationDraftContract = platformContract({
  operationId: 'platformApiCreateApplicationDraft',
  method: 'POST',
  routeTemplate: DRAFTS,
  successStatuses: [201],
  reader: resourceOf(draftReader),
  fieldPolicies: nested('/resource'),
  recoveries: (draft) => draftRecoveries(draft, '/resource'),
})

export const updateApplicationDraftContract = platformContract({
  operationId: 'platformApiUpdateApplicationDraft',
  method: 'PATCH',
  routeTemplate: DRAFT,
  successStatuses: [200],
  reader: resourceOf(draftReader),
  fieldPolicies: nested('/resource'),
  recoveries: (draft) => draftRecoveries(draft, '/resource'),
})

export const deleteApplicationDraftContract = platformContract({
  operationId: 'platformApiDeleteApplicationDraft',
  method: 'DELETE',
  routeTemplate: DRAFT,
  successStatuses: [202],
  // The canonical delete answer is not an object schema in the published package; its two read fields are restated.
  reader: z.object({ deleted: z.boolean(), id: DnsLabelName }) satisfies z.ZodType<DraftDeletion>,
})

export const cleanupCreationResourcesContract = platformContract({
  operationId: 'platformApiCleanupApplicationDraftCreationResources',
  method: 'POST',
  routeTemplate: `${DRAFT}/creation-cleanups`,
  successStatuses: [200],
  reader: resourceOf(draftReader),
  fieldPolicies: nested('/resource'),
  recoveries: (draft) => draftRecoveries(draft, '/resource'),
})

export const validateCreationPlanContract = platformContract({
  operationId: 'platformApiValidateApplicationDraftCreationPlan',
  method: 'POST',
  routeTemplate: `${DRAFT}/creation-plan-validations`,
  successStatuses: [200],
  reader: resourceOf(ApplicationDraftCreationPlanValidation satisfies z.ZodType<CreationPlanValidation>),
})

/** Begin answers 202 for a new execution and 200 for a replay of the same `clientRequestId`. */
export const beginCreationExecutionContract = platformContract({
  operationId: 'platformApiBeginApplicationDraftCreationExecution',
  method: 'POST',
  routeTemplate: `${DRAFT}/creation-executions`,
  successStatuses: [200, 202],
  reader: resourceOf(draftReader),
  fieldPolicies: nested('/resource'),
  recoveries: (draft) => draftRecoveries(draft, '/resource'),
})

export const runCreationExecutionContract = platformContract({
  operationId: 'platformApiRunApplicationDraftCreationExecution',
  method: 'POST',
  routeTemplate: `${DRAFT}/creation-executions/{executionId}/run`,
  successStatuses: [200, 202],
  reader: resourceOf(draftReader),
  fieldPolicies: nested('/resource'),
  recoveries: (draft) => draftRecoveries(draft, '/resource'),
})

export const createConversationTurnContract = platformContract({
  operationId: 'platformApiCreateApplicationDraftConversationTurn',
  method: 'POST',
  routeTemplate: `${DRAFT}/conversation-turns`,
  successStatuses: [202],
  reader: resourceOf(turnReader),
})

export const createPlanGenerationContract = platformContract({
  operationId: 'platformApiCreateApplicationDraftCreationPlanGeneration',
  method: 'POST',
  routeTemplate: `${DRAFT}/creation-plan-generations`,
  successStatuses: [202],
  reader: resourceOf(generationReader),
})

export const createImplementationRunContract = platformContract({
  operationId: 'platformApiCreateApplicationDraftImplementationRun',
  method: 'POST',
  routeTemplate: `${DRAFT}/implementation-runs`,
  successStatuses: [202],
  reader: resourceOf(runReader),
})

export const cancelImplementationRunContract = platformContract({
  operationId: 'platformApiCancelApplicationDraftImplementationRun',
  method: 'POST',
  routeTemplate: `${DRAFT}/implementation-runs/{runId}/cancel`,
  successStatuses: [202],
  reader: resourceOf(runReader),
})

/** Adding a workbook answers the draft with its new set and the added (or replayed) workbook's summary. */
export const addWorkbookContract = platformContract({
  operationId: 'platformApiAddApplicationDraftWorkbook',
  method: 'POST',
  routeTemplate: `${DRAFT}/workbooks`,
  successStatuses: [201],
  reader: z.object({ draft: draftReader, workbook: ApplicationDraftWorkbookSummary }),
  fieldPolicies: nested('/draft'),
  recoveries: ({ draft }) => draftRecoveries(draft, '/draft'),
})

export const removeWorkbookContract = platformContract({
  operationId: 'platformApiDeleteApplicationDraftWorkbook',
  method: 'DELETE',
  routeTemplate: `${DRAFT}/workbooks/{workbookId}`,
  successStatuses: [200],
  reader: draftReader,
  fieldPolicies: draftFieldPolicies,
  recoveries: draftRecoveries,
})
