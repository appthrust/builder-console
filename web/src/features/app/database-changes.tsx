// データベースの変更: the app database's changes that still need something —
// 承認待ち (with 「反映を承認する」), 反映中, 失敗 (with 「もう一度反映する」 when the
// run may be retried), 準備中 — and one 「反映済み N 件」 line for the applied ones.
// Shared by the app overview and the AI build session's side pane. A 403 or a
// database the Platform API does not know yet reads as one calm line; a Team
// membership that grants no database access gets the データ tab's notice.
// A phase, risk or run state this console does not know is shown as such and
// never offers 承認 or 再実行. A failed refresh keeps the list under one stale
// notice (and stops the actions, whose basis is the list); an approve or retry
// answered unreadably offers only 「最新の状態を確認する」.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { CheckCircle2, Clock, Lock } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ApiGateway } from '../../api/gateway'
import {
  approveDatabaseChange,
  databaseChangesQuery,
  isDataForbidden,
  isDataMembershipUnbound,
  isDatabaseNotFound,
  retryDatabaseChange,
  type DatabaseChangeTarget,
} from '../../api/queries/data'
import { keys } from '../../api/queries/shared'
import { copy, type ConsoleStatus } from '../../copy'
import { isOneOf, knownValue } from '../../model/contracts/build'
import type { DatabaseChange, DatabaseChangeRisk } from '../../model/contracts/data'
import { ActionError, Button, Card, CardBody, CardHeader, LoadFailed, StatusPill } from '../../ui'
import { text as appText } from './copy'
import { MembershipUnboundNotice } from './data/membership-unbound'
import { isUnconfirmedWrite, StaleNotice, UnconfirmedNotice, useWriteConfirmation } from './notices'

const text = copy.app.databaseChanges

/** `unsupported`: a phase this console does not know (shown as 状態不明, never approvable or retryable). */
type ChangeState = keyof typeof text.phase | 'unsupported'

export interface DatabaseChangeItem {
  id: string
  /** The migration file the change came from; undefined when the change names none. */
  path?: string
  state: ChangeState
  /** `unknown`: a review risk this console does not know. */
  risk?: DatabaseChangeRisk | 'unknown'
  /** 「反映を承認する」 is offered. */
  approvable: boolean
  /** 「もう一度反映する」 is offered: the last run failed and may be retried. */
  retryable: boolean
  /** What went wrong, for 「詳しい人向け」. */
  detail?: string
}

export type DatabaseChangeAction = 'approve' | 'retry'

const PILL: Record<ChangeState, ConsoleStatus> = {
  awaiting: 'unfinished',
  applying: 'deploying',
  failed: 'failed',
  preparing: 'unknown',
  rejected: 'unknown',
  unsupported: 'unknown',
}

function changeState(phase: DatabaseChange['phase']): ChangeState {
  if (phase?.kind === 'unknown') return 'unsupported'
  switch (knownValue(phase)) {
    case 'AwaitingApproval':
      return 'awaiting'
    case 'ReadyToRun':
    case 'Running':
      return 'applying'
    case 'Failed':
    case 'ReviewFailed':
      return 'failed'
    case 'Rejected':
      return 'rejected'
    default:
      return 'preparing'
  }
}

/** Unapplied changes in the order they were proposed, and how many were applied; archived ones are left out. */
export function deriveDatabaseChanges(changes: readonly DatabaseChange[]): { open: DatabaseChangeItem[]; applied: number } {
  const current = changes.filter((change) => !change.archived)
  const open = current
    .filter((change) => !isOneOf(change.phase, 'Succeeded'))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    .map((change): DatabaseChangeItem => {
      const state = changeState(change.phase)
      const findings = change.findings.filter(Boolean).join('\n')
      const detail = state === 'failed' ? change.latestRun?.message || findings || undefined : undefined
      const risk = change.risk ? knownValue(change.risk) ?? 'unknown' : undefined
      return {
        id: change.id,
        path: change.path,
        state,
        risk,
        // An approval rests on the review: an unknown risk is never approved here.
        approvable: state === 'awaiting' && risk !== 'unknown',
        retryable: isOneOf(change.phase, 'Failed') && isOneOf(change.latestRun?.phase, 'Failed') && change.latestRun?.retryable === true,
        detail,
      }
    })
  return { open, applied: current.length - open.length }
}

/**
 * Approve (decision Approved) or retry one change, then refetch the database's
 * change list. The accepted answer is not cached: the list read is the state.
 */
export async function runDatabaseChangeAction(
  queryClient: QueryClient,
  target: DatabaseChangeTarget,
  action: DatabaseChangeAction,
  gateway?: Pick<ApiGateway, 'platform'>,
): Promise<void> {
  if (action === 'approve') await approveDatabaseChange(target, gateway)
  else await retryDatabaseChange(target, gateway)
  await queryClient.invalidateQueries({ queryKey: keys.databaseChanges(target.projectId, target.databaseId) })
}

/** The app database's changes; renders nothing without a database, while loading, or when it never had a change. */
export function DatabaseChanges({ projectId, databaseId }: { projectId: string; databaseId: string | undefined }) {
  const queryClient = useQueryClient()
  const changes = useQuery(databaseChangesQuery(projectId, databaseId))
  const action = useMutation({
    mutationFn: ({ changeId, kind }: { changeId: string; kind: DatabaseChangeAction }) =>
      runDatabaseChangeAction(queryClient, { projectId, databaseId: databaseId!, changeId }, kind),
  })
  const confirmation = useWriteConfirmation([action.error], action.reset, () => changes.refetch())
  if (!databaseId || changes.isPending) return null
  return (
    <DatabaseChangesView
      changes={changes.data}
      error={changes.error}
      updatedAt={changes.dataUpdatedAt}
      refreshing={changes.isFetching}
      busy={action.isPending ? action.variables : undefined}
      actionError={action.error}
      unconfirmed={confirmation.unconfirmed ? { confirming: confirmation.confirming, onConfirm: () => void confirmation.confirm() } : undefined}
      onAction={(changeId, kind) => action.mutate({ changeId, kind })}
      onReload={() => void changes.refetch()}
    />
  )
}

export function DatabaseChangesView({ changes, error, updatedAt = 0, refreshing = false, busy, actionError, unconfirmed, onAction, onReload }: {
  changes: readonly DatabaseChange[] | undefined
  error: unknown
  /** When `changes` was last read (shown when a refresh failed). */
  updatedAt?: number
  refreshing?: boolean
  busy?: { changeId: string; kind: DatabaseChangeAction }
  actionError: unknown
  /** An approve or retry answered unreadably: its read-back, and whether it is running. */
  unconfirmed?: { confirming: boolean; onConfirm(): void }
  onAction(changeId: string, kind: DatabaseChangeAction): void
  onReload(): void
}) {
  // A refusal stands even over a list read earlier: it is never acted on with old access.
  if (isDataForbidden(error)) return <Frame><Calm icon={<Lock />}>{text.forbidden}</Calm></Frame>
  if (isDataMembershipUnbound(error)) return <Frame><MembershipUnboundNotice error={error} /></Frame>
  if (isDatabaseNotFound(error)) return <Frame><Calm icon={<Clock />}>{text.noDatabase}</Calm></Frame>
  if (!changes) return error ? <Frame><LoadFailed error={error} onRetry={onReload} /></Frame> : null
  const { open, applied } = deriveDatabaseChanges(changes)
  if (open.length === 0 && applied === 0) return null
  // The actions rest on the list: a list that could not be refreshed, or a write not yet read back, offers none.
  const stale = error !== null && error !== undefined
  const locked = busy !== undefined || stale || unconfirmed !== undefined
  return (
    <Frame lead={open.some((item) => item.approvable) ? text.lead : undefined}>
      {stale ? <div className="mb-3"><StaleNotice updatedAt={updatedAt} refetching={refreshing} onRetry={onReload} /></div> : null}
      {open.length > 0 ? (
        <ul className="divide-y divide-stone-100" data-testid="database-changes">
          {open.map((item) => (
            <Change key={item.id} item={item} busy={busy} locked={locked} onAction={onAction} />
          ))}
        </ul>
      ) : null}
      {applied > 0 ? (
        <p className={open.length > 0 ? 'mt-3 border-t border-stone-100 pt-3' : undefined}>
          <Calm icon={<CheckCircle2 />}>{text.applied(applied)}</Calm>
        </p>
      ) : null}
      {unconfirmed ? (
        <div className="mt-3"><UnconfirmedNotice confirming={unconfirmed.confirming} onConfirm={unconfirmed.onConfirm} /></div>
      ) : actionError && !isUnconfirmedWrite(actionError) ? (
        <div className="mt-3">
          {isDataForbidden(actionError) ? <Calm icon={<Lock />}>{text.actionForbidden}</Calm>
            : isDataMembershipUnbound(actionError) ? <MembershipUnboundNotice error={actionError} />
            : <ActionError error={actionError} />}
        </div>
      ) : null}
    </Frame>
  )
}

function Frame({ lead, children }: { lead?: string; children: ReactNode }) {
  return (
    <section aria-label={text.title}>
      <Card>
        <CardHeader title={text.title} lead={lead} />
        <CardBody>{children}</CardBody>
      </Card>
    </section>
  )
}

function Calm({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-start gap-2 text-sm text-stone-600 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-stone-400">
      {icon}
      <span>{children}</span>
    </span>
  )
}

function Change({ item, busy, locked, onAction }: {
  item: DatabaseChangeItem
  busy?: { changeId: string; kind: DatabaseChangeAction }
  /** Every action of the list is off (one is running, the list is stale, or a write awaits its read-back). */
  locked: boolean
  onAction(changeId: string, kind: DatabaseChangeAction): void
}) {
  const help = item.state === 'unsupported' || (item.state === 'awaiting' && item.risk === 'unknown')
    ? appText.unsupported.status
    : item.state === 'awaiting'
      ? item.risk === 'High' ? text.highRisk : text.awaitingHelp
      : item.state === 'failed' ? text.failedHelp : undefined
  const kind: DatabaseChangeAction | undefined = item.approvable ? 'approve' : item.retryable ? 'retry' : undefined
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0" data-state={item.state}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={PILL[item.state]} label={item.state === 'unsupported' ? appText.unsupported.label : text.phase[item.state]} />
          {item.path ? <span className="min-w-0 font-mono text-xs break-all text-stone-800">{item.path}</span> : <span className="text-sm text-stone-800">{text.unnamed}</span>}
        </div>
        {item.risk ? (
          <p className="mt-1.5 text-xs text-stone-500">
            {text.risk.label}: <span className={item.risk === 'High' ? 'font-medium text-bad-ink' : undefined}>{item.risk === 'unknown' ? appText.unsupported.releasePhase : text.risk[item.risk]}</span>
          </p>
        ) : null}
        {help ? <p className={item.risk === 'High' && item.state === 'awaiting' ? 'mt-1 text-sm text-bad-ink' : 'mt-1 text-sm text-stone-600'}>{help}</p> : null}
        {item.detail ? (
          <details className="mt-1 text-xs text-stone-500">
            <summary className="cursor-pointer select-none hover:text-stone-700">{text.details}</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{item.detail}</pre>
          </details>
        ) : null}
      </div>
      {kind ? (
        <Button
          tone={kind === 'approve' ? 'primary' : 'secondary'}
          size="sm"
          loading={busy?.changeId === item.id}
          disabled={locked}
          onClick={() => onAction(item.id, kind)}
        >
          {kind === 'approve' ? text.approve : text.retry}
        </Button>
      ) : null}
    </li>
  )
}
