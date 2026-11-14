// The DevWorkspace behind an implementation run (preview URL, preview
// database, readiness conditions). The canonical read model with an open
// phase, open condition statuses, an open preview database engine and an open
// scope, sandbox runtime and source volume state: an unknown phase is not
// Ready, an unknown condition status is not True, an unknown engine pauses
// only the preview database's own actions, and the other three are read by no
// screen (a value added later must not make the preview unreadable).
// `conditions` is required: Go never omits it, and null (a nil slice) is a
// failure, not "no conditions".
import { DevWorkspaceCondition, DevWorkspacePhase, DevWorkspacePreviewDatabase, DevWorkspacePreviewDatabaseEngine, DevWorkspaceRead, DevWorkspaceRuntime, DevWorkspaceSandboxRuntime, DevWorkspaceScope, DevWorkspaceSourceVolume } from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import type { PreviewWorkspace } from '../../../model/contracts/build'
import { platformContract } from '../define'
import { openCanonical } from './build'

const workspaceReader: z.ZodType<PreviewWorkspace> = DevWorkspaceRead.extend({
  phase: openCanonical(DevWorkspacePhase),
  conditions: z.array(DevWorkspaceCondition.extend({ status: openCanonical(DevWorkspaceCondition.shape.status) })),
  previewDatabase: DevWorkspacePreviewDatabase.extend({ engine: openCanonical(DevWorkspacePreviewDatabaseEngine) }).optional(),
  scope: openCanonical(DevWorkspaceScope),
  runtime: DevWorkspaceRuntime.extend({ sandboxRuntime: openCanonical(DevWorkspaceSandboxRuntime).optional() }).optional(),
  sourceVolume: DevWorkspaceSourceVolume.extend({ state: openCanonical(DevWorkspaceSourceVolume.shape.state) }).optional(),
})

const WORKSPACE = '/api/v1/projects/{projectId}/dev-workspaces/{id}'

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
  reader: z.object({ resource: workspaceReader }).transform(({ resource }) => resource),
})
