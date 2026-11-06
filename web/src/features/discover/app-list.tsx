// App cards, compact rows and the sortable app table shared by home, mine,
// company and group pages. Each page calls `useAppViews(projectId)` once (one
// project-wide platform read-model load) and passes it down as `lookup`.
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import type { BusinessApp } from '../../api/console'
import { pendingAccessRequestsQuery } from '../../api/queries'
import { copy, relativeTime } from '../../copy'
import { paths } from '../../routes/paths'
import { locale } from '../../shell/language'
import { useShell } from '../../shell/use-shell'
import { AppIcon, Button, ConfirmDialog, CopyButton, DataTable, HrefLink, Notice, OpenLink, Skeleton, StatusPill } from '../../ui'
import { useDiscardDraft } from '../app/mutations'
import { canEditApp } from '../app/permissions'
import { PendingBadge } from '../app/pending-badge'
import type { AppViews } from '../app/use-app-views'
import { text } from './copy'

export const ownerNames = (app: BusinessApp) =>
  app.owners.length > 0 ? app.owners.map((owner) => owner.displayName).join(text.list.ownerSeparator) : copy.appList.noOwner

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
      ) : view.status === 'unfinished' ? (
        <UnfinishedActions app={app} />
      ) : null}
    </div>
  )
}

/** 作りかけ: carry on, or drop the draft (it has no stack, so nothing else is removed). */
function UnfinishedActions({ app }: { app: BusinessApp }) {
  const { me } = useShell()
  const [open, setOpen] = useState(false)
  const discard = useDiscardDraft(app)
  if (!canEditApp(app, me)) return null
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
            if (!next) discard.reset()
            setOpen(next)
          }}
          title={text.list.discardTitle(app.displayName)}
          body={text.list.discardBody}
          confirmLabel={discard.isPending ? text.list.discarding : text.list.discardConfirm}
          tone="danger"
          onConfirm={() => discard.mutate(undefined, { onSuccess: () => setOpen(false) })}
          pending={discard.isPending}
          error={discard.error ?? undefined}
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

/** Home-page cards (ux-design §7.2): icon, name, status, 担当者. */
export function AppCards({ apps, lookup, pendingCounts }: { apps: BusinessApp[]; lookup: AppViews; pendingCounts?: ReadonlyMap<string, number> }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {apps.map((app) => (
        <li key={app.id} className="flex h-full min-w-0 flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4">
          <HrefLink href={appHref(app)} className="group flex min-h-10 min-w-0 items-center gap-3 rounded focus-visible:outline-2 focus-visible:outline-accent">
            <AppIcon icon={app.icon} name={app.displayName} />
            <span className="min-w-0">
              <span className="block truncate font-medium text-stone-900 group-hover:text-accent-strong">{app.displayName}</span>
              <span className="block truncate text-xs text-stone-500">{ownerNames(app)}</span>
            </span>
            <PendingBadge count={pendingCounts?.get(app.id) ?? 0} />
          </HrefLink>
          <div className="mt-auto"><AppStatus app={app} lookup={lookup} /></div>
          <AppUrlActions app={app} lookup={lookup} />
        </li>
      ))}
    </ul>
  )
}

/** Compact rows: group name, app, status and (optionally) when it was added. */
export function AppLines({ apps, lookup, showTime = false, pendingCounts }: { apps: BusinessApp[]; lookup: AppViews; showTime?: boolean; pendingCounts?: ReadonlyMap<string, number> }) {
  return (
    <ul className="divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200 bg-white">
      {apps.map((app) => {
        const added = showTime ? relativeTime(app.createdAt) : undefined
        return (
          <li key={app.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
            <HrefLink href={appHref(app)} className="flex min-h-10 min-w-0 flex-1 basis-48 items-center gap-3 rounded hover:text-accent-strong">
              <AppIcon icon={app.icon} name={app.displayName} size="sm" />
              <span className="min-w-0">
                <span className="block truncate font-medium text-stone-900">{app.displayName}</span>
                <span className="block truncate text-xs text-stone-500">{app.group.name}</span>
              </span>
              <PendingBadge count={pendingCounts?.get(app.id) ?? 0} />
            </HrefLink>
            <div className="min-w-0 flex-1 basis-64"><AppStatus app={app} lookup={lookup} /></div>
            {added ? <span className="w-24 text-xs text-stone-500 sm:text-right">{text.list.created(added)}</span> : null}
            <AppUrlActions app={app} lookup={lookup} />
          </li>
        )
      })}
    </ul>
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

/** Placeholder cards for the home group section. */
export function AppCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div role="status" aria-label={copy.common.loading} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="space-y-4 rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-md" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
      ))}
    </div>
  )
}
