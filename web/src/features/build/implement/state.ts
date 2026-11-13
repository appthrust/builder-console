import type { BuildFailure } from '../../../model/build'
import { classifyBuildFailure } from '../../../model/build/failure'
import { isOneOf, knownValue, type BuildDraft, type ImplementationHandoff, type ImplementationRun, type ImplementationTask, type RunStep } from '../../../model/contracts/build'
import type { OpenValue } from '../../../api/boundary'
import type { PreviewDatabaseStatus } from './runtime'
import type { PreviewReadiness } from './use-preview-readiness'
import { text } from '../copy'

export interface ImplementationState {
  /** `unsupported`: the run is in a state this console does not know; nothing is retried or started from it. */
  phase: 'idle' | 'starting-workspace' | 'running' | 'pushing' | 'done' | 'failed' | 'unsupported'
  tasks: ImplementationTask[]
  currentTaskId?: string
  previewUrl?: string
  previewStatus?: PreviewReadiness
  /** Unset until the workspace has been read. */
  previewDatabaseStatus?: PreviewDatabaseStatus
  activityTail?: string
  failure?: BuildFailure
  /** Start/retry is being submitted, or its draft inputs are not ready yet. */
  retryPending?: boolean
  workspaceId?: string
  /** The current task's clock, not the run's clock. */
  startedAt?: string
  step?: OpenValue<RunStep>
}

/** At least one task was pushed: the app contains something the AI made, not only the template. */
export function implemented(state: Pick<ImplementationState, 'tasks'>): boolean {
  return state.tasks.some((task) => isOneOf(task.status, 'done'))
}

/** Keep IDs identical to Dashboard applicationImplementationTodoId, including non-ASCII titles. */
export function implementationTodoId(title: string, index: number): string {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  let hash = 0
  if (!ascii) {
    for (const character of title) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  }
  return `todo-${index + 1}-${ascii ? ascii.slice(0, 40) : `task-${hash.toString(16)}`}`
}

function runPhase(run: ImplementationRun): ImplementationState['phase'] {
  switch (knownValue(run.status)) {
    case 'failed': case 'cancelled': return 'failed'
    case 'succeeded': return run.tasks.every((item) => isOneOf(item.status, 'done', 'skipped')) ? 'done' : 'idle'
    case 'pending': case 'running': return knownValue(run.step) === 'pushing' ? 'pushing' : run.currentTaskId ? 'running' : 'starting-workspace'
    case undefined: return 'unsupported'
  }
}

/** The server owns execution and recovery; a reload never rewrites task status. */
export function projectImplementation(draft: Pick<BuildDraft, 'id' | 'updatedAt'>, run?: ImplementationRun, handoff?: ImplementationHandoff): ImplementationState {
  if (!run) return {
    phase: 'idle',
    tasks: (handoff?.tasks ?? []).map((task, index) => ({ id: implementationTodoId(task.title, index), title: task.title, status: { kind: 'known', value: 'pending' } })),
  }
  const task = run.tasks.find((item) => item.id === run.currentTaskId)
  const phase = runPhase(run)
  const stopped = phase === 'failed'
  return {
    phase,
    tasks: stopped ? run.tasks.map((item) => isOneOf(item.status, 'running') ? { ...item, status: { kind: 'known', value: 'failed' } } : item) : run.tasks,
    currentTaskId: run.currentTaskId,
    workspaceId: run.devWorkspaceId || undefined,
    startedAt: task?.startedAt,
    step: run.step,
    activityTail: run.activityTail,
    ...(stopped ? { failure: classifyBuildFailure(run.error || task?.error || (isOneOf(run.status, 'cancelled') ? text.implement.cancelled : text.implement.failed), undefined, 'implement', { draftId: draft.id, executionId: run.id, at: run.finishedAt ?? task?.finishedAt ?? draft.updatedAt }, undefined, undefined, run.failureReason ?? task?.failureReason) } : {}),
  }
}
