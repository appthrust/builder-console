// 「自分の作業場所」 (My workspaces) domain values that arrive through the
// response boundary (api/contracts/platform/workspace.ts). Feature and model code
// reads these types, never the wire.
//
// A row keeps only what the drawer and the lease hint use, so a field this
// console never shows cannot break the list. Server enums a newer Platform may
// extend (`state`, `scope`, the source volume state) are open values: an
// unknown one is `{ kind: 'unknown' }`, never mapped onto a known one.
import type {
  DevWorkspaceListSummary,
  DevWorkspaceRead,
  DevWorkspaceScope,
  DevWorkspaceSourceVolume,
  DevWorkspaceState,
} from '@appthrust/api-schema/platform-api'
import type { OpenValue } from '../../api/boundary'

export type WorkspaceState = DevWorkspaceState
export type WorkspaceScope = DevWorkspaceScope
export type SourceVolumeState = DevWorkspaceSourceVolume['state']

/** What the caller may do with the workspace, decided by Platform. Absent on a server that predates it: nothing is offered. */
export type WorkspaceActions = NonNullable<DevWorkspaceRead['allowedActions']>

/** The activity lease: compute sleeps at `expiresAt` unless it is renewed. */
export type WorkspaceLease = { lastActivityAt?: string; expiresAt?: string; ttlSeconds: number }

/** A Retired workspace cannot run again; Platform deletes it at `deleteAt`. */
export type WorkspaceRetirement = NonNullable<DevWorkspaceRead['retired']>

export type MyWorkspace = Pick<DevWorkspaceRead, 'id' | 'projectId' | 'displayName' | 'applicationId' | 'applicationBranchId' | 'draftId' | 'branchUrl' | 'pullRequestUrl' | 'lastActivityAt' | 'ownedByCaller'> & {
  scope: OpenValue<WorkspaceScope>
  /** The server's product state; on a server without `state`, the state its phase stands for. */
  state: OpenValue<WorkspaceState>
  retired?: WorkspaceRetirement
  lease?: WorkspaceLease
  sourceVolume?: { state: OpenValue<SourceVolumeState>; releaseAt?: string }
  allowedActions?: WorkspaceActions
}

/** `GET dev-workspaces?owner=me`: the caller's workspaces (newest activity first) and the server's counts over them. */
export type MyWorkspaceList = {
  data: MyWorkspace[]
  summary: DevWorkspaceListSummary
  /** Go duration (`168h0m0s`): the server's idle threshold behind `summary.idleRetained`. */
  idleAfter: string
}

/** A delete Platform accepted; the workspace and its source data go away asynchronously. */
export type WorkspaceDeletion = { id: string }
