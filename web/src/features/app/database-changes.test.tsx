import type { DatabaseChange } from '@appthrust/api-schema/platform-api'
import { ORPCError } from '@orpc/client'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { consoleConfigQuery } from '../../api/queries/console'
import { DATABASE_CHANGES_POLL_MS, databaseChangesQuery } from '../../api/queries/data'
import { copy } from '../../copy'
import { dataText } from './data/copy'
import { DatabaseChanges, DatabaseChangesView, runDatabaseChangeAction } from './database-changes'

const text = copy.app.databaseChanges
const base = { projectId: 'commerce', databaseId: 'shop-db' }
const applied: DatabaseChange = { ...base, id: 'shop-db-0001-init', phase: 'Succeeded', source: { type: 'InlineSQL', path: 'db/migrations/0001_init.sql' }, createdAt: '2026-10-10T00:00:00Z' }
const awaiting: DatabaseChange = {
  ...base, id: 'shop-db-0002-items', phase: 'AwaitingApproval',
  source: { type: 'InlineSQL', path: 'db/migrations/0002_create_items.sql' }, review: { passed: true, risk: 'Low' }, createdAt: '2026-10-12T00:00:00Z',
}
const noop = () => undefined
const view = (props: Partial<Parameters<typeof DatabaseChangesView>[0]>) =>
  renderToStaticMarkup(<DatabaseChangesView changes={undefined} error={null} actionError={null} onAction={noop} onReload={noop} {...props} />)

test('an awaiting change shows 承認待ち, its file and the approve button; applied ones collapse into one line', () => {
  const html = view({ changes: [applied, awaiting] })
  expect(html).toContain(text.title)
  expect(html).toContain(text.phase.awaiting)
  expect(html).toContain('db/migrations/0002_create_items.sql')
  expect(html).toContain(`${text.risk.label}: <span>${text.risk.Low}</span>`)
  expect(html).toContain(text.approve)
  expect(html).toContain(text.applied(1))
  // The applied change is counted, not listed.
  expect(html).not.toContain('db/migrations/0001_init.sql')
  expect(html).not.toContain(text.retry)
})

test('a failed change offers もう一度反映する only when its last run may be retried; archived changes are left out', () => {
  const failed: DatabaseChange = { ...base, id: 'shop-db-0003', phase: 'Failed', latestRun: { id: 'r1', clusterId: 'c', phase: 'Failed', retryable: true, message: 'connection reset' } }
  const retryable = view({ changes: [failed] })
  expect(retryable).toContain(text.phase.failed)
  expect(retryable).toContain(text.retry)
  expect(retryable).toContain('connection reset')
  expect(retryable).toContain(text.unnamed)
  expect(view({ changes: [{ ...failed, latestRun: { ...failed.latestRun!, retryable: false } }] })).not.toContain(text.retry)
  expect(view({ changes: [{ ...awaiting, archived: true }] })).toBe('')
})

test('403 renders the calm permission line, never an error alert', () => {
  const forbidden = new ORPCError('FORBIDDEN', { status: 403, data: { body: { error: { code: 'forbidden', message: 'denied' } } } })
  const html = view({ error: forbidden })
  expect(html).toContain(text.forbidden)
  expect(html).not.toContain('role="alert"')
  expect(html).not.toContain(copy.common.loadFailed)
})

test('a 412 membership-unbound list or action names the cause like the データ tab, with the team settings link', () => {
  const unbound = new ORPCError('UNKNOWN', { status: 412, data: { body: { error: { code: 'failed_precondition', message: 'refused', details: { reason: 'database_access_membership_unbound', membershipReason: 'NotPersisted', teamId: 'tm-1' } } } } })
  const settingsUrl = 'https://dashboard.example.test/dashboard/settings'
  const client = new QueryClient()
  client.setQueryData(consoleConfigQuery.queryKey, { projectId: 'commerce', dashboardUrl: settingsUrl })
  const render = (props: Partial<Parameters<typeof DatabaseChangesView>[0]>) => renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DatabaseChangesView changes={undefined} error={null} actionError={null} onAction={noop} onReload={noop} {...props} />
    </QueryClientProvider>
  )
  for (const html of [render({ error: unbound }), render({ changes: [awaiting], actionError: unbound })]) {
    expect(html).toContain(dataText.membershipUnboundTitle)
    expect(html).toContain(dataText.membershipUnbound.NotPersisted)
    expect(html).toContain(`href="${settingsUrl}"`)
    expect(html).not.toContain(text.forbidden)
    expect(html).not.toContain(copy.common.loadFailed)
  }
})

test('404 (the database is not there yet) renders the calm 準備中 line', () => {
  const html = view({ error: new ORPCError('NOT_FOUND', { status: 404, data: { body: { error: { code: 'not_found', message: 'database not found' } } } }) })
  expect(html).toContain(text.noDatabase)
  expect(html).not.toContain('role="alert"')
})

test('an app without a database renders nothing', () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <DatabaseChanges projectId="commerce" databaseId={undefined} />
    </QueryClientProvider>
  )
  expect(html).toBe('')
})

test('approving sends decision Approved for that change and refetches the list', async () => {
  let current: DatabaseChange[] = [applied, awaiting]
  let listCalls = 0
  const approvals: unknown[] = []
  const api = {
    platformApiListDatabaseChanges: async () => { listCalls++; return { data: current, meta: { total: current.length } } },
    platformApiCreateDatabaseChangeApproval: async (input: unknown) => {
      approvals.push(input)
      current = [applied, { ...awaiting, phase: 'ReadyToRun' }]
      return {} as never
    },
    platformApiRetryDatabaseChange: async () => { throw new Error('not called') },
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const observer = new QueryObserver(queryClient, databaseChangesQuery('commerce', 'shop-db', api))
  const unsubscribe = observer.subscribe(noop)
  try {
    await observer.refetch()
    expect(listCalls).toBe(1)

    await runDatabaseChangeAction(api, queryClient, { projectId: 'commerce', databaseId: 'shop-db', changeId: awaiting.id }, 'approve')

    expect(approvals).toEqual([{ params: { projectId: 'commerce', id: 'shop-db', changeId: awaiting.id }, body: { decision: 'Approved' } }])
    expect(listCalls).toBe(2)
    expect(observer.getCurrentResult().data?.data.find((change) => change.id === awaiting.id)?.phase).toBe('ReadyToRun')
  } finally {
    unsubscribe()
    queryClient.clear()
  }
})

test('the list polls every 10 s only while a change is still moving', () => {
  const interval = databaseChangesQuery('commerce', 'shop-db').refetchInterval as (query: unknown) => number | false
  const at = (changes: DatabaseChange[]) => interval({ state: { data: { data: changes } } })
  expect(at([applied, awaiting])).toBe(DATABASE_CHANGES_POLL_MS)
  expect(at([applied, { ...awaiting, phase: 'Running' }])).toBe(DATABASE_CHANGES_POLL_MS)
  expect(at([applied, { ...awaiting, phase: 'Failed' }])).toBe(false)
  expect(at([applied, { ...awaiting, archived: true }])).toBe(false)
})
