// The caller's workspaces and the writes on one of them. Every write replaces
// that row in the shared list with Platform's answer and then re-reads the list,
// so the badge, the drawer and the lease hint move together.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useMe } from '../../api/queries/console'
import { myWorkspacesOptions, workspaceKeys } from '../../api/queries/workspaces'
import { extendWorkspaceLease, restartWorkspace, stopWorkspace } from '../../api/workspace'
import type { MyWorkspace, MyWorkspaceList } from '../../model/contracts/workspace'

/** Read only for a Project member while Platform answers the console. */
export function useMyWorkspaces() {
  const { data: me } = useMe()
  return useQuery({ ...myWorkspacesOptions(me.projectId), enabled: !me.notMember && !me.platformUnavailable })
}

function replaceRow(client: QueryClient, projectId: string, written: MyWorkspace) {
  client.setQueryData<MyWorkspaceList>(workspaceKeys.mine(projectId), (list) => list && {
    ...list,
    data: list.data.map((workspace) => (workspace.id === written.id ? written : workspace)),
  })
  void client.invalidateQueries({ queryKey: workspaceKeys.mine(projectId) })
}

/** A write on one row; `variables` names the row, so a failure is shown on that row only. */
function useRowWrite(write: (projectId: string, workspaceId: string) => Promise<MyWorkspace>, onDone?: (workspace: MyWorkspace) => void) {
  const { data: me } = useMe()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (workspace: Pick<MyWorkspace, 'id' | 'displayName'>) => write(me.projectId, workspace.id),
    onSuccess: (written) => {
      replaceRow(client, me.projectId, written)
      onDone?.(written)
    },
  })
}

export const useExtendLease = (onDone?: (workspace: MyWorkspace) => void) => useRowWrite(extendWorkspaceLease, onDone)

export const useStopWorkspace = (onDone?: (workspace: MyWorkspace) => void) => useRowWrite(stopWorkspace, onDone)

/** Brings a Stopped or Failed workspace back (`start` or `restart`): there is no start route, so both call restart. The list is re-read for its new state. */
export function useRestartWorkspace(onDone?: (workspace: Pick<MyWorkspace, 'id' | 'displayName'>) => void) {
  const { data: me } = useMe()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (workspace: Pick<MyWorkspace, 'id' | 'displayName'>) => restartWorkspace(me.projectId, workspace.id, {}),
    onSuccess: (_, workspace) => {
      void client.invalidateQueries({ queryKey: workspaceKeys.mine(me.projectId) })
      onDone?.(workspace)
    },
  })
}
