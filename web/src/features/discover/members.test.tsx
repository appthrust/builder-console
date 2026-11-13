import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../test/language'
import { consoleKeys } from '../../api/queries/console'
import { createConsoleApi, type Membership } from '../../api/console-unverified'
import { createConsoleTransport } from '../../api/console'
import { createTestGateway } from '../../api/testing/gateway'
import { groupsContract } from '../../api/contracts/console/groups'
import { meContract } from '../../api/contracts/console/me'
import { copy } from '../../copy'
import { consoleRoutes } from '../../dev/mock-console'
import { setLanguage } from '../../shell/language'
import { GroupPage } from './group'
import { splitMembers } from './members'

async function fixture(path: string, init?: RequestInit) {
  const url = new URL(path, 'http://mock.test')
  const response = await consoleRoutes(new Request(url, init), url)
  if (!response) throw new Error(`unhandled ${path}`)
  if (!response.ok) throw new Error(`fixture ${path}: ${response.status}`)
  return response
}

const consoleApi = createConsoleApi(createConsoleTransport(fixture))
const gateway = createTestGateway({ consoleFetch: fixture })
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let restoreLanguage: () => void
beforeEach(async () => {
  restoreLanguage = preserveLanguage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  await fixture('/api/console/__mock/reset', { method: 'POST' })
})
afterEach(() => {
  restoreLanguage()
  if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

/** The members tab of a seeded group; `loaded: false` leaves the member list pending. */
async function renderMembersTab(groupId: string, { loaded = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const [me, groups] = await Promise.all([gateway.console(meContract, undefined), gateway.console(groupsContract, undefined)])
  const group = groups.find((candidate) => candidate.id === groupId)
  if (!group) throw new Error(`Missing group ${groupId}`)
  client.setQueryData(consoleKeys.me, me)
  client.setQueryData(consoleKeys.groups, groups)
  if (loaded) client.setQueryData(consoleKeys.members(group.id), await consoleApi.directory.members(group.id))
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: [`/${group.path}/-/members`] }), isServer: true })
  await router.load()
  try {
    return { group, html: renderToStaticMarkup(<QueryClientProvider client={client}><RouterContextProvider router={router}><GroupPage group={group} tab="members" /></RouterContextProvider></QueryClientProvider>) }
  } finally {
    client.clear()
  }
}

const header = (html: string) => html.slice(0, html.indexOf('</header>'))
const caption = (html: string, name: string) => html.match(new RegExp(`<caption[^>]*>${name}</caption>(.*?)</table>`, 's'))?.[1] ?? ''

describe('direct and inherited members', () => {
  test('splitMembers keeps rows without a source group as direct, in their order', () => {
    const person = (id: string) => ({ id, subject: id, pending: false, email: `${id}@example.test`, displayName: id, avatarVersion: null })
    const row = (id: string, inheritedFrom: string | null): Membership => ({ groupId: 'team', person: person(id), role: 'member', inheritedFrom })
    const { direct, inherited } = splitMembers([row('a', 'dept'), row('b', null), row('c', 'root'), row('d', null)])
    expect(direct.map((member) => member.person.id)).toEqual(['b', 'd'])
    expect(inherited.map((member) => member.person.id)).toEqual(['a', 'c'])
  })

  test('the header counts own members and names the inherited ones as secondary text', async () => {
    const { group, html } = await renderMembersTab('g-team-a')
    expect(group.memberCount).toBe(3)
    expect(header(html)).toContain(`${copy.group.memberCount(2)}<span class="text-xs">${copy.group.inheritedCount(1)}</span>`)
    expect(header(html)).not.toContain(copy.group.memberCount(3))
  })

  test('the members tab lists own members and folds inherited ones, with their source, below', async () => {
    const { html } = await renderMembersTab('g-team-a')
    expect(html).toContain(copy.members.lead)
    const direct = caption(html, copy.members.title)
    expect(direct).toContain('山田 太郎')
    expect(direct).toContain('鈴木 一郎')
    expect(direct).not.toContain('佐藤 花子')
    expect(direct).not.toContain(copy.members.inherited('営業本部'))
    const toggle = html.match(/<button[^>]*aria-expanded="false"[^>]*>(.*?)<\/button>/s)?.[1] ?? ''
    expect(toggle).toContain(copy.members.inheritedTitle(1))
    // Collapsed by default: the inherited rows are not rendered until opened.
    expect(html).not.toContain('佐藤 花子')
  })

  test('a group without inherited members has no inherited count or section', async () => {
    const { html } = await renderMembersTab('g-soumu')
    expect(header(html)).toContain(copy.group.memberCount(1))
    expect(html).not.toContain(copy.group.inheritedCount(1).trim())
    expect(html).not.toContain('aria-expanded')
  })

  test('while the member list loads the header shows a placeholder, not the effective count', async () => {
    const { html } = await renderMembersTab('g-team-a', { loaded: false })
    expect(header(html)).toContain(`role="status" aria-label="${copy.common.loading}"`)
    expect(header(html)).not.toContain(copy.group.memberCount(3))
    expect(header(html)).not.toContain(copy.group.memberCount(2))
  })

  test('English copy names the split', async () => {
    setLanguage('en')
    const { html } = await renderMembersTab('g-team-a')
    expect(header(html)).toContain('2 members<span class="text-xs"> · 1 more inherited</span>')
    expect(html).toContain('Members inherited from parent groups (1)')
    expect(html).toContain('People who belong to this group directly.')
  })
})
