// The DevWorkspace behind an implementation run (preview URL, preview
// database, readiness conditions). The canonical read model with an open
// phase, open condition statuses and an open preview database engine: an
// unknown phase is not Ready, an unknown condition status is not True, and an
// unknown engine pauses only the preview database's own actions. `conditions`
// is required: Go never omits it, and null (a nil slice) is a failure, not
// "no conditions".
//
// 「自分の作業場所」 rows (`owner=me` list, extend-lease, stop) read only the
// fields the drawer shows, with open `state`, `scope` and source volume state.
import {
  DevWorkspaceCondition,
  DevWorkspaceListSummary,
  DevWorkspacePhase,
  DevWorkspacePreviewDatabase,
  DevWorkspacePreviewDatabaseEngine,
  DevWorkspaceRead,
  DevWorkspaceScope,
  DevWorkspaceSourceVolume,
  DevWorkspaceState,
} from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import type { OpenValue } from '../../boundary'
import type { PreviewWorkspace } from '../../../model/contracts/build'
import type { MyWorkspace, MyWorkspaceList, WorkspaceDeletion, WorkspaceState } from '../../../model/contracts/workspace'
import { platformContract } from '../define'
import { openCanonical } from './build'

const workspaceReader: z.ZodType<PreviewWorkspace> = DevWorkspaceRead.extend({
  phase: openCanonical(DevWorkspacePhase),
  conditions: z.array(DevWorkspaceCondition.extend({ status: openCanonical(DevWorkspaceCondition.shape.status) })),
  previewDatabase: DevWorkspacePreviewDatabase.extend({ engine: openCanonical(DevWorkspacePreviewDatabaseEngine) }).optional(),
})

/** The product state a phase stands for, on a server that predates `state` (platform-api deriveWorkspaceState). */
const STATE_BY_PHASE: Record<DevWorkspacePhase, WorkspaceState> = {
  Pending: 'Starting', Starting: 'Starting', Ready: 'Ready', Degraded: 'Degraded', Committing: 'Committing',
  Sleeping: 'Sleeping', Stopping: 'Stopped', Stopped: 'Stopped', Failed: 'Failed', Deleting: 'Deleting',
}

const fields = DevWorkspaceRead.shape
const myWorkspaceReader: z.ZodType<MyWorkspace> = DevWorkspaceRead.pick({
  id: true, projectId: true, displayName: true, applicationId: true, applicationBranchId: true, draftId: true,
  branchUrl: true, pullRequestUrl: true, lastActivityAt: true, ownedByCaller: true, retired: true, allowedActions: true,
}).extend({
  scope: openCanonical(DevWorkspaceScope),
  phase: openCanonical(DevWorkspacePhase),
  state: openCanonical(DevWorkspaceState).optional(),
  lease: fields.lease.unwrap().pick({ lastActivityAt: true, expiresAt: true, ttlSeconds: true }).optional(),
  sourceVolume: DevWorkspaceSourceVolume.pick({ releaseAt: true }).extend({ state: openCanonical(DevWorkspaceSourceVolume.shape.state) }).optional(),
}).transform(({ phase, state, ...workspace }): MyWorkspace => ({
  ...workspace,
  state: state ?? (phase.kind === 'known' ? { kind: 'known', value: STATE_BY_PHASE[phase.value] } : phase) as OpenValue<WorkspaceState>,
}))

const myWorkspaceListReader: z.ZodType<MyWorkspaceList> = z.object({
  data: z.array(myWorkspaceReader),
  summary: DevWorkspaceListSummary,
  idleAfter: z.string(),
})

/** The written workspace of a mutation answer (`resource`). */
const resourceOf = <T>(reader: z.ZodType<T>) => z.object({ resource: reader }).transform(({ resource }) => resource)

const deletionReader: z.ZodType<WorkspaceDeletion> = z.object({ operation: z.object({ resource: z.object({ id: z.string().min(1) }) }) })
  .transform(({ operation }) => ({ id: operation.resource.id }))

const WORKSPACES = '/api/v1/projects/{projectId}/dev-workspaces'
const WORKSPACE = `${WORKSPACES}/{id}`

export const getDevWorkspaceContract = platformContract({
  operationId: 'platformApiGetDevWorkspace',
  method: 'GET',
  routeTemplate: WORKSPACE,
  successStatuses: [200],
  reader: workspaceReader,
})

/** The restarted workspace (`resource` of the mutation answer). */
export const restartDevWorkspaceContract = platformContract({
  operationId: 'platformApiRestartDevWorkspace',
  method: 'POST',
  routeTemplate: `${WORKSPACE}/restart`,
  successStatuses: [202],
  reader: resourceOf(workspaceReader),
})

/** The caller's workspaces with `owner: 'me'` (platform-api handler/dev_workspace.go list, 200). */
export const listDevWorkspacesContract = platformContract({
  operationId: 'platformApiListDevWorkspaces',
  method: 'GET',
  routeTemplate: WORKSPACES,
  successStatuses: [200],
  reader: myWorkspaceListReader,
})

/** Renews the activity lease of the caller's own running workspace (202; 409 when it is not running). */
export const extendDevWorkspaceLeaseContract = platformContract({
  operationId: 'platformApiExtendDevWorkspaceLease',
  method: 'POST',
  routeTemplate: `${WORKSPACE}/extend-lease`,
  successStatuses: [202],
  reader: resourceOf(myWorkspaceReader),
})

/** Stops compute; the source data stays until the workspace is deleted (202). */
export const stopDevWorkspaceContract = platformContract({
  operationId: 'platformApiStopDevWorkspace',
  method: 'POST',
  routeTemplate: `${WORKSPACE}/stop`,
  successStatuses: [202],
  reader: resourceOf(myWorkspaceReader),
})

/** Deletes the workspace and its source data (202, replayed for the same Idempotency-Key). */
export const deleteDevWorkspaceContract = platformContract({
  operationId: 'platformApiDeleteDevWorkspace',
  method: 'DELETE',
  routeTemplate: WORKSPACE,
  successStatuses: [202],
  reader: deletionReader,
})
