// Deletes one or more of the caller's workspaces with the Dashboard's warning
// (Workspaces tab, delete-workspaces-dialog): unpushed changes are lost, and
// rows whose work never left the workspace are named. One DELETE per row, in
// order, each with its own Idempotency-Key that a retry of that row reuses.
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { mintIdempotencyKey } from '../../api/build-sessions'
import { useMe } from '../../api/queries/console'
import { workspaceKeys } from '../../api/queries/workspaces'
import { deleteWorkspace } from '../../api/workspace'
import { isOneOf } from '../../model/contracts/build'
import type { MyWorkspace } from '../../model/contracts/workspace'
import { ActionError, Button, Dialog } from '../../ui'
import { copy } from '../../copy'
import { workspacesText as text } from './copy'
import { hasPublishedBranch } from './model'

type RowResult = { state: 'deleting' } | { state: 'deleted' } | { state: 'failed'; error: unknown }

/** Open while `workspaces` is non-empty; `onDeleted` gets the ids Platform accepted, once per run. */
export function DeleteWorkspacesDialog({ workspaces, onOpenChange, onDeleted }: {
  workspaces: readonly MyWorkspace[]
  onOpenChange: (open: boolean) => void
  onDeleted: (ids: string[]) => void
}) {
  const { data: me } = useMe()
  const client = useQueryClient()
  const keys = useRef(new Map<string, string>())
  const [results, setResults] = useState<Record<string, RowResult>>({})
  const [running, setRunning] = useState(false)
  const count = workspaces.length
  const finished = !running && workspaces.some((workspace) => results[workspace.id])
  const failed = workspaces.filter((workspace) => results[workspace.id]?.state === 'failed').length
  const unpublished = workspaces.filter((workspace) => !hasPublishedBranch(workspace)).length

  async function run() {
    setRunning(true)
    const deleted: string[] = []
    for (const workspace of workspaces) {
      if (results[workspace.id]?.state === 'deleted') continue
      setResults((current) => ({ ...current, [workspace.id]: { state: 'deleting' } }))
      const key = keys.current.get(workspace.id) ?? mintIdempotencyKey()
      keys.current.set(workspace.id, key)
      try {
        await deleteWorkspace(me.projectId, workspace.id, key)
        deleted.push(workspace.id)
        setResults((current) => ({ ...current, [workspace.id]: { state: 'deleted' } }))
      } catch (error) {
        setResults((current) => ({ ...current, [workspace.id]: { state: 'failed', error } }))
      }
    }
    // The run is over once Platform answered every row; the drawer catches up when the re-read lands.
    void client.invalidateQueries({ queryKey: workspaceKeys.mine(me.projectId) })
    setRunning(false)
    onDeleted(deleted)
  }

  function change(next: boolean) {
    if (running) return
    if (!next) {
      setResults({})
      keys.current.clear()
    }
    onOpenChange(next)
  }

  return (
    <Dialog
      open={count > 0}
      onOpenChange={change}
      title={text.remove.title(count)}
      footer={finished ? (
        <>
          {failed > 0 ? <Button onClick={() => void run()}>{text.remove.retryFailed}</Button> : null}
          <Button tone="primary" onClick={() => change(false)}>{copy.common.close}</Button>
        </>
      ) : (
        <>
          <Button onClick={() => change(false)} disabled={running}>{copy.common.cancel}</Button>
          <Button tone="danger" onClick={() => void run()} loading={running}>{text.remove.confirm(count)}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        <p className="flex items-start gap-2 font-medium text-bad-ink">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{text.remove.warning}</span>
        </p>
        <p>{text.remove.body}</p>
        <ul aria-label={text.remove.rows} className="max-h-72 divide-y divide-stone-100 overflow-y-auto rounded-lg border border-line">
          {workspaces.map((workspace) => (
            <li key={workspace.id} data-delete-workspace-id={workspace.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-medium text-stone-900" title={workspace.displayName}>{workspace.displayName}</span>
              {isOneOf(workspace.state, 'Retired') ? <Tag tone="neutral">{text.remove.retired}</Tag> : null}
              {hasPublishedBranch(workspace) ? null : <Tag tone="warning">{text.remove.unpublished}</Tag>}
              <RowOutcome result={results[workspace.id]} />
            </li>
          ))}
        </ul>
        {unpublished > 0 && !finished ? <p className="text-xs text-stone-500">{text.remove.unpublishedNote(unpublished)}</p> : null}
      </div>
    </Dialog>
  )
}

function Tag({ tone, children }: { tone: 'neutral' | 'warning'; children: string }) {
  return (
    <span className={tone === 'warning'
      ? 'rounded-full bg-busy-soft px-2 py-0.5 text-xs font-medium whitespace-nowrap text-busy-ink ring-1 ring-amber-200 ring-inset'
      : 'rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-stone-600 ring-1 ring-stone-200 ring-inset'}
    >
      {children}
    </span>
  )
}

function RowOutcome({ result }: { result: RowResult | undefined }) {
  if (!result) return null
  if (result.state === 'deleting') {
    return <span role="status" className="flex items-center gap-1 text-xs text-stone-600"><Loader2 aria-hidden className="size-3.5 animate-spin text-accent" />{text.remove.deleting}</span>
  }
  if (result.state === 'deleted') {
    return <span role="status" className="flex items-center gap-1 text-xs text-accent-strong"><CheckCircle2 aria-hidden className="size-3.5" />{text.remove.deleted}</span>
  }
  return <div className="w-full"><ActionError error={result.error} /></div>
}
