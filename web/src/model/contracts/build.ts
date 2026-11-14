// Build / improve domain values that arrive through the response boundary
// (api/contracts/platform/build.ts, workspace.ts). Feature and model code
// reads these types and the pure operations below, never the wire.
//
// Each type is the canonical api-schema output with the differences the
// readers own: server enums a newer Platform may extend are open values (an
// unknown value is `{ kind: 'unknown' }`, never mapped onto a known one), a
// plan or source this console cannot use whole is `unsupported` with the part
// it can still show, parts no screen reads are not kept, and the draft
// collections an older server omits when empty are always arrays.
import type {
  ApplicationDraft as CanonicalDraft,
  ApplicationDraftConversationTurn as CanonicalTurn,
  ApplicationDraftConversationTurnKind,
  ApplicationDraftConversationTurnStatus,
  ApplicationDraftCreatedSourceRepository,
  ApplicationDraftCreationPlan,
  ApplicationDraftCreationExecution as CanonicalExecution,
  ApplicationDraftCreationExecutionStatus,
  ApplicationDraftCreationExecutionStep as CanonicalStep,
  ApplicationDraftCreationExecutionStepStatus,
  ApplicationDraftCreationTool,
  ApplicationDraftCreationPlanGeneration as CanonicalGeneration,
  ApplicationDraftCreationPlanGenerationStatus,
  ApplicationDraftImplementationFailureReason,
  ApplicationDraftImplementationHandoff as CanonicalHandoff,
  ApplicationDraftImplementationRun as CanonicalRun,
  ApplicationDraftImplementationRunStatus,
  ApplicationDraftImplementationStep,
  ApplicationDraftImplementationTask as CanonicalTask,
  ApplicationDraftImplementationTaskStatus,
  ApplicationDraftKind,
  ApplicationDraftPhase,
  ApplicationDraftPublishPreferences,
  ApplicationDraftSourceSummary,
  BuildFailure as CanonicalBuildFailure,
  DevWorkspaceCondition as CanonicalCondition,
  DevWorkspacePhase,
  DevWorkspacePreviewDatabase as CanonicalPreviewDatabase,
  DevWorkspacePreviewDatabaseEngine,
  DevWorkspaceRead,
  DevWorkspaceSandboxRuntime,
  DevWorkspaceScope,
  DevWorkspaceSourceVolume,
  PublishReadinessGate,
} from '@appthrust/api-schema/platform-api'
import type { OpenValue, Supported } from '../../api/boundary'
import type { ExcelAnalysis, ExcelProgress, UiDesign } from './excel'

export type DraftPhase = ApplicationDraftPhase
/** `creation` (also when absent) makes a new app; `improvement` changes an existing one. */
export type DraftKind = ApplicationDraftKind
export type CreationTool = ApplicationDraftCreationTool
export type ShareScopeChoice = NonNullable<ApplicationDraftPublishPreferences['shareScope']>
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
export type BuildExecutionStep = Omit<CanonicalStep, 'tool' | 'status' | 'phase'> & { tool: OpenValue<CreationTool>; status: OpenValue<ExecutionStepStatus>; phase?: OpenValue<ExecutionStepPhase> }
/** What a handoff shows and starts: its summary and tasks (its workspace mode, target and repository strategy are the server's alone). */
export type ImplementationHandoff = Pick<CanonicalHandoff, 'summary' | 'tasks'>
/** The approved snapshot an execution runs: the handoff it implements, and whether it asked for a public address. */
export interface ExecutionApproval {
  implementationHandoff?: ImplementationHandoff
  publishRequested: boolean
}
/** An execution; its event log is not read by any screen and is not kept. */
export type BuildExecution = Omit<CanonicalExecution, 'status' | 'steps' | 'approval' | 'events'> & { status: OpenValue<ExecutionStatus>; steps: BuildExecutionStep[]; approval?: ExecutionApproval }
export type ImplementationTask = Omit<CanonicalTask, 'status' | 'failureReason'> & { status: OpenValue<TaskStatus>; failureReason?: OpenValue<ImplementationFailureReason> }
export type ImplementationRun = Omit<CanonicalRun, 'status' | 'step' | 'failureReason' | 'tasks'> & {
  status: OpenValue<RunStatus>
  step?: OpenValue<RunStep>
  failureReason?: OpenValue<ImplementationFailureReason>
  tasks: ImplementationTask[]
}
export type CreatedSourceRepository = ApplicationDraftCreatedSourceRepository

/** The plan as Platform made it, held only when this console knows every value in it (it is changed and sent back, and created from). */
export type CreationPlan = ApplicationDraftCreationPlan
/** What can be shown of any plan, including one with a value this console does not know. */
export interface PlanOverview {
  summary: string
  markdown: string
  implementationHandoff?: ImplementationHandoff
}
/** A plan this console can use whole, or one it can only show (a newer Platform's value, tag or field is in it). */
export type DraftPlan = Supported<CreationPlan, PlanOverview>
export type ExcelSource = ApplicationDraftSourceSummary
/** The draft's source: the Excel workbook set, or a source kind this console does not know. */
export type DraftSource = Supported<ExcelSource, Record<string, never>>
export interface PublishPreferences {
  name?: string
  shareScope?: OpenValue<ShareScopeChoice>
}
/** The server's record of a failed source build (draft `buildFailure`): its redacted lines are what the console shows. */
export type DraftBuildFailure = Pick<CanonicalBuildFailure, 'lines'>

/**
 * A draft read through the boundary. Its five job collections are always
 * arrays (an older server omits them when empty); `phase`, `kind`, the share
 * scope and every job status are open values; the plan and the source may be
 * `unsupported`.
 */
export type BuildDraft = Omit<CanonicalDraft, 'phase' | 'kind' | 'publishPreferences' | 'source' | 'buildFailure' | 'creationPlan' | 'conversationTurns' | 'creationPlanGenerations' | 'creationExecutions' | 'implementationRuns' | 'createdSourceRepositories' | 'excelAnalysis' | 'uiDesign'> & {
  phase: OpenValue<DraftPhase>
  kind?: OpenValue<DraftKind>
  publishPreferences?: PublishPreferences
  source?: DraftSource
  buildFailure?: DraftBuildFailure
  creationPlan?: DraftPlan
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
export type DraftUiDesign = NonNullable<BuildDraft['uiDesign']>
export type DraftExcelAnalysis = NonNullable<BuildDraft['excelAnalysis']>
/** One readiness gate of a validation section: its id and state are open values. */
export interface PlanValidationGate {
  id: OpenValue<PublishReadinessGate['id']>
  state: OpenValue<PublishReadinessGate['state']>
  blocking: boolean
  message: string
}
export interface PlanValidationSection {
  valid: boolean
  message: string
  gates?: PlanValidationGate[]
}
/**
 * The server's verdict on the stored plan, with each section's gates. `valid` with a fingerprint is the server's
 * permission to create; a blocking gate in a state this console does not know as passed withholds it as well
 * (features/build/use-draft-creation.ts `validatePreparationPlan`).
 */
export interface CreationPlanValidation {
  valid: boolean
  message: string
  creationPlanFingerprint?: string
  staticErrors?: string[]
  applicationStackValidation?: { valid: boolean; message: string; source: PlanValidationSection; runtime: PlanValidationSection; publish?: PlanValidationSection }
}

/** The validation's gates in section order (source, runtime, publish). */
export function validationGates(validation: CreationPlanValidation): PlanValidationGate[] {
  const stack = validation.applicationStackValidation
  return [stack?.source, stack?.runtime, stack?.publish].flatMap((section) => section?.gates ?? [])
}
export type DraftDeletion = { deleted: boolean; id: string }

export type WorkspaceCondition = Omit<CanonicalCondition, 'status'> & { status: OpenValue<ConditionStatus> }
/** The workspace's own preview database; an engine this console does not know is an open value, not a broken workspace. */
export type PreviewDatabase = Omit<CanonicalPreviewDatabase, 'engine'> & { engine: OpenValue<PreviewDatabaseEngine> }
/** The DevWorkspace behind an implementation run's preview: its phase, condition statuses, database engine, scope, sandbox runtime and source volume state are open values. */
export type PreviewWorkspace = Omit<DevWorkspaceRead, 'phase' | 'conditions' | 'previewDatabase' | 'scope' | 'runtime' | 'sourceVolume'> & {
  phase: OpenValue<WorkspacePhase>
  conditions: WorkspaceCondition[]
  previewDatabase?: PreviewDatabase
  scope: OpenValue<DevWorkspaceScope>
  runtime?: { sandboxRuntime?: OpenValue<DevWorkspaceSandboxRuntime> }
  sourceVolume?: Omit<DevWorkspaceSourceVolume, 'state'> & { state: OpenValue<DevWorkspaceSourceVolume['state']> }
}

/** The plan when this console knows every value in it: only such a plan is changed, sent back or created from. */
export function knownPlan(draft: Pick<BuildDraft, 'creationPlan'> | undefined): CreationPlan | undefined {
  return draft?.creationPlan?.kind === 'supported' ? draft.creationPlan.value : undefined
}

/** What can be shown of the plan, whether or not this console knows every value in it. */
export function planOverview(draft: Pick<BuildDraft, 'creationPlan'> | undefined): PlanOverview | undefined {
  const plan = draft?.creationPlan
  if (!plan) return undefined
  return plan.kind === 'supported' ? plan.value : plan.identity
}

/** The draft's kind (absent is `creation`); `unknown` is neither a new app nor an improvement. */
export function draftKind(draft: Pick<BuildDraft, 'kind'>): DraftKind | 'unknown' {
  if (!draft.kind) return 'creation'
  return draft.kind.kind === 'known' ? draft.kind.value : 'unknown'
}

/** The Excel workbook set, when the draft's source is one; a source kind this console does not know is not. */
export function excelSource(draft: Pick<BuildDraft, 'source'> | undefined): ExcelSource | undefined {
  return draft?.source?.kind === 'supported' ? draft.source.value : undefined
}

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
