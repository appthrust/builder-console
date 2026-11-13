import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { commentsQuery, consoleKeys } from '../../api/queries/console'
import { queryClient } from '../../api/queries/shared'
import { copy } from '../../copy'
import type { Me } from '../../model/contracts/console'
import { Comments } from './comments'

const SECRET = 'SENTINEL-comments-5be1'
const at = new Date().toISOString()
const person = { id: 'p-1', subject: 'sub-1', pending: false, email: 'yamada@example.test', displayName: '山田', avatarVersion: null }
const me: Me = {
  person, isConsoleAdmin: false, canCreateApps: true, effectiveGroupIds: [], managedGroupIds: [], projectId: 'commerce',
  directoryPublicURL: '', migration: { pending: false, people: 0, groups: 0, memberships: 0 },
}
const thread = [
  { id: 'c-1', appId: 'app-1', author: person, body: '使ってみました', createdAt: at },
  { id: 'c-2', appId: 'app-1', author: { id: 'p-gone', displayName: '', unknown: true }, body: '退職者のコメント', createdAt: at },
]
const malformed = [{ ...thread[0], body: { html: SECRET } }]

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

/** Lets in-flight fetches settle and React Query's batched notifications reach the component. */
async function settle() {
  for (let tick = 0; tick < 4; tick++) await act(async () => { await Bun.sleep(5) })
}

/** The comments panel on the app's real query defaults (retry policy included), answering `answers` in order. */
async function renderPanel(answers: unknown[]) {
  const fetch = mock(async () => Response.json(answers.length > 1 ? answers.shift() : answers[0]))
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const client = new QueryClient({ defaultOptions: { queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false } } })
  client.setQueryData(consoleKeys.me, me)
  client.setQueryData(consoleKeys.groups, [])
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<QueryClientProvider client={client}><Comments appId="app-1" owners={[]} canDeleteAny={false} /></QueryClientProvider>) })
  await settle()
  const cleanup = async () => {
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
    warn.mockRestore()
  }
  return { client, container, fetch, warn, cleanup }
}

const text = (container: HTMLElement) => container.textContent ?? ''

test('an initial malformed list shows the fixed failure in the panel; the composer stays usable; nothing from the payload shows', async () => {
  const { container, fetch, warn, cleanup } = await renderPanel([malformed])
  try {
    expect(text(container)).toContain(copy.common.loadFailed)
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === copy.common.retry)).toBe(true)
    const composer = container.querySelector('textarea')
    expect(composer).not.toBeNull()
    expect(composer?.disabled).toBe(false)
    expect(container.innerHTML).not.toContain(SECRET)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET)
  } finally {
    await cleanup()
  }
})

test('good → malformed tick → recovery: the thread and its timestamp stay as last read, with a warning, then refresh', async () => {
  const recovered = [...thread, { id: 'c-3', appId: 'app-1', author: person, body: '追記です', createdAt: at }]
  const { client, container, fetch, warn, cleanup } = await renderPanel([thread, malformed, recovered])
  const key = commentsQuery('app-1').queryKey
  try {
    expect(text(container)).toContain('使ってみました')
    // A removed author keeps the comment, with no invented name or contact.
    expect(text(container)).toContain('退職者のコメント')
    expect(text(container)).toContain(copy.common.unknownPerson)
    const good = client.getQueryData(key)
    const goodAt = client.getQueryState(key)?.dataUpdatedAt

    await act(async () => { await client.refetchQueries({ queryKey: key }) })
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(Object.is(client.getQueryData(key), good)).toBe(true)
    expect(client.getQueryState(key)?.dataUpdatedAt).toBe(goodAt)
    expect(text(container)).toContain('使ってみました')
    expect(text(container)).toContain(copy.common.refreshFailed(copy.relative.justNow))
    expect(text(container)).not.toContain(copy.common.loadFailed)
    expect(container.querySelector('textarea')?.disabled).toBe(false)
    expect(container.innerHTML).not.toContain(SECRET)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET)

    await act(async () => { await client.refetchQueries({ queryKey: key }) })
    await settle()
    expect(text(container)).toContain('追記です')
    expect(text(container)).not.toContain(copy.common.refreshFailed(copy.relative.justNow))
  } finally {
    await cleanup()
  }
})
