// The sortable app table and status cells shared by mine, group and drafts
// pages. Each page calls `useAppViews(projectId)` once (one project-wide
// platform read-model load) and passes it down as `lookup`.
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import type { BusinessApp } from '../../model/contracts/console'
import type { AppView } from '../../model/app'
import { personName } from '../../model/directory'
import { pendingAccessRequestsQuery } from '../../api/queries/console'
import { copy, relativeTime } from '../../copy'
import { paths } from '../../routes/paths'
import { locale } from '../../shell/language'
import { AppIcon, Button, ConfirmDialog, CopyButton, DataTable, HrefLink, Notice, OpenLink, Skeleton, StatusPill } from '../../ui'
import { useDiscardDraft } from '../app/mutations'
import { PendingBadge } from '../app/pending-badge'
import type { AppViews } from '../app/use-app-views'
import { StaleNotice, UnconfirmedNotice, useWriteConfirmation } from '../app/notices'
import { text } from './copy'

export const ownerNames = (app: BusinessApp) =>
  app.owners.length > 0 ? app.owners.map(personName).join(text.list.ownerSeparator) : copy.appList.noOwner

const appHref = (app: BusinessApp) => paths.app(app.group.path, app.slug)

const actionLink = 'inline-flex min-h-10 items-center text-xs font-medium text-accent-strong underline md:min-h-8'

/** One approver-scoped request read per page, shared by all of its lists. */
export function usePendingAccessRequestCounts() {
  const requests = useQuery(pendingAccessRequestsQuery)
  return useMemo(() => {
    const counts = new Map<string, number>()
    for (const request of requests.data ?? []) {
      counts.set(request.appId, (counts.get(request.appId) ?? 0) + 1)
    }
    return counts
  }, [requests.data])
}

/** Keep the reason and next action readable, including in narrow problem rows. */
export function AppStatus({ app, lookup }: { app: BusinessApp; lookup: AppViews }) {
  if (lookup.loading) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-stone-400">
        <Skeleton className="h-5 w-14 rounded-full" />
        <span className="sr-only">{copy.appList.statusLoading}</span>
      </span>
    )
  }
  const view = lookup.viewFor(app)
  return (
    <div className="min-w-0">
      <StatusPill status={view.status} label={view.label} second={view.second} />
      {view.build && view.build.phase !== 'done' ? (
        <HrefLink href={paths.build(view.build.draftId)} className={`mt-1 ${actionLink}`}>{text.list.resume}</HrefLink>
      ) : view.status === 'failed' ? (
        <HrefLink href={appHref(app)} className={`mt-1 ${actionLink}`}>{text.list.check}</HrefLink>
      ) : view.status === 'unfinished' && !view.unreadableStack && !view.unreadableBuild ? (
        <UnfinishedActions app={app} view={view} />
      ) : null}
    </div>
  )
}

/** 作りかけ: carry on, or drop the draft (it has no stack, so nothing else is removed). */
function UnfinishedActions({ app, view }: { app: BusinessApp; view: AppView }) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const discard = useDiscardDraft(app, view)
  // A discard whose answer could not be read may have happened: the lists are read back before it is offered again.
  const confirmation = useWriteConfirmation([discard.error], discard.reset, () => queryClient.refetchQueries({ queryKey: ['console', 'apps'] }))
  if (view.unreadableStack || view.unreadableBuild || !app.permissions.maintain) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3">
      <HrefLink href={paths.new({ resume: app.id })} className={actionLink}>{text.list.resume}</HrefLink>
      <Button tone="ghost" size="sm" aria-label={text.list.discardLabel(app.displayName)} onClick={() => setOpen(true)}>
        {text.list.discard}
      </Button>
      {/* Portal clicks bubble through React; keep them from reaching the row link. */}
      <div className="contents" onClick={(event) => event.stopPropagation()}>
        <ConfirmDialog
          open={open}
          onOpenChange={(next) => {
            if (!next && !confirmation.unconfirmed) discard.reset()
            setOpen(next)
          }}
          title={text.list.discardTitle(app.displayName)}
          body={confirmation.unconfirmed ? <div className="space-y-3"><p>{text.list.discardBody}</p><UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} /></div> : text.list.discardBody}
          confirmLabel={discard.isPending ? text.list.discarding : text.list.discardConfirm}
          tone="danger"
          onConfirm={() => discard.mutate(undefined, { onSuccess: () => setOpen(false) })}
          pending={discard.isPending}
          disabled={confirmation.unconfirmed}
          error={confirmation.unconfirmed ? undefined : discard.error ?? undefined}
        />
      </div>
    </div>
  )
}

function AppUrlActions({ app, lookup }: { app: BusinessApp; lookup: AppViews }) {
  const url = lookup.viewFor(app).url
  if (!url) return null
  return (
    <div className="flex shrink-0 items-center gap-1" aria-label={text.list.urlLabel(app.displayName)}>
      <OpenLink href={url} label={text.list.open} />
      <CopyButton value={url} label={text.list.copyUrl} iconOnly />
    </div>
  )
}

/** Shown once above a list when the platform status could not be read; the list itself still renders. */
export function StatusLoadNotice({ lookup }: { lookup: AppViews }) {
  // Statuses keep showing the last good read when a refresh fails, with when it was read.
  if (lookup.stale && !lookup.failed) return <StaleNotice updatedAt={lookup.updatedAt} refetching={lookup.refetching} onRetry={lookup.refetch} />
  if (!lookup.failed) return null
  return (
    <Notice
      tone="warning"
      actions={
        <Button size="sm" onClick={lookup.refetch}>
          {copy.common.retry}
        </Button>
      }
    >
      {text.list.statusFailed}
    </Notice>
  )
}

const STATUS_ORDER = { failed: 0, unfinished: 1, deploying: 2, live: 3, unknown: 4 } as const
const column = createColumnHelper<BusinessApp>()

/**
 * Sortable app table (名前 / 状態 / 担当者 / グループ / 更新). Rows link to the
 * app; DataTable stacks rows into cards on narrow screens.
 */
export function AppTable({
  apps,
  lookup,
  showGroup = false,
  expandReason = false,
  caption,
  emptyState,
  pendingCounts,
}: {
  apps: BusinessApp[]
  lookup: AppViews
  showGroup?: boolean
  expandReason?: boolean
  caption?: string
  emptyState?: ReactNode
  pendingCounts?: ReadonlyMap<string, number>
}) {
  const [sorting, setSorting] = useState<SortingState>([])
  const columns = useMemo(() => {
    const labels = copy.appList.columns
    return [
      column.accessor('displayName', {
        id: 'name',
        header: labels.name,
        meta: { className: expandReason ? 'w-[22%] max-w-0' : 'w-[28%] max-w-0', primary: true },
        sortingFn: (a, b) => a.original.displayName.localeCompare(b.original.displayName, locale()),
        cell: ({ row }) => {
          const app = row.original
          return (
            <span className="flex min-w-0 items-center gap-3">
              <AppIcon icon={app.icon} name={app.displayName} size="sm" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{app.displayName}</span>
                {app.description ? (
                  <span className="block truncate text-xs text-stone-500" title={app.description}>
                    {app.description}
                  </span>
                ) : null}
              </span>
              <PendingBadge count={pendingCounts?.get(app.id) ?? 0} />
            </span>
          )
        },
      }),
      column.accessor((app) => (lookup.loading ? 'unknown' : lookup.viewFor(app).status), {
        id: 'status',
        header: labels.status,
        meta: { className: expandReason ? 'w-[42%] min-w-48' : 'w-[30%] min-w-40' },
        sortingFn: (a, b) =>
          STATUS_ORDER[a.getValue<keyof typeof STATUS_ORDER>('status')] -
          STATUS_ORDER[b.getValue<keyof typeof STATUS_ORDER>('status')],
        cell: ({ row }) => <AppStatus app={row.original} lookup={lookup} />,
      }),
      column.accessor(ownerNames, {
        id: 'owners',
        header: labels.owners,
        sortingFn: (a, b) => a.getValue<string>('owners').localeCompare(b.getValue<string>('owners'), locale()),
        cell: ({ getValue }) => <span className="block max-w-48 truncate text-stone-700">{getValue()}</span>,
      }),
      ...(showGroup
        ? [
            column.accessor((app) => app.group.name, {
              id: 'group',
              header: labels.group,
              sortingFn: (a, b) => a.original.group.path.localeCompare(b.original.group.path),
              cell: ({ row }) => (
                <span className="block max-w-40 truncate text-stone-600" title={row.original.group.path}>
                  {row.original.group.name}
                </span>
              ),
            }),
          ]
        : []),
      column.accessor('updatedAt', {
        id: 'updated',
        header: labels.updated,
        meta: { className: 'w-28' },
        sortDescFirst: true,
        cell: ({ getValue }) => (
          <time dateTime={getValue()} className="text-xs whitespace-nowrap text-stone-500">
            {relativeTime(getValue())}
          </time>
        ),
      }),
      column.display({
        id: 'url',
        header: 'URL',
        meta: { className: 'w-24', label: 'URL' },
        cell: ({ row }) => <AppUrlActions app={row.original} lookup={lookup} />,
      }),
    ]
  }, [lookup, showGroup, expandReason, pendingCounts])

  const table = useReactTable({
    data: apps,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (app) => app.id,
  })
  return <DataTable table={table} caption={caption} rowHref={appHref} emptyState={emptyState} />
}

/** Placeholder rows while an app list loads. */
export function AppListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label={copy.common.loading} className="space-y-px overflow-hidden rounded-lg border border-stone-200 bg-white">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-7 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
      ))}
    </div>
  )
}
