// The lease countdown inside an AI session (devworkspace builder-console.md §4):
// how long until the workspace on screen sleeps, in the warning color from five
// minutes before, and one click to extend it when Platform allows the caller to.
import { Clock, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../ui'
import { useClock } from '../improve/use-clock'
import { workspacesText as text } from './copy'
import { leaseHint } from './model'
import { useExtendLease, useMyWorkspaces } from './use-my-workspaces'

const PILL = 'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset tabular-nums [&_svg]:size-3.5 [&_svg]:shrink-0'

/** Nothing unless `workspaceId` is one of the caller's own running workspaces with a lease expiry. */
export function WorkspaceLeaseHint({ workspaceId }: { workspaceId: string | undefined }) {
  const workspaces = useMyWorkspaces().data?.data
  const workspace = workspaceId ? workspaces?.find((item) => item.id === workspaceId) : undefined
  const [extended, setExtended] = useState(false)
  const extend = useExtendLease(() => setExtended(true))
  const now = useClock(workspace !== undefined)
  const hint = workspace ? leaseHint(workspace, now) : undefined
  if (!workspace || !hint) return null
  const label = hint.expired ? text.leaseHint.expired : text.leaseHint.remaining(hint.minutes)
  const tone = hint.warning ? 'bg-busy-soft text-busy-ink ring-amber-200' : 'bg-white text-stone-600 ring-stone-200'
  const status = <span role="status" className="sr-only">{extended && !extend.isPending ? text.leaseHint.extended : ''}</span>
  const name = text.leaseHint.extendLabel(label)
  if (!hint.canExtend) {
    return <span data-testid="workspace-lease" data-warning={hint.warning} className={cn(PILL, tone)}><Clock aria-hidden />{label}</span>
  }
  return (
    <>
      <button
        type="button"
        data-testid="workspace-lease"
        data-warning={hint.warning}
        aria-label={name}
        title={name}
        disabled={extend.isPending}
        aria-busy={extend.isPending || undefined}
        onClick={() => {
          setExtended(false)
          extend.mutate(workspace)
        }}
        className={cn(PILL, tone, 'cursor-pointer transition-colors hover:ring-stone-400 disabled:cursor-wait', hint.warning && 'hover:ring-amber-400')}
      >
        {extend.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <Clock aria-hidden />}
        {label}
      </button>
      {extend.isError ? <span role="alert" className="text-xs text-bad-ink">{text.leaseHint.failed}</span> : null}
      {status}
    </>
  )
}
