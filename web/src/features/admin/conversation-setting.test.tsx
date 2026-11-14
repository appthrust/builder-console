// 新しい AI 会話 on 基盤の設定 (APT-753) over the real page, queries, gateway,
// transport and canonical contracts against the in-memory Console mock: each
// mode saves with `If-Match` and round-trips into `/config`, the allowlist is
// picked from the Directory, an unsaved choice saves on the version it started
// from: a 412 or a poll that reads a newer setting stops the choice and shows
// what replacing that setting would change (mode, who joins or leaves the
// list) until the user discards it or replaces exactly the setting shown,
// while a card without unsaved changes follows polls. An unreadable 2xx offers
// only the read-back, an unknown mode (also mid-edit) offers no save but keeps
// the unsaved-changes guard, and only Console administrators get the card.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider, type AnyRouter } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { consoleKeys, groupsQuery, meQuery } from '../../api/queries/console'
import { POLL_INTERVAL_MS, queryClient as appQueryClient } from '../../api/queries/shared'
import { createConsoleMockFetch, resetMocks, type ConsoleMockFetch } from '../../api/testing/console-mock-fetch'
import { copy } from '../../copy'
import { setLanguage } from '../../shell/language'
import { UnsavedChangesProvider } from '../../ui/use-unsaved-changes-guard'
import { preserveLanguage } from '../../../test/language'
import { text as appText } from '../app/copy'
import { text } from './copy'
import { AdminPlatformPage } from './platform-page'

const SECRET = 'SENTINEL-conversation-setting-7d1e'
const SETTING = /^\/api\/console\/admin\/conversation$/
const words = text.conversation

let mock: ConsoleMockFetch
let client: QueryClient
let root: Root | undefined
let router: AnyRouter
let container: HTMLDivElement
const restore: (() => void)[] = []
const originalFetch = globalThis.fetch

beforeEach(async () => {
  restore.push(preserveLanguage())
  setLanguage('ja')
  await resetMocks()
  mock = createConsoleMockFetch()
  globalThis.fetch = mock.fetch as typeof globalThis.fetch
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restore.push(() => warn.mockRestore())
  // Radix RadioGroup checks `closest('form') instanceof HTMLFormElement`; the shared DOM preload does not expose it.
  const form = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement')
  Object.defineProperty(globalThis, 'HTMLFormElement', { configurable: true, value: window.HTMLFormElement })
  restore.push(() => form ? Object.defineProperty(globalThis, 'HTMLFormElement', form) : Reflect.deleteProperty(globalThis, 'HTMLFormElement'))
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  for (const node of [...document.body.childNodes]) node.remove()
  client?.clear()
  // The SPA never sends the setting without its precondition.
  expect(mock.requests.filter((item) => item.status === 428)).toEqual([])
  globalThis.fetch = originalFetch
  for (const undo of restore.splice(0).reverse()) undo()
})

async function settle(rounds = 12) {
  for (let tick = 0; tick < rounds; tick++) await act(async () => { await Bun.sleep(5) })
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return mock.fetch(path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
}

/** Another signed-in person (a mock caller switch), e.g. a second administrator. */
async function signIn(personId: string, role: 'Admin' | 'Editor' | 'Viewer') {
  expect((await call('POST', '/api/console/__mock/caller', { personId, role })).status).toBe(200)
}

async function stored() {
  const response = await call('GET', '/api/console/admin/conversation')
  return { etag: response.headers.get('ETag'), body: await response.json() as { mode: string; version: number; allowlist: { subject: string; displayName?: string }[] } }
}

/** What the dev `/config` reports for the current caller. */
async function config(): Promise<boolean> {
  return ((await (await call('GET', '/api/console/__mock/config')).json()) as { newAppConversation: boolean }).newAppConversation
}

/** 基盤の設定 on the app's query defaults, as the signed-in caller; the app's polling only when asked for. */
async function renderPage({ polling = false } = {}) {
  await act(async () => { root?.unmount() })
  container?.remove()
  client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, ...(polling ? {} : { refetchInterval: false }), refetchOnWindowFocus: false } } })
  await Promise.all([client.fetchQuery(meQuery), client.fetchQuery(groupsQuery)])
  const rootRoute = createRootRoute()
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/-/admin/platform', component: () => null })
  // Another app page, to leave 基盤の設定 for (the unsaved-changes guard).
  const mine = createRoute({ getParentRoute: () => rootRoute, path: '/mine', component: () => null })
  router = createRouter({ routeTree: rootRoute.addChildren([page, mine]), history: createMemoryHistory({ initialEntries: ['/-/admin/platform'] }) })
  await router.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider><AdminPlatformPage /></UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>)
  })
  await settle()
}

const card = () => container.querySelector<HTMLElement>('[data-testid="conversation-setting"]')
const radio = (mode: string) => card()!.querySelector<HTMLButtonElement>(`#conversation-mode-${mode}`)!
const form = () => card()!.querySelector('form')!
const saveButton = () => [...card()!.querySelectorAll('button')].find((item) => item.textContent?.trim() === copy.app.settings.save)
const people = () => [...card()!.querySelectorAll('[data-testid="conversation-person-label"]')].map((row) => row.textContent)
const puts = () => mock.requests.filter((item) => item.method === 'PUT' && SETTING.test(item.path))

function button(name: string, scope: ParentNode = card()!): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
  if (!found) throw new Error(`no button ${name}`)
  return found
}

async function click(target: HTMLElement) {
  await act(async () => { target.click() })
  await settle()
}

async function save() {
  await act(async () => { form().requestSubmit() })
  await settle()
}

function type(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
  field.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
}

/** Adds a person through the Directory search, as a user does. */
async function addPerson(query: string, name: string) {
  const search = card()!.querySelector<HTMLInputElement>('#conversation-person-search')!
  await act(async () => { type(search, query) })
  await settle()
  await click(button(appText.settings.personAction(name, words.add)))
}

describe('each mode saves with If-Match from the last read and round-trips', () => {
  test('全員, then 一部の人だけ with a person, then 使わない: stored, shown after a reload, and what /config answers', async () => {
    await renderPage()
    expect(radio('off').getAttribute('aria-checked')).toBe('true')
    expect(card()!.querySelector('[data-testid="conversation-updated"]')!.textContent).toBe(words.neverUpdated)
    expect(await config()).toBe(false)

    await click(radio('on'))
    await save()
    await click(radio('allowlist'))
    await addPerson('佐藤', '佐藤 花子')
    await save()
    expect(people()).toEqual(['佐藤 花子sato@example.com'])
    // Only the listed people get the conversation: 佐藤 does, the signed-in 山田 does not.
    expect(await config()).toBe(false)
    await signIn('p-sato', 'Editor')
    expect(await config()).toBe(true)
    await signIn('p-yamada', 'Admin')

    await renderPage()
    expect(radio('allowlist').getAttribute('aria-checked')).toBe('true')
    expect(people()).toEqual(['佐藤 花子'])
    expect(card()!.querySelector('[data-testid="conversation-updated"]')!.textContent).toBe(words.updated('山田 太郎', copy.relative.justNow))
    await click(radio('off'))
    await save()

    expect(puts().map((item) => [item.status, item.ifMatch])).toEqual([[200, '"cs-0"'], [200, '"cs-1"'], [200, '"cs-2"']])
    const final = await stored()
    // 使わない keeps the list (ignored while off), so choosing 一部の人だけ again brings it back.
    expect(final.body).toMatchObject({ mode: 'off', version: 3, allowlist: [{ subject: 'sub-sato', displayName: '佐藤 花子' }] })
    expect(final.etag).toBe('"cs-3"')
    expect(radio('off').getAttribute('aria-checked')).toBe('true')
    expect(card()!.textContent).toContain(copy.app.settings.saved)
    expect(await config()).toBe(false)
  })

  test('全員 turns /config on for everyone', async () => {
    await renderPage()
    await click(radio('on'))
    await save()
    expect(await config()).toBe(true)
    await signIn('p-tanaka', 'Viewer')
    expect(await config()).toBe(true)
  })
})

describe('the allowlist', () => {
  test('a person is added from the Directory search and removed again; nothing is sent until 保存', async () => {
    await renderPage()
    await click(radio('allowlist'))
    expect(card()!.textContent).toContain(words.empty)
    await addPerson('佐藤', '佐藤 花子')
    await addPerson('鈴木', '鈴木 一郎')
    expect(people()).toEqual(['佐藤 花子sato@example.com', '鈴木 一郎suzuki@example.com'])
    // An added person is marked in the search instead of offered again.
    const search = card()!.querySelector<HTMLInputElement>('#conversation-person-search')!
    await act(async () => { type(search, '佐藤') })
    await settle()
    expect(card()!.textContent).toContain(words.added)
    await click(button(words.removeLabel('佐藤 花子')))
    expect(people()).toEqual(['鈴木 一郎suzuki@example.com'])
    expect(puts()).toEqual([])
    await save()
    expect((await stored()).body.allowlist).toEqual([{ subject: 'sub-suzuki', displayName: '鈴木 一郎' }])
  })

  test('someone who never signed in cannot be chosen (the setting lists sign-in subjects)', async () => {
    await renderPage()
    await click(radio('allowlist'))
    await addPerson('高橋', '高橋 健')
    expect(people()).toEqual([])
    expect(card()!.textContent).toContain(words.notSignedIn('高橋 健'))
  })

  test('at 200 people the search is closed with the fixed message; a subject the Directory does not know is 不明な利用者 and removable', async () => {
    const subjects = ['sub-gone', ...Array.from({ length: 199 }, (_, index) => `sub-extra-${index}`)]
    expect((await call('PUT', '/api/console/admin/conversation', { mode: 'allowlist', allowlist: subjects.map((subject) => ({ subject })) }, { 'If-Match': '"cs-0"' })).status).toBe(200)
    await renderPage()
    expect(people()).toHaveLength(200)
    expect(people()[0]).toBe(copy.common.unknownPerson)
    expect(card()!.querySelector<HTMLInputElement>('#conversation-person-search')!.disabled).toBe(true)
    expect(card()!.textContent).toContain(words.limit(200))
    await click(button(words.removeLabel(copy.common.unknownPerson)))
    expect(people()).toHaveLength(199)
    expect(card()!.querySelector<HTMLInputElement>('#conversation-person-search')!.disabled).toBe(false)
    expect(card()!.textContent).not.toContain(words.limit(200))
  })
})

const conflictNotice = () => [...card()!.querySelectorAll('[role="status"]')].find((item) => item.textContent?.includes(words.conflictTitle))
/** One line of the notice's difference: `mode`, `added` (joins the list by continuing) or `removed` (leaves it). */
const diff = (kind: 'mode' | 'added' | 'removed') => card()!.querySelector(`[data-testid="conversation-conflict-${kind}"]`)?.textContent ?? null
/** Another administrator's save, as another client would make it. */
async function foreignSave(personId: string, version: number, subjects: string[], mode = 'allowlist') {
  await signIn(personId, 'Admin')
  expect((await call('PUT', '/api/console/admin/conversation', { mode, allowlist: subjects.map((subject) => ({ subject })) }, { 'If-Match': `"cs-${version}"` })).status).toBe(200)
  await signIn('p-yamada', 'Admin')
}

test('412: the newer setting is read back and named, the unsaved choice stays for comparison, and nothing is resent', async () => {
  await renderPage()
  await click(radio('on'))
  // Another administrator saves first.
  await signIn('p-sato', 'Admin')
  expect((await call('PUT', '/api/console/admin/conversation', { mode: 'allowlist', allowlist: [{ subject: 'sub-suzuki' }] }, { 'If-Match': '"cs-0"' })).status).toBe(200)
  await signIn('p-yamada', 'Admin')
  const before = puts().length
  const mine = () => puts().slice(before)

  await save()
  expect(mine().map((item) => item.status)).toEqual([412])
  expect(conflictNotice()!.textContent).toContain(words.conflictBody(words.summaryWithPeople(words.modes.allowlist.title, 1)))
  // What continuing would replace: 全員 instead of their 一部の人だけ, and 鈴木 leaves the list.
  expect(diff('mode')).toBe(words.diffMode(words.modes.allowlist.title, words.modes.on.title))
  expect(diff('removed')).toBe(`${words.diffRemoved(1)} 鈴木 一郎`)
  expect(diff('added')).toBeNull()
  expect(radio('on').getAttribute('aria-checked')).toBe('true')
  expect(card()!.querySelector('[data-testid="conversation-updated"]')!.textContent).toBe(words.updated('佐藤 花子', copy.relative.justNow))
  // The choice was started on the older version: saving it is locked until the user decides.
  expect(saveButton()!.disabled).toBe(true)
  await save()
  expect(mine()).toHaveLength(1)

  // Keeping the choice is the user's decision; it is saved on the version just read.
  await click(button(words.keep))
  expect(conflictNotice()).toBeUndefined()
  await save()
  expect(mine().map((item) => [item.status, item.ifMatch])).toEqual([[412, '"cs-0"'], [200, '"cs-1"']])
  expect((await stored()).body.mode).toBe('on')
})

describe('with the app\'s polling on', () => {
  const reads = () => mock.requests.filter((item) => item.method === 'GET' && SETTING.test(item.path)).length
  /** Waits for the card's own poll (the app's refetchInterval) to read the setting again. */
  async function nextPoll() {
    const before = reads()
    for (let waited = 0; reads() === before; waited += 100) {
      if (waited > POLL_INTERVAL_MS * 2) throw new Error('the setting was not polled')
      await act(async () => { await Bun.sleep(100) })
    }
    await settle()
  }

  test('another administrator\'s save read by a poll stops the older unsaved choice at once; keeping it saves on the new version', async () => {
    expect((await call('PUT', '/api/console/admin/conversation', { mode: 'allowlist', allowlist: [{ subject: 'sub-sato' }, { subject: 'sub-suzuki' }] }, { 'If-Match': '"cs-0"' })).status).toBe(200)
    await renderPage({ polling: true })
    // 山田 starts from version 1 and takes 佐藤 off the list.
    await click(button(words.removeLabel('佐藤 花子')))
    expect(people()).toEqual(['鈴木 一郎'])
    // Meanwhile 佐藤 (also an administrator) takes 鈴木 off: version 2.
    await signIn('p-sato', 'Admin')
    expect((await call('PUT', '/api/console/admin/conversation', { mode: 'allowlist', allowlist: [{ subject: 'sub-sato' }] }, { 'If-Match': '"cs-1"' })).status).toBe(200)
    await signIn('p-yamada', 'Admin')

    await nextPoll()
    // Before any save: the newer setting is named, 山田's choice stays, and nothing can be saved or edited on it.
    expect(conflictNotice()!.textContent).toContain(words.conflictBody(words.summaryWithPeople(words.modes.allowlist.title, 1)))
    // Continuing would bring back 鈴木, whom 佐藤 just took off, and take 佐藤 off.
    expect(diff('added')).toBe(`${words.diffAdded(1)} 鈴木 一郎`)
    expect(diff('removed')).toBe(`${words.diffRemoved(1)} 佐藤 花子`)
    expect(diff('mode')).toBeNull()
    expect(card()!.querySelector('[data-testid="conversation-updated"]')!.textContent).toBe(words.updated('佐藤 花子', copy.relative.justNow))
    expect(people()).toEqual(['鈴木 一郎'])
    expect(saveButton()!.disabled).toBe(true)
    expect(radio('on').disabled).toBe(true)
    await save()
    expect(puts().map((item) => item.ifMatch)).toEqual(['"cs-0"', '"cs-1"'])
    // Further polls keep the choice and the notice; they never move its base.
    await nextPoll()
    expect(conflictNotice()).toBeDefined()
    expect(people()).toEqual(['鈴木 一郎'])

    await click(button(words.keep))
    expect(conflictNotice()).toBeUndefined()
    expect(saveButton()!.disabled).toBe(false)
    await save()
    expect(puts().slice(2).map((item) => [item.status, item.ifMatch])).toEqual([[200, '"cs-2"']])
    expect((await stored()).body).toMatchObject({ version: 3, allowlist: [{ subject: 'sub-suzuki' }] })
  }, 30_000)

  test('two more saves while the notice is up update it, 置き換えて続ける adopts the setting it shows, and a save after that stops it again', async () => {
    await foreignSave('p-yamada', 0, ['sub-sato', 'sub-suzuki'])
    await renderPage({ polling: true })
    await click(button(words.removeLabel('佐藤 花子')))
    await foreignSave('p-sato', 1, ['sub-sato'])
    await nextPoll()
    expect(diff('removed')).toBe(`${words.diffRemoved(1)} 佐藤 花子`)

    // Two consecutive saves (佐藤 adds 田中, then 田中 leaves only herself) before the next poll.
    await foreignSave('p-sato', 2, ['sub-sato', 'sub-tanaka'])
    await foreignSave('p-tanaka', 3, ['sub-tanaka'])
    await nextPoll()
    expect(conflictNotice()!.textContent).toContain(words.conflictBody(words.summaryWithPeople(words.modes.allowlist.title, 1)))
    expect(diff('added')).toBe(`${words.diffAdded(1)} 鈴木 一郎`)
    expect(diff('removed')).toBe(`${words.diffRemoved(1)} 田中 美咲`)
    expect(saveButton()!.disabled).toBe(true)

    // Continuing adopts version 4, the one on screen.
    await click(button(words.keep))
    // Another save lands after 置き換えて続ける and before 保存; the next poll stops the choice again.
    await foreignSave('p-sato', 4, ['sub-sato'])
    await nextPoll()
    expect(diff('removed')).toBe(`${words.diffRemoved(1)} 佐藤 花子`)
    expect(saveButton()!.disabled).toBe(true)
    await save()
    // 保存 sent nothing while stopped: only the five other saves.
    expect(puts().map((item) => item.ifMatch)).toEqual(['"cs-0"', '"cs-1"', '"cs-2"', '"cs-3"', '"cs-4"'])

    await click(button(words.keep))
    await save()
    expect(puts().slice(5).map((item) => [item.status, item.ifMatch])).toEqual([[200, '"cs-5"']])
    expect((await stored()).body).toMatchObject({ version: 6, allowlist: [{ subject: 'sub-suzuki' }] })
  }, 45_000)

  test('a card without unsaved changes follows the poll, even after a change that was undone; the next save uses the version it shows', async () => {
    await renderPage({ polling: true })
    await click(radio('on'))
    await click(radio('off'))
    await signIn('p-sato', 'Admin')
    expect((await call('PUT', '/api/console/admin/conversation', { mode: 'allowlist', allowlist: [{ subject: 'sub-suzuki' }] }, { 'If-Match': '"cs-0"' })).status).toBe(200)
    await signIn('p-yamada', 'Admin')

    await nextPoll()
    expect(conflictNotice()).toBeUndefined()
    expect(radio('allowlist').getAttribute('aria-checked')).toBe('true')
    expect(people()).toEqual(['鈴木 一郎'])
    expect(saveButton()!.disabled).toBe(true)
    await click(radio('on'))
    await save()
    expect(puts().slice(1).map((item) => [item.status, item.ifMatch])).toEqual([[200, '"cs-1"']])
  }, 30_000)
})

test('a save that lands after the notice is drawn and before 置き換えて続ける is not adopted: the shown version is, so the save is refused and the notice shows the newer setting', async () => {
  await foreignSave('p-yamada', 0, ['sub-sato', 'sub-suzuki'])
  await renderPage()
  await click(button(words.removeLabel('佐藤 花子')))
  await foreignSave('p-sato', 1, ['sub-sato'])
  await save()
  expect(diff('removed')).toBe(`${words.diffRemoved(1)} 佐藤 花子`)
  // 田中 saves while the notice for version 2 is on screen; nothing has read it yet.
  await foreignSave('p-tanaka', 2, ['sub-sato', 'sub-tanaka'])
  await click(button(words.keep))
  await save()
  // 山田's refused save, 田中's save, then 山田's save on version 2 (the one shown): refused too.
  expect(puts().slice(2).map((item) => [item.status, item.ifMatch])).toEqual([[412, '"cs-1"'], [200, '"cs-2"'], [412, '"cs-2"']])
  // The refusal reads version 3: the notice now names 田中 too, and only another decision continues.
  expect(diff('removed')).toBe(`${words.diffRemoved(2)} 佐藤 花子${words.separator}田中 美咲`)
  expect(saveButton()!.disabled).toBe(true)
  await click(button(words.keep))
  await save()
  expect(puts().slice(5).map((item) => [item.status, item.ifMatch])).toEqual([[200, '"cs-3"']])
})

test('a long difference lists the first five of each group with a count, 「すべて表示」 lists all, and people the Directory does not know are told apart by subject', async () => {
  const long = 'https://issuer.example/subjects/0123456789-abcdef'
  const subjects = [...Array.from({ length: 7 }, (_, index) => `sub-extra-${index}`), long]
  await foreignSave('p-yamada', 0, subjects)
  await renderPage()
  await click(radio('on'))
  await foreignSave('p-sato', 1, ['sub-sato'], 'allowlist')
  await save()
  const shortLong = `${long.slice(0, 12)}…${long.slice(-8)}`
  const label = (subject: string) => words.unknownSubject(copy.common.unknownPerson, subject)
  expect(diff('mode')).toBe(words.diffMode(words.modes.allowlist.title, words.modes.on.title))
  expect(diff('removed')).toBe(`${words.diffRemoved(1)} 佐藤 花子`)
  expect(diff('added')).toBe(`${words.diffAdded(8)} ${subjects.slice(0, 5).map(label).join(words.separator)} ${words.diffMore(3)}`)
  await click(button(words.showAll))
  expect(diff('added')).toBe(`${words.diffAdded(8)} ${[...subjects.slice(0, 7), shortLong].map(label).join(words.separator)}`)
  expect(button(words.showFewer).getAttribute('aria-expanded')).toBe('true')
})

test('a mode this console does not know arriving mid-edit says why nothing can be saved, stops editing, and keeps the unsaved-changes guard', async () => {
  await renderPage()
  await click(radio('on'))
  mock.rewrites.push({ method: 'GET', path: SETTING, once: false, body: (wire) => ({ ...wire, mode: 'groups' }) })
  await act(async () => { await client.refetchQueries({ queryKey: consoleKeys.conversationSetting }) })
  await settle()
  expect(card()!.textContent).toContain(`${words.unknownMode} ${words.unknownModeUnsaved}`)
  expect(conflictNotice()).toBeUndefined()
  expect([...card()!.querySelectorAll('[role="radio"]')].every((item) => (item as HTMLButtonElement).disabled)).toBe(true)
  expect(saveButton()).toBeUndefined()
  // Leaving the page still asks first: the unsaved choice is not silently dropped.
  await act(async () => { void router.navigate({ to: '/mine' }) })
  await settle()
  expect(document.body.textContent).toContain(copy.unsavedChanges.title)
  expect(document.body.textContent).toContain(words.unsaved)
  expect(router.state.location.pathname).toBe('/-/admin/platform')
})

test('412 then 変更をやめる shows the other administrator\'s setting', async () => {
  await renderPage()
  await click(radio('on'))
  await signIn('p-sato', 'Admin')
  await call('PUT', '/api/console/admin/conversation', { mode: 'allowlist', allowlist: [{ subject: 'sub-suzuki' }] }, { 'If-Match': '"cs-0"' })
  await signIn('p-yamada', 'Admin')
  await save()
  await click(button(words.discard))
  expect(radio('allowlist').getAttribute('aria-checked')).toBe('true')
  expect(people()).toEqual(['鈴木 一郎'])
  expect(saveButton()!.disabled).toBe(true)
})

test('after an unreadable 2xx save, a read-back that answers malformed keeps only 「最新の状態を確認する」 and saving locked', async () => {
  await renderPage()
  mock.rewrites.push({ method: 'PUT', path: SETTING, once: true, body: (wire) => ({ ...wire, version: SECRET }) })
  await click(radio('on'))
  await save()
  mock.rewrites.push({ method: 'GET', path: SETTING, once: true, body: (wire) => ({ ...wire, version: SECRET }) })
  const unconfirmed = () => [...card()!.querySelectorAll('[role="status"], [role="alert"]')].find((item) => item.textContent?.includes(appText.unconfirmed.title))
  await click(button(appText.unconfirmed.confirm, unconfirmed()!))
  expect([...unconfirmed()!.querySelectorAll('button')].map((item) => item.textContent?.trim())).toEqual([appText.unconfirmed.confirm])
  expect(card()!.textContent).toContain(copy.common.refreshFailed(copy.relative.justNow))
  expect(saveButton()!.disabled).toBe(true)
  await save()
  expect(puts()).toHaveLength(1)
  // A read-back that succeeds is the only way on.
  await click(button(appText.unconfirmed.confirm, unconfirmed()!))
  expect(unconfirmed()).toBeUndefined()
  expect(puts()).toHaveLength(1)
})

test('an unreadable 2xx save offers only 「最新の状態を確認する」, is not cached or resent, and the read-back settles it', async () => {
  await renderPage()
  mock.rewrites.push({ method: 'PUT', path: SETTING, once: true, body: (wire) => ({ ...wire, version: SECRET }) })
  await click(radio('on'))
  await save()
  const notice = [...card()!.querySelectorAll('[role="status"], [role="alert"]')].find((item) => item.textContent?.includes(appText.unconfirmed.title))!
  expect([...notice.querySelectorAll('button')].map((item) => item.textContent?.trim())).toEqual([appText.unconfirmed.confirm])
  expect(saveButton()!.disabled).toBe(true)
  expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(SECRET)
  await save()
  expect(puts()).toHaveLength(1)

  await click(button(appText.unconfirmed.confirm, notice))
  expect(card()!.textContent).not.toContain(appText.unconfirmed.title)
  // The save had happened: the read-back shows it, and the unsaved choice is gone.
  expect(radio('on').getAttribute('aria-checked')).toBe('true')
  expect(saveButton()!.disabled).toBe(true)
  expect(puts()).toHaveLength(1)
})

test('a refresh that answers malformed keeps the last good setting under the stale notice', async () => {
  await renderPage()
  mock.rewrites.push({ method: 'GET', path: SETTING, once: true, body: (wire) => ({ ...wire, version: SECRET }) })
  await act(async () => { await client.refetchQueries({ queryKey: consoleKeys.conversationSetting }) })
  await settle()
  expect(card()!.textContent).toContain(copy.common.refreshFailed(copy.relative.justNow))
  expect(radio('off').getAttribute('aria-checked')).toBe('true')
  expect(card()!.textContent).not.toContain(SECRET)
})

test('a mode this console does not know shows the known parts and offers no save', async () => {
  await call('PUT', '/api/console/admin/conversation', { mode: 'allowlist', allowlist: [{ subject: 'sub-sato' }] }, { 'If-Match': '"cs-0"' })
  mock.rewrites.push({ method: 'GET', path: SETTING, once: false, body: (wire) => ({ ...wire, mode: 'groups' }) })
  await renderPage()
  expect(card()!.textContent).toContain(words.unknownMode)
  expect([...card()!.querySelectorAll('[role="radio"]')].every((item) => item.getAttribute('aria-checked') === 'false' && (item as HTMLButtonElement).disabled)).toBe(true)
  expect(people()).toEqual(['佐藤 花子'])
  expect(card()!.querySelector('#conversation-person-search')).toBeNull()
  expect(saveButton()).toBeUndefined()
  expect(card()!.querySelector('[data-testid="conversation-updated"]')!.textContent).toBe(words.updated('山田 太郎', copy.relative.justNow))
})

describe('only Console administrators get the card', () => {
  test('an editor sees 基盤の設定 without the card and the setting is never requested', async () => {
    await signIn('p-yamada', 'Editor')
    await renderPage()
    expect(container.textContent).toContain(text.platform.readOnly)
    expect(card()).toBeNull()
    expect(mock.requests.filter((item) => SETTING.test(item.path))).toEqual([])
  })

  test('an administrator gets it from one read', async () => {
    await renderPage()
    expect(card()).not.toBeNull()
    expect(mock.requests.filter((item) => SETTING.test(item.path)).map((item) => [item.method, item.status])).toEqual([['GET', 200]])
  })
})
