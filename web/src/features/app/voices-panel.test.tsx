import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { appQuery, commentsQuery, consoleKeys, meQuery } from '../../api/queries/console'
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'
import type { AppComment } from '../../model/contracts/console'
import { VoicesPanel } from './voices-panel'

const APP_ID = 'a-keihi'
const originalFetch = globalThis.fetch
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  globalThis.fetch = originalFetch
})

async function settle() {
  for (let tick = 0; tick < 4; tick++) await act(async () => { await Bun.sleep(5) })
}

async function renderPanel({ unread, author, delayed = false }: { unread: number; author?: 'viewer' | 'other'; delayed?: boolean }) {
  const writes: { keepalive: boolean | undefined }[] = []
  let comments: AppComment[] = []
  const { promise, resolve: releaseComments } = Promise.withResolvers<void>()
  const commentsReady = delayed ? promise : Promise.resolve()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init)
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === `/api/console/apps/${APP_ID}/comments`) {
      await commentsReady
      return Response.json(comments)
    }
    if (request.method === 'GET' && url.pathname === '/api/console/inbox') {
      return Response.json({ items: unread > 0 ? [{ kind: 'feedback', app: { id: APP_ID, path: 'sales/east/team-a/keihi', displayName: '経費精算', icon: '💴' }, count: unread, since: '2026-10-10T09:00:00.000Z' }] : [] })
    }
    if (request.method === 'POST' && url.pathname === `/api/console/apps/${APP_ID}/comments/seen`) writes.push({ keepalive: init?.keepalive })
    return await (url.pathname.startsWith('/api/console/') ? consoleRoutes : platformRoutes)(request, url) ?? new Response(null, { status: 404 })
  }) as typeof globalThis.fetch
  for (const path of ['/api/v1/__mock/reset', '/api/console/__mock/reset']) await fetch(path, { method: 'POST' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } } })
  const [me, app] = await Promise.all([client.fetchQuery(meQuery), client.fetchQuery(appQuery(APP_ID))])
  if (author) comments = [{ id: 'c-voices', appId: APP_ID, author: { ...me.person, id: author === 'viewer' ? me.person.id : 'p-other' }, body: '使ってみました', createdAt: '2026-10-10T09:00:00.000Z' }]
  const rootRoute = createRootRoute()
  const route = createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null })
  const router = createRouter({ routeTree: rootRoute.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanups.push(async () => {
    releaseComments()
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
  })
  await act(async () => { root.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><VoicesPanel app={app} projectId={me.projectId} stackId={undefined} /></RouterContextProvider></QueryClientProvider>) })
  await settle()
  return { client, container, writes, releaseComments }
}

test.each([0, 1])('no comments makes no seen request, even with unread=%s', async (unread) => {
  const { writes } = await renderPanel({ unread })
  expect(writes).toHaveLength(0)
})

test('comments without unread feedback make no seen request', async () => {
  const { writes } = await renderPanel({ unread: 0, author: 'other' })
  expect(writes).toHaveLength(0)
})

test('only the viewer’s comments make no seen request', async () => {
  const { writes } = await renderPanel({ unread: 1, author: 'viewer' })
  expect(writes).toHaveLength(0)
})

test('unread feedback waits for another author’s comment and marks seen exactly once', async () => {
  const { client, container, writes, releaseComments } = await renderPanel({ unread: 1, author: 'other', delayed: true })
  expect(writes).toHaveLength(0)
  await act(async () => { releaseComments() })
  await settle()
  expect(writes).toHaveLength(1)
  expect(writes[0]?.keepalive).toBe(true)
  await act(async () => {
    client.setQueryData(consoleKeys.inbox, [])
    await client.refetchQueries({ queryKey: commentsQuery(APP_ID).queryKey })
  })
  await settle()
  expect(writes).toHaveLength(1)
  expect(container.querySelector('[data-testid="voices-new"]')).not.toBeNull()
})
