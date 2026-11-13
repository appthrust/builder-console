import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act } from 'react'
import { draftOf } from './testing/build-domain'
import type { BuildDraft } from '../model/contracts/build'
import { createRoot } from 'react-dom/client'
import { copy } from '../copy'
import { SessionExpiryBoundary } from '../ui/session-expired'
import { getDraft } from './build'
import { buildDraftOptions } from './queries/build'
import { platformFetch } from './client'
import { groupsContract } from './contracts/console/groups'
import { meContract } from './contracts/console/me'
import { createTestGateway } from './testing/gateway'
import { retryQuery, retryReadQuery } from './queries/shared'
import { checkSessionResponse, isSessionExpiredError, sessionExpiryStore, signInAgain } from './session-expiry'

const originalFetch = globalThis.fetch
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
beforeEach(() => { sessionExpiryStore.setState(() => false) })
afterEach(() => {
  globalThis.fetch = originalFetch
  sessionExpiryStore.setState(() => false)
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
})

const expiredResponses: Array<[string, () => Response]> = [
  ['401', () => Response.json({ error: 'unauthorized' }, { status: 401 })],
  ['302 to IAM', () => new Response(null, { status: 302, headers: { location: 'https://iam.example.test/sign-in' } })],
  ['opaque redirect', () => Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' })],
  ['followed IAM redirect', () => Object.defineProperty(Response.json({}), 'redirected', { value: true })],
  ['HTML login page', () => new Response('<!doctype html><html>Sign in</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })],
]

test.each(expiredResponses)('Platform API %s settles as session expiry and blocks subsequent polling', async (_name, response) => {
  const fetch = mock(async () => response())
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  const request = new Request('https://console.example.test/api/v1/projects/p/application-drafts/d')
  const error = await platformFetch(request).catch((error: unknown) => error)
  expect(isSessionExpiredError(error)).toBe(true)
  expect(error).toMatchObject({ status: 401, code: 'SESSION_EXPIRED' })
  expect(retryReadQuery(0, error)).toBe(false)
  expect(retryQuery(0, error)).toBe(false)
  expect(sessionExpiryStore.state).toBe(true)
  expect((fetch.mock.calls[0] as unknown as [Request])[0].redirect).toBe('manual')
  await expect(platformFetch(request)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

test.each(expiredResponses)('Console/Directory %s uses the same session expiry latch', async (_name, response) => {
  const fetcher = mock(async (_input: string, _init: RequestInit) => response())
  const gateway = createTestGateway({ consoleFetch: fetcher })
  await expect(gateway.console(meContract, undefined)).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' })
  await expect(gateway.console(groupsContract, undefined)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]?.[1].redirect).toBe('manual')
})

test('gateway HTML, forbidden JSON and successful JSON are not mistaken for expired sessions', () => {
  for (const response of [new Response('<html>Unavailable</html>', { status: 503, headers: { 'content-type': 'text/html' } }), Response.json({ error: 'forbidden' }, { status: 403 }), Response.json({ id: 'draft' })]) {
    expect(checkSessionResponse(response)).toBe(response)
    expect(sessionExpiryStore.state).toBe(false)
  }
})

test('the real oRPC adapter preserves the typed session failure rather than parsing an IAM page', async () => {
  globalThis.fetch = mock(async () => new Response(null, { status: 302, headers: { location: 'https://iam.example.test/sign-in' } })) as unknown as typeof fetch
  const error = await getDraft('project', 'draft').catch((error: unknown) => error)
  expect(isSessionExpiredError(error)).toBe(true)
  expect(retryReadQuery(0, error)).toBe(false)
})

test('cached running draft becomes a visible sign-in notice, removes polling observers and retains data', async () => {
  const at = '2026-11-09T01:55:44Z'
  const draft: ApplicationDraft = { id: 'draft', projectId: 'project', title: 'App', intent: 'Build app', phase: 'specifying', specMarkdown: '', architectureMarkdown: '', creationExecutions: [], ownerUserId: 'owner', createdAt: at, updatedAt: at, conversationTurns: [{ id: 'kickoff', kind: 'conversation', userMessage: 'この内容で提案して', status: 'running', startedAt: at, devWorkspaceId: 'workspace' }] }
  const options = buildDraftOptions('project', 'draft')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const cached = draftOf(draft)
  client.setQueryData(options.queryKey, cached)
  const fetch = mock(async () => new Response(null, { status: 302 }))
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function Poll() {
    useQuery({ ...options, refetchOnMount: false })
    return <p>Thinking</p>
  }
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><SessionExpiryBoundary><Poll /></SessionExpiryBoundary></QueryClientProvider>) })
    expect(container.textContent).toContain('Thinking')
    await act(async () => { await client.refetchQueries({ queryKey: options.queryKey }) })
    expect(container.textContent).toContain(copy.common.sessionExpired)
    expect(container.querySelector('button')?.textContent).toBe(copy.common.signInAgain)
    expect(container.textContent).not.toContain('Thinking')
    expect(client.getQueryCache().find({ queryKey: options.queryKey })?.getObserversCount()).toBe(0)
    // The cache holds the domain draft the reader made; the expired poll leaves that very value in place.
    expect(client.getQueryData<BuildDraft>(options.queryKey)).toBe(cached)
    await client.refetchQueries({ queryKey: options.queryKey, type: 'active' })
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
  }
})

test('sign-in action navigates to the same draft URL without clearing its reservation', () => {
  const href = 'https://console.example.test/-/build/draft-41cb28ef'
  const assign = mock()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href, assign } } })
  sessionExpiryStore.setState(() => true)
  signInAgain()
  expect(assign).toHaveBeenCalledWith(href)
  expect(sessionExpiryStore.state).toBe(true)
})
