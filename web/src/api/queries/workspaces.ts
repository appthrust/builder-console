// 「自分の作業場所」: the caller's DevWorkspaces (`owner=me`). One read shared by
// the header badge, the drawer and the in-session lease hint.
import { queryOptions } from '@tanstack/react-query'
import { listMyWorkspaces } from '../workspace'

/** Leases are minutes long and the hint counts down on its own clock, so the list is re-read every 30 s. */
export const MY_WORKSPACES_POLL_MS = 30_000

export const workspaceKeys = {
  mine: (projectId: string) => ['dev-workspaces', projectId, 'mine'] as const,
}

export const myWorkspacesOptions = (projectId: string) => queryOptions({
  queryKey: workspaceKeys.mine(projectId),
  queryFn: ({ signal }) => listMyWorkspaces(projectId, signal),
  refetchInterval: MY_WORKSPACES_POLL_MS,
})
