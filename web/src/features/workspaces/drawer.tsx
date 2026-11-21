// 「自分の作業場所」 (devworkspace builder-console.md §1–§3): the header entry with
// the running count, and the drawer with the caller's own workspaces in three
// groups. Every row action comes from Platform's `allowedActions`; Admin work,
// Project policy and other people's workspaces belong to the Dashboard.
import { useQuery } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { Laptop, X } from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import { useEffect, useState, type ReactNode } from 'react'
import { draftsOptions } from '../../api/queries/build'
import { useMe } from '../../api/queries/console'
import { copy, type ConsoleStatus } from '../../copy'
import { isOneOf, knownValue } from '../../model/contracts/build'
import type { MyWorkspace, MyWorkspaceList, WorkspaceState } from '../../model/contracts/workspace'
import { locale } from '../../shell/language'
import { ActionError, Button, Checkbox, cn, ConfirmDialog, EmptyState, LinkButton, LoadFailed, Loading, StatusPill } from '../../ui'
import { useClock } from '../improve/use-clock'
import { workspacesText as text } from './copy'
import { DeleteWorkspacesDialog } from './delete-dialog'
import {
  cleanupSelection,
  durationLabel,
  groupWorkspaces,
  isDeletable,
  leaseHint,
  openHref,
  parseGoDuration,
  runningCount,
  WORKSPACE_GROUPS,
  type WorkspaceGroup,
} from './model'
import { useExtendLease, useMyWorkspaces, useRestartWorkspace, useStopWorkspace } from './use-my-workspaces'

const PILL: Record<WorkspaceState, ConsoleStatus> = {
  Ready: 'live', Starting: 'deploying', Committing: 'deploying', Deleting: 'deploying', Degraded: 'failed', Failed: 'failed',
  Sleeping: 'unfinished', Stopped: 'unfinished', Retired: 'unknown',
}

/** The header entry: hidden for someone who cannot create apps and has no workspace. */
export function MyWorkspacesEntry() {
  const { data: me } = useMe()
  const query = useMyWorkspaces()
  const [open, setOpen] = useState(false)
  const location = useRouterState({ select: (state) => state.location.href })
  // Following 開く (or any navigation) leaves the drawer.
  useEffect(() => setOpen(false), [location])
  const workspaces = query.data?.data ?? []
  if (!me.canCreateApps && workspaces.length === 0) return null
  const running = runningCount(workspaces)
  return (
    <RDialog.Root open={open} onOpenChange={setOpen}>
      <RDialog.Trigger
        aria-label={text.entry(running)}
        title={text.title}
        data-testid="my-workspaces-entry"
        className="relative flex size-10 shrink-0 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100 hover:text-stone-900 data-[state=open]:bg-stone-100 md:size-9"
      >
        <Laptop aria-hidden className="size-5" />
        {running > 0 ? (
          <span aria-hidden data-testid="my-workspaces-badge" className="absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-white tabular-nums">
            {running}
          </span>
        ) : null}
      </RDialog.Trigger>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-stone-900/40 animate-fade-in" />
        <RDialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[30rem] max-w-full flex-col bg-white shadow-xl [word-break:auto-phrase] animate-slide-in-right focus:outline-none">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 pt-4 pb-3">
            <div className="min-w-0">
              <RDialog.Title className="text-base font-semibold text-stone-900">{text.title}</RDialog.Title>
              <RDialog.Description className="mt-0.5 text-xs text-stone-500">{text.description}</RDialog.Description>
            </div>
            <RDialog.Close aria-label={copy.common.close} className="-mr-2 flex size-10 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-800 md:size-8">
              <X aria-hidden className="size-4" />
            </RDialog.Close>
          </div>
          {query.data ? <Drawer list={query.data} /> : query.isError ? (
            <div className="p-5"><LoadFailed error={query.error} onRetry={() => void query.refetch()} /></div>
          ) : <Loading className="px-5" />}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

function idleAfterText(idleAfter: string): string {
  const ms = parseGoDuration(idleAfter)
  if (ms === undefined) return idleAfter
  const label = durationLabel(ms)
  return text.duration[label.unit](label.value)
}

function Drawer({ list }: { list: MyWorkspaceList }) {
  const { data: me } = useMe()
  // Only to find the AI session page a workspace belongs to; the shell already reads this list.
  const drafts = useQuery({ ...draftsOptions(me.projectId), refetchInterval: false }).data?.data ?? []
  const now = useClock(true)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [deleting, setDeleting] = useState<readonly MyWorkspace[]>([])
  const [stopping, setStopping] = useState<MyWorkspace>()
  const [notice, setNotice] = useState<string>()
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 6_000)
    return () => clearTimeout(timer)
  }, [notice])
  const extend = useExtendLease((workspace) => setNotice(text.extended(workspace.displayName)))
  const stop = useStopWorkspace((workspace) => {
    setStopping(undefined)
    setNotice(text.stopped(workspace.displayName))
  })
  const restart = useRestartWorkspace((workspace) => setNotice(text.restarted(workspace.displayName)))

  const groups = groupWorkspaces(list.data)
  // A row that left the list (deleted, or no longer deletable) leaves the selection.
  const chosen = list.data.filter((workspace) => selected.has(workspace.id) && isDeletable(workspace))
  const toggle = (id: string, on: boolean) => setSelected((current) => {
    const next = new Set(current)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })
  const cleanUp = () => {
    const ids = cleanupSelection(list.data, now, list.idleAfter)
    setSelected(new Set(ids))
    setNotice(text.cleanupSelected(ids.length))
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-stone-50/60 px-5 py-2.5 text-xs text-stone-600">
        <p data-testid="my-workspaces-summary" className="min-w-0 flex-1">
          <span className="whitespace-nowrap">{text.summary.kept(list.summary.retainedSourceVolumes)}</span>
          {text.summary.separator}
          <span className="whitespace-nowrap">{text.summary.idle(list.summary.idleRetained, idleAfterText(list.idleAfter))}</span>
        </p>
        {list.summary.idleRetained > 0 ? <Button size="sm" tone="ghost" className="-my-1 text-accent-strong" onClick={cleanUp}>{text.cleanup}</Button> : null}
      </div>
      <p role="status" aria-live="polite" className={cn('px-5 text-xs text-accent-strong', notice ? 'py-2' : 'sr-only')}>{notice}</p>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {list.data.length === 0 ? (
          <div className="p-5"><EmptyState icon={<Laptop />} title={text.empty.title} body={text.empty.body} /></div>
        ) : WORKSPACE_GROUPS.map((group) => groups[group].length ? (
          <section key={group} aria-labelledby={`my-workspaces-${group}`} data-group={group} className="border-b border-stone-100 last:border-b-0">
            <h3 id={`my-workspaces-${group}`} className="flex items-center gap-2 px-5 pt-4 pb-1 text-xs font-semibold text-stone-500">
              {text.groups[group]}
              <span className="font-normal tabular-nums">{text.groupCount(groups[group].length)}</span>
            </h3>
            <ul className="divide-y divide-stone-100">
              {groups[group].map((workspace) => (
                <Row
                  key={workspace.id}
                  workspace={workspace}
                  group={group}
                  now={now}
                  href={openHref(workspace, drafts)}
                  selected={selected.has(workspace.id)}
                  onSelect={(on) => toggle(workspace.id, on)}
                  extend={{ pending: extend.isPending && extend.variables?.id === workspace.id, error: extend.variables?.id === workspace.id ? extend.error : null, run: () => extend.mutate(workspace) }}
                  restart={{ pending: restart.isPending && restart.variables?.id === workspace.id, error: restart.variables?.id === workspace.id ? restart.error : null, run: () => restart.mutate(workspace) }}
                  onStop={() => { stop.reset(); setStopping(workspace) }}
                  onDelete={() => setDeleting([workspace])}
                />
              ))}
            </ul>
          </section>
        ) : null)}
      </div>
      {chosen.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-white px-5 py-3">
          <p className="mr-auto text-sm text-stone-700 tabular-nums">{text.selection(chosen.length)}</p>
          <Button size="sm" tone="ghost" onClick={() => setSelected(new Set())}>{text.clearSelection}</Button>
          <Button size="sm" tone="danger" onClick={() => setDeleting(chosen)}>{text.deleteSelected(chosen.length)}</Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={stopping !== undefined}
        onOpenChange={(open) => { if (!open) setStopping(undefined) }}
        title={stopping ? text.stop.title(stopping.displayName) : ''}
        body={text.stop.body}
        confirmLabel={text.stop.confirm}
        onConfirm={() => stopping && stop.mutate(stopping)}
        pending={stop.isPending}
        error={stop.error}
      />
      <DeleteWorkspacesDialog
        workspaces={deleting}
        onOpenChange={(open) => { if (!open) setDeleting([]) }}
        onDeleted={(ids) => setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))))}
      />
    </>
  )
}

const dateTime = (iso: string) => new Date(iso).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** The row's one line under its name: the lease while it runs, the source data otherwise, or why it is unusable. */
function rowLine(workspace: MyWorkspace, group: WorkspaceGroup, now: number): { text: string; warning: boolean } | undefined {
  const state = knownValue(workspace.state)
  if (!state) return { text: text.line.unknown, warning: false }
  if (group === 'running') {
    const hint = leaseHint(workspace, now)
    return hint ? { text: hint.expired ? text.line.leaseExpired : text.line.lease(hint.minutes), warning: hint.warning } : undefined
  }
  if (state === 'Retired') return { text: workspace.retired?.deleteAt ? text.line.retired(dateTime(workspace.retired.deleteAt)) : text.line.retiredUndated, warning: false }
  const volume = workspace.sourceVolume
  if (isOneOf(volume?.state, 'Released')) return { text: text.line.dataReleased, warning: false }
  if (isOneOf(volume?.state, 'Releasing')) return { text: text.line.dataReleasing, warning: false }
  if (volume?.releaseAt) return { text: text.line.dataUntil(dateTime(volume.releaseAt)), warning: false }
  if (state === 'Stopped') return { text: text.line.stopped, warning: false }
  return volume ? { text: text.line.dataKept, warning: false } : undefined
}

function targetText(workspace: MyWorkspace): string {
  const scope = knownValue(workspace.scope)
  if (scope === 'applicationDraft') return text.target.draft
  if (scope === 'application' && workspace.applicationId) {
    return workspace.applicationBranchId ? text.target.branch(workspace.applicationId, workspace.applicationBranchId) : text.target.application(workspace.applicationId)
  }
  return text.target.unknown
}

function Row({ workspace, group, now, href, selected, onSelect, extend, restart, onStop, onDelete }: {
  workspace: MyWorkspace
  group: WorkspaceGroup
  now: number
  href: string | undefined
  selected: boolean
  onSelect: (on: boolean) => void
  extend: { pending: boolean; error: unknown; run: () => void }
  /** Stopped or Failed → Running when Platform allows `start` or `restart`; there is no start route, both call restart. */
  restart: { pending: boolean; error: unknown; run: () => void }
  onStop: () => void
  onDelete: () => void
}) {
  const name = workspace.displayName
  const state = knownValue(workspace.state)
  const allowed = workspace.allowedActions
  const line = rowLine(workspace, group, now)
  const deletable = isDeletable(workspace)
  const label = (action: string) => text.actionLabel(name, action)
  const actions: ReactNode[] = []
  if (allowed?.open && href) {
    const action = group === 'sleeping' ? text.action.resume : text.action.open
    actions.push(<LinkButton key="open" href={href} size="sm" tone={group === 'running' ? 'secondary' : 'primary'} aria-label={label(action)}>{action}</LinkButton>)
  }
  if (group === 'running' && allowed?.extendLease) {
    actions.push(<Button key="extend" size="sm" loading={extend.pending} aria-label={label(text.action.extend)} onClick={extend.run}>{text.action.extend}</Button>)
  }
  if (group === 'running' && allowed?.stop) {
    actions.push(<Button key="stop" size="sm" aria-label={label(text.action.stop)} onClick={onStop}>{text.action.stop}</Button>)
  }
  if (group === 'other' && (allowed?.start || allowed?.restart)) {
    actions.push(<Button key="restart" size="sm" tone="primary" loading={restart.pending} aria-label={label(text.action.restart)} onClick={restart.run}>{text.action.restart}</Button>)
  }
  if (deletable) {
    actions.push(<Button key="delete" size="sm" className="text-bad-ink!" aria-label={label(text.action.delete)} onClick={onDelete}>{text.action.delete}</Button>)
  }
  return (
    <li data-workspace-id={workspace.id} data-state={state ?? 'unknown'} className="flex gap-3 px-5 py-3">
      <div className="w-4 shrink-0 pt-1">
        {deletable ? <Checkbox checked={selected} onCheckedChange={onSelect} description={text.select(name)} /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate font-medium text-stone-900" title={name}>{name}</p>
          <span className="shrink-0"><StatusPill status={state ? PILL[state] : 'unknown'} label={state ? text.state[state] : text.state.unknown} /></span>
        </div>
        <p className="mt-0.5 text-xs text-stone-500">
          <span>{targetText(workspace)}</span>
          {line ? (
            <>
              <span aria-hidden className="px-1 text-stone-300">·</span>
              <span data-testid="workspace-line" className={cn(line.warning && 'font-medium text-busy-ink')}>{line.text}</span>
            </>
          ) : null}
        </p>
        {actions.length ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{actions}</div> : null}
        {extend.error || restart.error ? <div className="mt-2"><ActionError error={extend.error || restart.error} /></div> : null}
      </div>
    </li>
  )
}
