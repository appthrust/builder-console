import type { ReleasePhase } from '@appthrust/api-schema/platform-api'
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { History, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { client } from '../../api/client'
import { keys } from '../../api/queries/shared'
import { releasesQuery, useReleaseState } from '../../api/queries/app'
import { copy, relativeTime, type ConsoleStatus } from '../../copy'
import { deriveReleaseHistory, deriveRollbackView, versionLabel, type AppView, type RollbackOption } from '../../model/app'
import { locale } from '../../shell/language'
import { Button, Card, CardBody, CardHeader, ConfirmDialog, DataTable, EmptyState, LoadFailed, Loading, Notice, StatusPill } from '../../ui'
import { text } from './copy'
import { webScope } from './platform'

/** One line of 更新履歴: a release, or a rollback candidate the release list does not carry. */
interface ReleaseRow {
  key: string
  version: string
  rawVersion: string
  at?: string
  phase?: ReleasePhase
  phaseText?: string
  failureReason?: string
  rollback?: RollbackOption
  running: boolean
}

const PHASE_STATUS: Record<ReleasePhase, ConsoleStatus> = {
  Failed: 'failed',
  Succeeded: 'live',
  Pending: 'deploying',
  InProgress: 'deploying',
  WaitingPromotion: 'deploying',
}

/** Per-render state the action cell reads; columns stay stable within a mount so cells never remount. */
interface RollbackMeta {
  busy: boolean
  choose: (option: RollbackOption) => void
}

const column = createColumnHelper<ReleaseRow>()

function rollbackButton(option: RollbackOption, meta: RollbackMeta) {
  return (
    <Button
      size="sm"
      disabled={meta.busy}
      icon={<RotateCcw />}
      onClick={() => meta.choose(option)}
      aria-label={`${option.version} ${copy.app.releases.rollback}`}
    >
      {copy.app.releases.rollback}
    </Button>
  )
}

const createColumns = () => [
  column.accessor('version', {
    header: text.releases.columns.version,
    enableSorting: false,
    cell: ({ row, table }) => (
      <span className="flex flex-wrap items-center gap-2">
        <span title={row.original.rawVersion} className="text-stone-900">
          <span className="font-semibold">{row.original.version}</span>
          {row.original.at ? <time dateTime={row.original.at} className="mt-0.5 block text-xs text-stone-500">{new Date(row.original.at).toLocaleDateString(locale())}</time> : null}
        </span>
        {row.original.running ? (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-strong">{text.releases.running}</span>
        ) : null}
        {/* Narrow screens show rows as cards; the action sits in the card title instead of its own line. */}
        {row.original.rollback ? (
          <span className="ml-auto md:hidden">{rollbackButton(row.original.rollback, table.options.meta as RollbackMeta)}</span>
        ) : null}
      </span>
    ),
  }),
  column.accessor((row) => row.at ?? '', {
    id: 'at',
    header: text.releases.columns.at,
    sortingFn: 'text',
    meta: { className: 'whitespace-nowrap' },
    cell: ({ row }) =>
      row.original.at ? (
        <time dateTime={row.original.at} title={new Date(row.original.at).toLocaleString(locale())} className="text-stone-600">
          {relativeTime(row.original.at)}
        </time>
      ) : (
        <span className="text-stone-400">—</span>
      ),
  }),
  column.accessor((row) => row.phaseText ?? '', {
    id: 'phase',
    header: text.releases.columns.phase,
    enableSorting: false,
    cell: ({ row }) =>
      row.original.phase ? (
        <StatusPill status={PHASE_STATUS[row.original.phase]} label={row.original.phaseText} />
      ) : (
        <span className="text-stone-400">{text.releases.unknownPhase}</span>
      ),
  }),
  column.accessor((row) => row.failureReason ?? '', {
    id: 'reason',
    header: text.releases.columns.reason,
    enableSorting: false,
    meta: { className: 'min-w-48' },
    cell: ({ row }) =>
      row.original.failureReason ? (
        <span className="text-stone-700">{row.original.failureReason}</span>
      ) : (
        <span className="text-stone-400">{text.releases.noReason}</span>
      ),
  }),
  column.display({
    id: 'action',
    header: () => <span className="sr-only">{text.releases.columns.action}</span>,
    meta: { label: text.releases.columns.action, className: 'text-right', hideOnMobile: true },
    cell: ({ row, table }) => (row.original.rollback ? rollbackButton(row.original.rollback, table.options.meta as RollbackMeta) : null),
  }),
]

export function ReleasesTab({ projectId, view }: { projectId: string; view: AppView }) {
  const queryClient = useQueryClient()
  const [columns] = useState(createColumns)
  const platform = view.platform
  const scope = webScope(projectId, view)
  const overview = useQuery({
    queryKey: platform ? keys.releases(projectId, platform.id, platform.branchId) : ['releases', 'none'],
    queryFn: platform ? releasesQuery(projectId, platform.id, platform.branchId).queryFn : skipToken,
  })
  const releaseState = useReleaseState(scope)
  const rollback = deriveRollbackView(releaseState.data)
  const [pendingTarget, setPendingTarget] = useState<RollbackOption>()
  const [started, setStarted] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([{ id: 'at', desc: true }])

  const mutation = useMutation({
    mutationFn: (targetTransitionId: string) => {
      if (!scope) throw new Error('rollback requires a web component')
      return client.platformApiRollbackApplicationBranchComponent({ params: scope, body: { targetTransitionId } })
    },
    onSuccess: () => {
      setPendingTarget(undefined)
      setStarted(true)
      void queryClient.invalidateQueries({ queryKey: ['release-state'] })
      void queryClient.invalidateQueries({ queryKey: ['releases'] })
      void queryClient.invalidateQueries({ queryKey: keys.summaries(projectId) })
    },
  })
  const busy = rollback.inFlight || mutation.isPending
  const resetMutation = mutation.reset

  const rows = useMemo<ReleaseRow[]>(() => {
    const history = deriveReleaseHistory(overview.data, platform?.webComponentId)
    const releases = overview.data?.components.flatMap((component) => component.releases) ?? []
    const current = deriveRollbackView(releaseState.data)
    const optionByVersion = new Map(current.options.map((option) => [option.version, option]))
    // A queued duplicate is not evidence of a running release.
    const runningIndex = history.findIndex((release) => release.phase === 'Succeeded' &&
      (current.currentVersion ? release.version === current.currentVersion : view.platform?.facts.webReady))
    const fromHistory = history.map((release, index) => {
      const version = versionLabel(releases, release.id)
      const option = optionByVersion.get(release.version)
      const label = version?.label ?? text.releases.unknownPhase
      return {
        key: release.id,
        version: label,
        rawVersion: release.version,
        at: version?.at || release.at,
        phase: release.phase,
        phaseText: release.phaseText,
        failureReason: release.failureReason,
        rollback: option && index !== runningIndex ? { ...option, version: label } : undefined,
        running: index === runningIndex,
      }
    })
    const unmatched = current.options
      .filter((option) => !history.some((release) => release.version === option.version))
      .map((option) => ({
        key: option.transitionId,
        version: copy.app.releases.rollback,
        rawVersion: option.version,
        at: option.at,
        rollback: { ...option, version: copy.app.releases.rollback },
        running: false,
      }))
    return [...fromHistory, ...unmatched]
  }, [overview.data, platform?.webComponentId, view.platform?.facts.webReady, releaseState.data])

  const meta = useMemo<RollbackMeta>(
    () => ({
      busy,
      choose: (option) => {
        setStarted(false)
        resetMutation()
        setPendingTarget(option)
      },
    }),
    [busy, resetMutation]
  )

  const table = useReactTable({
    data: rows,
    columns,
    meta,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.key,
  })

  if (!platform) {
    return <EmptyState icon={<History />} title={copy.app.releases.empty} body={text.releases.lead} />
  }

  return (
    <Card>
      <CardHeader
        title={copy.app.releases.title}
        lead={text.releases.lead}
        actions={
          rows.some((row) => row.running) ? (
            <p className="text-sm text-stone-600">
              {copy.app.releases.current}:{' '}
              <span className="font-mono text-stone-900" data-testid="current-version">
                {rows.find((row) => row.running)?.version}
              </span>
            </p>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        {rollback.inFlight ? (
          <Notice>{copy.app.releases.rollbackInFlight}</Notice>
        ) : started ? (
          <Notice tone="success">{copy.app.releases.rollbackStarted}</Notice>
        ) : null}
        {releaseState.isError ? <LoadFailed onRetry={() => void releaseState.refetch()} error={releaseState.error} /> : null}

        <div data-testid="release-history">
          {overview.isPending ? (
            <Loading />
          ) : overview.isError ? (
            <LoadFailed onRetry={() => void overview.refetch()} error={overview.error} />
          ) : (
            <DataTable
              table={table}
              caption={text.releases.caption}
              emptyState={<EmptyState icon={<History />} title={copy.app.releases.empty} />}
            />
          )}
          {!overview.isPending && scope && rollback.options.length === 0 && rows.length > 0 ? (
            <p className="mt-3 text-xs text-stone-500">{copy.app.releases.noRollback}</p>
          ) : null}
        </div>
      </CardBody>

      <ConfirmDialog
        open={pendingTarget !== undefined}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setPendingTarget(undefined)
        }}
        title={text.releases.confirmTitle}
        body={
          <>
            <p>{pendingTarget ? copy.app.releases.rollbackConfirm(pendingTarget.version) : null}</p>
            <p className="mt-2">{text.releases.confirmBody}</p>
          </>
        }
        confirmLabel={copy.app.releases.rollback}
        onConfirm={() => {
          if (pendingTarget) mutation.mutate(pendingTarget.transitionId)
        }}
        pending={mutation.isPending}
        error={mutation.error ?? undefined}
      />
    </Card>
  )
}
