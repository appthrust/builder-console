// The データ tab against unreadable answers (design §6, X3/X5) and a column
// type this console does not know: the real app page, queries, gateway and
// contracts run over the in-memory Platform and console mocks; only the
// answer under test is rewritten on its way back.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, type AnyRouter } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { appQuery, groupsQuery, meQuery } from '../../../api/queries/console'
import { keys, queryClient as appQueryClient } from '../../../api/queries/shared'
import type { DatabaseRowsPage } from '../../../model/contracts/data'
import { copy } from '../../../copy'
import { consoleRoutes } from '../../../dev/mock-console'
import { platformRoutes } from '../../../dev/mock-platform'
import { setLanguage } from '../../../shell/language'
import { UnsavedChangesProvider } from '../../../ui/use-unsaved-changes-guard'
import { preserveLanguage } from '../../../../test/language'
import { AppPage } from '../app-page'
import { text } from '../copy'
import { dataText } from './copy'
import { writeText } from './copy-write'

const SECRET = 'SENTINEL-data-tab-9b47'
const APP_ID = 'a-mitsumori'
const APP_PATH = '/sales/east/team-a/mitsumori'
const DATABASE = '/api/v1/projects/commerce/databases/mitsumori-db'
const ROWS = new RegExp(`^${DATABASE}/tables/public/products/rows$`)
const ROW = new RegExp(`^${DATABASE}/tables/public/products/rows/[^/]+$`)
const DESCRIBE = new RegExp(`^${DATABASE}/schema/tables/public/products$`)
const ROWS_KEY = keys.databaseRows('commerce', 'mitsumori-db', 'public', 'products')

type Json = Record<string, unknown>
/** Rewrites a successful answer of the in-memory mocks before the page reads it. */
interface Rewrite { method: string; path: RegExp; body: (wire: Json) => unknown; once: boolean }

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
  const rewritten = rewrite.body((await response.json()) as Json)
  return rewritten instanceof Response ? rewritten : Response.json(rewritten, { status: response.status })
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

beforeEach(async () => {
  restore = [preserveLanguage()]
  setLanguage('ja')
  rewrites = []
  requests = []
  globalThis.fetch = mockFetch as typeof globalThis.fetch
  // The boundary reports a contract failure with console.warn (safe metadata only); keep test output quiet.
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  // Radix Select checks `trigger.form instanceof HTMLFormElement`; the shared DOM preload does not expose it.
  const form = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement')
  Object.defineProperty(globalThis, 'HTMLFormElement', { configurable: true, value: window.HTMLFormElement })
  restore.push(() => form ? Object.defineProperty(globalThis, 'HTMLFormElement', form) : Reflect.deleteProperty(globalThis, 'HTMLFormElement'))
  // The dialogs' focus return looks up the menu trigger with CSS.escape, which the shared DOM preload does not expose.
  const css = Object.getOwnPropertyDescriptor(globalThis, 'CSS')
  Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => `\\${char}`) } })
  restore.push(() => css ? Object.defineProperty(globalThis, 'CSS', css) : Reflect.deleteProperty(globalThis, 'CSS'))
  restore.push(() => warn.mockRestore())
  for (const path of ['/api/v1/__mock/reset', '/api/console/__mock/reset']) await mockFetch(path, { method: 'POST' })
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

function AppRoute() {
  const app = useQuery(appQuery(APP_ID)).data
  return app ? <AppPage key={app.id} app={app} tab="data" /> : null
}

/** The データ tab on the app's query defaults (retry policy included), with refreshes left to the test. */
async function renderData(search = 'table=public.products') {
  client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false, refetchOnWindowFocus: false } } })
  await Promise.all([client.fetchQuery(meQuery), client.fetchQuery(groupsQuery), client.fetchQuery(appQuery(APP_ID))])
  const rootRoute = createRootRoute({ component: () => <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> })
  const anyRoute = createRoute({ getParentRoute: () => rootRoute, path: '$', component: AppRoute })
  router = createRouter({
    routeTree: rootRoute.addChildren([anyRoute]),
    history: createMemoryHistory({ initialEntries: [`${APP_PATH}/-/data?${search}`] }),
    // Search values stay strings, as the app router reads them (router.tsx).
    parseSearch: (value) => Object.fromEntries(new URLSearchParams(value)),
    stringifySearch: (value) => {
      const query = new URLSearchParams(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')).toString()
      return query ? `?${query}` : ''
    },
  })
  await router.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  })
  await settle()
}

const pageText = () => document.body.textContent ?? ''
const count = (method: string, path: RegExp) => requests.filter((item) => item.method === method && path.test(item.path)).length
const refreshFailed = copy.common.refreshFailed(copy.relative.justNow)
/** Every value the page holds in its query cache, serialized: nothing from an unreadable answer may be in it. */
const cachedWire = () => JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))
const rowsPages = () => client.getQueriesData<DatabaseRowsPage>({ queryKey: ROWS_KEY })
const grid = () => container.querySelector<HTMLElement>('table')!
const gridRows = () => [...grid().querySelectorAll('tbody tr')].map((row) => row.textContent)
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)

function buttons(scope: ParentNode = document.body) {
  return [...scope.querySelectorAll('button')]
}

function button(name: string | RegExp, scope: ParentNode = document.body): HTMLButtonElement {
  const matches = (value: string | null | undefined) => value != null && (typeof name === 'string' ? value.trim() === name : name.test(value.trim()))
  const found = buttons(scope).find((item) => matches(item.textContent) || matches(item.getAttribute('aria-label')))
  if (!found) throw new Error(`no button ${name}`)
  return found
}

/** The input labelled `label` (labels start with the field name; required fields add a mark). */
function input(label: string, scope: ParentNode): HTMLInputElement {
  const found = [...scope.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label))
  if (!found) throw new Error(`no field ${label}`)
  return document.getElementById(found.htmlFor) as HTMLInputElement
}

/** Types into a React-controlled input the way a user does. */
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
  field.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
}

async function click(target: HTMLElement) {
  await act(async () => { target.click() })
  await settle()
}

/** One 「↻」-style refresh of the 表's rows. */
async function refreshRows() {
  await act(async () => { await client.refetchQueries({ queryKey: ROWS_KEY }) })
  await settle()
}

/** The Sheet of row 1 (ノートPC), in edit mode. */
async function editLaptop() {
  await act(async () => { await router.navigate({ href: `${APP_PATH}/-/data?table=public.products&row=1` }) })
  await settle()
  await click(button(writeText.sheet.edit, dialog()!))
  return dialog()!
}

/** The write-unconfirmed state: only 「最新の状態を確認する」 is offered (never a retry). */
function expectOnlyConfirm(scope: HTMLElement) {
  const notice = [...scope.querySelectorAll('[role="status"], [role="alert"]')].find((item) => item.textContent?.includes(text.unconfirmed.title))
  expect(notice).toBeDefined()
  expect(buttons(notice!).map((item) => item.textContent?.trim())).toEqual([text.unconfirmed.confirm])
  expect(scope.textContent).not.toContain(copy.common.retry)
  expect(scope.textContent).not.toContain(SECRET)
}

describe('X3: the rows refresh into an unreadable answer', () => {
  test('the grid keeps its last good rows under one stale notice, the open Sheet keeps its unsent edit, and it clears on recovery', async () => {
    await renderData()
    const shown = gridRows()
    expect(shown.length).toBe(12)
    const sheet = await editLaptop()
    await act(async () => { type(input('在庫', sheet), '5') })
    await settle()
    const good = rowsPages()
    const goodAt = client.getQueryState(good[0]![0])!.dataUpdatedAt
    expect(pageText()).not.toContain(refreshFailed)

    const reads = count('GET', ROWS)
    rewrites.push({ method: 'GET', path: ROWS, once: true, body: (wire) => ({ ...wire, rows: [{ id: 1, name: SECRET }, SECRET] }) })
    await refreshRows()
    expect(count('GET', ROWS)).toBe(reads + 1)
    expect(rowsPages().map(([, data]) => data)).toEqual(good.map(([, data]) => data))
    expect(rowsPages().every(([key, data], index) => Object.is(data, good[index]![1]) && client.getQueryState(key)!.dataUpdatedAt === goodAt)).toBe(true)
    expect(gridRows()).toEqual(shown)
    expect(pageText().split(refreshFailed)).toHaveLength(2)
    expect(container.querySelector('section[aria-labelledby="data-collection-title"]')!.textContent).toContain(refreshFailed)
    expect(pageText()).not.toContain(copy.common.loadFailed)
    expect(pageText()).not.toContain(SECRET)
    expect(cachedWire()).not.toContain(SECRET)
    // The Sheet and its unsent input are untouched; the toolbar stays usable.
    expect(dialog()).toBe(sheet)
    expect(input('在庫', sheet).value).toBe('5')
    expect(button(writeText.sheet.save, sheet).disabled).toBe(false)
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.disabled).toBe(false)

    await refreshRows()
    expect(client.getQueryState(good[0]![0])!.dataUpdatedAt).toBeGreaterThan(goodAt)
    expect(pageText()).not.toContain(refreshFailed)
    expect(gridRows()).toEqual(shown)
    expect(input('在庫', sheet).value).toBe('5')
  })

  test('a first load that is unreadable is the panel’s fixed failure, never an empty 表', async () => {
    rewrites.push({ method: 'GET', path: ROWS, once: true, body: (wire) => ({ ...wire, rows: null, debug: SECRET }) })
    await renderData()
    expect(container.querySelector('table')).toBeNull()
    expect(pageText()).toContain(copy.common.loadFailed)
    expect(pageText()).not.toContain(dataText.noRows)
    expect(pageText()).not.toContain(SECRET)
    // The toolbar (表 select, search) stays; the retry reads again and shows the rows.
    expect(container.querySelector('input[type="search"]')).not.toBeNull()
    await click(button(copy.common.retry, container))
    expect(gridRows()).toHaveLength(12)
  })

  test('an unreadable table description is a fixed failure of the tab, never a 表 without columns', async () => {
    rewrites.push({ method: 'GET', path: DESCRIBE, once: false, body: (wire) => ({ ...wire, columns: [{ name: SECRET }] }) })
    await renderData()
    expect(container.querySelector('table')).toBeNull()
    expect(pageText()).toContain(copy.common.loadFailed)
    expect(pageText()).not.toContain(dataText.noTables)
    expect(pageText()).not.toContain(SECRET)
  })
})

describe('X5: a row write answered 2xx unreadably', () => {
  test('save: the rows are not patched, the edit stays, nothing is resent; only the confirmation, which reads back', async () => {
    await renderData()
    const sheet = await editLaptop()
    await act(async () => { type(input('在庫', sheet), '7') })
    await settle()
    const before = rowsPages()
    rewrites.push({ method: 'PATCH', path: ROW, once: true, body: (wire) => ({ ...wire, rows: [] }) })
    await click(button(writeText.sheet.save, sheet))
    expect(count('PATCH', ROW)).toBe(1)
    expect(rowsPages().every(([, data], index) => Object.is(data, before[index]![1]))).toBe(true)
    expect(sheet.textContent).not.toContain(writeText.sheet.saved)
    expect(sheet.textContent).not.toContain(writeText.errors.other)
    expectOnlyConfirm(sheet)
    expect(input('在庫', sheet).value).toBe('7')
    expect(button(writeText.sheet.save, sheet).disabled).toBe(true)
    // Enter in a field does not send it either.
    await act(async () => { input('在庫', sheet).form!.requestSubmit() })
    await settle()
    expect(count('PATCH', ROW)).toBe(1)

    const reads = count('GET', ROWS)
    await click(button(text.unconfirmed.confirm, sheet))
    expect(count('GET', ROWS)).toBeGreaterThan(reads)
    expect(count('PATCH', ROW)).toBe(1)
    expect(sheet.textContent).not.toContain(text.unconfirmed.title)
    // The write had happened: the read-back holds 7, the edit is kept on top, and saving sends nothing more.
    expect(sheet.textContent).toContain(writeText.errors.reloadedSame)
    expect(input('在庫', sheet).value).toBe('7')
    expect(button(writeText.sheet.save, sheet).disabled).toBe(false)
    await click(button(writeText.sheet.save, sheet))
    expect(count('PATCH', ROW)).toBe(1)
    expect(sheet.querySelector('[data-field="stock"] dd')!.textContent).toBe('7')
  })

  test('add: closing the Sheet keeps the latch — the 表 offers only the confirmation and 行を追加 waits for it', async () => {
    await renderData()
    await click(button(dataText.addRow, container))
    const sheet = dialog()!
    await act(async () => {
      type(input('商品名', sheet), 'ヘッドセット')
      type(input('単価', sheet), '9800')
    })
    await settle()
    rewrites.push({ method: 'POST', path: ROWS, once: true, body: (wire) => ({ ...wire, rows: SECRET }) })
    await click(button(writeText.sheet.save, sheet))
    expect(count('POST', ROWS)).toBe(1)
    expectOnlyConfirm(sheet)
    expect(input('商品名', sheet).value).toBe('ヘッドセット')
    expect(cachedWire()).not.toContain(SECRET)

    // Closing asks before discarding the input; the latch outlives the Sheet.
    await click(button(copy.common.close, sheet))
    await click(button(writeText.sheet.discardConfirm, dialog()!))
    expect(dialog()).toBeUndefined()
    const section = container.querySelector<HTMLElement>('section[aria-labelledby="data-collection-title"]')!
    expectOnlyConfirm(section)
    expect(button(dataText.addRow, container).disabled).toBe(true)
    expect(count('POST', ROWS)).toBe(1)

    await click(button(text.unconfirmed.confirm, section))
    expect(section.textContent).not.toContain(text.unconfirmed.title)
    expect(button(dataText.addRow, container).disabled).toBe(false)
    expect(count('POST', ROWS)).toBe(1)
    // The read-back shows the row the unreadable answer had created.
    expect(gridRows().some((row) => row?.includes('ヘッドセット'))).toBe(true)
  })

  test('delete: 削除する waits for the confirmation; a read-back without the row closes the dialog and the Sheet', async () => {
    await renderData()
    // A row nothing references (every seeded product is used by 入出庫).
    await mockFetch(`${DATABASE}/tables/public/products/rows`, { method: 'POST', body: JSON.stringify({ values: { name: '削除用', unit_price: 1 } }), headers: { 'Content-Type': 'application/json' } })
    await refreshRows()
    const added = rowsPages()[0]![1]!.rows.find((row) => row.name === '削除用')!
    await act(async () => { await router.navigate({ href: `${APP_PATH}/-/data?table=public.products&row=${added.id}` }) })
    await settle()
    // The menu opens from the keyboard (Radix opens it on pointerdown or Enter, not on a bare click).
    const trigger = button(writeText.sheet.menu, dialog()!)
    await act(async () => { trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event) })
    await settle()
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes(writeText.sheet.delete))!)
    const confirm = dialog()!
    rewrites.push({ method: 'DELETE', path: ROW, once: true, body: () => ({ rows: [], operation: {} }) })
    await click(button(writeText.deleteDialog.confirm, confirm))
    expect(count('DELETE', ROW)).toBe(1)
    expectOnlyConfirm(confirm)
    expect(button(writeText.deleteDialog.confirm, confirm).disabled).toBe(true)
    await click(button(writeText.deleteDialog.confirm, confirm))
    expect(count('DELETE', ROW)).toBe(1)

    await click(button(text.unconfirmed.confirm, confirm))
    expect(count('DELETE', ROW)).toBe(1)
    expect(dialog()).toBeUndefined()
    expect(gridRows().some((row) => row?.includes('削除用'))).toBe(false)
  })
})

describe('X5: a row write answered 2xx with a row the console cannot address ({rows:[{}]})', () => {
  test('save: no row is patched, no 保存しました, the edit stays; only the confirmation', async () => {
    await renderData()
    const sheet = await editLaptop()
    await act(async () => { type(input('在庫', sheet), '4') })
    await settle()
    const before = rowsPages()
    rewrites.push({ method: 'PATCH', path: ROW, once: true, body: (wire) => ({ ...wire, rows: [{}] }) })
    await click(button(writeText.sheet.save, sheet))
    expect(count('PATCH', ROW)).toBe(1)
    expect(rowsPages().every(([, data], index) => Object.is(data, before[index]![1]))).toBe(true)
    expect(sheet.textContent).not.toContain(writeText.sheet.saved)
    expectOnlyConfirm(sheet)
    expect(input('在庫', sheet).value).toBe('4')
    expect(button(writeText.sheet.save, sheet).disabled).toBe(true)
    await settle()
    expect(count('PATCH', ROW)).toBe(1)
  })

  test('add: the Sheet stays on the typed form, nothing is reported added; only the confirmation', async () => {
    await renderData()
    await click(button(dataText.addRow, container))
    const sheet = dialog()!
    await act(async () => {
      type(input('商品名', sheet), 'スピーカー')
      type(input('単価', sheet), '5000')
    })
    await settle()
    rewrites.push({ method: 'POST', path: ROWS, once: true, body: (wire) => ({ ...wire, rows: [{}] }) })
    await click(button(writeText.sheet.save, sheet))
    expect(count('POST', ROWS)).toBe(1)
    expect(dialog()).toBe(sheet)
    expect(sheet.textContent).not.toContain(writeText.sheet.created)
    expectOnlyConfirm(sheet)
    expect(input('商品名', sheet).value).toBe('スピーカー')
    expect(button(writeText.sheet.save, sheet).disabled).toBe(true)
  })

  test('delete: the row is not dropped from the 表 and the Sheet stays; the read-back decides', async () => {
    await renderData()
    await mockFetch(`${DATABASE}/tables/public/products/rows`, { method: 'POST', body: JSON.stringify({ values: { name: '削除用', unit_price: 1 } }), headers: { 'Content-Type': 'application/json' } })
    await refreshRows()
    const added = rowsPages()[0]![1]!.rows.find((row) => row.name === '削除用')!
    await act(async () => { await router.navigate({ href: `${APP_PATH}/-/data?table=public.products&row=${added.id}` }) })
    await settle()
    const sheet = dialog()!
    const trigger = button(writeText.sheet.menu, sheet)
    await act(async () => { trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event) })
    await settle()
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes(writeText.sheet.delete))!)
    const confirm = dialog()!
    const before = rowsPages()
    rewrites.push({ method: 'DELETE', path: ROW, once: true, body: (wire) => ({ ...wire, rows: [{}] }) })
    await click(button(writeText.deleteDialog.confirm, confirm))
    expect(count('DELETE', ROW)).toBe(1)
    expect(rowsPages().every(([, data], index) => Object.is(data, before[index]![1]))).toBe(true)
    expect(gridRows().some((row) => row?.includes('削除用'))).toBe(true)
    expect(sheet.isConnected).toBe(true)
    expectOnlyConfirm(confirm)
    expect(button(writeText.deleteDialog.confirm, confirm).disabled).toBe(true)

    await click(button(text.unconfirmed.confirm, confirm))
    expect(count('DELETE', ROW)).toBe(1)
    expect(dialog()).toBeUndefined()
    expect(gridRows().some((row) => row?.includes('削除用'))).toBe(false)
  })
})

describe('a column whose database type has no dedicated input', () => {
  test('is shown and edited as text with its type named, travels in a save, and a database rejection lands on the field', async () => {
    const leadTime = { name: 'lead_time', type: 'interval', nullable: true, hasDefault: false, primaryKey: false, description: '納期' }
    const area = { name: 'area', type: 'geometry', nullable: true, hasDefault: false, primaryKey: false, description: '範囲' }
    const point = { type: 'Point', coordinates: [1, 2] }
    rewrites.push({ method: 'GET', path: DESCRIBE, once: false, body: (wire) => ({ ...wire, columns: [...(wire.columns as unknown[]), leadTime, area] }) })
    rewrites.push({ method: 'GET', path: ROWS, once: false, body: (wire) => ({ ...wire, rows: (wire.rows as Json[]).map((row) => ({ ...row, lead_time: '3 days', area: point })) }) })
    await renderData()
    expect(gridRows()).toHaveLength(12)
    const header = [...grid().querySelectorAll<HTMLElement>('thead th')].find((item) => item.textContent?.includes('納期'))!
    expect(header.querySelector('[data-testid="column-type"]')?.textContent).toBe('interval')
    // Sortable like any text column.
    expect(header.querySelector('button')).not.toBeNull()
    expect(gridRows()[0]).toContain('3 days')
    expect(gridRows()[0]).toContain('{"type":"Point","coordinates":[1,2]}')
    expect(pageText()).not.toContain('[object Object]')
    expect(button(dataText.addRow, container).disabled).toBe(false)

    const sheet = await editLaptop()
    const leadInput = input('納期', sheet)
    expect(leadInput.value).toBe('3 days')
    expect(leadInput.closest('div')!.parentElement!.textContent).toContain(writeText.field.unlistedType('interval'))
    expect(sheet.querySelector('[data-testid="field-type"]')?.textContent).toBe('interval')
    expect(input('範囲', sheet).value).toBe('{"type":"Point","coordinates":[1,2]}')

    // The Platform names the column of a rejected value: answer as it would for an interval it cannot parse.
    const bodies: unknown[] = []
    let answer: (body: Json) => Response = () => Response.json({ error: { code: 'invalid_argument', message: 'invalid input syntax for type interval', details: { reason: 'constraint_violation', sqlstate: '22P02', column: 'lead_time' } } }, { status: 400 })
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init)
      if (request.method !== 'PATCH') return mockFetch(request)
      const body = (await request.json()) as Json
      bodies.push(body)
      requests.push({ method: 'PATCH', path: new URL(request.url).pathname, status: 0 })
      return answer(body)
    }) as typeof globalThis.fetch
    try {
      await act(async () => { type(leadInput, 'two weeks-ish') })
      await settle()
      await click(button(writeText.sheet.save, sheet))
      expect(bodies).toEqual([{ values: { lead_time: 'two weeks-ish' }, expected: expect.objectContaining({ lead_time: '3 days' }) }])
      expect(leadInput.getAttribute('aria-invalid')).toBe('true')
      expect(sheet.textContent).toContain('納期 の値が正しくありません')
      expect(leadInput.value).toBe('two weeks-ish')

      answer = (body) => Response.json({
        columns: [], rowCount: 1, limit: 1, offset: 0, truncated: false, fetchedAt: '2026-11-13T00:00:00Z', operation: {},
        rows: [{ id: 1, name: 'ノートPC', stock: 8, area: point, ...(body.values as Json) }],
      })
      await act(async () => { type(leadInput, '2 weeks') })
      await settle()
      await click(button(writeText.sheet.save, sheet))
    } finally {
      globalThis.fetch = original
    }
    // The untouched object value is never sent; the edited text is, as typed.
    expect(bodies[1]).toMatchObject({ values: { lead_time: '2 weeks' } })
    expect(JSON.stringify(bodies)).not.toContain('area')
    expect(sheet.textContent).toContain(writeText.sheet.saved)
  })

  test('the 表 still offers 行を追加, whose form has the text input, not required for a nullable column', async () => {
    const leadTime = { name: 'lead_time', type: 'interval', nullable: true, hasDefault: false, primaryKey: false, description: '納期' }
    rewrites.push({ method: 'GET', path: DESCRIBE, once: false, body: (wire) => ({ ...wire, columns: [...(wire.columns as unknown[]), leadTime] }) })
    await renderData()
    await click(button(dataText.addRow, container))
    const sheet = dialog()!
    expect(input('納期', sheet).value).toBe('')
    expect(input('納期', sheet).closest('div')!.parentElement!.textContent).not.toContain(copy.common.required)
  })
})
