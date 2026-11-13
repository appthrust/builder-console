import { ORPCError } from '@orpc/client'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ResponseContractError } from '../../api/boundary'
import { consoleConfigQuery } from '../../api/queries/console'
import { DATABASE_CHANGES_POLL_MS, databaseChangesQuery } from '../../api/queries/data'
import { changeOf } from '../../api/testing/data-domain'
import { createTestGateway } from '../../api/testing/gateway'
import { copy } from '../../copy'
import type { DatabaseChange } from '../../model/contracts/data'
import { text as appText } from './copy'
import { dataText } from './data/copy'
import { DatabaseChanges, DatabaseChangesView, runDatabaseChangeAction } from './database-changes'

const text = copy.app.databaseChanges
const base = { projectId: 'commerce', databaseId: 'shop-db' }
const wireApplied = { ...base, id: 'shop-db-0001-init', phase: 'Succeeded', source: { type: 'InlineSQL', path: 'db/migrations/0001_init.sql' }, createdAt: '2026-10-10T00:00:00Z' }
const wireAwaiting = {
  ...base, id: 'shop-db-0002-items', phase: 'AwaitingApproval',
  source: { type: 'InlineSQL', path: 'db/migrations/0002_create_items.sql' }, review: { passed: true, risk: 'Low' }, createdAt: '2026-10-12T00:00:00Z',
}
const wireFailed = { ...base, id: 'shop-db-0003', phase: 'Failed', latestRun: { id: 'r1', clusterId: 'c', phase: 'Failed', retryable: true, message: 'connection reset' } }
const applied = changeOf(wireApplied)
const awaiting = changeOf(wireAwaiting)
const noop = () => undefined
const view = (props: Partial<Parameters<typeof DatabaseChangesView>[0]>) =>
  renderToStaticMarkup(<DatabaseChangesView changes={undefined} error={null} actionError={null} onAction={noop} onReload={noop} {...props} />)
/** The action buttons of the list (approve / retry) and whether each is enabled. */
const actions = (html: string) => [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*?(反映を承認する|もう一度反映する)<\/button>/g)].map((match) => [match[1], !/\sdisabled=""/.test(match[0])])

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
  const retryable = view({ changes: [changeOf(wireFailed)] })
  expect(retryable).toContain(text.phase.failed)
  expect(retryable).toContain(text.retry)
  expect(retryable).toContain('connection reset')
  expect(retryable).toContain(text.unnamed)
  expect(view({ changes: [changeOf({ ...wireFailed, latestRun: { ...wireFailed.latestRun, retryable: false } })] })).not.toContain(text.retry)
  expect(view({ changes: [changeOf({ ...wireAwaiting, archived: true })] })).toBe('')
})

test('a phase, risk or run state this console does not know is shown as such and never offers an action', () => {
  const unknownPhase = view({ changes: [changeOf({ ...wireAwaiting, phase: 'Quarantined' })] })
  expect(unknownPhase).toContain(appText.unsupported.label)
  expect(unknownPhase).toContain(appText.unsupported.status)
  expect(unknownPhase).not.toContain(text.phase.preparing)
  expect(actions(unknownPhase)).toEqual([])
  // Never counted as applied either.
  expect(unknownPhase).not.toContain(text.applied(1))

  const unknownRisk = view({ changes: [changeOf({ ...wireAwaiting, review: { passed: true, risk: 'Catastrophic' } })] })
  expect(unknownRisk).toContain(text.phase.awaiting)
  expect(unknownRisk).toContain(`${text.risk.label}: <span>${appText.unsupported.releasePhase}</span>`)
  expect(actions(unknownRisk)).toEqual([])

  const unknownRun = view({ changes: [changeOf({ ...wireFailed, latestRun: { ...wireFailed.latestRun, phase: 'Paused' } })] })
  expect(unknownRun).toContain(text.phase.failed)
  expect(actions(unknownRun)).toEqual([])
})

test('a failed refresh keeps the list under one stale notice and stops its actions', () => {
  const unreadable = new ResponseContractError({ source: 'platform', operationId: 'platformApiListDatabaseChanges', method: 'GET', routeTemplate: '/x', issues: [{ path: '/data', code: 'invalid_type' }] })
  const html = view({ changes: [applied, awaiting], error: unreadable, updatedAt: Date.now() })
  expect(html.split(copy.common.refreshFailed(copy.relative.justNow))).toHaveLength(2)
  expect(html).toContain('db/migrations/0002_create_items.sql')
  expect(html).not.toContain(copy.common.loadFailed)
  expect(actions(html)).toEqual([[text.approve, false]])
  expect(actions(view({ changes: [applied, awaiting] }))).toEqual([[text.approve, true]])
})

test('an approve answered unreadably offers only 「最新の状態を確認する」 and keeps the actions off', () => {
  const unconfirmed = new ResponseContractError({ source: 'platform', operationId: 'platformApiCreateDatabaseChangeApproval', method: 'POST', routeTemplate: '/x', issues: [{ path: '/resource', code: 'missing' }] })
  const html = view({ changes: [applied, awaiting], actionError: unconfirmed, unconfirmed: { confirming: false, onConfirm: noop } })
  expect(html).toContain(appText.unconfirmed.title)
  expect(html).toContain(appText.unconfirmed.confirm)
  expect(html).not.toContain(copy.common.retry)
  expect(actions(html)).toEqual([[text.approve, false]])
})

test('403 renders the calm permission line, never an error alert, even over a list read earlier', () => {
  const forbidden = new ORPCError('FORBIDDEN', { status: 403, data: { body: { error: { code: 'forbidden', message: 'denied' } } } })
  for (const html of [view({ error: forbidden }), view({ changes: [awaiting], error: forbidden })]) {
    expect(html).toContain(text.forbidden)
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain(copy.common.loadFailed)
    expect(html).not.toContain(text.approve)
  }
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

test('approving sends decision Approved for that change through the gateway and refetches the list', async () => {
  let current: unknown[] = [wireApplied, wireAwaiting]
  const requests: { method: string; path: string; body?: unknown }[] = []
  const gateway = createTestGateway({
    platformFetch: async (request) => {
      const path = new URL(request.url).pathname
      requests.push({ method: request.method, path, ...(request.method === 'POST' ? { body: await request.json() } : {}) })
      if (request.method === 'GET') return Response.json({ data: current, meta: { total: current.length } })
      current = [wireApplied, { ...wireAwaiting, phase: 'ReadyToRun' }]
      return Response.json({ ...wireAwaiting, resource: { id: wireAwaiting.id, projectId: 'commerce', databaseId: 'shop-db', phase: 'ReadyToRun' }, operation: {} }, { status: 202 })
    },
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const observer = new QueryObserver(queryClient, databaseChangesQuery('commerce', 'shop-db', gateway))
  const unsubscribe = observer.subscribe(noop)
  try {
    await observer.refetch()
    await runDatabaseChangeAction(queryClient, { projectId: 'commerce', databaseId: 'shop-db', changeId: awaiting.id }, 'approve', gateway)

    expect(requests.map((item) => [item.method, item.path])).toEqual([
      ['GET', '/api/v1/projects/commerce/databases/shop-db/changes'],
      ['POST', `/api/v1/projects/commerce/databases/shop-db/changes/${awaiting.id}/approvals`],
      ['GET', '/api/v1/projects/commerce/databases/shop-db/changes'],
    ])
    expect(requests[1]?.body).toEqual({ decision: 'Approved' })
    expect(observer.getCurrentResult().data?.find((change) => change.id === awaiting.id)?.phase).toEqual({ kind: 'known', value: 'ReadyToRun' })
  } finally {
    unsubscribe()
    queryClient.clear()
  }
})

test('an approve answered 2xx unreadably rejects as unconfirmed and refetches nothing', async () => {
  let posts = 0
  let reads = 0
  const gateway = createTestGateway({
    platformFetch: async (request) => {
      if (request.method === 'GET') {
        reads++
        return Response.json({ data: [wireAwaiting], meta: { total: 1 } })
      }
      posts++
      return Response.json({ resource: { phase: 'ReadyToRun' } }, { status: 202 })
    },
  })
  const queryClient = new QueryClient()
  const failure = await runDatabaseChangeAction(queryClient, { projectId: 'commerce', databaseId: 'shop-db', changeId: awaiting.id }, 'approve', gateway).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(ResponseContractError)
  expect((failure as ResponseContractError).outcome).toBe('write_unconfirmed')
  expect([posts, reads]).toEqual([1, 0])
})

test('the list polls every 10 s only while a change is still moving; an unknown phase keeps the usual poll', () => {
  const interval = databaseChangesQuery('commerce', 'shop-db').refetchInterval as (query: unknown) => number | false
  const at = (changes: DatabaseChange[]) => interval({ state: { data: changes } })
  expect(at([applied, awaiting])).toBe(DATABASE_CHANGES_POLL_MS)
  expect(at([applied, changeOf({ ...wireAwaiting, phase: 'Running' })])).toBe(DATABASE_CHANGES_POLL_MS)
  expect(at([applied, changeOf({ ...wireAwaiting, phase: 'Failed' })])).toBe(false)
  expect(at([applied, changeOf({ ...wireAwaiting, archived: true })])).toBe(false)
  expect(at([applied, changeOf({ ...wireAwaiting, phase: 'Quarantined' })])).toBe(DATABASE_CHANGES_POLL_MS)
})
