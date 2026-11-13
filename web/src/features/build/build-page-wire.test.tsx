// The build screen against unreadable Platform answers (design §6, X3/X5, APT-748):
// the real page, queries, gateway and contracts run over the in-memory Platform
// and console mocks; only the answer under test is rewritten on its way back.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { groupsContract } from '../../api/contracts/console/groups'
import { meContract } from '../../api/contracts/console/me'
import { buildKeys } from '../../api/queries/build'
import { consoleKeys } from '../../api/queries/console'
import { queryClient as appQueryClient } from '../../api/queries/shared'
import { createTestGateway } from '../../api/testing/gateway'
import { copy } from '../../copy'
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'
import { buildCopy } from '../../model/build/copy'
import type { BuildDraft } from '../../model/contracts/build'
import { setLanguage } from '../../shell/language'
import { UnsavedChangesProvider } from '../../ui/use-unsaved-changes-guard'
import { preserveLanguage } from '../../../test/language'
import { BuildPage } from './build-page'
import { text as uiText } from './copy'
import { implementationCopy } from './implement/copy'

const SECRET = 'SENTINEL-build-page-7f3a'
const PROJECT = '/api/v1/projects/commerce'

type Json = Record<string, unknown>
/** Rewrites a successful answer of the in-memory Platform mock before the page reads it. */
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
  return Response.json(rewrite.body((await response.json()) as Json), { status: response.status })
}

/** Drives the Platform mock directly (setup and server-side truth); these calls are not the page's requests. */
async function call(method: string, path: string, body?: unknown) {
  const url = new URL(path, 'http://mock.test')
  const response = await platformRoutes(new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), url)
  if (!response?.ok) throw new Error(`mock ${method} ${path}: ${response?.status}`)
  return (await response.json()) as Json
}
const advance = async (count = 1) => { for (let step = 0; step < count; step++) await call('POST', '/api/v1/__mock/advance') }
const draftPath = (id: string) => `${PROJECT}/application-drafts/${id}`
const consoleGateway = createTestGateway({ consoleFetch: (path, init) => mockFetch(path, init) })

/** The opening turn answered with a question: the composer is open and no job runs, so nothing polls. */
async function askingDraft() {
  const draft = (await call('POST', `${PROJECT}/application-drafts`, { intent: '営業が見積書を作って PDF で出せるアプリ。顧客と品目を登録したい。' })).resource as Json
  await call('POST', `${draftPath(draft.id as string)}/conversation-turns`, { message: buildCopy.questions.firstTurn })
  await advance()
  return draft.id as string
}

/** A plan is ready and 「この内容で作る」 is offered (stage 決める). */
async function plannedDraft() {
  const draft = (await call('POST', `${PROJECT}/application-drafts`, { intent: '見積を管理するアプリ', title: '見積を管理' })).resource as Json
  await call('POST', `${draftPath(draft.id as string)}/creation-plan-generations`, {})
  await advance(4)
  return draft.id as string
}

/** The app is created; no implementation run exists yet. */
async function createdDraft() {
  const id = await plannedDraft()
  const validation = (await call('POST', `${draftPath(id)}/creation-plan-validations`, {})).resource as Json
  const begun = (await call('POST', `${draftPath(id)}/creation-executions`, { clientRequestId: 'wire-test', creationPlanFingerprint: validation.creationPlanFingerprint })).resource as { creationExecutions: { id: string }[] }
  await call('POST', `${draftPath(id)}/creation-executions/${begun.creationExecutions[0]!.id}/run`, {})
  await advance(6)
  return id
}

/** 用意する has begun and runs (nothing advances it): the page asks its hidden preparation question on its own. */
async function preparingDraft() {
  const id = await plannedDraft()
  const validation = (await call('POST', `${draftPath(id)}/creation-plan-validations`, {})).resource as Json
  const begun = (await call('POST', `${draftPath(id)}/creation-executions`, { clientRequestId: 'wire-preparing', creationPlanFingerprint: validation.creationPlanFingerprint })).resource as { creationExecutions: { id: string }[] }
  await call('POST', `${draftPath(id)}/creation-executions/${begun.creationExecutions[0]!.id}/run`, {})
  return id
}

type WireTask = { status: string; verification?: { criteria?: unknown[] } }
type WireRun = { status: string; tasks: WireTask[] }

/** The implementation run has finished its first task (verified against its criteria) and works on the next. */
async function buildingDraft() {
  const id = await createdDraft()
  await call('POST', `${draftPath(id)}/implementation-runs`, {})
  for (let step = 0; step < 12; step++) {
    const run = ((await call('GET', draftPath(id))).implementationRuns as WireRun[]).at(-1)!
    if (run.tasks.some((task) => task.status === 'done') && run.tasks.some((task) => task.status === 'running')) break
    await advance()
  }
  const run = ((await call('GET', draftPath(id))).implementationRuns as WireRun[]).at(-1)!
  expect(run.tasks.find((task) => task.status === 'done')?.verification?.criteria?.length).toBeGreaterThan(0)
  return id
}

/** Lets in-flight fetches settle and React Query's batched notifications reach the page. */
async function settle(rounds = 8) {
  for (let tick = 0; tick < rounds; tick++) await act(async () => { await Bun.sleep(10) })
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

/** The build page on the app's query defaults (retry policy included), with polling left to the test. */
async function renderBuild(draftId: string) {
  client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false } } })
  const [me, groups] = await Promise.all([consoleGateway.console(meContract, undefined), consoleGateway.console(groupsContract, undefined)])
  client.setQueryData(consoleKeys.me, me)
  client.setQueryData(consoleKeys.groups, groups)
  const rootRoute = createRootRoute()
  const buildRoute = createRoute({ getParentRoute: () => rootRoute, path: '/-/build/$draftId', component: () => null })
  const router = createRouter({ routeTree: rootRoute.addChildren([buildRoute]), history: createMemoryHistory({ initialEntries: [`/-/build/${draftId}`] }) })
  await router.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider><BuildPage draftId={draftId} /></UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>)
  })
  await settle()
  return { key: buildKeys.draft('commerce', draftId), router }
}

/** One poll tick of the draft query, as its interval would run it. */
async function tick(key: readonly unknown[]) {
  await act(async () => { await client.refetchQueries({ queryKey: key }) })
  await settle()
}

const pageText = () => container.textContent ?? ''
const composer = () => container.querySelector<HTMLTextAreaElement>('#build-reply')!
const stage = () => container.querySelector('[data-testid="build-session"]')?.getAttribute('data-stage')
const count = (method: string, path: RegExp) => requests.filter((item) => item.method === method && path.test(item.path)).length
const refreshFailed = copy.common.refreshFailed(copy.relative.justNow)
/** Every value the page holds in its query cache, serialized: nothing from an unreadable answer may be in it. */
const cachedWire = () => JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))

/** Types into a React-controlled textarea the way a user does. */
function type(field: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
  field.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
  if (!found) throw new Error(`no button ${name}`)
  return found
}

/** The notices titled `title` (a Notice is one status/alert element), in `scope` (default: the whole page). */
const notices = (title: string, scope = '[data-testid="build-session"]') => [...container.querySelector(scope)!.querySelectorAll('[role="status"], [role="alert"]')].filter((item) => item.querySelector('p')?.textContent === title)

/** Every action the notices titled `title` offer, without the support-reference copy button (it copies text and changes nothing). */
const actionsOf = (title: string) => notices(title).flatMap((notice) => [...notice.querySelectorAll('button')]).filter((item) => item.getAttribute('aria-label') !== buildCopy.failure.copyReference && item.textContent?.trim() !== buildCopy.failure.copyReference)

async function click(target: HTMLButtonElement) {
  await act(async () => { target.click() })
  await settle()
}

describe('X3: good → malformed draft tick → good on the build screen', () => {
  test('the last draft, its timestamp and the unsent reply stay under one fixed notice, which clears on recovery', async () => {
    const draftId = await askingDraft()
    const draftGet = new RegExp(`${draftPath(draftId)}$`)
    const { key } = await renderBuild(draftId)
    const log = () => container.querySelector('[role="log"]')!.textContent
    const spec = () => container.querySelector('[data-testid="build-spec"]')!.textContent
    const shown = { log: log(), spec: spec() }
    expect(shown.log).toContain('見積の PDF には何を載せますか？')
    expect(pageText()).not.toContain(refreshFailed)
    const good = client.getQueryData<BuildDraft>(key)
    const goodAt = client.getQueryState(key)!.dataUpdatedAt
    const reply = 'PDF に会社ロゴも入れたい'
    await act(async () => { type(composer(), reply) })
    expect(button(uiText.composer.send).disabled).toBe(false)

    rewrites.push({ method: 'GET', path: draftGet, once: true, body: (wire) => ({ ...wire, title: { leaked: SECRET }, conversationTurns: SECRET }) })
    await tick(key)
    expect(count('GET', draftGet)).toBe(2)
    expect(Object.is(client.getQueryData(key), good)).toBe(true)
    expect(client.getQueryState(key)!.dataUpdatedAt).toBe(goodAt)
    expect(client.getQueryState(key)!.status).toBe('error')
    expect({ log: log(), spec: spec() }).toEqual(shown)
    expect(composer().value).toBe(reply)
    expect(composer().disabled).toBe(false)
    expect(button(uiText.composer.send).disabled).toBe(false)
    expect(pageText().split(refreshFailed)).toHaveLength(2)
    // The notice sits among the page's notices under the session header, not above the page.
    expect(container.querySelector('[data-testid="build-session"]')!.textContent).toContain(refreshFailed)
    expect(pageText()).not.toContain(copy.common.loadFailed)
    expect(pageText()).not.toContain(copy.common.panelFailed)
    expect(container.innerHTML).not.toContain(SECRET)
    expect(cachedWire()).not.toContain(SECRET)
    // A contract failure is final for this tick: no burst of re-reads.
    await settle()
    expect(count('GET', draftGet)).toBe(2)

    await tick(key)
    expect(count('GET', draftGet)).toBe(3)
    expect(client.getQueryState(key)!.status).toBe('success')
    expect(client.getQueryState(key)!.dataUpdatedAt).toBeGreaterThan(goodAt)
    expect(pageText()).not.toContain(refreshFailed)
    expect({ log: log(), spec: spec() }).toEqual(shown)
    expect(composer().value).toBe(reply)
  })
})

describe('APT-748: draft collections on the build screen', () => {
  test('a draft Platform marshals without creationExecutions (empty, omitted) renders as a draft with none', async () => {
    const draftId = await askingDraft()
    const omitted: unknown[] = []
    rewrites.push({ method: 'GET', path: new RegExp(`${draftPath(draftId)}$`), once: false, body: ({ creationExecutions, ...wire }) => { omitted.push(creationExecutions); return wire } })
    const { key } = await renderBuild(draftId)
    expect(omitted).toEqual([[]])
    expect(client.getQueryData<BuildDraft>(key)?.creationExecutions).toEqual([])
    expect(stage()).toBe('ask')
    expect(container.querySelector('[role="log"]')!.textContent).toContain('見積の PDF には何を載せますか？')
    expect(container.querySelector('[data-testid="build-spec"]')).not.toBeNull()
    expect(composer().disabled).toBe(false)
    for (const failure of [copy.common.loadFailed, copy.common.panelFailed, refreshFailed, buildCopy.unsupported.title]) expect(pageText()).not.toContain(failure)
  })

  const broken = {
    'a run without tasks': (runs: WireRun[]) => runs.map(({ tasks: _tasks, ...run }) => run),
    'a verification without criteria': (runs: WireRun[]) => runs.map((run) => ({ ...run, tasks: run.tasks.map((task) => task.verification ? { ...task, verification: { ...task.verification, criteria: undefined } } : task) })),
  }
  test.each(Object.keys(broken) as (keyof typeof broken)[])('%s on a poll: the fixed notice, while the conversation input and the preview stay usable', async (name) => {
    const draftId = await buildingDraft()
    const { key } = await renderBuild(draftId)
    const preview = container.querySelector('iframe')
    expect(preview).not.toBeNull()
    const previewSrc = preview!.getAttribute('src')
    expect(button(implementationCopy.open).disabled).toBe(false)
    // Task labels only: the running task's elapsed time ticks every second.
    const tasks = () => [...container.querySelectorAll(`[aria-label="${uiText.implement.steps}"] li > div > div > span:first-child`)].map((label) => label.textContent)
    const shownTasks = tasks()
    expect(shownTasks.length).toBeGreaterThan(1)
    const good = client.getQueryData<BuildDraft>(key)
    const reply = 'ボタンの色を変えてください'
    await act(async () => { type(composer(), reply) })

    rewrites.push({ method: 'GET', path: new RegExp(`${draftPath(draftId)}$`), once: true, body: (wire) => ({ ...wire, implementationRuns: broken[name](wire.implementationRuns as WireRun[]) }) })
    await tick(key)
    expect(client.getQueryState(key)!.status).toBe('error')
    expect(Object.is(client.getQueryData(key), good)).toBe(true)
    expect(pageText().split(refreshFailed)).toHaveLength(2)
    expect(pageText()).not.toContain(copy.common.panelFailed)
    expect(pageText()).not.toContain(copy.common.loadFailed)
    // The preview keeps its frame and its controls; the ladder keeps the last good tasks.
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(previewSrc)
    expect(button(implementationCopy.open).disabled).toBe(false)
    expect(tasks()).toEqual(shownTasks)
    expect(composer().value).toBe(reply)
    expect(composer().disabled).toBe(false)
    expect(button(uiText.composer.send).disabled).toBe(false)
  })
})

describe('X5: a 2xx write whose answer cannot be read', () => {
  const unconfirmed = buildCopy.failure.unconfirmed.title

  /** Sends a reply from the composer; its turn POST answers 202 with a body that breaks the contract. */
  async function unreadableTurn() {
    const draftId = await askingDraft()
    const turns = new RegExp(`${draftPath(draftId)}/conversation-turns$`)
    const draftGet = new RegExp(`${draftPath(draftId)}$`)
    const view = await renderBuild(draftId)
    rewrites.push({ method: 'POST', path: turns, once: true, body: (wire) => ({ ...wire, resource: { id: SECRET, userMessage: SECRET } }) })
    const readsBefore = count('GET', draftGet)
    await act(async () => { type(composer(), 'PDF に会社ロゴも入れたい') })
    await click(button(uiText.composer.send))
    return { draftId, turns, draftGet, readsBefore, ...view }
  }

  /** Presses 「この内容で作る」; the begin or the run POST answers 2xx with a body that breaks the contract. */
  async function unreadableExecution(step: 'begin' | 'run') {
    const draftId = await plannedDraft()
    const begin = new RegExp(`${draftPath(draftId)}/creation-executions$`)
    const run = new RegExp(`${draftPath(draftId)}/creation-executions/[^/]+/run$`)
    const draftGet = new RegExp(`${draftPath(draftId)}$`)
    const view = await renderBuild(draftId)
    expect(stage()).toBe('decide')
    rewrites.push({ method: 'POST', path: step === 'begin' ? begin : run, once: true, body: (wire) => ({ ...wire, resource: { ...(wire.resource as Json), title: { leaked: SECRET }, creationExecutions: SECRET } }) })
    await click(button(buildCopy.primary.prepare))
    await settle(10)
    return { draftId, begin, run, draftGet, ...view }
  }

  test('conversation turn: nothing enters the cache, the reply is not resent, and only a re-read is offered', async () => {
    const { draftId, turns, draftGet, readsBefore, key, router } = await unreadableTurn()
    expect(count('POST', turns)).toBe(1)
    expect(requests.find((item) => item.method === 'POST' && turns.test(item.path))?.status).toBe(202)
    // One notice in the conversation (the artifact pane repeats the failure's text without actions).
    expect(notices(unconfirmed, '#build-conversation')).toHaveLength(1)
    expect(cachedWire()).not.toContain(SECRET)
    expect(container.innerHTML).not.toContain(SECRET)
    // The draft is read back: what the cache shows is the server's state, not the unread answer.
    expect(count('GET', draftGet)).toBeGreaterThan(readsBefore)
    const server = (await call('GET', draftPath(draftId))).conversationTurns as { id: string }[]
    expect(client.getQueryData<BuildDraft>(key)?.conversationTurns.map((turn) => turn.id)).toEqual(server.map((turn) => turn.id))
    expect(router.state.location.pathname).toBe(`/-/build/${draftId}`)
    expect(stage()).toBe('ask')

    // Later ticks and renders never send the reply again.
    await tick(key)
    await settle(20)
    expect(count('POST', turns)).toBe(1)
    const actions = actionsOf(unconfirmed)
    expect(actions).toHaveLength(1)
    const reads = count('GET', draftGet)
    await click(actions[0]!)
    expect(count('GET', draftGet)).toBeGreaterThan(reads)
    expect(count('POST', turns)).toBe(1)
    expect(notices(unconfirmed)).toHaveLength(0)
  })

  test('conversation turn: the re-read is labelled as checking the latest state, not as a retry', async () => {
    await unreadableTurn()
    expect(actionsOf(unconfirmed).map((item) => item.textContent?.trim())).toEqual([buildCopy.failure.confirm])
  })

  test.each(['begin', 'run'] as const)('creation execution (%s): nothing enters the cache, the write is not resent, and only a re-read is offered', async (step) => {
    const { draftId, begin, run, draftGet, router } = await unreadableExecution(step)
    expect(count('POST', begin)).toBe(1)
    // The success side effect of begin is the run; an unread begin answer does not start it.
    expect(count('POST', run)).toBe(step === 'begin' ? 0 : 1)
    expect(notices(unconfirmed, '#build-conversation')).toHaveLength(1)
    expect(cachedWire()).not.toContain(SECRET)
    expect(container.innerHTML).not.toContain(SECRET)
    const failedAt = requests.findIndex((item) => item.method === 'POST' && (step === 'begin' ? begin : run).test(item.path))
    expect(requests.slice(failedAt + 1).some((item) => item.method === 'GET' && draftGet.test(item.path))).toBe(true)
    expect(router.state.location.pathname).toBe(`/-/build/${draftId}`)

    await settle(20)
    expect(count('POST', begin)).toBe(1)
    expect(count('POST', run)).toBe(step === 'begin' ? 0 : 1)
    const actions = actionsOf(unconfirmed)
    expect(actions).toHaveLength(1)
    const reads = count('GET', draftGet)
    await click(actions[0]!)
    expect(count('GET', draftGet)).toBeGreaterThan(reads)
    // Re-reading never begins a second execution.
    expect(count('POST', begin)).toBe(1)
    if (step === 'run') expect(count('POST', run)).toBe(1)
  })

  // The re-read's draft GET is issued before the resumed run and used to land after the run's answer, replacing it in
  // the cache (the draft looked un-run and …/run was sent again). A write's answer now cancels draft reads in flight.
  test('creation execution (begin): re-reading resumes the begun execution\'s run once, not twice', async () => {
    const { run } = await unreadableExecution('begin')
    await settle(20)
    const actions = actionsOf(unconfirmed)
    expect(actions.map((item) => item.textContent?.trim())).toEqual([buildCopy.failure.confirm])
    await click(actions[0]!)
    await settle(10)
    expect(count('POST', run)).toBe(1)
  })

  /** A created draft whose implementation start answers 2xx unreadably; draft reads hide the new run while `hidden.runs`. */
  async function unreadableImplementationStart(hidden = { runs: false }) {
    const draftId = await createdDraft()
    const runs = new RegExp(`${draftPath(draftId)}/implementation-runs$`)
    const draftGet = new RegExp(`${draftPath(draftId)}$`)
    rewrites.push({ method: 'POST', path: runs, once: true, body: (wire) => ({ ...wire, resource: { ...(wire.resource as Json), tasks: SECRET } }) })
    rewrites.push({ method: 'GET', path: draftGet, once: false, body: (wire) => hidden.runs ? { ...wire, implementationRuns: [] } : wire })
    const view = await renderBuild(draftId)
    await settle(10)
    return { draftId, runs, draftGet, ...view }
  }

  test('implementation run: nothing enters the cache, the start is not resent, and the read-back run clears the warning', async () => {
    const { draftId, runs, draftGet, key, router } = await unreadableImplementationStart()
    expect(count('POST', runs)).toBe(1)
    expect(cachedWire()).not.toContain(SECRET)
    expect(container.innerHTML).not.toContain(SECRET)
    const startedAt = requests.findIndex((item) => item.method === 'POST' && runs.test(item.path))
    expect(requests.slice(startedAt + 1).some((item) => item.method === 'GET' && draftGet.test(item.path))).toBe(true)
    // What the screen shows is the read-back run, the one the server accepted; with it the warning has done its job.
    const server = ((await call('GET', draftPath(draftId))).implementationRuns as { id: string }[]).map((item) => item.id)
    expect(server).toHaveLength(1)
    expect(client.getQueryData<BuildDraft>(key)?.implementationRuns.map((item) => item.id)).toEqual(server)
    expect(notices(unconfirmed)).toHaveLength(0)
    expect(router.state.location.pathname).toBe(`/-/build/${draftId}`)

    await tick(key)
    await settle(20)
    expect(count('POST', runs)).toBe(1)
  })

  test('implementation run: until a read shows the run, the warning offers only 「最新の状態を確認する」, which re-reads and never starts again', async () => {
    const hidden = { runs: true }
    const { runs, draftGet, key } = await unreadableImplementationStart(hidden)
    expect(count('POST', runs)).toBe(1)
    expect(notices(unconfirmed, '#build-artifact')).toHaveLength(1)
    // Neither 「もう一度試す」 nor 「この作業を飛ばす」: only the re-read.
    expect(actionsOf(unconfirmed).map((item) => item.textContent?.trim())).toEqual([buildCopy.failure.confirm])
    // A poll that still shows no run starts nothing.
    await tick(key)
    await settle(20)
    expect(count('POST', runs)).toBe(1)
    expect(notices(unconfirmed, '#build-artifact')).toHaveLength(1)

    hidden.runs = false
    const reads = count('GET', draftGet)
    await click(actionsOf(unconfirmed)[0]!)
    await settle(10)
    expect(count('GET', draftGet)).toBeGreaterThan(reads)
    expect(count('POST', runs)).toBe(1)
    expect(client.getQueryData<BuildDraft>(key)?.implementationRuns).toHaveLength(1)
    expect(notices(unconfirmed)).toHaveLength(0)
  })
})

describe('an unknown draft phase', () => {
  test('offers no write: the composer and the reply chips are disabled with the fixed explanation, no step is current, reading stays', async () => {
    const draftId = await askingDraft()
    rewrites.push({ method: 'GET', path: new RegExp(`${draftPath(draftId)}$`), once: false, body: (wire) => ({ ...wire, phase: 'Archived' }) })
    const { key } = await renderBuild(draftId)
    expect(notices(buildCopy.unsupported.title)).toHaveLength(1)
    expect(container.querySelector('[role="log"]')!.textContent).toContain('見積の PDF には何を載せますか？')
    expect(container.querySelector('[data-testid="build-spec"]')).not.toBeNull()
    expect(composer().disabled).toBe(true)
    expect(button(uiText.composer.send).disabled).toBe(true)
    const chips = [...container.querySelectorAll<HTMLButtonElement>(`[role="group"][aria-label="${uiText.composer.suggestions}"] button`)]
    expect(chips.length).toBeGreaterThan(0)
    expect(chips.every((chip) => chip.disabled)).toBe(true)
    expect(container.querySelector('#build-reply-disabled')?.textContent).toBe(buildCopy.unsupported.detail)
    expect(composer().getAttribute('aria-describedby')).toContain('build-reply-disabled')
    expect(container.querySelector('header [aria-current="step"]')).toBeNull()
    await tick(key)
    await settle(10)
    expect(requests.filter((item) => item.method !== 'GET')).toEqual([])
  })
})

describe('the session\'s own writes', () => {
  // Browser stories saw POST …/conversation-turns twice (the second answered 409): the page re-rendered with the
  // session acknowledging the hidden preparation turn before the draft query's batched notification brought the turn.
  test('the hidden preparation turn is sent once, also before the page has re-rendered with its answer', async () => {
    const draftId = await preparingDraft()
    const turns = new RegExp(`${draftPath(draftId)}/conversation-turns$`)
    const { key } = await renderBuild(draftId)
    await settle(20)
    expect(requests.filter((item) => item.method === 'POST' && turns.test(item.path)).map((item) => item.status)).toEqual([202])
    expect(client.getQueryData<BuildDraft>(key)?.conversationTurns.map((turn) => turn.userMessage)).toEqual([buildCopy.questions.prepareTurn])
    await tick(key)
    await settle(20)
    expect(count('POST', turns)).toBe(1)
  })
})
