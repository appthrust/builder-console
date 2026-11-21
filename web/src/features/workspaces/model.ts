// 「自分の作業場所」 (builder-console.md §2–§4): how the caller's workspaces are
// grouped, which ones 「片づける」 selects, the lease countdown, and where 開く
// goes. Actions come only from Platform's `allowedActions`; nothing here infers
// readiness from URLs or messages, and an unknown state is never "running".
import { isOneOf, knownValue, type BuildDraft } from '../../model/contracts/build'
import type { MyWorkspace, WorkspaceState } from '../../model/contracts/workspace'
import { isImprovementDraft } from '../../model/improve'
import { paths } from '../../routes/paths'

export type WorkspaceGroup = 'running' | 'sleeping' | 'other'

export const WORKSPACE_GROUPS: readonly WorkspaceGroup[] = ['running', 'sleeping', 'other']

/** Compute is up or coming up (platform-api counts these as active). */
const RUNNING_STATES: readonly WorkspaceState[] = ['Ready', 'Degraded', 'Committing', 'Starting']

/** Running, Sleeping, or everything else (Stopped, Retired, Failed, Deleting and states this console does not know). */
export function workspaceGroup(workspace: Pick<MyWorkspace, 'state'>): WorkspaceGroup {
  if (isOneOf(workspace.state, ...RUNNING_STATES)) return 'running'
  if (isOneOf(workspace.state, 'Sleeping')) return 'sleeping'
  return 'other'
}

/** The three groups, each in the server's order (newest activity first). */
export function groupWorkspaces<W extends Pick<MyWorkspace, 'state'>>(workspaces: readonly W[]): Record<WorkspaceGroup, W[]> {
  const groups: Record<WorkspaceGroup, W[]> = { running: [], sleeping: [], other: [] }
  for (const workspace of workspaces) groups[workspaceGroup(workspace)].push(workspace)
  return groups
}

/** The header badge: workspaces whose compute is running. */
export function runningCount(workspaces: readonly Pick<MyWorkspace, 'state'>[]): number {
  return workspaces.filter((workspace) => workspaceGroup(workspace) === 'running').length
}

const GO_UNIT_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }

/** Milliseconds of a Go `time.Duration` string such as `168h0m0s`; undefined when it does not parse. */
export function parseGoDuration(value: string | undefined): number | undefined {
  const text = value?.trim()
  if (!text) return undefined
  if (text === '0') return 0
  let total = 0
  let consumed = 0
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gy)) {
    total += Number(match[1]) * GO_UNIT_MS[match[2]!]!
    consumed += match[0].length
  }
  return consumed === text.length ? total : undefined
}

/** A duration as whole days when it is a whole number of days, else whole hours (`idleAfter` labels). */
export type DurationLabel = { unit: 'days' | 'hours'; value: number }

export function durationLabel(ms: number): DurationLabel {
  const day = 24 * 3_600_000
  return ms >= day && ms % day === 0 ? { unit: 'days', value: ms / day } : { unit: 'hours', value: Math.max(1, Math.round(ms / 3_600_000)) }
}

/**
 * The server's `idleRetained` rule applied to one row: the source data is
 * retained, compute is not running, and the last activity is strictly older
 * than `idleAfterMs` (a row without a time counts as idle, as the server reads
 * a missing time as the zero time).
 */
export function isIdle(workspace: Pick<MyWorkspace, 'state' | 'sourceVolume' | 'lastActivityAt'>, now: number, idleAfterMs: number): boolean {
  if (!isOneOf(workspace.sourceVolume?.state, 'Retained') || workspaceGroup(workspace) === 'running') return false
  const last = workspace.lastActivityAt ? Date.parse(workspace.lastActivityAt) : Number.NaN
  return Number.isNaN(last) || last < now - idleAfterMs
}

/** Rows that can be chosen for deletion: not running, and Platform allows the delete. */
export function isDeletable(workspace: Pick<MyWorkspace, 'state' | 'allowedActions'>): boolean {
  return workspaceGroup(workspace) !== 'running' && workspace.allowedActions?.delete === true
}

/** 「片づける」: the idle Sleeping and Stopped rows the caller may delete. Nothing when `idleAfter` does not parse. */
export function cleanupSelection(workspaces: readonly MyWorkspace[], now: number, idleAfter: string): string[] {
  const idleAfterMs = parseGoDuration(idleAfter)
  if (idleAfterMs === undefined) return []
  return workspaces
    .filter((workspace) => isOneOf(workspace.state, 'Sleeping', 'Stopped') && isDeletable(workspace) && isIdle(workspace, now, idleAfterMs))
    .map((workspace) => workspace.id)
}

/** Warning color from five minutes before the lease runs out (§4). */
export const LEASE_WARNING_MS = 5 * 60_000

/**
 * The lease countdown of a running workspace: whole minutes left (rounded up,
 * 0 once expired), whether it is in the warning window, and whether the caller
 * may extend it. None for a workspace that is not running or has no expiry.
 */
export type LeaseHint = { minutes: number; expired: boolean; warning: boolean; canExtend: boolean }

export function leaseHint(workspace: Pick<MyWorkspace, 'state' | 'lease' | 'allowedActions'>, now: number): LeaseHint | undefined {
  if (workspaceGroup(workspace) !== 'running' || !workspace.lease?.expiresAt) return undefined
  const expiresAt = Date.parse(workspace.lease.expiresAt)
  if (Number.isNaN(expiresAt)) return undefined
  const remaining = expiresAt - now
  return {
    minutes: Math.max(0, Math.ceil(remaining / 60_000)),
    expired: remaining <= 0,
    warning: remaining <= LEASE_WARNING_MS,
    canExtend: workspace.allowedActions?.extendLease === true,
  }
}

/** Whether the work is reachable outside the workspace (a pushed branch or a pull request); deleting loses the rest. */
export function hasPublishedBranch(workspace: Pick<MyWorkspace, 'branchUrl' | 'pullRequestUrl'>): boolean {
  return Boolean(workspace.branchUrl || workspace.pullRequestUrl)
}

type DraftWorkspaces = Pick<BuildDraft, 'id' | 'kind' | 'activeWorkspaceId' | 'implementationWorkspaceId' | 'devWorkspaceId' | 'implementationRuns'>

/** The workspace an AI session page shows: its latest run's, else the session's active, implementation or conversation workspace. */
export function sessionWorkspaceId(draft: Omit<DraftWorkspaces, 'id' | 'kind'>): string | undefined {
  return draft.implementationRuns.at(-1)?.devWorkspaceId || draft.activeWorkspaceId || draft.implementationWorkspaceId || draft.devWorkspaceId || undefined
}

/**
 * Where 開く / 再開する go: the AI session (build or improve page) that uses the
 * workspace, else the build page of the draft it was made for. Undefined when
 * the console has no page for it; then no open action is shown.
 */
export function openHref(workspace: Pick<MyWorkspace, 'id' | 'draftId' | 'scope'>, drafts: readonly DraftWorkspaces[]): string | undefined {
  const session = drafts.find((draft) =>
    draft.activeWorkspaceId === workspace.id || draft.implementationWorkspaceId === workspace.id || draft.devWorkspaceId === workspace.id ||
    draft.implementationRuns.some((run) => run.devWorkspaceId === workspace.id))
    ?? drafts.find((draft) => draft.id === workspace.draftId)
  if (session) return isImprovementDraft(session) ? paths.improve(session.id) : paths.build(session.id)
  return knownValue(workspace.scope) === 'applicationDraft' && workspace.draftId ? paths.build(workspace.draftId) : undefined
}
