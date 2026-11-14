// Build / improve domain values that arrive through the response boundary
// (api/contracts/platform/build.ts, workspace.ts). Feature and model code
// reads these types and the pure operations below, never the wire.
//
// Each type is the canonical api-schema output with the differences the
// readers own: server enums a newer Platform may extend are open values (an
// unknown value is `{ kind: 'unknown' }`, never mapped onto a known one), and
// the draft collections an older server omits when empty are always arrays.
import type {
  ApplicationDraft as CanonicalDraft,
  ApplicationDraftConversationTurn as CanonicalTurn,
  ApplicationDraftConversationTurnKind,
  ApplicationDraftConversationTurnStatus,
  ApplicationDraftCreatedSourceRepository,
  ApplicationDraftCreationExecution as CanonicalExecution,
  ApplicationDraftCreationExecutionStatus,
  ApplicationDraftCreationExecutionStep as CanonicalStep,
  ApplicationDraftCreationExecutionStepStatus,
  ApplicationDraftCreationPlanGeneration as CanonicalGeneration,
  ApplicationDraftCreationPlanGenerationStatus,
  ApplicationDraftCreationPlanValidation,
  ApplicationDraftImplementationFailureReason,
  ApplicationDraftImplementationRun as CanonicalRun,
  ApplicationDraftImplementationRunStatus,
  ApplicationDraftImplementationStep,
  ApplicationDraftImplementationTask as CanonicalTask,
  ApplicationDraftImplementationTaskStatus,
  ApplicationDraftPhase,
  DevWorkspaceCondition as CanonicalCondition,
  DevWorkspacePhase,
  DevWorkspacePreviewDatabase as CanonicalPreviewDatabase,
  DevWorkspacePreviewDatabaseEngine,
  DevWorkspaceRead,
} from '@appthrust/api-schema/platform-api'
import type { OpenValue } from '../../api/boundary'
import type { ExcelAnalysis, ExcelProgress, UiDesign } from './excel'

export type DraftPhase = ApplicationDraftPhase
export type TurnKind = ApplicationDraftConversationTurnKind
export type TurnStatus = ApplicationDraftConversationTurnStatus
export type GenerationStatus = ApplicationDraftCreationPlanGenerationStatus
export type GenerationStage = NonNullable<CanonicalGeneration['stage']>
export type ExecutionStatus = ApplicationDraftCreationExecutionStatus
export type ExecutionStepStatus = ApplicationDraftCreationExecutionStepStatus
export type ExecutionStepPhase = NonNullable<CanonicalStep['phase']>
export type RunStatus = ApplicationDraftImplementationRunStatus
export type RunStep = ApplicationDraftImplementationStep
export type TaskStatus = ApplicationDraftImplementationTaskStatus
export type ImplementationFailureReason = ApplicationDraftImplementationFailureReason
export type WorkspacePhase = DevWorkspacePhase
export type ConditionStatus = CanonicalCondition['status']
export type PreviewDatabaseEngine = DevWorkspacePreviewDatabaseEngine

export type BuildTurn = Omit<CanonicalTurn, 'kind' | 'status' | 'excelProgress' | 'uiDesign'> & { kind: OpenValue<TurnKind>; status: OpenValue<TurnStatus>; excelProgress?: ExcelProgress; uiDesign?: UiDesign }
export type BuildGeneration = Omit<CanonicalGeneration, 'status' | 'stage'> & { status: OpenValue<GenerationStatus>; stage?: OpenValue<GenerationStage> }
export type BuildExecutionStep = Omit<CanonicalStep, 'status' | 'phase'> & { status: OpenValue<ExecutionStepStatus>; phase?: OpenValue<ExecutionStepPhase> }
export type BuildExecution = Omit<CanonicalExecution, 'status' | 'steps'> & { status: OpenValue<ExecutionStatus>; steps: BuildExecutionStep[] }
export type ImplementationTask = Omit<CanonicalTask, 'status' | 'failureReason'> & { status: OpenValue<TaskStatus>; failureReason?: OpenValue<ImplementationFailureReason> }
export type ImplementationRun = Omit<CanonicalRun, 'status' | 'step' | 'failureReason' | 'tasks'> & {
  status: OpenValue<RunStatus>
  step?: OpenValue<RunStep>
  failureReason?: OpenValue<ImplementationFailureReason>
  tasks: ImplementationTask[]
}
export type CreatedSourceRepository = ApplicationDraftCreatedSourceRepository

/**
 * A draft read through the boundary. Its five job collections are always
 * arrays (an older server omits them when empty); `phase` and every job
 * status are open values.
 */
export type BuildDraft = Omit<CanonicalDraft, 'phase' | 'conversationTurns' | 'creationPlanGenerations' | 'creationExecutions' | 'implementationRuns' | 'createdSourceRepositories' | 'excelAnalysis' | 'uiDesign'> & {
  phase: OpenValue<DraftPhase>
  conversationTurns: BuildTurn[]
  creationPlanGenerations: BuildGeneration[]
  creationExecutions: BuildExecution[]
  implementationRuns: ImplementationRun[]
  createdSourceRepositories: CreatedSourceRepository[]
  /** Read through the Excel readers (model/contracts/excel.ts): open kinds, design parts read one by one. */
  excelAnalysis?: ExcelAnalysis
  uiDesign?: UiDesign
}
export type BuildDraftList = { data: BuildDraft[] }
export type CreationPlan = NonNullable<BuildDraft['creationPlan']>
export type ImplementationHandoff = NonNullable<CreationPlan['implementationHandoff']>
export type PublishPreferences = NonNullable<BuildDraft['publishPreferences']>
export type DraftSource = NonNullable<BuildDraft['source']>
export type DraftUiDesign = NonNullable<BuildDraft['uiDesign']>
export type DraftExcelAnalysis = NonNullable<BuildDraft['excelAnalysis']>
/** The server's record of a failed source build (draft `buildFailure`). */
export type DraftBuildFailure = NonNullable<BuildDraft['buildFailure']>
export type CreationPlanValidation = ApplicationDraftCreationPlanValidation
export type DraftDeletion = { deleted: boolean; id: string }

export type WorkspaceCondition = Omit<CanonicalCondition, 'status'> & { status: OpenValue<ConditionStatus> }
/** The workspace's own preview database; an engine this console does not know is an open value, not a broken workspace. */
export type PreviewDatabase = Omit<CanonicalPreviewDatabase, 'engine'> & { engine: OpenValue<PreviewDatabaseEngine> }
/** A workspace HTTP endpoint's state; a state this console does not know is never Ready. */
export type PreviewEndpointState = 'Pending' | 'Ready' | 'Unavailable'
/**
 * The workspace's own preview origin as the Platform reports it (`httpEndpoints[]`, target `preview`).
 * `origin` only when Ready, and only when it is a preview origin of this Console's Project
 * (`https://pv-<32 hex>.<project-domain>`); an endpoint anywhere else reads as an unknown state.
 * Knowing the origin grants nothing: the viewer still needs a session.
 */
export type PreviewEndpoint = { state: OpenValue<PreviewEndpointState>; origin?: string; publishUID: string; reason?: string }
/**
 * The DevWorkspace behind an implementation run's preview: an open phase, open condition statuses and an open
 * database engine. The isolated `preview` endpoint is read; the raw `previewUrl` is not part of the domain value,
 * so a moved workspace cannot fall back to it. An endpoint of a target this console does not know is dropped.
 */
export type PreviewWorkspace = Omit<DevWorkspaceRead, 'phase' | 'conditions' | 'previewDatabase' | 'previewUrl'> & {
  phase: OpenValue<WorkspacePhase>; conditions: WorkspaceCondition[]; previewDatabase?: PreviewDatabase; preview?: PreviewEndpoint
  /** Legacy same-origin preview (remove at migration stage 5): only for a workspace never moved to its own origin. */
  legacyPreviewUrl?: string
}
/**
 * One grant for the workspace's preview origin (`POST …/http-sessions`). `grant` is a short-lived credential:
 * hold it in memory only, hand it to the exchange once and drop it; never store, log, cache or put it in a URL.
 */
export type PreviewSession = { origin: string; publishUID: string; exchangeUrl: string; grant: string; expiresAt: string; renewAfterSeconds: number }

/**
 * The known value, or `undefined` when this client does not know it. Only for
 * "is it this known value?" questions, where an unknown value is safely "no":
 * it never equals success, failure or any permission.
 */
export function knownValue<K extends string>(value: OpenValue<K> | undefined): K | undefined {
  return value?.kind === 'known' ? value.value : undefined
}

/** Whether `value` is one of `values`; an unknown value is none of them. */
export function isOneOf<K extends string>(value: OpenValue<K> | undefined, ...values: K[]): boolean {
  const known = knownValue(value)
  return known !== undefined && values.includes(known)
}

/** A turn, generation, execution, run or task as a job: running, settled, or in a state this client cannot judge. */
export type JobState = 'active' | 'settled' | 'unknown'

export function jobState(job: { status: OpenValue<string> } | undefined): JobState {
  if (!job) return 'settled'
  if (job.status.kind === 'unknown') return 'unknown'
  return job.status.value === 'pending' || job.status.value === 'running' ? 'active' : 'settled'
}
