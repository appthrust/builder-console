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
import { MinePage } from '../discover/mine'
import { DraftsPage } from '../discover/drafts'
import { text as discoverText } from '../discover/copy'
import { storedDraftWire } from '../../api/testing/stored-plan'
import { buildKeys } from '../../api/queries/build'
import { beginBuild } from '../build/entry'
import { buildCopy } from '../../model/build/copy'
import { ImprovePage } from '../improve/improve-page'
import { text as improveText } from '../improve/copy'
import { initialSession, saveBuildSession } from '../build/session'
import { saveConsoleCreation } from '../build/console-session-state'
import { rewriteDraftWire } from '../../api/testing/build-domain'
import { useAppViews } from './use-app-views'
import { useDeleteApp, useDiscardDraft } from './mutations'

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

/** Exercises stale/programmatic mutation entrypoints with a real decoded app view. */
function DeletionProbe() {
  const app = useQuery(appQuery(APP_ID)).data!
  const view = useAppViews('commerce').viewFor(app)
  const remove = useDeleteApp('commerce', app, view)
  const discard = useDiscardDraft(app, view)
  return <><button onClick={() => remove.mutate()}>Attempt delete</button><button onClick={() => discard.mutate()}>Attempt discard</button>{remove.isError && discard.isError ? <p>Both writes refused</p> : null}</>
}

/** The app page on the app's query defaults (retry policy included), with polling left to the test. */
async function renderApp(tab: AppTab, scene: 'app' | 'mine' | 'mine-problems' | 'drafts' | 'deletion-probe' | { improve: string } = 'app', search = '') {
  client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false, refetchOnWindowFocus: false } } })
  await Promise.all([client.fetchQuery(meQuery), client.fetchQuery(groupsQuery), client.fetchQuery(appQuery(APP_ID))])
  const rootRoute = createRootRoute()
  const anyRoute = createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null })
  router = createRouter({ routeTree: rootRoute.addChildren([anyRoute]), history: createMemoryHistory({ initialEntries: [`${APP_PATH}/-/${tab}${search}`] }) })
  await router.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider>{typeof scene === 'object' ? <ImprovePage draftId={scene.improve} /> : scene === 'mine' ? <MinePage /> : scene === 'mine-problems' ? <MinePage status="problem" /> : scene === 'drafts' ? <DraftsPage /> : scene === 'deletion-probe' ? <DeletionProbe /> : <AppRoute tab={tab} />}</UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>)
  })
  await settle()
}

const pageText = () => document.body.textContent ?? ''
const count = (method: string, path: RegExp) => requests.filter((item) => item.method === method && path.test(item.path)).length
/** Writes the page made, except opening 概要 marking the app's comments seen (利用者の声), which no scenario here is about. */
const writes = () => requests.filter((item) => item.method !== 'GET' && !/^\/api\/console\/apps\/[^/]+\/comments\/seen$/.test(item.path))
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

describe('APT-1109: isolated rows keep the rest of the project readable', () => {
  const stackList = new RegExp(`^${PROJECT}/application-stacks$`)
  const draftList = new RegExp(`^${PROJECT}/application-drafts$`)
  const rows = () => [...container.querySelectorAll('tbody tr')]
  const row = (name: string) => rows().find((item) => item.textContent?.includes(name))!

  test('one unreadable stack becomes unknown while a normal neighbour keeps its status, without a project failure notice', async () => {
    await renderApp('overview', 'mine')
    const before = rows().map((item) => item.textContent)
    expect(before.length).toBeGreaterThan(1)
    rewrites.push({ method: 'GET', path: stackList, once: false, body: (wire) => ({ ...wire, data: (wire.data as Json[]).map((stack) => stack.id === 'mitsumori' ? { ...stack, templateId: 'Bad Id!' } : stack) }) })
    await tick(keys.stacks('commerce'))
    expect(pageText()).not.toContain(discoverText.list.statusFailed)
    expect(row('見積').textContent).toContain(text.unsupported.label)
    expect(rows().filter((item) => !item.textContent?.includes('見積')).map((item) => item.textContent)).toEqual(before.filter((value) => !value?.includes('見積')))
    expect(row('見積').textContent).not.toContain(discoverText.list.resume)
    expect(writes()).toEqual([])
    // Without an id only apps lacking their own readable stack become unknown.
    rewrites = [{ method: 'GET', path: stackList, once: false, body: (wire) => ({ ...wire, data: (wire.data as Json[]).map((stack) => stack.id === 'mitsumori' ? { templateId: 'Bad Id!' } : stack) }) }]
    await tick(keys.stacks('commerce'))
    expect(row('見積').textContent).toContain(text.unsupported.label)
    expect(rows().filter((item) => !item.textContent?.includes('見積')).map((item) => item.textContent)).toEqual(before.filter((value) => !value?.includes('見積')))
  })

  test('opening the app tied to an unreadable stack offers no edit or deletion', async () => {
    rewrites.push({ method: 'GET', path: stackList, once: false, body: (wire) => ({ ...wire, data: (wire.data as Json[]).map((stack) => stack.id === 'mitsumori' ? { ...stack, applicationId: '' } : stack) }) })
    await renderApp('overview')
    expect(container.querySelector('header')?.textContent).toContain(text.unsupported.label)
    expect(buttons().some((item) => item.textContent?.trim() === text.header.menu && !item.disabled)).toBe(false)
    expect(container.querySelector('[data-testid=\"improve-with-ai\"]')).toBeNull()
    expect(pageText()).not.toContain(discoverText.list.statusFailed)
    expect(writes()).toEqual([])
  })

  test('an unreadable plan in the draft list does not change normal app statuses', async () => {
    await renderApp('overview', 'mine')
    const before = rows().map((item) => item.textContent)
    rewrites.push({ method: 'GET', path: draftList, once: false, body: () => ({ data: [{ ...storedDraftWire, creationPlan: { representation: ['future-kind'] } }] }) })
    await tick(buildKeys.drafts('commerce'))
    expect(rows().map((item) => item.textContent)).toEqual(before)
    expect(pageText()).not.toContain(discoverText.list.statusFailed)
  })

  test('a bad draft row remains inert without blocking a new legacy AI creation', async () => {
    rewrites.push({ method: 'GET', path: draftList, once: false, body: () => ({ data: [storedDraftWire, { ...storedDraftWire, id: 'broken-draft', title: SECRET, createdAt: 'not-a-date' }] }) })
    await renderApp('overview', 'drafts')
    expect(pageText()).toContain(storedDraftWire.title)
    const unreadable = [...container.querySelectorAll('li')].find((item) => item.textContent === discoverText.drafts.unreadable)!
    expect(unreadable).toBeDefined()
    expect(unreadable.querySelector('a, button')).toBeNull()
    expect(pageText()).not.toContain(SECRET)
    expect(pageText()).not.toContain(discoverText.list.statusFailed)
    const created = await beginBuild('commerce', 'a different app', { groupId: 'g-team-a', ownerSubject: 'owner' })
    expect(created.id).not.toBe('broken-draft')
    expect(writes()).toEqual([{ method: 'POST', path: `${PROJECT}/application-drafts`, status: 201 }])
    expect(requests.some((item) => item.path.endsWith('/broken-draft'))).toBe(false)
    // An independently readable exact match still resumes as before.
    expect((await beginBuild('commerce', storedDraftWire.intent, { groupId: 'g-team-a', ownerSubject: 'owner' })).id).toBe(storedDraftWire.id)
  })
})

describe('APT-1136: a reported failure of the latest build of an app that runs a release', () => {
  const repositories = new RegExp(`^${PROJECT}/application-source-repositories$`)
  const summaries = new RegExp(`^${PROJECT}/component-summaries$`)
  const runUrl = 'https://github.com/acme/mitsumori/actions/runs/42'
  const behind = buildCopy.sourceBuild.behind
  const failBuild = () => rewrites.push({ method: 'GET', path: repositories, once: false, body: (wire) => ({
    ...wire, data: (wire.data as Json[]).map((repository) => repository.id === 'mitsumori-src' ? { ...repository, build: { ...(repository.build as Json), state: 'failed', runUrl } } : repository),
  }) })
  const row = () => [...container.querySelectorAll('tbody tr')].find((item) => item.textContent?.includes('見積'))
  const pill = (scope: ParentNode) => scope.querySelector('[data-status]')

  test('keeps 公開中 in the header and the list, says it in a warning notice with the run link, and is not 問題あり', async () => {
    failBuild()
    await renderApp('overview')
    const header = container.querySelector('header')!
    expect(pill(header)?.getAttribute('data-status')).toBe('live')
    expect(pill(header)?.textContent).toBe(copy.status.live)
    expect(pageText()).not.toContain(buildCopy.sourceBuild.status)
    const notice = container.querySelector<HTMLElement>('[data-testid="latest-build-failed"]')!
    expect(notice.textContent).toContain(behind.title)
    expect(notice.textContent).toContain(behind.detail)
    expect(notice.querySelector('[role="alert"]')).toBeNull()
    const link = [...notice.querySelectorAll('a')].find((item) => item.textContent === buildCopy.sourceBuild.run)
    expect(link?.getAttribute('href')).toBe(runUrl)
    // Only what is known: the reported failure can be false, so nothing says the app lacks the new changes.
    expect(notice.textContent).not.toContain('まだアプリに入っていません')
    // Without an extracted cause there is no AI repair entry (as in 0.5.9, which had no notice at all for this data).
    expect(notice.textContent).not.toContain('AI に直させる')
    // 「詳しい人向け」 carries the same fact as its one place outside the notice.
    await click(button(copy.app.overview.advanced.toggle))
    expect(container.querySelector('[data-testid="advanced-latest-build"]')?.textContent).toContain(behind.latestFailed)
    expect(writes()).toEqual([])

    await act(async () => { root?.unmount() })
    await renderApp('overview', 'mine')
    expect(pill(row()!)?.getAttribute('data-status')).toBe('live')
    expect(row()!.textContent).not.toContain(buildCopy.sourceBuild.status)
    await act(async () => { root?.unmount() })
    await renderApp('overview', 'mine-problems')
    expect(row()).toBeUndefined()
  })

  test('an extracted cause is shown with 「AI に直させる」 exactly as 0.5.9 offered it for the same stack data', async () => {
    failBuild()
    rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-stacks$`), once: false, body: (wire) => ({
      ...wire, data: (wire.data as Json[]).map((stack) => stack.id === 'mitsumori' ? { ...stack, buildFailure: { lines: ["Module not found: './missing'"] } } : stack),
    }) })
    await renderApp('overview')
    const notice = container.querySelector<HTMLElement>('[data-testid="latest-build-failed"]')!
    expect(notice.querySelector('[data-testid="build-failure-cause"]')?.textContent).toBe(behind.cause("Module not found: './missing'"))
    expect(buttons(notice).some((item) => item.textContent?.includes('AI に直させる'))).toBe(true)
    // One notice: the 0.5.9 error notice for the same cause is replaced, not repeated.
    expect(container.querySelectorAll('[data-testid="build-failure-cause"]')).toHaveLength(1)
    expect(writes()).toEqual([])
  })

  test('an app with no running release keeps the build failure as its status, without the secondary notice', async () => {
    failBuild()
    rewrites.push({ method: 'GET', path: summaries, once: false, body: (wire) => ({
      ...wire, items: (wire.items as Json[]).map((item) => item.id === 'mitsumori-web' ? { ...item, statusKey: 'Provisioning', reasonKey: 'DeliveryProgressing' } : item),
    }) })
    await renderApp('overview')
    const header = container.querySelector('header')!
    expect(pill(header)?.getAttribute('data-status')).toBe('failed')
    expect(pill(header)?.textContent).toBe(buildCopy.sourceBuild.status)
    expect(container.querySelector('[data-testid="status-text"]')?.textContent).toBe(buildCopy.sourceBuild.status)
    expect(container.querySelector('[data-testid="latest-build-failed"]')).toBeNull()

    await act(async () => { root?.unmount() })
    await renderApp('overview', 'mine-problems')
    expect(pill(row()!)?.getAttribute('data-status')).toBe('failed')
    expect(row()!.textContent).toContain(buildCopy.sourceBuild.status)
  })
})

test('unreferenced project publishes leave the normal app status and URL unchanged', async () => {
  await renderApp('overview')
  const status = container.querySelector('[data-testid="status-text"]')!.textContent
  const url = container.querySelector('[data-testid="app-url"]')!.getAttribute('href')
  rewrites.push({ method: 'GET', path: PUBLISHES, once: false, body: (wire) => ({ ...wire, data: [{ id: 'unreferenced', applicationId: '', branchId: '', componentId: '', phase: 'succeeded', publicUrl: 'https://unrelated.example.test/' }, ...(wire.data as Json[])] }) })
  await tick(keys.publishes('commerce'))
  expect(client.getQueryState(keys.publishes('commerce'))?.status).toBe('success')
  expect(container.querySelector('[data-testid="status-text"]')!.textContent).toBe(status)
  expect(container.querySelector('[data-testid="app-url"]')!.getAttribute('href')).toBe(url)
  expect(pageText()).not.toContain(discoverText.list.statusFailed)
  expect(pageText()).not.toContain('unrelated.example.test')
})

test('an unreadable improvement offers no generation and the app can start a new improvement instead', async () => {
  const response = await mockFetch(`${PROJECT}/application-drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'improvement', applicationStackId: 'mitsumori', intent: 'Change the list', title: 'Unreadable improvement' }) })
  expect(response.status).toBe(201)
  const draft = (await response.json()).resource as Json
  const id = draft.id as string
  rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-drafts(?:$|/${id}$)`), once: false, body: (wire) => rewriteDraftWire(wire, id, (draft) => ({ ...draft, creationPlan: { representation: ['future-kind'] } })) })
  requests = []
  await renderApp('overview', { improve: id })
  expect(pageText()).toContain(improveText.unreadablePlan.detail)
  expect(buttons().some((item) => item.textContent?.trim() === buildCopy.failure.plan.replan)).toBe(false)
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true)
  expect([...container.querySelectorAll('a')].some((link) => link.getAttribute('href') === APP_PATH)).toBe(true)
  expect(writes()).toEqual([])
  await act(async () => { root?.unmount() })
  container.remove()
  client.clear()
  await renderApp('overview')
  await click(container.querySelector<HTMLButtonElement>('[data-testid="improve-with-ai"]')!)
  expect(dialog()).not.toBeNull()
  const message = dialog()!.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => { type(message, 'Start a different improvement') })
  await click(button(improveText.entry.submit, dialog()!))
  expect(count('POST', new RegExp(`^${PROJECT}/application-drafts$`))).toBe(1)
  expect(count('POST', /creation-plan-generations$/)).toBe(0)
  expect(requests.some((item) => item.method === 'DELETE' || (item.method === 'PATCH' && item.path.endsWith(`/${id}`)))).toBe(false)
})

test('any unreadable stack keeps an unmatched wizard app unknown without resume or discard', async () => {
  await mockFetch('/api/console/__mock/app-draft', { method: 'POST' })
  rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-stacks$`), once: false, body: (wire) => ({ ...wire, data: [...wire.data as Json[], { id: 'stack-3f1234567890abcd', templateId: 'Bad Id!' }] }) })
  requests = []
  await renderApp('overview', 'drafts')
  const row = container.querySelector('a[href$="/draft-stopped"]')!.closest('li')!
  expect(row.textContent).toContain(text.unsupported.label)
  expect(row.textContent).not.toContain(discoverText.list.resume)
  expect(row.querySelectorAll('button')).toHaveLength(0)
  expect(requests.every((item) => item.method === 'GET')).toBe(true)
})

test('all unreadable stack rows keep apps listed with unknown status', async () => {
  rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-stacks$`), once: false, body: (wire) => ({ ...wire, data: (wire.data as Json[]).map((stack) => ({ ...stack, templateId: 'Bad Id!' })) }) })
  await renderApp('overview', 'mine')
  const rows = [...container.querySelectorAll('tbody tr')]
  expect(rows.length).toBeGreaterThan(1)
  for (const row of rows) expect(row.textContent).toContain(text.unsupported.label)
  expect(pageText()).not.toContain(copy.mine.empty)
})

test('all unreadable draft rows remain inert rows rather than an empty state', async () => {
  rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-drafts$`), once: false, body: () => ({ data: [{ ...storedDraftWire, id: 'bad-one', createdAt: 'not-a-date' }, { ...storedDraftWire, id: 'bad-two', kind: 'future-kind' }] }) })
  await renderApp('overview', 'drafts')
  const rows = [...container.querySelectorAll('li')].filter((row) => row.textContent === discoverText.drafts.unreadable)
  expect(rows).toHaveLength(2)
  for (const row of rows) expect(row.querySelector('button, a')).toBeNull()
  expect(pageText()).not.toContain(discoverText.drafts.empty)
})

test('readable drafts sort newest first before unreadable rows', async () => {
  rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-drafts$`), once: false, body: () => ({ data: [
    { ...storedDraftWire, id: 'bad', createdAt: 'not-a-date' },
    { ...storedDraftWire, id: 'old', title: 'Older draft', updatedAt: '2026-11-01T00:00:00Z' },
    { ...storedDraftWire, id: 'new', title: 'Newer draft', updatedAt: '2026-11-15T00:00:00Z' },
  ] }) })
  await renderApp('overview', 'drafts')
  const rows = [...container.querySelectorAll(`ul[aria-label="${discoverText.drafts.title}"] > li`)].map((row) => row.textContent ?? '')
  expect(rows.findIndex((row) => row.includes('Newer draft'))).toBeLessThan(rows.findIndex((row) => row.includes('Older draft')))
  expect(rows.at(-1)).toBe(discoverText.drafts.unreadable)
})

test.each(['platform-v1', 'console-v1'] as const)('an unreadable creating-draft row linked by %s tab state makes its app unknown', async (engine) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } })
  restore.push(() => descriptor ? Object.defineProperty(globalThis, 'sessionStorage', descriptor) : Reflect.deleteProperty(globalThis, 'sessionStorage'))
  if (engine === 'platform-v1') saveBuildSession('creating-draft', { ...initialSession({ projectId: 'commerce', ownerSubject: 'owner', groupId: 'g-team-a', baseIntent: 'Create app' }), createdAppId: APP_ID })
  else saveConsoleCreation('creating-draft', { groupId: 'g-team-a', prepareRequested: false, reusePlan: false, createdAppId: APP_ID })
  rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-drafts$`), once: false, body: () => ({ data: [{ ...storedDraftWire, id: 'creating-draft', createdAt: 'not-a-date' }] }) })
  await renderApp('overview')
  expect(container.querySelector('header')?.textContent).toContain(text.unsupported.label)
  expect(container.querySelector('[data-testid="app-url"]')?.getAttribute('href')).toBe('https://mitsumori.commerce.appthrust.test/')
  expect(container.querySelector(`button[aria-label="${text.header.menu}"]`)).toBeNull()
  expect(buttons().some((item) => item.textContent?.trim() === copy.app.settings.deleteAction && !item.disabled)).toBe(false)
  expect(container.querySelector('[data-testid="improve-with-ai"]')).toBeNull()
  await click(button(sharingCopy.title))
  expect(dialog()).not.toBeNull()
  expect([...dialog()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].every((item) => item.disabled)).toBe(true)
  expect(buttons(dialog()!).some((item) => item.textContent?.trim() === copy.app.settings.save)).toBe(false)
  expect(writes()).toEqual([])
  expect(pageText()).not.toContain(discoverText.list.statusFailed)
  for (const tab of ['settings', 'releases'] as const) {
    await act(async () => { root?.unmount() })
    container.remove()
    client.clear()
    await renderApp(tab)
    const edits = buttons().filter((item) => item.textContent?.trim() === copy.app.settings.deleteAction || /この版に戻す/.test(item.getAttribute('aria-label') ?? ''))
    expect(edits.length).toBeGreaterThan(0)
    for (const edit of edits) {
      expect(edit.disabled).toBe(true)
      await click(edit)
    }
    expect(dialog()).toBeNull()
    expect(writes()).toEqual([])
  }
})

test.each(['stack', 'build'] as const)('delete and discard hooks refuse an unreadable %s view before any request', async (kind) => {
  if (kind === 'stack') {
    rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-stacks$`), once: false, body: (wire) => ({ ...wire, data: (wire.data as Json[]).map((stack) => stack.id === 'mitsumori' ? { ...stack, templateId: 'Bad Id!' } : stack) }) })
  } else {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    const values = new Map<string, string>()
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } })
    restore.push(() => descriptor ? Object.defineProperty(globalThis, 'sessionStorage', descriptor) : Reflect.deleteProperty(globalThis, 'sessionStorage'))
    saveConsoleCreation('creating-draft', { groupId: 'g-team-a', prepareRequested: false, reusePlan: false, createdAppId: APP_ID })
    rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-drafts$`), once: false, body: () => ({ data: [{ ...storedDraftWire, id: 'creating-draft', createdAt: 'not-a-date' }] }) })
  }
  await renderApp('overview', 'deletion-probe')
  await click(button('Attempt delete'))
  await click(button('Attempt discard'))
  expect(pageText()).toContain('Both writes refused')
  expect(writes()).toEqual([])
})

test.each(['improve', 'repair'] as const)('an unreadable draft row does not block a new %s', async (entry) => {
  await mockFetch('/api/v1/__mock/codex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ available: true }) })
  rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-drafts$`), once: false, body: () => ({ data: [{ ...storedDraftWire, id: 'unreadable-row', createdAt: 'not-a-date' }] }) })
  if (entry === 'repair') rewrites.push({ method: 'GET', path: new RegExp(`^${PROJECT}/application-stacks$`), once: false, body: (wire) => ({ ...wire, data: (wire.data as Json[]).map((stack) => stack.id === 'mitsumori' ? { ...stack, buildFailure: { lines: ['Module not found: example'] } } : stack) }) })
  requests = []
  await renderApp('overview')
  await click(container.querySelector<HTMLButtonElement>(`[data-testid="${entry === 'repair' ? 'repair-build-with-ai' : 'improve-with-ai'}"]`)!)
  if (entry === 'improve') {
    const input = dialog()!.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => { type(input, 'Improve this app') })
    await click(button(improveText.entry.submit, dialog()!))
  }
  expect(writes()).toEqual([
    { method: 'POST', path: `${PROJECT}/application-drafts`, status: 201 },
    { method: 'POST', path: expect.stringMatching(/\/application-drafts\/[^/]+\/conversation-turns$/), status: 202 },
  ])
  expect(requests.some((item) => item.path.includes('/unreadable-row'))).toBe(false)
})

describe('role-based views: people who do not maintain the app get the intro page (ux-design §6.5, §6.6)', () => {
  const USE_ONLY = { use: true, comment: true, propose: false, maintain: false, data: false }
  const PROPOSER = { ...USE_ONLY, propose: true }
  const asCaller = (permissions: typeof USE_ONLY) => rewrites.push({ method: 'GET', path: CONSOLE_APP, once: false, body: (wire) => ({ ...wire, permissions }) })
  const tabs = () => container.querySelector(`nav[aria-label="${text.header.tabsLabel}"]`)

  test.each(['overview', 'settings', 'logs', 'data'] as const)('every tab URL (%s) shows the tab-less intro with 担当者に伝える and no engineering words', async (tab) => {
    asCaller(USE_ONLY)
    await renderApp(tab)
    expect(tabs()).toBeNull()
    expect(container.querySelector('[data-testid="intro-open"]')!.textContent).toContain(text.intro.open)
    expect(pageText()).toContain(text.feedback.title)
    expect(pageText()).toContain(text.feedback.lead)
    expect(pageText()).not.toContain(sharingCopy.title)
    expect(pageText()).not.toContain(text.propose.action)
    for (const word of ['ログ', 'イメージ', 'ポート', text.overview.placement, text.settings.advanced]) expect(pageText()).not.toContain(word)
    expect(pageText()).not.toMatch(/\bv\d+\b/)
    // Nothing behind the tabs is read for someone who cannot see them.
    expect(count('GET', LOGS)).toBe(0)
    expect(count('GET', ENV)).toBe(0)
  })

  test('someone who may propose gets 「直しを提案する」; a closed contribution scope refuses in the dialog with the server reason', async () => {
    asCaller(PROPOSER)
    rewrites.push({ method: 'POST', path: new RegExp(`^${PROJECT}/application-drafts$`), once: true, body: () => Response.json({ error: { code: 'contribution_not_accepted', message: text.propose.refused } }, { status: 403 }) })
    await renderApp('overview')
    expect(tabs()).toBeNull()
    await click(button(text.propose.action, container))
    const open = dialog()!
    expect(open.textContent).toContain(text.propose.title)
    expect(open.textContent).toMatch(/さんが確認してから反映されます。/)
    const field = open.querySelector('textarea')!
    await act(async () => { type(field, '一覧に絞り込みを足したい') })
    await submit(open.querySelector('form')!)
    expect(dialog()!.textContent).toContain(text.propose.refused)
  })

  test('a maintainer previews it with ?as=user under a banner, and 「もとに戻る」 brings the tabs back', async () => {
    await renderApp('overview', 'app', '?as=user')
    expect(container.querySelector('[data-testid="user-preview-banner"]')!.textContent).toContain(text.intro.preview)
    expect(tabs()).toBeNull()
    // Users delete only their own comments, so the preview does too: moderation stays on the guide tab.
    const myName = client.getQueryData(meQuery.queryKey)!.person.displayName
    const rows = [...section('comments').closest('section')!.querySelectorAll('li')]
    expect(rows.length).toBeGreaterThan(rows.filter((row) => row.textContent?.startsWith(myName)).length)
    expect(rows.filter((row) => row.querySelector(`button[aria-label="${text.comments.menu}"]`)).length).toBe(rows.filter((row) => row.textContent?.startsWith(myName)).length)
    await click(button(text.intro.previewExit, container))
    expect(router.state.location.searchStr).not.toContain('as=user')
    expect(container.querySelector('[data-testid="user-preview-banner"]')).toBeNull()
    expect(tabs()).not.toBeNull()
    expect(container.querySelector('[data-testid="user-view-link"]')!.getAttribute('href')).toContain('?as=user')
  })
})
