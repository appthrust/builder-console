import type { ApplicationDraftCreationExecution, ApplicationSourceRepository } from '@appthrust/api-schema/platform-api'
import { buildCopy } from './copy'
import { classifyBuildFailure } from './failure'
import type { ProgressCard } from './types'
import { isProductLanguage } from './wording'
import { deriveCreateProgress, type ProgressInput } from '../progress'

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(ms) ? ms / 1000 : 0))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function isBuildPending(operation: { status: string } | undefined): boolean {
  return operation?.status === 'pending' || operation?.status === 'running'
}

export function executionSteps(execution: ApplicationDraftCreationExecution): NonNullable<ProgressCard['steps']> {
  const copy = buildCopy.progress.steps
  return execution.steps.map((step) => ({
    label: step.tool.endsWith('.validate') ? copy.check
      : step.tool.startsWith('appthrust.applicationSourceRepository.') ? copy.source
        : step.tool === 'appthrust.applicationStack.create' ? copy.release
          : step.tool === 'appthrust.applicationStack.observe' ? execution.approval?.applicationStackRequest?.publish ? copy.url : copy.ready : copy.records,
    state: step.status === 'done' || step.status === 'skipped' ? 'done' : step.status === 'running' ? 'doing' : step.status === 'failed' ? 'failed' : 'todo',
    ...(step.status === 'failed' ? { detail: classifyBuildFailure(step.message ?? execution.error ?? '', undefined, 'prepare').reason } : {}),
  }))
}

type PreparationPhase = 'syncing' | 'building' | 'starting'

function stagedProgress(phase: PreparationPhase, now: number, since?: string, reason?: string, title?: string, buildUrl?: string): ProgressCard {
  const copy = buildCopy.progress.observe
  const active = copy.phases[phase]
  const activeIndex = phase === 'syncing' ? 0 : 1
  const started = Date.parse(since ?? '')
  const elapsed = Number.isFinite(started) ? Math.max(0, now - started) : undefined
  const reasonHint = reason && Object.hasOwn(copy.reasons, reason) ? copy.reasons[reason as keyof typeof copy.reasons] : undefined
  const delayed = elapsed !== undefined && elapsed > active.minutes * 2 * 60_000
  const safeTitle = title && isProductLanguage(title) && !/argo|gitops|release|database|component|cluster|gateway|dns|certificate|placement|runtime|project|team|イメージ/i.test(title) ? title : undefined
  return {
    kind: 'prepare', title: buildCopy.progress.prepare.title, interrupted: false, staged: true,
    steps: [
      { label: copy.source, state: 'done' },
      ...(['syncing', phase === 'syncing' ? 'starting' : phase] as const).map((key, index) => ({
        label: key === 'syncing' && index === activeIndex && safeTitle ? safeTitle : copy.phases[key].label,
        state: index < activeIndex ? 'done' as const : index === activeIndex ? reasonHint ? 'failed' as const : 'doing' as const : 'todo' as const,
        expectation: copy.phases[key].expectation,
        ...(index === activeIndex && elapsed !== undefined ? { elapsedLabel: formatElapsed(elapsed) } : {}),
        ...(index === activeIndex ? { activity: active.activity } : {}),
      })),
    ],
    currentActivity: active.activity,
    ...(phase === 'building' && buildUrl && /^https?:\/\//i.test(buildUrl) ? { buildUrl } : {}),
    ...(reasonHint || delayed ? { delayHint: delayed ? copy.delayed(reasonHint ?? active.hint) : reasonHint } : {}),
  }
}

function observeProgress(execution: ApplicationDraftCreationExecution, now: number): Partial<ProgressCard> | undefined {
  const observe = execution.steps.find((step) => step.tool === 'appthrust.applicationStack.observe')
  if (observe?.phase === 'syncing') return { ...stagedProgress('syncing', now, observe.detail?.since, observe.detail?.reason, observe.title), hint: undefined }
  const steps = executionSteps(execution)
  const sourceDone = steps.some((step) => step.label === buildCopy.progress.steps.source && step.state === 'done')
  return {
    staged: true,
    steps: [
      { label: buildCopy.progress.observe.source, state: sourceDone ? 'done' : 'doing' },
      { label: buildCopy.progress.observe.phases.syncing.label, state: sourceDone ? 'doing' : 'todo' },
      { label: buildCopy.progress.observe.phases.starting.label, state: 'todo' },
    ],
  }
}

/** A source build can fail before the stack or console app binding exists. */
export function sourceBuildFailureProgress(build: ApplicationSourceRepository['build']): ProgressCard | undefined {
  if (build?.state !== 'failed') return undefined
  return {
    kind: 'prepare', title: buildCopy.progress.prepare.title, interrupted: false, staged: true, buildFailed: true,
    steps: [
      { label: buildCopy.progress.observe.source, state: 'done' },
      { label: buildCopy.progress.observe.phases.syncing.label, state: 'done' },
      { label: buildCopy.progress.observe.phases.starting.label, state: 'failed', detail: buildCopy.sourceBuild.failed },
    ],
    ...(build.runUrl && /^https?:\/\//i.test(build.runUrl) ? { buildUrl: build.runUrl } : {}),
  }
}

/** Preparation ends with the template's startup, not its automatically issued URL. */
export function appPreparationProgress(input: ProgressInput, now: number, since?: string): ProgressCard | undefined {
  const failed = sourceBuildFailureProgress(input.sourceRepository?.build)
  if (failed) return failed
  const steps = deriveCreateProgress(input)
  const release = steps.find((step) => step.key === 'release')
  if (release?.state === 'done') return undefined
  const repository = input.sourceRepository
  const imageReady = repository?.conditions.some((condition) => condition.type === 'ImageReady' && condition.status === 'True')
  const building = repository !== undefined && repository.status !== 'ready' && !imageReady
  const phase = building ? 'building' : 'starting'
  const reason = release?.state === 'failed' ? building ? 'build_failed' : 'release_failed' : undefined
  return stagedProgress(phase, now, since, reason, undefined, release?.href)
}

/** Neutral run projection: no workspace, transport, phase, or browser storage dependency. */
export interface ImplementationProgressInput {
  tasks: readonly { id: string; title: string; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; versionLabel?: string }[]
  currentTaskId?: string
  step?: 'request' | 'working' | 'pushing'
  startedAt?: string
  activityTail?: string
}

export function implementationProgress(input: ImplementationProgressInput, now: number): NonNullable<ProgressCard['steps']> {
  const copy = buildCopy.progress.task
  return input.tasks.map((task) => {
    const active = task.id === input.currentTaskId && task.status === 'running'
    const since = Date.parse(input.startedAt ?? '')
    const activity = input.step === 'working' ? copy.working(Boolean(input.activityTail?.trim()))
      : input.step ? copy[input.step] : undefined
    return {
      taskId: task.id,
      label: copy.label(isProductLanguage(task.title) ? task.title : copy.fallback),
      state: task.status === 'running' ? 'doing' : task.status === 'pending' ? 'todo' : task.status === 'failed' ? 'failed' : 'done',
      status: `${copy.status[task.status]}${task.versionLabel && isProductLanguage(task.versionLabel) ? ` · ${task.versionLabel}` : ''}`,
      ...(active && Number.isFinite(since) ? { elapsedLabel: formatElapsed(now - since) } : {}),
      ...(active && activity ? { activity } : {}),
    }
  })
}

/** One ladder, including the retained preparation rungs and final publication readiness. */
export function buildProgress(preparation: ProgressCard | undefined, input: ImplementationProgressInput, now: number, released: boolean): ProgressCard {
  const tasks = implementationProgress(input, now)
  const complete = input.tasks.length > 0 && input.tasks.every((task) => task.status === 'done' || task.status === 'skipped')
  return {
    ...preparation,
    kind: 'prepare', title: buildCopy.progress.prepare.title, staged: true,
    interrupted: preparation?.interrupted ?? false,
    // Raw AI activity belongs exclusively in 「詳しい人向け」.
    activity: undefined, currentActivity: undefined,
    steps: [
      ...(preparation?.steps ?? [buildCopy.progress.observe.source, buildCopy.progress.observe.phases.syncing.label, buildCopy.progress.observe.phases.starting.label].map((label) => ({ label, state: 'done' as const }))),
      ...tasks,
      { label: buildCopy.progress.publishReady, state: preparation?.buildFailed ? 'todo' : complete && released ? 'done' : complete && input.tasks.some((task) => task.status === 'done') ? 'doing' : 'todo' },
    ],
  }
}

/** Lines of the live activity a progress card shows. */
export const ACTIVITY_LINES = 6

/** The last `ACTIVITY_LINES` non-empty lines of an activity tail. */
export function activityLines(text: string | undefined): string[] {
  const lines = (text ?? '').split('\n').map((line) => line.trimEnd()).filter(Boolean)
  return lines.slice(-ACTIVITY_LINES)
}

/** Lease expiry signals interruption, not failure: server-side recovery still owns the run. */
export function progressCard(input: {
  kind: ProgressCard['kind']
  now: number
  operation?: { status: string; startedAt: string; finishedAt?: string; runLeaseExpiresAt?: string; stage?: string; error?: string; activityTail?: string }
  execution?: ApplicationDraftCreationExecution
  phase?: string
  activityTail?: string
}): ProgressCard {
  const { kind, now, operation, execution, phase } = input
  const copy = buildCopy.progress
  const active = isBuildPending(operation)
  const activity = active || phase ? activityLines(input.activityTail ?? operation?.activityTail) : []
  const started = operation ? Date.parse(operation.startedAt) : Number.NaN
  const end = !active && operation?.finishedAt ? Date.parse(operation.finishedAt) : now
  const elapsedLabel = Number.isFinite(started) && Number.isFinite(end) ? formatElapsed(end - started) : undefined
  const lease = operation?.runLeaseExpiresAt ? Date.parse(operation.runLeaseExpiresAt) : Number.NaN
  const interrupted = operation?.status === 'running' && lease < now
  const effectiveKind = active && operation?.stage === 'workspace' || phase === 'starting-workspace' ? 'workspace' : kind
  const failure = operation?.status === 'failed'
    ? classifyBuildFailure(operation.error ?? '', undefined, kind === 'turn' || kind === 'plan' || kind === 'implement' ? kind : 'prepare')
    : undefined
  const content = interrupted ? copy.interrupted
    : failure ? { title: failure.title, hint: failure.reason }
      : active && kind === 'plan' && operation?.stage === 'prepare' ? copy.planPrepare
        : active && kind === 'plan' && operation?.stage === 'read' ? copy.read
          : phase === 'syncing' ? copy.implementationSync
            : phase === 'pushing' ? copy.implementationPush : copy[effectiveKind]
  return {
    kind: effectiveKind, ...content, interrupted,
    ...(elapsedLabel ? { elapsedLabel } : {}),
    ...(activity.length ? { activity } : {}),
    ...(execution ? { steps: executionSteps(execution) } : failure ? { steps: [{ label: failure.title, state: 'failed' as const, detail: failure.reason }] } : {}),
    ...(kind === 'prepare' && execution && !interrupted && !failure ? observeProgress(execution, now) : {}),
  }
}
