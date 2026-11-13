// The proposal screen against unreadable and unknown answers (design §5, §6,
// X3/X5, unknown Person): the real page, queries, gateway and contracts run
// over the in-memory Platform and console mocks; a proposal is made there by
// the improvement flow (as 佐藤) and reviewed by its owner (山田). Only the
// answer under test is rewritten on its way back.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider, type AnyRouter } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { groupsQuery, meQuery } from '../../api/queries/console'
import { proposalKeys } from '../../api/queries/proposal'
import { queryClient as appQueryClient } from '../../api/queries/shared'
import { copy } from '../../copy'
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'
import { setLanguage } from '../../shell/language'
import { preserveLanguage } from '../../../test/language'
import { text as appText } from '../app/copy'
import { text } from './copy'
import { ProposalPage } from './proposal-page'

const SECRET = 'SENTINEL-proposal-page-2b8f'
const PROJECT = '/api/v1/projects/commerce'
const PEOPLE = /^\/api\/console\/directory\/people$/

type Json = Record<string, unknown>
/** Rewrites a successful answer of the in-memory mocks before the page reads it. */
interface Rewrite { method: string; path: RegExp; body: (wire: Json, url: URL) => unknown; once: boolean }

let rewrites: Rewrite[] = []
let requests: { method: string; path: string; status: number }[] = []

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init)
  const url = new URL(request.url)
  const response = await (url.pathname.startsWith('/api/console/') ? consoleRoutes : platformRoutes)(request, url)
  requests.push({ method: request.method, path: url.pathname, status: response?.status ?? 404 })
  if (!response) return Response.json({ error: { message: 'unhandled' } }, { status: 404 })
  const rewrite = rewrites.find((item) => item.method === request.method && item.path.test(url.pathname))
  if (!rewrite || !response.ok) return response
  if (rewrite.once) rewrites = rewrites.filter((item) => item !== rewrite)
  const rewritten = rewrite.body((await response.json()) as Json, url)
  return rewritten instanceof Response ? rewritten : Response.json(rewritten, { status: response.status })
}

async function call(method: string, path: string, body?: unknown): Promise<Json> {
  const response = await mockFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return (await response.json()) as Json
}

/** 佐藤 improves 見積作成 until the proposal awaits review; 山田 (an owner) signs in to review it. */
async function propose(): Promise<string> {
  await call('POST', '/api/console/__mock/caller', { personId: 'p-sato', role: 'Editor' })
  const draft = await call('POST', `${PROJECT}/application-drafts`, { kind: 'improvement', applicationStackId: 'mitsumori', title: '見積作成', intent: '一覧に絞り込みを足したい' })
  const path = `${PROJECT}/application-drafts/${draft.id as string}`
  for (const message of ['一覧に絞り込みを足したい', '状態で絞り込みたい']) {
    await call('POST', `${path}/conversation-turns`, { message })
    await call('POST', '/api/v1/__mock/advance')
  }
  await call('POST', `${path}/implementation-runs`)
  for (let i = 0; i < 12; i++) await call('POST', '/api/v1/__mock/advance')
  const proposalId = (await call('GET', path)).proposalId as string
  await call('POST', '/api/console/__mock/caller', { personId: 'p-yamada', role: 'Editor' })
  return proposalId
}

/** Lets in-flight fetches settle and React Query's batched notifications reach the page. */
async function settle(rounds = 10) {
  for (let tick = 0; tick < rounds; tick++) await act(async () => { await Bun.sleep(10) })
}

const originalFetch = globalThis.fetch
let client: QueryClient
let root: Root | undefined
let container: HTMLDivElement
let restore: (() => void)[] = []
let router: AnyRouter
let proposalId: string
let detailPath: RegExp
let decisionsPath: RegExp

beforeEach(async () => {
  restore = [preserveLanguage()]
  setLanguage('ja')
  rewrites = []
  globalThis.fetch = mockFetch as typeof globalThis.fetch
  // The boundary reports a contract failure with console.warn (safe metadata only); keep test output quiet.
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restore.push(() => warn.mockRestore())
  for (const path of ['/api/v1/__mock/reset', '/api/console/__mock/reset']) await mockFetch(path, { method: 'POST' })
  proposalId = await propose()
  detailPath = new RegExp(`^${PROJECT}/source-change-proposals/${proposalId}$`)
  decisionsPath = new RegExp(`^${PROJECT}/source-change-proposals/${proposalId}/decisions$`)
  requests = []
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  for (const node of [...document.body.childNodes]) node.remove()
  client?.clear()
  globalThis.fetch = originalFetch
  for (const undo of restore.reverse()) undo()
})

/** The proposal page on the app's query defaults (retry policy included), with polling left to the test. */
async function renderProposal() {
  client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false, refetchOnWindowFocus: false } } })
  await Promise.all([client.fetchQuery(meQuery), client.fetchQuery(groupsQuery)])
  const rootRoute = createRootRoute()
  const anyRoute = createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null })
  router = createRouter({ routeTree: rootRoute.addChildren([anyRoute]), history: createMemoryHistory({ initialEntries: [`/-/proposals/${proposalId}`] }) })
  await router.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><ProposalPage id={proposalId} /></RouterContextProvider></QueryClientProvider>)
  })
  await settle()
}

const pageText = () => document.body.textContent ?? ''
const count = (method: string, path: RegExp) => requests.filter((item) => item.method === method && path.test(item.path)).length
const detailKey = () => proposalKeys.detail('commerce', proposalId)
const refreshFailed = copy.common.refreshFailed(copy.relative.justNow)
/** Every value the page holds in its query cache, serialized: nothing from an unreadable answer may be in it. */
const cachedWire = () => JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))
const actions = () => container.querySelector<HTMLElement>('[data-testid="proposal-actions"]')

function button(name: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((item) => item.textContent?.trim() === name)
  if (!found) throw new Error(`no button ${name}`)
  return found
}

async function click(target: HTMLElement) {
  await act(async () => { target.click() })
  await settle()
}

async function tick() {
  await act(async () => { await client.refetchQueries({ queryKey: detailKey(), exact: true }) })
  await settle()
}

/** The review actions are all shown and all disabled. */
function expectReviewDisabled() {
  for (const name of [text.accept, text.requestChanges, text.reject]) expect(button(name, actions()!).disabled).toBe(true)
}

describe('a reviewer opens the proposal', () => {
  test('the known proposal shows its tasks, proposer and reviewer names, and offers the decisions', async () => {
    await renderProposal()
    expect(container.querySelector('h1')!.textContent).toBe(String((await call('GET', `${PROJECT}/source-change-proposals/${proposalId}`)).title))
    expect(pageText()).toContain(text.by('佐藤 花子'))
    expect(pageText()).toContain(text.reviewers('山田 太郎'))
    expect(pageText()).toContain(text.phase.Proposed)
    expect(container.querySelectorAll('ol > li').length).toBeGreaterThan(0)
    for (const name of [text.accept, text.requestChanges, text.reject]) expect(button(name, actions()!).disabled).toBe(false)
    expect(pageText()).not.toContain(text.unsupported)
  })

  test('an unknown revision kind keeps the known parts and disables every review action with the fixed explanation', async () => {
    rewrites.push({ method: 'GET', path: detailPath, once: false, body: (wire) => ({ ...wire, base: { kind: 'Snapshot', snapshot: { id: SECRET } } }) })
    await renderProposal()
    expect(pageText()).toContain(text.reviewers('山田 太郎'))
    expect(pageText()).toContain(text.phase.Proposed)
    expect(actions()!.textContent).toContain(text.unsupported)
    expectReviewDisabled()
    await click(button(text.accept, actions()!))
    expect(count('POST', decisionsPath)).toBe(0)
    expect(container.innerHTML).not.toContain(SECRET)
  })

  test('an unknown phase reads 状態不明, never 確認待ち, and offers no decision', async () => {
    rewrites.push({ method: 'GET', path: detailPath, once: false, body: (wire) => ({ ...wire, phase: SECRET }) })
    await renderProposal()
    expect(container.querySelector('[data-status]')!.textContent).toBe(text.phaseUnknown)
    expect(pageText()).not.toContain(text.phase.Proposed)
    expect(actions()!.textContent).toContain(text.unsupported)
    expectReviewDisabled()
    expect(container.innerHTML).not.toContain(SECRET)
  })

  test('an unknown decision kind disables the decisions', async () => {
    rewrites.push({ method: 'GET', path: detailPath, once: false, body: (wire) => ({ ...wire, decisions: [{ subject: 'sub-sato', decision: SECRET, at: '2026-11-13T00:00:00Z' }] }) })
    await renderProposal()
    expect(actions()!.textContent).toContain(text.unsupported)
    expectReviewDisabled()
  })
})

describe('reviewer people the Directory cannot vouch for', () => {
  test('a subject the Directory does not know, or answers with someone else, is 「不明な利用者」', async () => {
    rewrites.push({
      method: 'GET', path: PEOPLE, once: false,
      // 佐藤 is answered as nobody; 山田's lookup is answered with 佐藤's record.
      body: (wire, url) => url.searchParams.get('subject') === 'sub-sato' ? { items: [] }
        : url.searchParams.get('subject') === 'sub-yamada' ? { items: [{ id: 'p-sato', subject: 'sub-sato', pending: false, email: 'sato@example.com', displayName: '佐藤 花子', avatarVersion: null }] }
        : wire,
    })
    await renderProposal()
    expect(pageText()).toContain(text.by(copy.common.unknownPerson))
    expect(pageText()).toContain(text.reviewers(copy.common.unknownPerson))
    expect(pageText()).not.toContain('佐藤 花子')
    // Review authority is the signed-in principal's subject, not a Directory name.
    expect(button(text.accept, actions()!).disabled).toBe(false)
  })
})

describe('X3: the proposal refreshes into an unreadable answer', () => {
  test('a first unreadable answer is the fixed load failure; nothing from it is shown or cached', async () => {
    rewrites.push({ method: 'GET', path: detailPath, once: false, body: (wire) => ({ ...wire, reviewers: SECRET }) })
    await renderProposal()
    expect(pageText()).toContain(copy.common.loadFailed)
    expect(actions()).toBeNull()
    expect(container.innerHTML).not.toContain(SECRET)
    expect(cachedWire()).not.toContain(SECRET)
  })

  test('the last good proposal stays under one stale notice, decisions wait for a current answer, and it clears on recovery', async () => {
    await renderProposal()
    const good = client.getQueryData(detailKey())
    const goodAt = client.getQueryState(detailKey())!.dataUpdatedAt
    const shown = container.querySelector('[data-testid="proposal-detail"]')!.textContent
    rewrites.push({ method: 'GET', path: detailPath, once: true, body: (wire) => ({ ...wire, decisions: null, title: SECRET }) })
    await tick()
    expect(Object.is(client.getQueryData(detailKey()), good)).toBe(true)
    expect(client.getQueryState(detailKey())!.dataUpdatedAt).toBe(goodAt)
    expect(pageText().split(refreshFailed)).toHaveLength(2)
    expect(container.querySelector('[data-testid="proposal-detail"]')!.textContent).toContain(refreshFailed)
    expect(container.querySelector('[data-testid="proposal-detail"]')!.textContent!.replace(refreshFailed, '').replace(copy.common.retry, '')).toBe(shown!)
    expect(pageText()).not.toContain(copy.common.loadFailed)
    expect(container.innerHTML).not.toContain(SECRET)
    expect(cachedWire()).not.toContain(SECRET)
    expectReviewDisabled()

    await tick()
    expect(pageText()).not.toContain(refreshFailed)
    expect(client.getQueryState(detailKey())!.dataUpdatedAt).toBeGreaterThan(goodAt)
    expect(button(text.accept, actions()!).disabled).toBe(false)
  })
})

describe('X5: a decision answered 2xx unreadably', () => {
  test('approve: nothing cached, no success, never sent twice; only the confirmation, which reads the proposal back', async () => {
    await renderProposal()
    const before = client.getQueryData(detailKey())
    rewrites.push({ method: 'POST', path: decisionsPath, once: true, body: (wire) => ({ ...wire, resource: { phase: SECRET } }) })
    const accept = button(text.accept, actions()!)
    // A double click is one decision.
    await act(async () => { accept.click(); accept.click() })
    await settle()
    expect(count('POST', decisionsPath)).toBe(1)
    expect(Object.is(client.getQueryData(detailKey()), before)).toBe(true)
    expect(cachedWire()).not.toContain(SECRET)
    expect(pageText()).toContain(text.phase.Proposed)
    const notice = [...actions()!.querySelectorAll('[role="status"]')].find((item) => item.textContent?.includes(appText.unconfirmed.title))!
    expect([...notice.querySelectorAll('button')].map((item) => item.textContent?.trim())).toEqual([appText.unconfirmed.confirm])
    expect(actions()!.textContent).not.toContain(copy.common.retry)
    expectReviewDisabled()
    await click(button(text.accept, actions()!))
    await settle()
    expect(count('POST', decisionsPath)).toBe(1)

    const reads = count('GET', detailPath)
    await click(button(appText.unconfirmed.confirm, actions()!))
    expect(count('GET', detailPath)).toBeGreaterThan(reads)
    expect(count('POST', decisionsPath)).toBe(1)
    // The decision had been recorded: the read-back shows it accepted, and nothing is offered to send again.
    expect(container.querySelector('[data-status]')!.textContent).not.toBe(text.phase.Proposed)
    expect(actions()).toBeNull()
    expect(pageText()).not.toContain(appText.unconfirmed.title)
  })

  test('request changes: the dialog closes, the comment is not resent; only the confirmation', async () => {
    await renderProposal()
    await click(button(text.requestChanges, actions()!))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const field = dialog.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, '担当者でも絞り込みたい')
      field.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
    })
    await settle()
    rewrites.push({ method: 'POST', path: decisionsPath, once: true, body: () => ({ resource: SECRET }) })
    await act(async () => { dialog.querySelector('form')!.requestSubmit() })
    await settle()
    expect(count('POST', decisionsPath)).toBe(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(actions()!.textContent).toContain(appText.unconfirmed.title)
    expectReviewDisabled()
    expect(container.innerHTML).not.toContain(SECRET)
    await click(button(appText.unconfirmed.confirm, actions()!))
    expect(count('POST', decisionsPath)).toBe(1)
    expect(container.querySelector('[data-status]')!.textContent).toBe(text.phase.ChangesRequested)
    expect(pageText()).toContain('担当者でも絞り込みたい')
  })
})
