import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { decodeResponse, type ResponseContract } from '../../api/boundary'
import { creationToolsContract, getRepositoryDestinationContract, listDomainsContract, listRegistryConnectionsContract, listSourceConnectionsContract, listStackDefinitionsContract, listTemplatesContract } from '../../api/contracts/platform/catalog'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { consoleKeys } from '../../api/queries/console'
import { createTestGateway } from '../../api/testing/gateway'
import { groupsContract } from '../../api/contracts/console/groups'
import { meContract } from '../../api/contracts/console/me'
import { createConnectionsQuery, creationToolsQuery, repositoryDestinationQuery } from '../../api/queries/catalog'
import { copy } from '../../copy'
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'
import { preserveLanguage } from '../../../test/language'
import { UnsavedChangesProvider } from '../../ui/use-unsaved-changes-guard'
import { text } from './copy'
import { NewAppPage } from './new-app-page'

async function fixture(path: string, init?: RequestInit) {
  const url = new URL(path, 'http://mock.test')
  const response = await (path.startsWith('/api/console/') ? consoleRoutes : platformRoutes)(new Request(url, init), url)
  if (!response?.ok) throw new Error(`fixture ${path}: ${response?.status}`)
  return response
}

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const formDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement')
let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  // Opening Advanced mounts Radix Select, which tests its trigger's associated form.
  Object.defineProperty(globalThis, 'HTMLFormElement', { configurable: true, value: window.HTMLFormElement })
})
afterEach(() => {
  restoreLanguage()
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  if (sessionStorageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', sessionStorageDescriptor)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
  if (formDescriptor) Object.defineProperty(globalThis, 'HTMLFormElement', formDescriptor)
  else Reflect.deleteProperty(globalThis, 'HTMLFormElement')
})

test.each([true, false])('new app distinguishes pending domain and recovers on its scheduled poll: admin=%s', async (admin) => {
  const gateway = createTestGateway({ consoleFetch: fixture })
  const [me, groups] = await Promise.all([gateway.console(meContract, undefined), gateway.console(groupsContract, undefined)])
  const project = `/api/v1/projects/${me.projectId}`
  const [templates, definitions, sources, registries, domains, tools] = await Promise.all([
    `${project}/application-templates`, '/api/v1/application-stack-definitions',
    `${project}/source-connections`, '/api/v1/registry-connections',
    `${project}/domains`, `${project}/application-drafts/creation-tools`,
  ].map(async (path) => (await fixture(path)).json()))
  const pendingDomains = domains.data.map((domain: Record<string, unknown>) => ({ ...domain, usableForPublish: false, delegationReady: false, publishUnavailableReason: 'ProjectGatewayPending' }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  client.setQueryData(consoleKeys.me, { ...me, isConsoleAdmin: admin, canCreateApps: true, effectiveGroupIds: [groups[0]!.id] })
  client.setQueryData(consoleKeys.groups, groups)
  // The cache holds what the gateway would: each wire answer decoded by its contract.
  const read = <D,>(contract: ResponseContract<D>, wire: unknown): D => {
    const result = decodeResponse(contract, wire)
    if (!result.ok) throw new Error(`${contract.operationId} fixture does not match its contract`)
    return result.value
  }
  client.setQueryData(['application-templates', me.projectId], read(listTemplatesContract, templates))
  client.setQueryData(['application-stack-definitions'], read(listStackDefinitionsContract, definitions))
  const connections = createConnectionsQuery(me.projectId)
  client.setQueryData(connections.queryKey, { sources: read(listSourceConnectionsContract, sources).data, registries: read(listRegistryConnectionsContract, registries).data, domains: read(listDomainsContract, { data: pendingDomains }).data })
  client.setQueryData(creationToolsQuery(me.projectId).queryKey, read(creationToolsContract, { ...tools, codexAvailable: true }))
  client.setQueryData(repositoryDestinationQuery(me.projectId).queryKey, read(getRepositoryDestinationContract, await (await fixture(`/api/v1/projects/${me.projectId}/repository-destination`)).json()))

  const timers = new Map<number, { run: () => void; delay: number }>()
  let nextTimer = 0
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, delay: number) => {
    const id = ++nextTimer
    timers.set(id, { run: handler, delay })
    return id
  }) as typeof setInterval)
  const clearInterval = spyOn(globalThis, 'clearInterval').mockImplementation((id) => { timers.delete(Number(id)) })
  let domainReads = 0
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://mock.test'), init)
    const url = new URL(request.url)
    if (url.pathname === `${project}/domains`) domainReads++
    return fixture(url.pathname + url.search, init)
  }) as typeof globalThis.fetch)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const rootRoute = createRootRoute()
  const route = createRoute({ getParentRoute: () => rootRoute, path: '/new', component: NewAppPage })
  const router = createRouter({ routeTree: rootRoute.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/new?step=start'] }), isServer: true })
  try {
    await router.load()
    await act(async () => { root.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider><NewAppPage /></UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>) })
    expect(container.textContent).toContain('公開用のドメインは準備中です')
    expect(container.textContent).not.toContain('まだ用意されていません')
    expect(container.textContent).not.toContain(text.openPlatform)
    const templateButtons = [...container.querySelectorAll<HTMLButtonElement>('button[data-testid^="template-"]')]
    const aiButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.includes(text.customizeWithAi))
    expect(templateButtons.length).toBeGreaterThan(0)
    expect(aiButtons.length).toBeGreaterThan(0)
    for (const button of [...templateButtons, ...aiButtons]) expect(button.disabled).toBe(true)
    const poll = [...timers.values()].find((timer) => timer.delay === 10_000)
    expect(poll).toBeDefined()
    await act(async () => {
      poll!.run()
      await client.getQueryCache().find({ queryKey: connections.queryKey })?.promise
      // Flush TanStack Query's scheduled observer notifications, not elapsed poll time.
      await delay(0)
    })
    expect(domainReads).toBe(1)
    expect(container.textContent).not.toContain('公開用のドメインは準備中です')
    // The mock approval template is independently blocked by its source allowlist.
    for (const button of templateButtons) expect(button.disabled).toBe(button.dataset.testid === 'template-biz-approval-postgres')
    for (const button of aiButtons) expect(button.disabled).toBe(false)
    expect([...timers.values()].some((timer) => timer.delay === 10_000)).toBe(false)

    await act(async () => {
      client.setQueryData(connections.queryKey, { sources: sources.data, registries: registries.data, domains: [] })
      await delay(0)
    })
    expect(container.textContent).toContain(admin ? text.missingAdmin(copy.create.prerequisite.domain) : copy.create.missing(['domain']))
    expect(container.textContent).not.toContain('公開用のドメインは準備中です')
    for (const button of [...templateButtons, ...aiButtons]) expect(button.disabled).toBe(true)
    expect([...timers.values()].some((timer) => timer.delay === 10_000)).toBe(false)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
    fetch.mockRestore()
    interval.mockRestore()
    clearInterval.mockRestore()
  }
})

test.each([403, 500])('non-admin create page handles registry-connections %s without confusing it with the domain inventory', async (status) => {
  await fixture('/api/v1/__mock/reset', { method: 'POST' })
  await fixture('/api/console/__mock/reset', { method: 'POST' })
  await fixture('/api/v1/__mock/codex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ available: true }) })
  const gateway = createTestGateway({ consoleFetch: fixture })
  const [me, groups] = await Promise.all([gateway.console(meContract, undefined), gateway.console(groupsContract, undefined)])
  const project = `/api/v1/projects/${me.projectId}`
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  client.setQueryData(consoleKeys.me, { ...me, isConsoleAdmin: false, canCreateApps: true, effectiveGroupIds: [groups[0]!.id] })
  client.setQueryData(consoleKeys.groups, groups)
  const requests: { method: string; path: string; status: number }[] = []
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://mock.test'), init)
    const url = new URL(request.url)
    const response = url.pathname === '/api/v1/registry-connections'
      ? Response.json({ error: { code: status === 403 ? 'forbidden' : 'internal', message: status === 403 ? 'Platform Admin role required' : 'registry read failed' } }, { status })
      : await (url.pathname.startsWith('/api/console/') ? consoleRoutes : platformRoutes)(request, url)
    requests.push({ method: request.method, path: url.pathname, status: response?.status ?? 404 })
    return response ?? Response.json({ error: 'unhandled' }, { status: 404 })
  }) as typeof globalThis.fetch)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const rootRoute = createRootRoute()
  const route = createRoute({ getParentRoute: () => rootRoute, path: '/new', component: NewAppPage })
  const router = createRouter({ routeTree: rootRoute.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/new?step=start'] }), isServer: true })
  try {
    await router.load()
    await act(async () => { root.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider><NewAppPage /></UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>) })
    for (let tick = 0; tick < 8; tick++) await act(async () => { await delay(0) })
    const intent = container.querySelector<HTMLTextAreaElement>('#create-start-intent')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(intent), 'value')!.set!.call(intent, '見積を管理するアプリ')
      intent.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
    })
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    const ai = buttons.find((button) => button.textContent?.trim() === copy.create.start.build)!
    const templates = [...container.querySelectorAll<HTMLButtonElement>('button[data-testid^="template-"]')]
    const existing = buttons.find((button) => button.textContent?.includes(copy.create.start.upload.title))!
    const query = createConnectionsQuery(me.projectId)
    expect(requests.filter((request) => request.path === '/api/v1/registry-connections')).toEqual([{ method: 'GET', path: '/api/v1/registry-connections', status }])
    for (const path of [`${project}/domains`, `${project}/source-connections`]) {
      expect(requests.filter((request) => request.path === path)).toEqual([{ method: 'GET', path, status: 200 }])
    }
    expect(templates.length).toBeGreaterThan(0)
    expect(ai).toBeDefined()
    if (status === 403) {
      expect(client.getQueryState(query.queryKey)?.status).toBe('success')
      expect(client.getQueryData(query.queryKey)?.registries).toEqual([])
      expect(container.textContent).not.toContain(copy.create.missing(['domain']))
      expect(container.textContent).not.toContain(text.missingAdmin(copy.create.prerequisite.domain))
      expect(ai.disabled).toBe(false)
      expect(existing.disabled).toBe(false)
      // This mock template is independently disallowed; registry visibility must not change that decision.
      for (const button of templates) expect(button.disabled).toBe(button.dataset.testid === 'template-biz-approval-postgres')
      const advanced = [...container.querySelectorAll<HTMLElement>('summary, button')].find((item) => item.textContent?.trim() === copy.create.advanced.toggle)!
      await act(async () => { advanced.click() })
      expect(container.textContent).toContain(copy.create.missing(['registry']))
      expect(container.querySelector<HTMLInputElement>('#create-image')?.disabled).toBe(true)
      expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === copy.create.advanced.use)?.disabled).toBe(true)
    } else {
      expect(client.getQueryState(query.queryKey)?.status).toBe('error')
      expect(client.getQueryData(query.queryKey)).toBeUndefined()
      expect(container.textContent).toContain(copy.common.loadFailed)
      expect(ai.disabled).toBe(true)
      for (const button of templates) expect(button.disabled).toBe(true)
    }
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
    fetch.mockRestore()
    await fixture('/api/v1/__mock/reset', { method: 'POST' })
    await fixture('/api/console/__mock/reset', { method: 'POST' })
  }
})
