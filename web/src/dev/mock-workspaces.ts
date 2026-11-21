// 「自分の作業場所」 in the mock Platform (`GET dev-workspaces?owner=me`,
// extend-lease, stop, delete): six seeded workspaces of the signed-in person and
// the read model Platform derives for every row (platform-api
// handler/dev_workspace_management.go deriveWorkspaceState / decideWorkspaceActions,
// handler/dev_workspace.go summarizeDevWorkspaces). Routes live in ./mock-platform.ts.
import type { DevWorkspaceListSummary, DevWorkspacePhase, DevWorkspaceRead, DevWorkspaceState } from '@appthrust/api-schema/platform-api'

type Actions = NonNullable<DevWorkspaceRead['allowedActions']>

/** Platform's default lease (pkg/devworkspacelease DefaultTTLSeconds) and idle threshold (`idleAfter`). */
export const MOCK_LEASE_TTL_SECONDS = 3_600
export const MOCK_IDLE_AFTER = '168h0m0s'
const IDLE_AFTER_MS = 168 * 3_600_000

const ACTIVE_PHASES: readonly DevWorkspacePhase[] = ['Pending', 'Starting', 'Ready', 'Degraded', 'Committing']

/** The stored `state` (only a Retired seed has one), else the state the phase stands for. */
export function mockWorkspaceState(workspace: DevWorkspaceRead): DevWorkspaceState {
  if (workspace.state) return workspace.state
  switch (workspace.phase) {
    case 'Deleting': return 'Deleting'
    case 'Failed': return 'Failed'
    case 'Stopping': case 'Stopped': return 'Stopped'
    case 'Sleeping': case 'Degraded': case 'Committing': case 'Ready': return workspace.phase
    default: return 'Starting'
  }
}

function decideActions(state: DevWorkspaceState, owner: boolean, write: boolean): Actions {
  owner = owner && write
  const running = state === 'Ready' || state === 'Degraded'
  const stoppable = running || state === 'Starting' || state === 'Sleeping'
  const actions: Actions = {
    open: owner && (stoppable || state === 'Committing'), stop: write && stoppable, start: write && (state === 'Stopped' || state === 'Sleeping'),
    // Exactly Platform's values: a Stopped workspace has `start`, not `restart`; the console runs `start` through the restart route.
    restart: write && (running || state === 'Failed'), extendLease: owner && running, keepLonger: false, commit: owner && state === 'Ready', delete: owner,
    blockedBy: {},
  }
  if (!actions.open) actions.blockedBy.open = 'NotRunnable'
  if (!actions.extendLease) actions.blockedBy.extendLease = 'NotRunning'
  if (!actions.commit) actions.blockedBy.commit = 'NotRunning'
  if (!owner) for (const key of ['open', 'extendLease', 'commit']) actions.blockedBy[key] = 'NotOwner'
  if (!actions.start) actions.blockedBy.start = 'NotAllowed'
  if (!actions.restart) actions.blockedBy.restart = 'NotAllowed'
  if (state === 'Retired') Object.assign(actions.blockedBy, { start: 'Retired', restart: 'Retired' })
  if (!actions.stop) actions.blockedBy.stop = write ? 'Terminal' : 'NotAllowed'
  if (!actions.delete) actions.blockedBy.delete = 'NotAllowed'
  return actions
}

/** The row as Platform answers it for `caller`: product state, allowed actions, lease and source volume. */
export function presentWorkspace(workspace: DevWorkspaceRead, caller: string, write: boolean): DevWorkspaceRead {
  const state = mockWorkspaceState(workspace)
  const owner = workspace.ownerUserId === caller
  const lastActivityAt = workspace.lastActivityAt ?? workspace.createdAt
  return {
    ...workspace,
    state,
    ownedByCaller: owner,
    allowedActions: decideActions(state, owner, write),
    lease: workspace.lease ?? { lastActivityAt, expiresAt: workspace.expiresAt, ttlSeconds: MOCK_LEASE_TTL_SECONDS, source: 'default' },
    sourceVolume: workspace.sourceVolume ?? { state: 'Retained' },
  }
}

/** The list `summary` over the returned rows. */
export function summarizeWorkspaces(rows: readonly DevWorkspaceRead[], now: number): DevWorkspaceListSummary {
  const summary = { total: rows.length, active: 0, sleeping: 0, stopped: 0, retainedSourceVolumes: 0, idleRetained: 0, degraded: 0, retired: 0 }
  for (const row of rows) {
    const active = ACTIVE_PHASES.includes(row.phase)
    if (active) summary.active++
    else if (row.phase === 'Sleeping') summary.sleeping++
    else if (row.phase === 'Stopping' || row.phase === 'Stopped' || row.phase === 'Failed') summary.stopped++
    if (row.state === 'Degraded') summary.degraded++
    if (row.state === 'Retired') summary.retired++
    if (row.sourceVolume?.state !== 'Retained') continue
    summary.retainedSourceVolumes++
    const last = row.lastActivityAt ? Date.parse(row.lastActivityAt) : 0
    if (!active && last < now - IDLE_AFTER_MS) summary.idleRetained++
  }
  return summary
}

const at = (minutesFromNow: number) => new Date(Date.now() + minutesFromNow * 60_000).toISOString()
const DAY = 24 * 60

/**
 * The seeded owner: 山田 太郎 (`p-yamada` in ./mock-console.ts), the signed-in person under the default console
 * role. Another caller (`__mock/role`) sees none of these as theirs. A literal, because the Platform mock is
 * seeded while ./mock-console.ts is still loading.
 */
const SEEDED_OWNER = 'sub-yamada'

/**
 * The signed-in person's six workspaces: Running 2 (one Ready with 42 minutes of
 * lease, one Degraded inside the five-minute warning), Sleeping 2 (one idle for
 * nine days, without a published branch), Stopped 1 (idle, kept until deleted)
 * and Retired 1 (deleted by Platform in five days).
 */
export function seedMyWorkspaces(projectId: string): DevWorkspaceRead[] {
  const base = (id: string) => `/api/v1/projects/${projectId}/dev-workspaces/${id}`
  const workspace = (id: string, fields: Partial<DevWorkspaceRead> & Pick<DevWorkspaceRead, 'displayName' | 'phase'>): DevWorkspaceRead => ({
    id, projectId, scope: 'application', ownerUserId: SEEDED_OWNER, branchName: `appthrust/${id}`, baseRef: 'main', conditions: [], ...fields,
  })
  const lease = (lastActivity: number, expires: number) => ({ lastActivityAt: at(lastActivity), expiresAt: at(expires), ttlSeconds: MOCK_LEASE_TTL_SECONDS, source: 'default' as const })
  return [
    workspace('devws-mitsumori-fix', {
      displayName: '見積の明細を直す', applicationId: 'mitsumori', phase: 'Ready', createdAt: at(-90), lastActivityAt: at(-18), lease: lease(-18, 42),
      branchUrl: 'https://github.com/acme/mitsumori/tree/appthrust/devws-mitsumori-fix', editorUrl: `${base('devws-mitsumori-fix')}/editor/`,
      sourceVolume: { state: 'Retained' },
    }),
    workspace('devws-nippo-filter', {
      displayName: '日報に絞り込みを足す', applicationId: 'nippo', phase: 'Degraded', createdAt: at(-75), lastActivityAt: at(-57), lease: lease(-57, 3),
      degraded: [{ reason: 'PreviewNotListening', message: 'preview is not listening yet' }], sourceVolume: { state: 'Retained' },
    }),
    workspace('devws-keihi-receipt', {
      displayName: '経費に領収書を添付する', applicationId: 'keihi', phase: 'Sleeping', createdAt: at(-4 * DAY), lastActivityAt: at(-2 * DAY), lease: lease(-2 * DAY, -2 * DAY + 60),
      pullRequestUrl: 'https://github.com/acme/keihi/pull/12', sourceVolume: { state: 'Retained', releaseAt: at(5 * DAY) },
    }),
    workspace('devws-uriage-board', {
      displayName: '売上ダッシュボード', scope: 'applicationDraft', draftId: 'draft-uriage-board', phase: 'Sleeping', createdAt: at(-12 * DAY), lastActivityAt: at(-9 * DAY),
      lease: lease(-9 * DAY, -9 * DAY + 60), sourceVolume: { state: 'Retained', releaseAt: at(DAY) },
    }),
    workspace('devws-kintai-csv', {
      displayName: '勤怠を CSV で出す', applicationId: 'kintai', phase: 'Stopped', createdAt: at(-20 * DAY), lastActivityAt: at(-12 * DAY), lease: lease(-12 * DAY, -12 * DAY + 60),
      sourceVolume: { state: 'Retained' },
    }),
    workspace('devws-mitsumori-old', {
      displayName: '見積の旧作業場所', applicationId: 'mitsumori', phase: 'Failed', state: 'Retired', createdAt: at(-6 * DAY), lastActivityAt: at(-3 * DAY),
      lease: lease(-3 * DAY, -3 * DAY + 60), retired: { at: at(-2 * DAY), reason: 'RuntimeTargetReplaced', deleteAt: at(5 * DAY) },
      sourceVolume: { state: 'Retained' },
    }),
  ]
}
