// The Excel → app page against 2xx write answers it cannot read (design §6, X5):
// the real page, queries, gateway and contracts run over the in-memory Platform
// and console mocks; only the answer under test is rewritten on its way back.
// A write whose answer cannot be read may have happened: nothing from it is
// cached, its success side effect does not run, nothing is resent, and the only
// way on is 「最新の状態を確認する」 (a re-read).
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { z } from 'zod'
import { groupsContract } from '../../api/contracts/console/groups'
import { meContract } from '../../api/contracts/console/me'
import { buildKeys } from '../../api/queries/build'
import { consoleKeys } from '../../api/queries/console'
import { queryClient as appQueryClient } from '../../api/queries/shared'
import { createTestGateway } from '../../api/testing/gateway'
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'
import { buildCopy } from '../../model/build/copy'
import type { BuildDraft } from '../../model/contracts/build'
import { paths } from '../../routes/paths'
import { setLanguage } from '../../shell/language'
import { UnsavedChangesProvider } from '../../ui/use-unsaved-changes-guard'
import { preserveLanguage } from '../../../test/language'
import { text } from './copy'
import { toDraftWorkbook } from './model'
import { Excel2AppPage } from './page'
import { SAMPLE_SETS } from './samples'
import { UI_DESIGN_INIT } from './use-excel2app-draft'

const SECRET = 'SENTINEL-excel-page-41b9'
const PROJECT = '/api/v1/projects/commerce'
const DRAFTS = `${PROJECT}/application-drafts`
const SAMPLE = SAMPLE_SETS.find((sample) => sample.id === 'defects')!
const FILE = SAMPLE.workbooks[0]!.fileName

type Json = Record<string, unknown>
/** Rewrites a successful answer of the in-memory Platform mock before the page reads it. */
interface Rewrite { method: string; path: RegExp; body: (wire: Json) => unknown; once: boolean }

let rewrites: Rewrite[] = []
let requests: { method: string; path: string; status: number; idempotencyKey: string | null }[] = []

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init)
  const url = new URL(request.url)
  const idempotencyKey = request.headers.get('Idempotency-Key')
  const response = await (url.pathname.startsWith('/api/console/') ? consoleRoutes : platformRoutes)(request, url)
  requests.push({ method: request.method, path: url.pathname, status: response?.status ?? 404, idempotencyKey })
  if (!response) return Response.json({ error: { message: 'unhandled' } }, { status: 404 })
  const rewrite = rewrites.find((item) => item.method === request.method && item.path.test(url.pathname))
  if (!rewrite || !response.ok) return response
  if (rewrite.once) rewrites = rewrites.filter((item) => item !== rewrite)
  return Response.json(rewrite.body((await response.json()) as Json), { status: response.status })
}

/** Drives the Platform mock directly (setup and server-side truth); these calls are not the page's requests. */
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(path, 'http://mock.test')
  const response = await platformRoutes(new Request(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), url)
  if (!response?.ok) throw new Error(`mock ${method} ${path}: ${response?.status}`)
  return (await response.json()) as Json
}
const draftPath = (id: string) => `${DRAFTS}/${id}`
const consoleGateway = createTestGateway({ consoleFetch: (path, init) => mockFetch(path, init) })

/** A draft holding the sample workbook; `analysed` runs the analysis turn, `designed` the default design turn. */
async function storedDraft({ analysed = false, designed = false } = {}) {
  const id = ((await call('POST', DRAFTS, { title: '不具合管理台帳', intent: text.pick.draftIntent(FILE) })).resource as Json).id as string
  await call('POST', `${draftPath(id)}/workbooks`, toDraftWorkbook(SAMPLE.workbooks[0]!), { 'Idempotency-Key': 'wire-setup' })
  if (analysed) {
    await call('POST', `${draftPath(id)}/conversation-turns`, { kind: 'excel-analysis', message: '' })
    await call('POST', '/api/v1/__mock/advance')
  }
  if (designed) {
    await call('POST', `${draftPath(id)}/conversation-turns`, { kind: 'ui-design', message: UI_DESIGN_INIT })
    await call('POST', '/api/v1/__mock/advance')
  }
  return id
}

/** Lets in-flight fetches settle and React Query's batched notifications reach the page. */
async function settle(rounds = 8) {
  for (let tick = 0; tick < rounds; tick++) await act(async () => { await Bun.sleep(10) })
}

/** Settles until `ready` holds (the preview loads the stored grids and the chart code). */
async function until(ready: () => boolean, rounds = 60) {
  for (let tick = 0; tick < rounds && !ready(); tick++) await settle(1)
  if (!ready()) throw new Error('the page did not reach the expected state')
}

const storage = { session: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), local: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') }
const originalFetch = globalThis.fetch
let client: QueryClient
let root: Root | undefined
let container: HTMLDivElement
let restore: (() => void)[] = []

beforeEach(async () => {
  restore = [preserveLanguage()]
  setLanguage('ja')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage })
  window.sessionStorage.clear()
  rewrites = []
  requests = []
  globalThis.fetch = mockFetch as typeof globalThis.fetch
  // The boundary reports a contract failure with console.warn (safe metadata only); keep test output quiet.
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restore.push(() => warn.mockRestore())
  await call('POST', '/api/v1/__mock/reset')
  const consoleReset = new URL('/api/console/__mock/reset', 'http://mock.test')
  await consoleRoutes(new Request(consoleReset, { method: 'POST' }), consoleReset)
  await call('POST', '/api/v1/__mock/codex', { available: true })
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  client?.clear()
  globalThis.fetch = originalFetch
  window.sessionStorage.clear()
  for (const undo of restore.reverse()) undo()
  for (const [key, descriptor] of [['sessionStorage', storage.session], ['localStorage', storage.local]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

/** The Excel → app route (its search carries the draft once one exists) on the app's query defaults, with polling left to the test. */
async function renderExcel(draftId?: string) {
  client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false } } })
  const [me, groups] = await Promise.all([consoleGateway.console(meContract, undefined), consoleGateway.console(groupsContract, undefined)])
  client.setQueryData(consoleKeys.me, me)
  client.setQueryData(consoleKeys.groups, groups)
  const rootRoute = createRootRoute({ component: () => <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> })
  const excelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/-/excel2app',
    validateSearch: z.object({ draft: z.string().min(1).optional() }),
    component: function ExcelRoute() {
      const { draft } = excelRoute.useSearch()
      return <Excel2AppPage draftId={draft} />
    },
  })
  const buildRoute = createRoute({ getParentRoute: () => rootRoute, path: '/-/build/$draftId', component: () => null })
  const router = createRouter({ routeTree: rootRoute.addChildren([excelRoute, buildRoute]), history: createMemoryHistory({ initialEntries: [paths.excel2app(draftId)] }) })
  await router.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  })
  await settle()
  return router
}

const count = (method: string, path: RegExp) => requests.filter((item) => item.method === method && path.test(item.path)).length
/** Every value the page holds in its query cache, serialized: nothing from an unreadable answer may be in it. */
const cachedWire = () => JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))
const byTestId = <E extends Element = HTMLElement>(id: string) => container.querySelector<E>(`[data-testid="${id}"]`)
const unconfirmedNotices = () => [...container.querySelectorAll('[role="status"], [role="alert"]')].filter((item) => item.querySelector('p')?.textContent === buildCopy.failure.unconfirmed.title)
const buttonsIn = (scope: Element) => [...scope.querySelectorAll('button')].map((item) => item.textContent?.trim())
const stepTitle = () => container.querySelector('#excel2app-step-title')?.textContent
const fileRows = () => [...container.querySelectorAll('[data-testid="excel2app-file"]')].map((row) => ({ state: row.getAttribute('data-state'), status: row.querySelector('[role="status"]')?.textContent }))

/** Types into a React-controlled field the way a user does. */
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
  field.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
  if (!found) throw new Error(`no button ${name}`)
  return found
}

async function click(target: Element | null) {
  if (!target) throw new Error('nothing to click')
  await act(async () => { (target as HTMLElement).click() })
  await settle()
}

/** The one notice of an unconfirmed write offers only the re-read. */
function expectOnlyConfirm() {
  const notices = unconfirmedNotices()
  expect(notices).toHaveLength(1)
  expect(buttonsIn(notices[0]!)).toEqual([buildCopy.failure.confirm])
}

describe('X5: a 2xx Excel write whose answer cannot be read', () => {
  const workbooks = /\/application-drafts\/[^/]+\/workbooks$/
  const turns = /\/application-drafts\/[^/]+\/conversation-turns$/
  const draftGet = /\/application-drafts\/[^/]+$/

  /** Picks the one-workbook sample on a fresh page; the workbook POST answers 201 with a body that breaks the contract. */
  async function unreadableWorkbookAdd() {
    const router = await renderExcel()
    rewrites.push({ method: 'POST', path: workbooks, once: true, body: (wire) => ({ ...wire, workbook: { ...(wire.workbook as Json), id: SECRET } }) })
    await click(byTestId(`excel2app-sample-${SAMPLE.id}`))
    await settle(10)
    const draftId = router.state.location.search.draft as string
    return { router, draftId }
  }
  test('workbook add in a batch: the rest of the batch is not sent after an unreadable answer, and after the re-read each is offered again under its own key', async () => {
    await renderExcel()
    rewrites.push({ method: 'POST', path: workbooks, once: true, body: (wire) => ({ ...wire, workbook: { ...(wire.workbook as Json), id: SECRET } }) })
    const orders = SAMPLE_SETS.find((sample) => sample.id === 'orders')!
    expect(orders.workbooks.length).toBeGreaterThan(1)
    await click(byTestId('excel2app-sample-orders'))
    await settle(10)
    expect(count('POST', workbooks)).toBe(1)
    expect(count('POST', turns)).toBe(0)
    expectOnlyConfirm()
    const notSent = orders.workbooks.slice(1).map(() => ({ state: 'failed', status: text.pick.saveFailed }))
    expect(fileRows()).toEqual(expect.arrayContaining([{ state: 'failed', status: text.pick.unconfirmed }, ...notSent]))

    await click(byTestId('excel2app-unconfirmed')!.querySelector('button'))
    expect(count('POST', workbooks)).toBe(1)
    expect(fileRows()).toEqual([{ state: 'stored', status: text.pick.stored }, ...notSent])
    for (let file = 1; file < orders.workbooks.length; file++) await click(button(text.pick.retry))
    const adds = requests.filter((item) => item.method === 'POST' && workbooks.test(item.path))
    expect(adds.map((item) => item.status)).toEqual(orders.workbooks.map(() => 201))
    expect(new Set(adds.map((item) => item.idempotencyKey)).size).toBe(orders.workbooks.length)
    expect(fileRows()).toEqual(orders.workbooks.map(() => ({ state: 'stored', status: text.pick.stored })))
    // Retrying the files never starts the analysis on its own.
    expect(count('POST', turns)).toBe(0)
  })

  test('workbook add: nothing is cached, the analysis does not start, nothing is resent, only a re-read is offered, and the re-read finds the stored workbook', async () => {
    const { draftId } = await unreadableWorkbookAdd()
    expect(requests.filter((item) => item.method === 'POST' && workbooks.test(item.path)).map((item) => item.status)).toEqual([201])
    // The sample's success side effect is the analysis turn: it is not started on an unread add.
    expect(count('POST', turns)).toBe(0)
    expect(draftId).toBeTruthy()
    expectOnlyConfirm()
    expect(cachedWire()).not.toContain(SECRET)
    expect(container.innerHTML).not.toContain(SECRET)
    // The file is neither offered for a retry nor counted as stored; adding or picking more is closed.
    expect(fileRows()).toContainEqual({ state: 'failed', status: text.pick.unconfirmed })
    expect([...container.querySelectorAll('button')].some((item) => item.textContent?.trim() === text.pick.retry)).toBe(false)
    expect(byTestId<HTMLButtonElement>(`excel2app-sample-${SAMPLE.id}`)?.disabled).toBe(true)

    // Later reads and renders never send the workbook again.
    await act(async () => { await client.refetchQueries({ queryKey: buildKeys.draft('commerce', draftId) }) })
    await settle(20)
    expect(count('POST', workbooks)).toBe(1)

    const reads = count('GET', draftGet)
    await click(byTestId('excel2app-unconfirmed')!.querySelector('button'))
    expect(count('GET', draftGet)).toBeGreaterThan(reads)
    expect(unconfirmedNotices()).toHaveLength(0)
    // The re-read shows the add happened: one stored row, no second POST.
    expect(fileRows()).toEqual([{ state: 'stored', status: text.pick.stored }])
    expect(count('POST', workbooks)).toBe(1)
    const server = ((await call('GET', draftPath(draftId))).source as { workbooks: unknown[] }).workbooks
    expect(server).toHaveLength(1)
  })

  test('workbook add: when the re-read does not show it yet, the retry is a same-key replay and the set keeps one workbook', async () => {
    // Reads lag the write: the draft and the set's list do not show the new member until `hidden` is lifted.
    const hidden = { member: true }
    rewrites.push({ method: 'GET', path: draftGet, once: false, body: (wire) => (hidden.member ? Object.fromEntries(Object.entries(wire).filter(([key]) => key !== 'source')) : wire) })
    rewrites.push({ method: 'GET', path: workbooks, once: false, body: (wire) => (hidden.member ? { ...wire, data: [] } : wire) })
    const { draftId } = await unreadableWorkbookAdd()
    expectOnlyConfirm()
    await click(byTestId('excel2app-unconfirmed')!.querySelector('button'))
    expect(unconfirmedNotices()).toHaveLength(0)
    // Not found on the re-read: the file is offered again, under the same key.
    expect(fileRows()).toEqual([{ state: 'failed', status: text.pick.saveFailed }])
    expect(count('POST', workbooks)).toBe(1)

    await click(button(text.pick.retry))
    const adds = requests.filter((item) => item.method === 'POST' && workbooks.test(item.path))
    expect(adds).toHaveLength(2)
    expect(adds[1]!.idempotencyKey).toBeTruthy()
    expect(adds[1]!.idempotencyKey).toBe(adds[0]!.idempotencyKey)
    expect(adds.map((item) => item.status)).toEqual([201, 201])
    expect(fileRows()).toEqual([{ state: 'stored', status: text.pick.stored }])
    hidden.member = false
    const server = ((await call('GET', draftPath(draftId))).source as { workbooks: { id: string }[] }).workbooks
    expect(server).toHaveLength(1)
    expect(client.getQueryData<BuildDraft>(buildKeys.draft('commerce', draftId))?.source?.workbooks.map((member) => member.id)).toEqual(server.map((member) => member.id))
  })

  test('analysis turn: the turn is not resent, nothing is cached, and the re-read shows the turn the server accepted', async () => {
    const draftId = await storedDraft()
    await renderExcel(draftId)
    rewrites.push({ method: 'POST', path: turns, once: true, body: (wire) => ({ ...wire, resource: { ...(wire.resource as Json), excelProgress: SECRET } }) })
    await click(byTestId('excel2app-analyse'))
    await settle(10)
    expect(requests.filter((item) => item.method === 'POST' && turns.test(item.path)).map((item) => item.status)).toEqual([202])
    expectOnlyConfirm()
    expect(cachedWire()).not.toContain(SECRET)
    expect(container.innerHTML).not.toContain(SECRET)
    await act(async () => { await client.refetchQueries({ queryKey: buildKeys.draft('commerce', draftId) }) })
    await settle(20)
    expect(count('POST', turns)).toBe(1)

    await click(byTestId('excel2app-unconfirmed')!.querySelector('button'))
    expect(unconfirmedNotices()).toHaveLength(0)
    expect(count('POST', turns)).toBe(1)
    const server = ((await call('GET', draftPath(draftId))).conversationTurns as { id: string }[]).map((item) => item.id)
    expect(server).toHaveLength(1)
    expect(client.getQueryData<BuildDraft>(buildKeys.draft('commerce', draftId))?.conversationTurns.map((item) => item.id)).toEqual(server)
  })

  test('design turn: the instruction is not resent, the chat is closed until the re-read, and the re-read shows the turn the server accepted', async () => {
    const draftId = await storedDraft({ analysed: true, designed: true })
    await renderExcel(draftId)
    await until(() => Boolean(byTestId('excel2app-chat-input')))
    rewrites.push({ method: 'POST', path: turns, once: true, body: (wire) => ({ ...wire, resource: { ...(wire.resource as Json), uiDesign: { appName: SECRET } } }) })
    const before = count('POST', turns)
    await act(async () => { type(byTestId<HTMLInputElement>('excel2app-chat-input')!, '一覧をカード表示に') })
    await click(byTestId('excel2app-chat-send'))
    await settle(10)
    expect(count('POST', turns)).toBe(before + 1)
    expectOnlyConfirm()
    expect(cachedWire()).not.toContain(SECRET)
    expect(container.innerHTML).not.toContain(SECRET)
    expect(byTestId<HTMLInputElement>('excel2app-chat-input')?.disabled).toBe(true)
    expect(byTestId<HTMLButtonElement>('excel2app-to-implement')?.disabled).toBe(true)
    await act(async () => { await client.refetchQueries({ queryKey: buildKeys.draft('commerce', draftId) }) })
    await settle(20)
    expect(count('POST', turns)).toBe(before + 1)

    await click(byTestId('excel2app-unconfirmed')!.querySelector('button'))
    expect(unconfirmedNotices()).toHaveLength(0)
    expect(count('POST', turns)).toBe(before + 1)
    const server = ((await call('GET', draftPath(draftId))).conversationTurns as { id: string; userMessage: string }[])
    // The analysis turn, the default design turn and the one instruction: it reached the server once.
    expect(server.map((item) => item.userMessage).slice(1)).toEqual([UI_DESIGN_INIT, '一覧をカード表示に'])
    expect(client.getQueryData<BuildDraft>(buildKeys.draft('commerce', draftId))?.conversationTurns.map((item) => item.id)).toEqual(server.map((item) => item.id))
    expect(byTestId<HTMLInputElement>('excel2app-chat-input')?.disabled).toBe(false)
  })

  test('specification save: the edit stays on screen unsaved, the preview does not open, nothing is resent, and only a re-read is offered', async () => {
    const draftId = await storedDraft({ analysed: true })
    await renderExcel(draftId)
    expect(stepTitle()).toBe(text.spec.title)
    await click(button(text.spec.edit))
    const editor = () => byTestId<HTMLTextAreaElement>('excel2app-spec-input')!
    const edited = `${editor().value}\n担当者ごとに一覧を分けたい\n`
    await act(async () => { type(editor(), edited) })
    const patch = new RegExp(`${draftPath(draftId)}$`)
    rewrites.push({ method: 'PATCH', path: patch, once: true, body: (wire) => ({ ...wire, resource: { ...(wire.resource as Json), specMarkdown: { text: SECRET } } }) })
    await click(byTestId('excel2app-next'))
    await settle(10)
    expect(requests.filter((item) => item.method === 'PATCH').map((item) => item.status)).toEqual([200])
    // The success side effect is the preview and its design turn: neither happens.
    expect(stepTitle()).toBe(text.spec.title)
    expect(count('POST', turns)).toBe(0)
    expectOnlyConfirm()
    expect(cachedWire()).not.toContain(SECRET)
    expect(container.innerHTML).not.toContain(SECRET)
    // The typed text stays in the editor; leaving the field does not save it again, and 次へ is closed.
    expect(editor().value).toBe(edited)
    await act(async () => { editor().dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }) as unknown as Event) })
    await settle(10)
    expect(count('PATCH', patch)).toBe(1)
    expect(byTestId<HTMLButtonElement>('excel2app-next')?.disabled).toBe(true)

    await click(byTestId('excel2app-unconfirmed')!.querySelector('button'))
    expect(unconfirmedNotices()).toHaveLength(0)
    // The re-read shows the save happened; 次へ then opens the preview without saving again.
    expect(((await call('GET', draftPath(draftId))).specMarkdown as string)).toContain('担当者ごとに一覧を分けたい')
    await click(byTestId('excel2app-next'))
    expect(count('PATCH', patch)).toBe(1)
    expect(stepTitle()).toBe(text.preview.title)
  })
})
