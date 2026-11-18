// Resuming a creation whose app already exists (APT-1128 review): creating needs a membership of the target group,
// and an app kept in a group the caller no longer belongs to is neither continued nor moved to another group. Both
// persisted forms are covered: the session this tab saved, and the wizard rebuilt from the server's draft (?resume=).
// Over the real page, queries, gateway and contracts; the in-memory Console and Platform mocks answer every request.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createCreateApi } from '../../api/create'
import { groupsContract } from '../../api/contracts/console/groups'
import { meContract } from '../../api/contracts/console/me'
import { consoleKeys } from '../../api/queries/console'
import { createTestGateway } from '../../api/testing/gateway'
import { copy } from '../../copy'
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'
import type { BusinessApp } from '../../model/contracts/console'
import { setLanguage } from '../../shell/language'
import { UnsavedChangesProvider } from '../../ui/use-unsaved-changes-guard'
import { preserveLanguage } from '../../../test/language'
import { text } from './copy'
import type { CreateValues } from './form'
import { NewAppPage } from './new-app-page'
import { readCreateSession, saveCreateSession } from './persistence'

let requests: { method: string; path: string }[] = []

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const response = await (url.pathname.startsWith('/api/console/') ? consoleRoutes : platformRoutes)(request, url)
  return response ?? Response.json({ error: { code: 'not_found', message: 'unhandled' } }, { status: 404 })
}

/** The page's own requests. */
async function pageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://mock.test'), init)
  requests.push({ method: request.method, path: new URL(request.url).pathname })
  return route(request)
}

/** Setup: these calls are not the page's. */
const gateway = createTestGateway({
  consoleFetch: (path, init) => route(new Request(new URL(path, 'http://mock.test'), init)),
  platformFetch: (request) => route(request),
})
const api = createCreateApi(gateway)
async function mock(path: string, body: unknown) {
  const response = await route(new Request(new URL(path, 'http://mock.test'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
  if (!response.ok) throw new Error(`mock ${path}: ${response.status}`)
}

const storage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
let restore: (() => void)[] = []
let root: Root | undefined
let container: HTMLDivElement
let client: QueryClient

beforeEach(async () => {
  restore = [preserveLanguage()]
  setLanguage('ja')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage })
  window.sessionStorage.clear()
  requests = []
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(pageFetch as typeof globalThis.fetch)
  restore.push(() => fetch.mockRestore())
  await mock('/api/v1/__mock/reset', {})
  await mock('/api/console/__mock/reset', {})
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  // The mocks are module-level state shared with later test files: leave them as the next file expects them.
  await mock('/api/v1/__mock/reset', {})
  await mock('/api/console/__mock/reset', {})
  client?.clear()
  window.sessionStorage.clear()
  for (const undo of restore.reverse()) undo()
  if (storage) Object.defineProperty(globalThis, 'sessionStorage', storage)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
})

const imageRef = 'ghcr.io/acme/demo:1.0.0'

/** An app the earlier attempt made in `groupId` (the signed-in person belongs to it then). */
async function keptApp(groupId: string): Promise<BusinessApp> {
  return api.createApp({ displayName: '備品貸出', description: '', tags: [], groupId, slug: 'bihin', share: { scope: 'private', groupIds: [], extraPersonIds: [] } })
}

function savedValues(draft: BusinessApp | undefined, groupId: string): CreateValues {
  return {
    entry: 'image', imageRef, repository: undefined, intent: '', templateId: undefined, displayName: draft?.displayName ?? '備品貸出', description: '', tags: [],
    groupId, urlName: draft?.slug ?? 'bihin', urlNameEdited: false, scope: 'private', shareGroupIds: null,
  }
}

/** Opens `path` for the signed-in person, who now belongs to `effectiveGroupIds` only. */
async function open(path: string, effectiveGroupIds: string[]) {
  const [me, groups] = await Promise.all([gateway.console(meContract, undefined), gateway.console(groupsContract, undefined)])
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  client.setQueryData(consoleKeys.me, { ...me, canCreateApps: true, effectiveGroupIds })
  client.setQueryData(consoleKeys.groups, groups)
  const rootRoute = createRootRoute()
  const newRoute = createRoute({ getParentRoute: () => rootRoute, path: '/new', component: NewAppPage })
  const router = createRouter({ routeTree: rootRoute.addChildren([newRoute]), history: createMemoryHistory({ initialEntries: [path] }), isServer: true })
  await router.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider><NewAppPage /></UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>)
  })
  for (let tick = 0; tick < 12; tick++) await act(async () => { await Bun.sleep(10) })
}

const keptNotice = () => container.querySelector('[data-testid="create-kept-group"]')
const buttons = (label: string) => [...container.querySelectorAll('button')].filter((item) => item.textContent?.trim() === label)
/** Writes to Console app records (create, change, bind): none may follow from a blocked resume. */
const appWrites = () => requests.filter((item) => item.method !== 'GET' && item.path.startsWith('/api/console/apps'))
const savedGroupId = () => readCreateSession()?.values.groupId

test.each(['ja', 'en'] as const)('an oversized URL opening stays editable with a byte count and cannot start a build (%s)', async (language) => {
  setLanguage(language)
  const exact = '庫'.repeat(1332) + '😀'
  const oversized = exact + '字'
  await open(`/new?intent=${encodeURIComponent(oversized)}`, ['g-team-a'])
  const input = container.querySelector<HTMLTextAreaElement>('#create-start-intent')!
  const [build] = buttons(copy.create.start.build)
  expect(input.value).toBe(oversized)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(container.querySelector('#create-start-intent-error')?.textContent).toContain(language === 'ja' ? '3 バイト超えています' : '3 bytes over the limit')
  expect(build!.disabled).toBe(true)
  await act(async () => { build!.click() })
  expect(requests.filter((item) => item.method === 'POST' && /\/(?:application-drafts|build-sessions)$/.test(item.path))).toEqual([])
  expect(container.querySelector('#build-start-failure')).toBeNull()

  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, exact)
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
  })
  expect(container.querySelector('#create-start-intent-hint')?.textContent).toBe(language === 'ja' ? '残り 0 バイト' : '0 bytes remaining')
  expect(build!.disabled).toBe(false)
})

test('a saved session whose app is kept in a group the caller left is held, never moved to the group they belong to now', async () => {
  const draft = await keptApp('g-team-a')
  saveCreateSession({ version: 1, step: 'confirm', progress: { draft }, values: savedValues(draft, draft.group.id) })
  // 山田 has since moved from 営業1課 to 総務部.
  await open('/new?step=confirm', ['g-soumu'])

  expect(keptNotice()?.textContent).toContain(text.keptGroup.title)
  expect(keptNotice()?.textContent).toContain(text.keptGroup.body(draft.group.name))
  expect(keptNotice()?.querySelector('a')?.getAttribute('href')).toBe('/company')
  const submit = buttons('作る')
  expect(submit).toHaveLength(1)
  expect(submit[0]!.disabled).toBe(true)
  await act(async () => { submit[0]!.click() })
  expect(appWrites()).toEqual([])
  // The form still names the app's own group: nothing would move it to 総務部.
  expect(savedGroupId()).toBe(draft.group.id)
  expect((await api.app(draft.id)).group.id).toBe('g-team-a')
})

test('a wizard rebuilt from the server\'s draft (?resume=) is held the same way, with every entry closed', async () => {
  const draft = await keptApp('g-team-a')
  await open(`/new?resume=${draft.id}`, ['g-soumu'])

  expect(requests.some((item) => item.method === 'GET' && item.path === `/api/console/apps/${draft.id}`)).toBe(true)
  expect(keptNotice()?.textContent).toContain(text.keptGroup.body(draft.group.name))
  // The guidance stands once; no entry starts anything from this page.
  expect(container.textContent?.split(text.keptGroup.body(draft.group.name))).toHaveLength(2)
  const templates = [...container.querySelectorAll<HTMLButtonElement>('[data-testid^="template-"]')]
  expect(templates.length).toBeGreaterThan(0)
  for (const template of templates) expect(template.disabled).toBe(true)
  expect(container.querySelector<HTMLButtonElement>('[data-testid="create-excel2app"]')?.disabled).toBe(true)
  for (const label of ['AI でカスタマイズ', '次へ']) {
    expect(buttons(label).length).toBeGreaterThan(0)
    for (const button of buttons(label)) expect(button.disabled).toBe(true)
  }
  expect(appWrites()).toEqual([])
  expect(savedGroupId()).toBe(draft.group.id)
})

test('a saved session with nothing made yet takes the default membership instead of a group the caller left', async () => {
  saveCreateSession({ version: 1, step: 'start', progress: {}, values: savedValues(undefined, 'g-soumu') })
  await open('/new', ['g-team-a'])

  expect(keptNotice()).toBeNull()
  expect(container.querySelector('[data-testid="create-no-group"]')).toBeNull()
  expect(savedGroupId()).toBe('g-team-a')
})

test('a kept app in a group the caller still belongs to goes on there, even when the remembered choice was another group', async () => {
  // 佐藤 belongs to 営業本部 and everything below it; her attempt made the app in 営業企画部.
  await mock('/api/console/__mock/caller', { personId: 'p-sato', role: 'Editor' })
  const draft = await keptApp('g-planning')
  saveCreateSession({ version: 1, step: 'confirm', progress: { draft }, values: savedValues(draft, 'g-soumu') })
  // Her default membership (営業1課 comes first) is not where the kept app is.
  await open('/new?step=confirm', ['g-team-a', 'g-planning'])

  expect(keptNotice()).toBeNull()
  expect(savedGroupId()).toBe('g-planning')
})
