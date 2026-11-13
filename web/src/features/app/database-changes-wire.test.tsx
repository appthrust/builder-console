// 「データベースの変更」 against unreadable answers (design §6, X3/X5): the real
// panel, query, gateway and contracts run over the in-memory Platform mock;
// only the answer under test is rewritten on its way back.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { keys, queryClient as appQueryClient } from '../../api/queries/shared'
import { copy } from '../../copy'
import { platformRoutes } from '../../dev/mock-platform'
import { setLanguage } from '../../shell/language'
import { preserveLanguage } from '../../../test/language'
import { text } from './copy'
import { DatabaseChanges } from './database-changes'

const SECRET = 'SENTINEL-db-changes-3c18'
const CHANGES = /^\/api\/v1\/projects\/commerce\/databases\/mitsumori-db\/changes$/
const APPROVE = /^\/api\/v1\/projects\/commerce\/databases\/mitsumori-db\/changes\/[^/]+\/approvals$/
const KEY = keys.databaseChanges('commerce', 'mitsumori-db')
const changesText = copy.app.databaseChanges

type Json = Record<string, unknown>
interface Rewrite { method: string; path: RegExp; body: (wire: Json) => unknown }

let rewrites: Rewrite[] = []
let requests: { method: string; path: string }[] = []
const originalFetch = globalThis.fetch
let client: QueryClient
let root: Root | undefined
let container: HTMLDivElement
let restore: (() => void)[] = []

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init)
  const url = new URL(request.url)
  const response = (await platformRoutes(request, url)) ?? Response.json({ error: { message: 'unhandled' } }, { status: 404 })
  requests.push({ method: request.method, path: url.pathname })
  const index = rewrites.findIndex((item) => item.method === request.method && item.path.test(url.pathname))
  if (index < 0 || !response.ok) return response
  const [rewrite] = rewrites.splice(index, 1)
  return Response.json(rewrite!.body((await response.json()) as Json), { status: response.status })
}

async function settle(rounds = 10) {
  for (let tick = 0; tick < rounds; tick++) await act(async () => { await Bun.sleep(10) })
}

beforeEach(async () => {
  restore = [preserveLanguage()]
  setLanguage('ja')
  rewrites = []
  globalThis.fetch = mockFetch as typeof globalThis.fetch
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  restore.push(() => warn.mockRestore())
  await mockFetch('/api/v1/__mock/reset', { method: 'POST' })
  requests = []
  client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, refetchOnWindowFocus: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><DatabaseChanges projectId="commerce" databaseId="mitsumori-db" /></QueryClientProvider>)
  })
  await settle()
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container.remove()
  client.clear()
  globalThis.fetch = originalFetch
  for (const undo of restore.reverse()) undo()
})

const count = (method: string, path: RegExp) => requests.filter((item) => item.method === method && path.test(item.path)).length
const refreshFailed = copy.common.refreshFailed(copy.relative.justNow)
const approveButton = () => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === changesText.approve)
const item = (state: string) => container.querySelector(`[data-state="${state}"]`)

async function refresh() {
  await act(async () => { await client.refetchQueries({ queryKey: KEY }) })
  await settle()
}

describe('X3: the change list refreshes into an unreadable answer', () => {
  test('keeps the list under one stale notice with 承認 off; the next good read clears it', async () => {
    expect(item('awaiting')?.textContent).toContain('0002_create_estimates.sql')
    expect(approveButton()?.disabled).toBe(false)
    const good = client.getQueryData(KEY)
    const goodAt = client.getQueryState(KEY)!.dataUpdatedAt

    rewrites.push({ method: 'GET', path: CHANGES, body: (wire) => ({ ...wire, data: [{ id: SECRET }] }) })
    await refresh()
    expect(Object.is(client.getQueryData(KEY), good)).toBe(true)
    expect(client.getQueryState(KEY)!.dataUpdatedAt).toBe(goodAt)
    expect(container.textContent!.split(refreshFailed)).toHaveLength(2)
    expect(item('awaiting')?.textContent).toContain('0002_create_estimates.sql')
    expect(container.textContent).toContain(changesText.applied(1))
    expect(approveButton()?.disabled).toBe(true)
    expect(container.textContent).not.toContain(SECRET)
    expect(container.textContent).not.toContain(copy.common.loadFailed)

    await refresh()
    expect(container.textContent).not.toContain(refreshFailed)
    expect(approveButton()?.disabled).toBe(false)
  })
})

describe('X5: an approval answered 2xx unreadably', () => {
  test('caches nothing, never resends, and offers only 「最新の状態を確認する」, which reads the list back', async () => {
    const before = client.getQueryData(KEY)
    rewrites.push({ method: 'POST', path: APPROVE, body: (wire) => ({ ...wire, resource: { id: SECRET } }) })
    const reads = count('GET', CHANGES)
    await act(async () => { approveButton()!.click() })
    await settle()
    expect(count('POST', APPROVE)).toBe(1)
    expect(count('GET', CHANGES)).toBe(reads)
    expect(Object.is(client.getQueryData(KEY), before)).toBe(true)
    const notice = [...container.querySelectorAll('[role="status"], [role="alert"]')].find((node) => node.textContent?.includes(text.unconfirmed.title))!
    expect([...notice.querySelectorAll('button')].map((node) => node.textContent?.trim())).toEqual([text.unconfirmed.confirm])
    expect(approveButton()?.disabled).toBe(true)
    expect(container.textContent).not.toContain(copy.common.retry)
    expect(container.textContent).not.toContain(SECRET)
    await act(async () => { approveButton()!.click() })
    await settle()
    expect(count('POST', APPROVE)).toBe(1)

    await act(async () => { [...notice.querySelectorAll('button')][0]!.click() })
    await settle()
    expect(count('GET', CHANGES)).toBe(reads + 1)
    expect(count('POST', APPROVE)).toBe(1)
    expect(container.textContent).not.toContain(text.unconfirmed.title)
    // The approval had happened: the read-back shows it applying, with nothing left to approve.
    expect(item('applying')?.textContent).toContain('0002_create_estimates.sql')
    expect(approveButton()).toBeUndefined()
  })
})
