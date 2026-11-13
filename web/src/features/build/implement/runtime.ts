import { devWorkspaceProxyUrl } from '../../../api/workspace'
import { isOneOf, type ImplementationTask, type PreviewWorkspace } from '../../../model/contracts/build'

/** Only a workspace known to be Ready has a preview; a phase this console does not know is not Ready. */
export function implementationPreviewUrl(workspace: PreviewWorkspace): string | undefined {
  return isOneOf(workspace.phase, 'Ready') && workspace.previewUrl ? devWorkspaceProxyUrl(workspace.previewUrl) : undefined
}

/**
 * The workspace's preview database as the build page tells it (design §6.4). `none`: the
 * workspace has no preview database (older or analysis-only workspaces). `sleeping`: the
 * workspace's compute is scaled down and its data kept. `ready` is SQL connectivity only;
 * `ready-verified` additionally needs the AI's own data check. `unsupported`: an engine this
 * console does not know; only the database's own actions pause, the rest of the workspace is read as usual.
 */
export type PreviewDatabaseStatus = 'none' | 'starting' | 'sleeping' | 'unavailable' | 'ready-unverified' | 'ready-verified' | 'unsupported'

/** Not-ready reasons the user does not act on: they resolve by themselves (`Pending`: the controller has not reported yet) or when the next implementation task restarts the workspace. */
const WAITING_REASONS: Record<string, 'starting' | 'sleeping'> = {
  Pending: 'starting', PreviewDatabaseProvisioning: 'starting', PreviewDatabaseStarting: 'starting', PreviewDatabaseResetting: 'starting', StorageVolumeProvisioning: 'starting',
  WorkspaceSleeping: 'sleeping', WorkspaceStopped: 'sleeping',
}

/** A number of rows/records, or a total/count followed by its number: the note reports observed data, not a plan. */
const ROW_COUNT = /\d[\d,]*\s*(?:行|件|レコード|rows?\b|records?\b)/i
const TOTAL = /(?:合計|総計|件数|行数|row count|rows|records|totals?)[^\d\n]{0,12}\d/i

export function previewDatabaseStatus(workspace: PreviewWorkspace, tasks: readonly ImplementationTask[]): PreviewDatabaseStatus {
  const database = workspace.previewDatabase
  if (!database) return 'none'
  if (database.engine.kind === 'unknown') return 'unsupported'
  // Any other not-ready reason (unsupported, crashed, ownership or budget failures) needs the user, not a wait.
  if (!database.ready) return (database.reason && WAITING_REASONS[database.reason]) || 'unavailable'
  // Only a report made against the database running now counts: a reset or restart leaves older reports behind.
  // A condition status this console does not know is not True.
  const readySince = workspace.conditions.find((condition) => condition.type === 'PreviewDatabaseReady' && isOneOf(condition.status, 'True'))?.lastTransitionTime
  const latest = tasks.map((task) => task.verification).filter((report) => report !== undefined).sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt))[0]
  const current = latest && (!readySince || Date.parse(latest.reportedAt) >= Date.parse(readySince))
  const verified = current && latest.criteria.some((criterion) => criterion.met && criterion.note !== undefined && (ROW_COUNT.test(criterion.note) || TOTAL.test(criterion.note)))
  return verified ? 'ready-verified' : 'ready-unverified'
}
