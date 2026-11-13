// The app screens against unreadable answers (design §6, X3/X5, unknown Person):
// the real page, queries, gateway and contracts run over the in-memory Platform
// and console mocks; only the answer under test is rewritten on its way back.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider, type AnyRouter } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { envVarsKey } from '../../api/queries/app'
import { appQuery, groupsQuery, meQuery } from '../../api/queries/console'
import { keys, queryClient as appQueryClient } from '../../api/queries/shared'
import { copy } from '../../copy'
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'
import type { AppTab } from '../../routes/paths'
import { setLanguage } from '../../shell/language'
import { UnsavedChangesProvider } from '../../ui/use-unsaved-changes-guard'
import { preserveLanguage } from '../../../test/language'
import { AppPage } from './app-page'
import { text } from './copy'
import { sharingCopy } from '../../copy/sharing'

const SECRET = 'SENTINEL-app-page-5d21'
const APP_ID = 'a-mitsumori'
const APP_PATH = '/sales/east/team-a/mitsumori'
const PROJECT = '/api/v1/projects/commerce'
const COMPONENT = `${PROJECT}/applications/mitsumori/branches/production/components/mitsumori-web`
const RELEASES = new RegExp(`^${PROJECT}/applications/mitsumori/releases$`)
const PUBLISHES = new RegExp(`^${PROJECT}/publishes$`)
const ENV = new RegExp(`^${COMPONENT}/env-vars$`)
const ROLLBACK = new RegExp(`^${COMPONENT}/rollback$`)
const STACK = new RegExp(`^${PROJECT}/application-stacks/mitsumori$`)
const CONSOLE_APP = new RegExp(`^/api/console/apps/${APP_ID}$`)
const LOGS = new RegExp(`^${PROJECT}/components/mitsumori-web/logs$`)

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

/** The app route's component: the live app record from `appQuery`, as the resource route renders it. */
function AppRoute({ tab }: { tab: AppTab }) {
  const app = useQuery(appQuery(APP_ID)).data
  return app ? <AppPage key={app.id} app={app} tab={tab} /> : null
}

/** The app page on the app's query defaults (retry policy included), with polling left to the test. */
async function renderApp(tab: AppTab) {
  client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false, refetchOnWindowFocus: false } } })
  await Promise.all([client.fetchQuery(meQuery), client.fetchQuery(groupsQuery), client.fetchQuery(appQuery(APP_ID))])
  const rootRoute = createRootRoute()
  const anyRoute = createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null })
  router = createRouter({ routeTree: rootRoute.addChildren([anyRoute]), history: createMemoryHistory({ initialEntries: [`${APP_PATH}/-/${tab}`] }) })
  await router.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider><AppRoute tab={tab} /></UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>)
  })
  await settle()
}

const pageText = () => document.body.textContent ?? ''
const count = (method: string, path: RegExp) => requests.filter((item) => item.method === method && path.test(item.path)).length
const refreshFailed = copy.common.refreshFailed(copy.relative.justNow)
/** Every value the page holds in its query cache, serialized: nothing from an unreadable answer may be in it. */
const cachedWire = () => JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))
const section = (id: string) => container.querySelector<HTMLElement>(`#${id}`)!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')

function buttons(scope: ParentNode = document.body) {
  return [...scope.querySelectorAll('button')]
}

function button(name: string | RegExp, scope: ParentNode = document.body): HTMLButtonElement {
  const matches = (value: string | null | undefined) => value != null && (typeof name === 'string' ? value.trim() === name : name.test(value.trim()))
  const found = buttons(scope).find((item) => matches(item.textContent) || matches(item.getAttribute('aria-label')))
  if (!found) throw new Error(`no button ${name}`)
  return found
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

async function submit(form: HTMLFormElement) {
  await act(async () => { form.requestSubmit() })
  await settle()
}

/** One poll tick of `queryKey`, as its interval would run it. */
async function tick(queryKey: readonly unknown[]) {
  await act(async () => { await client.refetchQueries({ queryKey }) })
  await settle()
}

/** The write-unconfirmed state of one panel: only 「最新の状態を確認する」 is offered (never a retry). */
function expectOnlyConfirm(scope: HTMLElement) {
  const notice = [...scope.querySelectorAll('[role="status"], [role="alert"]')].find((item) => item.textContent?.includes(text.unconfirmed.title))
  expect(notice).toBeDefined()
  expect(buttons(notice!).map((item) => item.textContent?.trim())).toEqual([text.unconfirmed.confirm])
  expect(scope.textContent).not.toContain(copy.common.retry)
  expect(scope.textContent).not.toContain(SECRET)
}

describe('X3: one panel refreshes into an unreadable answer', () => {
  test('the release history keeps its last good rows under one stale notice; the header, tabs and the URL card stay usable, and it clears on recovery', async () => {
    await renderApp('releases')
    const history = () => container.querySelector('[data-testid="release-history"]')!
    const rows = () => [...history().querySelectorAll('tbody tr')].map((row) => row.textContent)
    const shown = rows()
    expect(shown.length).toBeGreaterThan(2)
    const heading = container.querySelector('h1')!.textContent
    const status = container.querySelector('[data-testid="status-text"]')!.textContent
    const releasesKey = keys.releases('commerce', 'mitsumori', 'production')
    const good = client.getQueryData(releasesKey)
    const goodAt = client.getQueryState(releasesKey)!.dataUpdatedAt
    expect(pageText()).not.toContain(refreshFailed)

    const reads = count('GET', RELEASES)
    rewrites.push({ method: 'GET', path: RELEASES, once: true, body: (wire) => ({ ...wire, components: [{ id: 'mitsumori-web', releases: SECRET }] }) })
    await tick(releasesKey)
    expect(count('GET', RELEASES)).toBe(reads + 1)
    expect(Object.is(client.getQueryData(releasesKey), good)).toBe(true)
    expect(client.getQueryState(releasesKey)!.dataUpdatedAt).toBe(goodAt)
    expect(rows()).toEqual(shown)
    expect(pageText().split(refreshFailed)).toHaveLength(2)
    expect(history().textContent).toContain(refreshFailed)
    expect(pageText()).not.toContain(copy.common.loadFailed)
    expect(container.innerHTML).not.toContain(SECRET)
    expect(cachedWire()).not.toContain(SECRET)
    // The header, tabs and the URL card are untouched and usable.
    expect(container.querySelector('h1')!.textContent).toBe(heading)
    expect(container.querySelector('[data-testid="status-text"]')!.textContent).toBe(status)
    expect([...container.querySelectorAll('nav a, [role="tablist"] a')].map((link) => link.textContent)).toEqual(expect.arrayContaining([copy.app.tabs.overview, copy.app.tabs.settings]))
    expect(container.querySelector('[data-testid="app-url"]')?.getAttribute('href')).toBe('https://mitsumori.commerce.appthrust.test/')
    expect(button(copy.app.copyUrl, container).disabled).toBe(false)
    expect(button(text.header.menu, container).disabled).toBe(false)
    // A rollback rests on the release state, which is current: still offered.
    expect(buttons(history()).some((item) => /この版に戻す/.test(item.getAttribute('aria-label') ?? '') && !item.disabled)).toBe(true)

    await tick(releasesKey)
    expect(client.getQueryState(releasesKey)!.status).toBe('success')
    expect(client.getQueryState(releasesKey)!.dataUpdatedAt).toBeGreaterThan(goodAt)
    expect(pageText()).not.toContain(refreshFailed)
    expect(rows()).toEqual(shown)
  })

  test('the env form keeps typed and staged input across a failed refresh, blocks saving on stale data, and saves after recovery', async () => {
    await renderApp('settings')
    const env = section('env')
    const key = env.querySelector<HTMLInputElement>('#env-key')!
    const value = env.querySelector<HTMLInputElement>('#env-value')!
    await act(async () => { type(key, 'FEATURE_FLAG'); type(value, 'on') })
    await submit(key.form!)
    expect(env.textContent).toContain('FEATURE_FLAG')
    await act(async () => { type(key, 'SECOND_FLAG'); type(value, 'typed but not added') })
    await settle()
    const save = () => button(copy.app.settings.save, env)
    expect(save().disabled).toBe(false)
    const envKey = envVarsKey({ projectId: 'commerce', applicationId: 'mitsumori', branchId: 'production', componentId: 'mitsumori-web' })
    const good = client.getQueryData(envKey)

    rewrites.push({ method: 'GET', path: ENV, once: true, body: (wire) => ({ ...wire, variables: { leaked: SECRET } }) })
    await tick(envKey)
    expect(Object.is(client.getQueryData(envKey), good)).toBe(true)
    expect(env.textContent).toContain(refreshFailed)
    expect(env.textContent).toContain('FEATURE_FLAG')
    expect(env.textContent).toContain('APP_TITLE')
    expect(key.value).toBe('SECOND_FLAG')
    expect(value.value).toBe('typed but not added')
    expect(save().disabled).toBe(true)
    expect(container.innerHTML).not.toContain(SECRET)
    // The sibling card is untouched.
    expect(section('name').querySelector<HTMLInputElement>('#settings-name')!.disabled).toBe(false)

    await tick(envKey)
    expect(env.textContent).not.toContain(refreshFailed)
    expect(key.value).toBe('SECOND_FLAG')
    expect(env.textContent).toContain('FEATURE_FLAG')
    expect(save().disabled).toBe(false)
  })
})

describe('X5: a write answered 2xx unreadably', () => {
  test('app update: nothing cached, no 保存しました, no resend; only the confirmation, and 保存 waits for it', async () => {
    await renderApp('settings')
    const general = section('name')
    const name = general.querySelector<HTMLInputElement>('#settings-name')!
    const before = client.getQueryData(appQuery(APP_ID).queryKey)
    await act(async () => { type(name, '見積作成 v2') })
    await settle()
    rewrites.push({ method: 'PATCH', path: CONSOLE_APP, once: true, body: (wire) => ({ ...wire, share: SECRET }) })
    await submit(name.form!)
    expect(count('PATCH', CONSOLE_APP)).toBe(1)
    expect(Object.is(client.getQueryData(appQuery(APP_ID).queryKey), before)).toBe(true)
    expect(cachedWire()).not.toContain(SECRET)
    expect(general.textContent).not.toContain(copy.app.settings.saved)
    expectOnlyConfirm(general)
    expect(button(copy.app.settings.save, general).disabled).toBe(true)
    expect(name.value).toBe('見積作成 v2')
    await settle()
    expect(count('PATCH', CONSOLE_APP)).toBe(1)

    const reads = count('GET', CONSOLE_APP)
    await click(button(text.unconfirmed.confirm, general))
    expect(count('GET', CONSOLE_APP)).toBe(reads + 1)
    expect(count('PATCH', CONSOLE_APP)).toBe(1)
    // The write had happened: the read-back shows it.
    expect(container.querySelector('h1')!.textContent).toBe('見積作成 v2')
    expect(general.textContent).not.toContain(text.unconfirmed.title)
  })

  test('env save: the saved list is not replaced, staged changes stay, no resend; only the confirmation', async () => {
    await renderApp('settings')
    const env = section('env')
    const key = env.querySelector<HTMLInputElement>('#env-key')!
    await act(async () => { type(key, 'FEATURE_FLAG'); type(env.querySelector<HTMLInputElement>('#env-value')!, 'on') })
    await submit(key.form!)
    const envKey = envVarsKey({ projectId: 'commerce', applicationId: 'mitsumori', branchId: 'production', componentId: 'mitsumori-web' })
    const before = client.getQueryData(envKey)
    rewrites.push({ method: 'PUT', path: ENV, once: true, body: (wire) => ({ ...wire, resource: { revision: SECRET } }) })
    await click(button(copy.app.settings.save, env))
    expect(count('PUT', ENV)).toBe(1)
    expect(Object.is(client.getQueryData(envKey), before)).toBe(true)
    expect(cachedWire()).not.toContain(SECRET)
    expect(env.textContent).not.toContain(copy.app.settings.saved)
    expect(env.textContent).toContain(text.settings.envPending(1))
    expectOnlyConfirm(env)
    expect(button(copy.app.settings.save, env).disabled).toBe(true)
    await settle()
    expect(count('PUT', ENV)).toBe(1)

    const reads = count('GET', ENV)
    await click(button(text.unconfirmed.confirm, env))
    expect(count('GET', ENV)).toBe(reads + 1)
    expect(count('PUT', ENV)).toBe(1)
    expect(env.textContent).not.toContain(text.unconfirmed.title)
    // The write had happened: the read-back shows FEATURE_FLAG saved, once, and nothing is left staged to send twice.
    const flagRows = [...env.querySelectorAll('[data-testid="env-table"] tbody tr')].filter((row) => row.textContent?.includes('FEATURE_FLAG'))
    expect(flagRows).toHaveLength(1)
    expect(env.textContent).not.toContain(text.settings.envPending(1))
    expect(button(copy.app.settings.save, env).disabled).toBe(true)
  })

  test('rollback: no 戻す処理を始めました, no resend; the dialog closes and the panel offers only the confirmation', async () => {
    await renderApp('releases')
    const history = container.querySelector<HTMLElement>('[data-testid="release-history"]')!
    const rollbackButton = () => buttons(history).find((item) => /この版に戻す/.test(item.getAttribute('aria-label') ?? ''))!
    await click(rollbackButton())
    rewrites.push({ method: 'POST', path: ROLLBACK, once: true, body: (wire) => ({ ...wire, resource: { transitionId: SECRET } }) })
    await click(button(copy.app.releases.rollback, dialog()!))
    expect(count('POST', ROLLBACK)).toBe(1)
    expect(dialog()).toBeNull()
    expect(pageText()).not.toContain(copy.app.releases.rollbackStarted)
    expect(cachedWire()).not.toContain(SECRET)
    const card = history.closest<HTMLElement>('section, article, div[class*="rounded"]') ?? container
    expectOnlyConfirm(container)
    expect(rollbackButton().disabled).toBe(true)
    await settle()
    expect(count('POST', ROLLBACK)).toBe(1)
    expect(card.textContent).toContain(text.unconfirmed.title)

    await click(button(text.unconfirmed.confirm, container))
    expect(count('POST', ROLLBACK)).toBe(1)
    expect(pageText()).not.toContain(text.unconfirmed.title)
  })

  test('delete: nothing else is deleted, the page stays, and closing the dialog never re-enables a resend', async () => {
    await renderApp('settings')
    const open = async () => {
      await click(button(copy.app.settings.deleteAction, section('danger')))
      const confirmInput = dialog()!.querySelector<HTMLInputElement>('input')!
      await act(async () => { type(confirmInput, '見積作成') })
      await settle()
    }
    await open()
    rewrites.push({ method: 'DELETE', path: STACK, once: true, body: () => ({ resource: { id: SECRET } }) })
    await click(button(copy.app.settings.deleteConfirm, dialog()!))
    expect(count('DELETE', STACK)).toBe(1)
    expect(requests.filter((item) => item.method === 'DELETE').map((item) => item.path)).toEqual([`${PROJECT}/application-stacks/mitsumori`])
    expect(router.state.location.pathname).toBe(`${APP_PATH}/-/settings`)
    expect(client.getQueryData(appQuery(APP_ID).queryKey)).toBeDefined()
    expectOnlyConfirm(dialog()!)
    expect(button(copy.app.settings.deleteConfirm, dialog()!).disabled).toBe(true)

    // Regression (W5): closing the dialog used to reset the failed mutation, so reopening offered the delete again.
    await click(button(copy.common.cancel, dialog()!))
    expect(dialog()).toBeNull()
    await open()
    expectOnlyConfirm(dialog()!)
    expect(button(copy.app.settings.deleteConfirm, dialog()!).disabled).toBe(true)
    await click(button(copy.app.settings.deleteConfirm, dialog()!))
    expect(count('DELETE', STACK)).toBe(1)

    await click(button(text.unconfirmed.confirm, dialog()!))
    expect(count('DELETE', STACK)).toBe(1)
    expect(dialog()!.textContent).not.toContain(text.unconfirmed.title)
  })
})

describe('an owner the server can no longer resolve', () => {
  test('is 「不明な利用者」 without a link, avatar or address, and is left out of mail links and invitation addresses', async () => {
    const gone = { id: 'p-gone', displayName: '', unknown: true }
    rewrites.push({ method: 'GET', path: CONSOLE_APP, once: false, body: (wire) => ({ ...wire, owners: [gone, ...(wire.owners as unknown[])] }) })
    // A 403 on the logs offers 「担当者に聞く」 (the owners' mail link).
    rewrites.push({ method: 'GET', path: LOGS, once: false, body: () => Response.json({ error: { code: 'forbidden', message: 'forbidden' } }, { status: 403 }) })
    await renderApp('logs')
    const meta = container.querySelector<HTMLElement>('[data-testid="app-meta"]')!
    const unknown = meta.querySelector<HTMLElement>('[data-testid="unknown-person"]')!
    expect(unknown.textContent).toBe(copy.common.unknownPerson)
    expect(unknown.closest('a')).toBeNull()
    expect(unknown.querySelector('img, svg')).toBeNull()
    expect(meta.querySelectorAll('[data-testid="unknown-person"]')).toHaveLength(1)
    expect([...meta.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('p-gone'))).toBe(false)
    const mail = [...container.querySelectorAll('a')].find((link) => link.getAttribute('href')?.startsWith('mailto:'))
    expect(mail).toBeDefined()
    const recipients = decodeURIComponent(mail!.getAttribute('href')!.slice('mailto:'.length).split('?')[0]!).split(',')
    expect(recipients.length).toBeGreaterThan(0)
    expect(recipients.every((address) => /^[^\s@]+@[^\s@]+$/.test(address))).toBe(true)
    expect(mail!.textContent).not.toContain(copy.common.unknownPerson)

    await click(button(sharingCopy.title, container))
    const share = dialog()!
    const row = share.querySelector<HTMLElement>('[data-testid="share-person-p-gone"]')!
    expect(row.textContent).toContain(copy.common.unknownPerson)
    expect(row.querySelector('img')).toBeNull()
    expect(row.textContent).not.toContain('@')
    const invitation = share.querySelector<HTMLElement>(`[aria-label="${sharingCopy.invitationEmail}"]`)!
    expect(invitation.textContent).toMatch(/@/)
    await act(async () => { invitation.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }) as unknown as Event) })
    await settle()
    const addresses = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? '')
    expect(addresses.length).toBeGreaterThan(0)
    expect(addresses.every((address) => /^[^\s@]+@[^\s@]+$/.test(address))).toBe(true)
  })
})

describe('a publishes read that failed', () => {
  test('never shows the app as live: the first answer is unreadable, so no status is claimed', async () => {
    rewrites.push({ method: 'GET', path: PUBLISHES, once: false, body: (wire) => ({ ...wire, data: SECRET }) })
    await renderApp('overview')
    const header = container.querySelector('header')!
    expect(header.textContent).not.toContain(copy.status.live)
    expect(container.querySelector('[data-testid="status-text"]')!.textContent).toBe(copy.common.loadFailed)
    expect(container.querySelector('[data-testid="app-url"]')).toBeNull()
    expect(pageText()).toContain(copy.common.loadFailed)
    expect(container.innerHTML).not.toContain(SECRET)

    rewrites = []
    await tick(keys.publishes('commerce'))
    expect(container.querySelector('header')!.textContent).toContain(copy.status.live)
  })
})
