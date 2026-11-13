// The console-v1 build screen (APT-753 S4-U2) over the real route, hook,
// queries, gateway and S4-0 contracts against the in-memory v1 mock: every
// turn's answer stands on its own, candidates are concrete and selectable,
// unresolved items stay out of the specification, the revision changes only
// after 反映する, publish values are asked only once created and come only from
// the typed inputs (and back from the session after a reload), progress is
// the server's, double clicks send once, and unreadable 2xx / 412 / unknown
// values behave per the wire-boundary rules. Only the answer under test is
// rewritten on its way back.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { buildSessionsApi as api, mintIdempotencyKey } from '../../api/build-sessions'
import { groupsContract } from '../../api/contracts/console/groups'
import { meContract } from '../../api/contracts/console/me'
import { buildSessionKeys, isObserving } from '../../api/queries/build-sessions'
import { consoleKeys } from '../../api/queries/console'
import { queryClient as appQueryClient } from '../../api/queries/shared'
import { sessionExpiryStore } from '../../api/session-expiry'
import { createConsoleMockFetch, createSessionApp, resetMocks, type ConsoleMockFetch } from '../../api/testing/console-mock-fetch'
import { createTestGateway } from '../../api/testing/gateway'
import { platformRoutes } from '../../dev/mock-platform'
import { buildCopy } from '../../model/build/copy'
import type { BuildTurnInput } from '../../model/contracts/console'
import { BuildRouteView, loadBuildRoute } from '../../routes/build'
import { setLanguage } from '../../shell/language'
import { UnsavedChangesProvider } from '../../ui/use-unsaved-changes-guard'
import { preserveLanguage } from '../../../test/language'
import { text } from './copy'
import { startConsoleBuild } from './entry'

const BASE = '/api/console/v1/build-sessions'
const c = text.console
let mock: ConsoleMockFetch
let mounted: { root: Root; container: HTMLDivElement; client: QueryClient }[] = []
const originalFetch = globalThis.fetch
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const restore: (() => void)[] = []

beforeEach(async () => {
  restore.push(preserveLanguage())
  setLanguage('ja')
  await resetMocks()
  mock = createConsoleMockFetch()
  globalThis.fetch = mock.fetch as typeof globalThis.fetch
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage })
  window.sessionStorage.clear()
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restore.push(() => warn.mockRestore())
  // Radix RadioGroup checks `closest('form') instanceof HTMLFormElement`; the shared DOM preload does not expose it.
  const form = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement')
  Object.defineProperty(globalThis, 'HTMLFormElement', { configurable: true, value: window.HTMLFormElement })
  restore.push(() => form ? Object.defineProperty(globalThis, 'HTMLFormElement', form) : Reflect.deleteProperty(globalThis, 'HTMLFormElement'))
  // The Platform plan generation the plan turn starts settles as it is read (the server observes it).
  const toggle = new URL('/api/v1/__mock/plan-generation', 'http://mock.test')
  await platformRoutes(new Request(toggle, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoAdvance: true }) }), toggle)
})

afterEach(async () => {
  for (const { root, container, client } of mounted) {
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
  }
  mounted = []
  expect(mock.requests.filter((item) => item.status === 428)).toEqual([])
  globalThis.fetch = originalFetch
  await act(async () => { sessionExpiryStore.setState(() => false) })
  window.sessionStorage.clear()
  if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
  for (const undo of restore.splice(0).reverse()) undo()
})

async function settle(rounds = 12) {
  for (let tick = 0; tick < rounds; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** Steps the mock's active turn until the server stops asking to observe it (the server's work, not the page's). */
async function finishActive(sessionId: string) {
  for (let step = 0; step < 10; step++) {
    const session = await api.get(sessionId)
    if (!session.activeTurnId) return
    const turn = await api.getTurn(sessionId, session.activeTurnId)
    if (!isObserving(turn.nextAction)) return
  }
}

/** A started session whose opening turn was answered. */
async function startSession() {
  const { id: draftId } = await startConsoleBuild('設備の点検を記録するアプリ', 'g-team-a')
  const resolved = await api.resolve(draftId)
  const sessionId = resolved.engine === 'console-v1' ? resolved.sessionId : ''
  await finishActive(sessionId)
  return { draftId, sessionId }
}

/** A turn sent by the server-side setup (not by the page), observed to its end. */
async function say(sessionId: string, message: string, intent: Extract<BuildTurnInput, { kind: 'conversation' }>['intent'] = 'auto') {
  const session = await api.get(sessionId)
  await api.createTurn(sessionId, { kind: 'conversation', message, intent, baseSpecRevision: session.specification.revision }, { key: mintIdempotencyKey(), version: session.version })
  await finishActive(sessionId)
}

interface Page { container: HTMLDivElement; client: QueryClient }

async function open(draftId: string): Promise<Page> {
  const client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false } } })
  const gateway = createTestGateway({ consoleFetch: (path, init) => mock.fetch(path, init) })
  const [me, groups] = await Promise.all([gateway.console(meContract, undefined), gateway.console(groupsContract, undefined)])
  client.setQueryData(consoleKeys.me, me)
  client.setQueryData(consoleKeys.groups, groups)
  const rootRoute = createRootRoute({ component: () => <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> })
  const buildRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/-/build/$draftId',
    loader: ({ params }) => loadBuildRoute(client, params.draftId),
    component: function BuildRoute() {
      return <BuildRouteView draftId={buildRoute.useParams().draftId} loaded={buildRoute.useLoaderData()} />
    },
  })
  const router = createRouter({ routeTree: rootRoute.addChildren([buildRoute]), history: createMemoryHistory({ initialEntries: [`/-/build/${draftId}`] }) })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container, client })
  await act(async () => { root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>) })
  await settle()
  return { container, client }
}

/** What the server did meanwhile reaches the page the way a poll would: a re-read of the session and its turns. */
async function reread(page: Page) {
  await act(async () => { await page.client.invalidateQueries({ queryKey: buildSessionKeys.all }) })
  await settle()
}

const log = (page: Page) => page.container.querySelector('[role="log"]')!
const specPane = (page: Page) => page.container.querySelector('#build-artifact')!
const turnsIn = (page: Page) => [...page.container.querySelectorAll('[data-testid="console-turn"]')]
const buttons = (scope: Element, name: string) => [...scope.querySelectorAll('button')].filter((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
function button(scope: Element, name: string): HTMLButtonElement {
  const found = buttons(scope, name)[0]
  if (!found) throw new Error(`no button ${name}`)
  return found
}
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
  field.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
}
const notices = (page: Page) => [...page.container.querySelectorAll('[data-testid="build-session"] > div:not([role="tablist"]) [role="status"], [data-testid="build-session"] > div:not([role="tablist"]) [role="alert"]')]
const posts = (sessionId: string, tail: string) => mock.requests.filter((item) => item.method === 'POST' && item.path === `${BASE}/${sessionId}${tail}`)
const turnPath = (sessionId: string) => new RegExp(`^${BASE}/${sessionId}/turns/[^/]+$`)

describe('the typed reply', () => {
  test('every turn shows its own answer block, the opening one included (APT-752)', async () => {
    const { draftId, sessionId } = await startSession()
    await say(sessionId, 'Rust で作れますか？', 'question')
    await say(sessionId, 'おすすめの名前の候補を出して')
    await say(sessionId, 'ほかの名前にしたい')
    const page = await open(draftId)
    const turns = turnsIn(page)
    expect(turns).toHaveLength(4)
    expect(turns.map((turn) => turn.querySelectorAll('[data-testid="reply-answer"]').length)).toEqual([1, 1, 1, 1])
    expect(turns.map((turn) => turn.querySelector('[data-testid="reply-answer"]')!.textContent)).toEqual([
      'ご質問の点を確認しました。', 'ご質問の点を確認しました。', '候補を二つ挙げます。', 'いまの名前は変えずに、別の名前を一緒に考えましょう。',
    ])
  })

  test('candidates are concrete and selectable on the newest reply only; choosing one asks for a change, never a plan', async () => {
    const { draftId, sessionId } = await startSession()
    await say(sessionId, 'おすすめの名前の候補を出して')
    const page = await open(draftId)
    const candidates = turnsIn(page).at(-1)!.querySelector('[data-testid="reply-candidates"]')!
    const choices = [...candidates.querySelectorAll('button')]
    expect(choices.map((item) => [item.children[0]!.textContent, item.children[1]!.textContent])).toEqual([['申請ノート', '申請を記録して承認まで追えます'], ['申請ボード', '申請の状況を一覧で見られます']])
    expect(choices.every((item) => !item.disabled)).toBe(true)
    await act(async () => { choices[0]!.click(); choices[1]!.click() })
    await settle()
    const sent = await api.allTurns(sessionId)
    expect(sent.at(-1)).toMatchObject({ kind: 'conversation', request: { kind: 'conversation', message: c.candidateMessage('申請ノート'), intent: 'change' } })
    // The setup's turn, then the page's one choice.
    expect(posts(sessionId, '/turns').map((item) => item.status)).toEqual([202, 202])
    // Once a newer turn exists the older candidates are listed, not offered.
    await finishActive(sessionId)
    await reread(page)
    const older = turnsIn(page).at(-2)!.querySelector('[data-testid="reply-candidates"]')!
    expect(older.querySelectorAll('button')).toHaveLength(0)
    expect(older.textContent).toContain('申請ノート')
  })

  test('open decisions are shown as unresolved in the conversation and never in the specification', async () => {
    const { draftId, sessionId } = await startSession()
    await say(sessionId, 'ほかの名前にしたい')
    const page = await open(draftId)
    const open_ = turnsIn(page).at(-1)!.querySelector('[data-testid="reply-open-decisions"]')!
    expect(open_.textContent).toContain(c.openDecisions)
    expect(open_.textContent).toContain('ほかの名前にしたい')
    expect(specPane(page).textContent).not.toContain('ほかの名前にしたい')
    expect(specPane(page).textContent).not.toContain(c.openDecisions)
  })

  test('reply chips answer the newest question and send its message as a conversation turn', async () => {
    const { draftId, sessionId } = await startSession()
    const page = await open(draftId)
    const chips = page.container.querySelector(`[role="group"][aria-label="${text.composer.suggestions}"]`)!
    await act(async () => { button(chips, '特にない').click() })
    await settle()
    expect((await api.allTurns(sessionId)).at(-1)).toMatchObject({ request: { message: '特にありません', intent: 'auto' } })
  })

  test('reply text is rendered as text: markup from the model is not interpreted', async () => {
    const { draftId, sessionId } = await startSession()
    await say(sessionId, 'Rust で作れますか？')
    const markup = '<img src=x onerror="alert(1)"><a href="javascript:alert(1)">開く</a>'
    mock.rewrites.push({ method: 'GET', path: new RegExp(`^${BASE}/${sessionId}/turns(\\?|$)`), once: false, body: (wire) => ({ ...wire, items: (wire.items as Record<string, Record<string, unknown>>[]).map((turn) => turn.reply ? { ...turn, reply: { ...turn.reply, answer: markup } } : turn) }) })
    const page = await open(draftId)
    expect(page.container.querySelector('[data-testid="reply-answer"]')!.textContent).toBe(markup)
    expect(log(page).querySelector('img, a[href^="javascript"]')).toBeNull()
  })
})

describe('the spec change confirmation', () => {
  test('the confirmed revision stays until 反映する, then the accepted proposal becomes the next revision', async () => {
    const { draftId, sessionId } = await startSession()
    await say(sessionId, '承認を二段階にして')
    const page = await open(draftId)
    const proposal = turnsIn(page).at(-1)!.querySelector('[data-testid="reply-proposal"]')!
    expect(proposal.textContent).toContain('依頼の内容を仕様に加えます')
    expect(proposal.textContent).toContain('承認を二段階にして')
    expect(page.container.querySelector('[data-testid="spec-revision"]')!.textContent).toBe(c.spec.revision(0))
    expect(specPane(page).textContent).not.toContain('承認を二段階にして')
    expect(specPane(page).textContent).toContain(c.spec.pending)

    const accept = button(proposal, c.proposal.accept)
    await act(async () => { accept.click(); accept.click() })
    await settle()
    expect(mock.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/resolution'))).toHaveLength(1)
    expect(page.container.querySelector('[data-testid="spec-revision"]')!.textContent).toBe(c.spec.revision(1))
    expect(specPane(page).querySelector('[data-testid="build-spec"]')!.textContent).toContain('承認を二段階にして')
    expect(specPane(page).textContent).not.toContain(c.spec.pending)
    expect(turnsIn(page).at(-1)!.textContent).toContain(c.proposal.accepted)
    expect(buttons(page.container, c.proposal.accept)).toHaveLength(0)
  })

  test('反映しない keeps the revision and the specification', async () => {
    const { draftId, sessionId } = await startSession()
    await say(sessionId, '承認を二段階にして')
    const page = await open(draftId)
    await act(async () => { button(page.container, c.proposal.keep).click() })
    await settle()
    expect((await api.get(sessionId)).specification.revision).toBe(0)
    expect(page.container.querySelector('[data-testid="spec-revision"]')!.textContent).toBe(c.spec.revision(0))
    expect(specPane(page).textContent).not.toContain('承認を二段階にして')
    expect(turnsIn(page).at(-1)!.textContent).toContain(c.proposal.kept)
  })
})

describe('progress', () => {
  test('says what is awaited and when it was last observed; activity is only what the server sent', async () => {
    const { draftId, sessionId } = await startSession()
    const session = await api.get(sessionId)
    await api.createTurn(sessionId, { kind: 'conversation', message: 'Rust で作れますか？', intent: 'question', baseSpecRevision: 0 }, { key: mintIdempotencyKey(), version: session.version })
    mock.rewrites.push({ method: 'GET', path: turnPath(sessionId), once: false, body: (wire) => ({ ...wire, state: 'running', nextAction: 'observe', progress: { stage: 'queued', observedAt: new Date().toISOString(), activity: [] } }) })
    const page = await open(draftId)
    const progress = page.container.querySelector('[data-testid="console-progress"]')!
    expect(progress.getAttribute('data-waiting')).toBe('queued')
    expect(progress.textContent).toContain(c.progress.waiting.queued)
    expect(progress.textContent).toContain(c.progress.observed(''))
    expect(progress.querySelectorAll('li')).toHaveLength(0)
    expect(progress.textContent).not.toContain(c.progress.slow)

    mock.rewrites.splice(0)
    mock.rewrites.push({ method: 'GET', path: turnPath(sessionId), once: false, body: (wire) => ({ ...wire, state: 'running', nextAction: 'observe', progress: { stage: 'thinking', observedAt: new Date().toISOString(), activity: ['入力を確認しています'] } }) })
    await reread(page)
    const thinking = page.container.querySelector('[data-testid="console-progress"]')!
    expect([...thinking.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['入力を確認しています'])
  })

  test('no new observation for a minute reads as slow, never as failed', async () => {
    const { draftId, sessionId } = await startSession()
    const session = await api.get(sessionId)
    await api.createTurn(sessionId, { kind: 'conversation', message: 'Rust で作れますか？', intent: 'question', baseSpecRevision: 0 }, { key: mintIdempotencyKey(), version: session.version })
    const old = new Date(Date.now() - 5 * 60_000).toISOString()
    mock.rewrites.push({ method: 'GET', path: turnPath(sessionId), once: false, body: (wire) => ({ ...wire, state: 'running', nextAction: 'observe', progress: { stage: 'thinking', observedAt: old, activity: [] } }) })
    const page = await open(draftId)
    const progress = page.container.querySelector('[data-testid="console-progress"]')!
    expect(progress.getAttribute('data-slow')).toBe('true')
    expect(progress.textContent).toContain(c.progress.slow)
    expect(page.container.querySelector('[role="alert"]')).toBeNull()
  })

  test('the one repair in progress and an exhausted repair are distinct; an exhausted one offers to send the words again', async () => {
    const { draftId, sessionId } = await startSession()
    const session = await api.get(sessionId)
    await api.createTurn(sessionId, { kind: 'conversation', message: 'Rust で作れますか？', intent: 'question', baseSpecRevision: 0 }, { key: mintIdempotencyKey(), version: session.version })
    mock.rewrites.push({ method: 'GET', path: turnPath(sessionId), once: false, body: (wire) => ({ ...wire, state: 'dispatching', attempt: 1, nextAction: 'observe', progress: { stage: 'repairing', observedAt: new Date().toISOString(), activity: [] } }) })
    const page = await open(draftId)
    expect(page.container.querySelector('[data-testid="console-progress"]')!.getAttribute('data-waiting')).toBe('repairing')
    expect(log(page).textContent).toContain(c.progress.repairingHint)
    expect(log(page).textContent).not.toContain(c.failure.repair_exhausted.title)

    // The server ends the turn: still invalid after the repair. The session is idle again.
    mock.rewrites.splice(0)
    const failed = (wire: Record<string, unknown>) => ({ ...wire, state: 'failed', attempt: 1, nextAction: 'none', failure: { error: 'reply_invalid', message: 'reply is still invalid' } })
    mock.rewrites.push({ method: 'GET', path: new RegExp(`^${BASE}/${sessionId}/turns(\\?|$)`), once: false, body: (wire) => ({ ...wire, items: (wire.items as Record<string, unknown>[]).map((turn, index, all) => index === all.length - 1 ? failed(turn) : turn) }) })
    mock.rewrites.push({ method: 'GET', path: turnPath(sessionId), once: false, body: failed })
    mock.rewrites.push({ method: 'GET', path: new RegExp(`^${BASE}/${sessionId}$`), once: false, body: (wire) => { const { activeTurnId: _active, ...rest } = wire; return { ...rest, nextAction: 'none', capabilities: { canConverse: true, canRequestPlan: true } } } })
    await reread(page)
    expect(page.container.querySelector('[data-testid="console-progress"]')).toBeNull()
    expect(log(page).textContent).toContain(c.failure.repair_exhausted.title)
    expect(log(page).textContent).not.toContain(c.progress.repairingHint)
    mock.rewrites.splice(0)
    // The mock still holds the turn as running; let it end so the session accepts a new turn.
    await finishActive(sessionId)
    await reread(page)
  })
})

/** A session with a plan (and optionally a spec change accepted after it), created on its Platform draft by another client. */
async function createdSession(options: { before?: (sessionId: string) => Promise<void>; staleAfterPlan?: boolean } = {}) {
  const { draftId, sessionId } = await startSession()
  await options.before?.(sessionId)
  await createSessionApp(api, mock, sessionId, options)
  return { draftId, sessionId }
}

describe('publish name and audience (asked after creation, design §12)', () => {
  test('are not asked while specifying or with a plan; the server refuses them before creation (412 failed_precondition)', async () => {
    const { draftId, sessionId } = await startSession()
    const page = await open(draftId)
    expect(page.container.querySelector('#console-publish-name')).toBeNull()
    let session = await api.get(sessionId)
    await expect(api.setPublishPreferences(sessionId, { name: '点検ノート', shareScope: 'private' }, { key: mintIdempotencyKey(), version: session.version }))
      .rejects.toMatchObject({ status: 412, code: 'failed_precondition' })
    await api.createTurn(sessionId, { kind: 'request_plan', specRevision: 0 }, { key: mintIdempotencyKey(), version: session.version })
    await finishActive(sessionId)
    session = await api.get(sessionId)
    await expect(api.setPublishPreferences(sessionId, { name: '点検ノート', shareScope: 'private' }, { key: mintIdempotencyKey(), version: session.version }))
      .rejects.toMatchObject({ status: 412, code: 'failed_precondition' })
    await reread(page)
    await settle(20)
    expect(page.container.querySelector('[data-testid="build-proposal"]')).not.toBeNull()
    expect(page.container.querySelector('#console-publish-name')).toBeNull()
  })

  test('a created session asks for them empty (never from the spec name or a candidate), saves exactly the typed values, and a reload brings them back', async () => {
    const { draftId, sessionId } = await createdSession({ before: (id) => say(id, 'おすすめの名前の候補を出して') })
    const page = await open(draftId)
    await settle(30)
    const form = page.container.querySelector('[data-testid="console-publish"]')!
    const name = form.querySelector<HTMLInputElement>('#console-publish-name')!
    const save = button(form, c.publish.save)
    expect(name.value).toBe('')
    expect(form.querySelector('[role="radio"][aria-checked="true"]')).toBeNull()
    expect(form.querySelector('[data-testid="console-publish-required"]')!.textContent).toBe(c.publish.required)
    expect(save.disabled).toBe(true)

    await act(async () => { type(name, 'あ'.repeat(41)) })
    expect(form.textContent).toContain(c.publish.nameTooLong)
    await act(async () => { type(name, '  点検ノート  ') })
    await act(async () => { form.querySelector<HTMLButtonElement>('#console-publish-scope-group')!.click() })
    expect(save.disabled).toBe(false)
    const advances = posts(sessionId, '/advance').length
    const patches: unknown[] = []
    const fetch = mock.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH' && String(input).endsWith('/publish-preferences')) patches.push(JSON.parse(String(init.body)))
      return fetch(input, init)
    }) as typeof globalThis.fetch
    await act(async () => { save.click(); save.click() })
    await settle(30)
    expect(patches).toEqual([{ name: '点検ノート', shareScope: 'group' }])
    // The server commits first and writes the draft on the advance the session asks for.
    expect(posts(sessionId, '/advance')).toHaveLength(advances + 1)
    expect((await api.get(sessionId)).publish).toEqual({ desired: { name: '点検ノート', shareScope: 'group' }, sync: { state: { kind: 'known', value: 'applied' } } })
    const saved = form.querySelector('[data-testid="console-publish-saved"]')!.textContent
    expect(saved).toContain(c.publish.saved('点検ノート'))
    expect(saved).toContain(c.publish.sync.applied)
    expect(form.querySelector('[data-testid="console-publish-required"]')).toBeNull()

    const reloaded = await open(draftId)
    await settle(30)
    const again = reloaded.container.querySelector('[data-testid="console-publish"]')!
    expect(again.querySelector<HTMLInputElement>('#console-publish-name')!.value).toBe('点検ノート')
    expect(again.querySelector('[role="radio"][aria-checked="true"]')!.id).toBe('console-publish-scope-group')
    expect(again.querySelector('[data-testid="console-publish-saved"]')!.textContent).toContain(c.publish.sync.applied)
  })

  test('an app created from an earlier specification than the last confirmed one says so once', async () => {
    const { draftId } = await createdSession({ staleAfterPlan: true })
    const page = await open(draftId)
    await settle(30)
    const titles = [...page.container.querySelectorAll('[data-testid="build-session"] > div:not([role="tablist"]) *')].filter((item) => item.textContent === c.createdFromEarlier.title)
    expect(titles).toHaveLength(1)
    expect(page.container.textContent).toContain(c.createdFromEarlier.waiting)
    expect(buttons(page.container, c.plan.replan)).toHaveLength(0)
  })
})

describe('the plan', () => {
  test('comes from the typed button only; a double click sends one request_plan; the hand-off is shown', async () => {
    const { draftId, sessionId } = await startSession()
    const page = await open(draftId)
    const plan = button(page.container.querySelector('header')!, buildCopy.questions.kickoffReply)
    await act(async () => { plan.click(); plan.click() })
    await settle()
    expect(posts(sessionId, '/turns')).toHaveLength(1)
    expect((await api.allTurns(sessionId)).map((turn) => turn.kind)).toEqual(['conversation', 'request_plan'])
    await finishActive(sessionId)
    await reread(page)
    const planTurn = page.container.querySelector('[data-testid="console-plan-turn"]')!
    expect(planTurn.textContent).toContain(c.plan.planned(0))
  })

  test('a current plan offers 「この内容で作る」, which starts the creation execution on the Platform draft; no Platform conversation turn is ever sent', async () => {
    const { draftId, sessionId } = await startSession()
    const session = await api.get(sessionId)
    await api.createTurn(sessionId, { kind: 'request_plan', specRevision: 0 }, { key: mintIdempotencyKey(), version: session.version })
    await finishActive(sessionId)
    expect((await api.get(sessionId)).plan).toEqual({ specRevision: 0, stale: false })
    const page = await open(draftId)
    const proposal = page.container.querySelector('[data-testid="build-proposal"]')!
    const create = button(proposal, buildCopy.primary.prepare)
    await settle(30)
    expect(create.disabled).toBe(false)
    expect(page.container.querySelector('[data-testid="console-plan-stale"]')).toBeNull()
    await act(async () => { create.click(); create.click() })
    await settle(40)
    expect(mock.requests.filter((item) => item.method === 'POST' && item.path.endsWith(`/application-drafts/${draftId}/creation-executions`))).toHaveLength(1)
    expect(mock.requests.filter((item) => item.method === 'POST' && /\/creation-executions\/[^/]+\/run$/.test(item.path))).toHaveLength(1)
    expect(mock.requests.filter((item) => item.path.includes('/conversation-turns'))).toEqual([])
    expect((await api.get(sessionId)).lifecycle).toEqual({ kind: 'known', value: 'created' })
  })

  test('a spec change accepted after planning makes the plan stale: no creation, re-planning offered', async () => {
    const { draftId, sessionId } = await startSession()
    let session = await api.get(sessionId)
    await api.createTurn(sessionId, { kind: 'request_plan', specRevision: 0 }, { key: mintIdempotencyKey(), version: session.version })
    await finishActive(sessionId)
    await say(sessionId, '承認を二段階にして')
    session = await api.get(sessionId)
    await api.resolveTurn(sessionId, session.activeTurnId!, { decision: 'accept_spec' }, { key: mintIdempotencyKey(), version: session.version })
    expect((await api.get(sessionId)).plan).toEqual({ specRevision: 0, stale: true })
    const page = await open(draftId)
    await settle(20)
    const proposal = page.container.querySelector('[data-testid="build-proposal"]')!
    expect(buttons(proposal, buildCopy.primary.prepare)).toHaveLength(0)
    const stale = proposal.querySelector('[data-testid="console-plan-stale"]')!
    expect(stale.textContent).toContain(c.plan.stale)
    await act(async () => { button(stale, c.plan.replan).click() })
    await settle()
    expect((await api.allTurns(sessionId)).at(-1)).toMatchObject({ kind: 'request_plan', specRevision: 1 })
  })

  test('the composer sends free text, typed 「この内容で提案して」 included, as a conversation turn; a second send while one is open sends nothing', async () => {
    const { draftId, sessionId } = await startSession()
    const page = await open(draftId)
    const field = page.container.querySelector<HTMLTextAreaElement>('#build-reply')!
    await act(async () => { type(field, buildCopy.questions.kickoffReply) })
    const send = button(page.container, text.composer.send)
    await act(async () => { send.click() })
    await act(async () => { type(field, buildCopy.questions.kickoffReply); send.click() })
    await settle()
    expect(posts(sessionId, '/turns')).toHaveLength(1)
    expect((await api.allTurns(sessionId)).map((turn) => turn.kind)).toEqual(['conversation', 'conversation'])
  })
})

describe('wire-boundary rules', () => {
  test('an unreadable 2xx on 反映する offers only 「最新の状態を確認する」; nothing else can be sent until the re-read', async () => {
    const { draftId, sessionId } = await startSession()
    await say(sessionId, '承認を二段階にして')
    const page = await open(draftId)
    mock.rewrites.push({ method: 'POST', path: /\/resolution$/, once: true, body: () => ({ unexpected: true }) })
    await act(async () => { button(page.container, c.proposal.accept).click() })
    await settle()
    const shown = notices(page)
    expect(shown.map((item) => item.querySelector('p')?.textContent)).toEqual([buildCopy.failure.unconfirmed.title])
    expect(shown[0]!.querySelectorAll('button')).toHaveLength(1)
    expect(buttons(page.container, c.proposal.accept).every((item) => item.disabled)).toBe(true)
    expect(page.container.querySelector<HTMLTextAreaElement>('#build-reply')!.disabled).toBe(true)
    expect(posts(sessionId, `/turns/${(await api.allTurns(sessionId)).at(-1)!.id}/resolution`)).toHaveLength(1)

    await act(async () => { button(shown[0]!, buildCopy.failure.confirm).click() })
    await settle()
    expect(notices(page)).toHaveLength(0)
    // The resolution happened on the server; the re-read shows it.
    expect(page.container.querySelector('[data-testid="spec-revision"]')!.textContent).toBe(c.spec.revision(1))
  })

  test('412 shows the newer state, sends nothing again, and can put the rejected message back in the composer', async () => {
    const { draftId, sessionId } = await startSession()
    const page = await open(draftId)
    // Another tab moved the session on first.
    await say(sessionId, 'Rust で作れますか？', 'question')
    const field = page.container.querySelector<HTMLTextAreaElement>('#build-reply')!
    await act(async () => { type(field, '承認を二段階にして') })
    await act(async () => { button(page.container, text.composer.send).click() })
    await settle()
    // The other tab's turn, then this page's: refused, not resent.
    expect(posts(sessionId, '/turns').map((item) => item.status)).toEqual([202, 412])
    const conflict = notices(page).find((item) => item.querySelector('p')?.textContent === c.conflict.title)!
    expect(conflict).toBeDefined()
    expect(turnsIn(page)).toHaveLength(2)
    expect(field.value).toBe('')
    await act(async () => { button(conflict, c.conflict.restore).click() })
    await settle()
    expect(field.value).toBe('承認を二段階にして')
    expect(notices(page).find((item) => item.querySelector('p')?.textContent === c.conflict.title)).toBeUndefined()
    expect(posts(sessionId, '/turns')).toHaveLength(2)
  })

  test('a refused write gets its typed copy, not the server text', async () => {
    const { draftId, sessionId } = await startSession()
    const page = await open(draftId)
    mock.rewrites.push({ method: 'POST', path: new RegExp(`^${BASE}/${sessionId}/turns$`), once: true, response: () => Response.json({ error: 'input_too_large', message: 'inputs exceed 262144 bytes' }, { status: 413, headers: { 'Cache-Control': 'no-store' } }) })
    await act(async () => { type(page.container.querySelector<HTMLTextAreaElement>('#build-reply')!, '長い説明'); button(page.container, text.composer.send).click() })
    await settle()
    expect(page.container.textContent).toContain(c.failure.too_large.title)
    expect(page.container.textContent).not.toContain('inputs exceed')
  })

  test('an unknown lifecycle: known parts stay, writes stop with the fixed explanation', async () => {
    const { draftId, sessionId } = await startSession()
    await say(sessionId, '承認を二段階にして')
    mock.rewrites.push({ method: 'GET', path: new RegExp(`^${BASE}/${sessionId}$`), once: false, body: (wire) => ({ ...wire, lifecycle: 'reviewing' }) })
    const page = await open(draftId)
    expect(page.container.textContent).toContain(buildCopy.unsupported.title)
    expect(turnsIn(page).at(-1)!.querySelector('[data-testid="reply-answer"]')!.textContent).toBe('仕様の変更案をまとめました。反映するか選んでください。')
    expect(page.container.querySelector<HTMLTextAreaElement>('#build-reply')!.disabled).toBe(true)
    expect(button(page.container.querySelector('header')!, buildCopy.questions.kickoffReply).disabled).toBe(true)
    expect(buttons(page.container, c.proposal.accept).every((item) => item.disabled)).toBe(true)
    // An unknown lifecycle is not `created`: the publish inputs are not offered at all.
    expect(page.container.querySelector('#console-publish-name')).toBeNull()
  })

  test('an unknown turn state shows its reply and offers none of its actions', async () => {
    const { draftId, sessionId } = await startSession()
    await say(sessionId, '承認を二段階にして')
    const unknownState = (turn: Record<string, unknown>) => turn.state === 'awaiting_confirmation' ? { ...turn, state: 'reviewing' } : turn
    mock.rewrites.push({ method: 'GET', path: new RegExp(`^${BASE}/${sessionId}/turns(\\?|$)`), once: false, body: (wire) => ({ ...wire, items: (wire.items as Record<string, unknown>[]).map(unknownState) }) })
    mock.rewrites.push({ method: 'GET', path: turnPath(sessionId), once: false, body: unknownState })
    const page = await open(draftId)
    const last = turnsIn(page).at(-1)!
    expect(last.querySelector('[data-testid="reply-answer"]')).not.toBeNull()
    expect(last.textContent).toContain(c.unknownTurn)
    expect(buttons(last, c.proposal.accept)).toHaveLength(0)
    expect(page.container.querySelector('[data-testid="spec-revision"]')!.textContent).toBe(c.spec.revision(0))
  })

  test('an unknown failure code shows generic copy and the re-read, never the raw server text', async () => {
    const { draftId, sessionId } = await startSession()
    const failedTurn = (turn: Record<string, unknown>) => ({ ...turn, state: 'failed', reply: undefined, failure: { error: 'quota_spent', message: 'raw upstream text' } })
    mock.rewrites.push({ method: 'GET', path: new RegExp(`^${BASE}/${sessionId}/turns(\\?|$)`), once: false, body: (wire) => ({ ...wire, items: (wire.items as Record<string, unknown>[]).map(failedTurn) }) })
    const page = await open(draftId)
    expect(log(page).textContent).toContain(c.failure.unknown.title)
    expect(log(page).textContent).not.toContain('raw upstream text')
    expect(buttons(log(page), buildCopy.failure.confirm)).toHaveLength(1)
  })
})
