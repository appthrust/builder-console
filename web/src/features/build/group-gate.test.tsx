import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { ApplicationDraftCreationToolRegistryResponse } from '@appthrust/api-schema/platform-api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { consoleKeys } from '../../api/queries/console'
import { createTestGateway } from '../../api/testing/gateway'
import { groupsContract } from '../../api/contracts/console/groups'
import { meContract } from '../../api/contracts/console/me'
import { type Group } from '../../model/contracts/console'
import { createConnectionsQuery, creationToolsQuery, repositoryDestinationQuery } from '../../api/queries/catalog'
import { decodeResponse, type ResponseContract } from '../../api/boundary'
import { creationToolsContract, getRepositoryDestinationContract, listDomainsContract, listRegistryConnectionsContract, listSourceConnectionsContract, listStackDefinitionsContract, listTemplatesContract } from '../../api/contracts/platform/catalog'
import { copy } from '../../copy'
import { aiPolicyExplanation } from '../../copy/ai-policy'
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'
import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
import { UnsavedChangesProvider } from '../../ui/use-unsaved-changes-guard'
import { text as createText } from '../create/copy'
import { text } from './copy'
import { beginBuild, resolveBuildGroup } from './entry'

async function fixture(path: string, init?: RequestInit) {
  const url = new URL(path, 'http://mock.test')
  const handler = path.startsWith('/api/console/') ? consoleRoutes : platformRoutes
  const response = await handler(new Request(url, init), url)
  if (!response) throw new Error(`unhandled ${path}`)
  if (!response.ok) throw new Error(`fixture ${path}: ${response.status}`)
  return response
}

const gateway = createTestGateway({ consoleFetch: fixture })
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
})
afterEach(() => {
  restoreLanguage()
  if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('AI ownership resolves current group, membership root, effective id, then no group', async () => {
  const [seed] = await gateway.console(groupsContract, undefined)
  if (!seed) throw new Error('Missing directory fixture')
  const parent: Group = { ...seed, id: 'parent', parentId: null }
  const child: Group = { ...seed, id: 'child', parentId: parent.id }
  const other: Group = { ...seed, id: 'other', parentId: null }
  const groups = [child, other, parent]
  const me = { effectiveGroupIds: [child.id, parent.id] }
  expect(resolveBuildGroup(me, groups, other)).toBe(other.id)
  expect(resolveBuildGroup(me, groups)).toBe(parent.id)
  expect(resolveBuildGroup({ effectiveGroupIds: ['unlisted', 'second'] }, groups)).toBe('unlisted')
  expect(resolveBuildGroup({ effectiveGroupIds: [] }, groups)).toBeUndefined()
})

async function renderPage(path: '/new' | '/-/build/draft-1', hasGroup: boolean, availability?: Partial<ApplicationDraftCreationToolRegistryResponse>) {
  const [{ BuildPage }, { NewAppPage }] = await Promise.all([import('./build-page'), import('../create/new-app-page')])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const [me, groups] = await Promise.all([gateway.console(meContract, undefined), gateway.console(groupsContract, undefined)])
  const caller = { ...me, canCreateApps: true, effectiveGroupIds: hasGroup ? [groups[0]!.id] : [] }
  client.setQueryData(consoleKeys.me, caller)
  client.setQueryData(consoleKeys.groups, groups)
  if (path === '/new') {
    const project = `/api/v1/projects/${me.projectId}`
    const [templates, definitions, sources, registries, domains, tools] = await Promise.all([
      `${project}/application-templates`, '/api/v1/application-stack-definitions',
      `${project}/source-connections`, '/api/v1/registry-connections',
      `${project}/domains`, `${project}/application-drafts/creation-tools`,
    ].map(async (url) => (await fixture(url)).json()))
    // The cache holds what the gateway would: each wire answer decoded by its contract.
    const read = <D,>(contract: ResponseContract<D>, wire: unknown): D => {
      const result = decodeResponse(contract, wire)
      if (!result.ok) throw new Error(`${contract.operationId} fixture does not match its contract`)
      return result.value
    }
    client.setQueryData(['application-templates', me.projectId], read(listTemplatesContract, templates))
    client.setQueryData(['application-stack-definitions'], read(listStackDefinitionsContract, definitions))
    client.setQueryData(createConnectionsQuery(me.projectId).queryKey, { sources: read(listSourceConnectionsContract, sources).data, registries: read(listRegistryConnectionsContract, registries).data, domains: read(listDomainsContract, domains).data })
    client.setQueryData(creationToolsQuery(me.projectId).queryKey, read(creationToolsContract, { ...tools, ...availability }))
    client.setQueryData(repositoryDestinationQuery(me.projectId).queryKey, read(getRepositoryDestinationContract, await (await fixture(`/api/v1/projects/${me.projectId}/repository-destination`)).json()))
  }
  const root = createRootRoute()
  const newRoute = createRoute({ getParentRoute: () => root, path: '/new', component: NewAppPage })
  const buildRoute = createRoute({ getParentRoute: () => root, path: '/-/build/$draftId', component: () => <BuildPage draftId="draft-1" /> })
  const router = createRouter({ routeTree: root.addChildren([newRoute, buildRoute]), history: createMemoryHistory({ initialEntries: [path] }), isServer: true })
  await router.load()
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider>{path === '/new' ? <NewAppPage /> : <BuildPage draftId="draft-1" />}</UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>)
  } finally {
    client.clear()
  }
}

test('a no-group caller sees the blocking state and directory link instead of a build session', async () => {
  const html = await renderPage('/-/build/draft-1', false)
  expect(html).toContain(text.page.noGroup.title)
  expect(html).toContain(text.page.noGroup.body)
  expect(html).toContain('href="/company"')
  expect(html).toContain(text.page.noGroup.directory)
  expect(html).not.toContain('data-testid="build-session"')
})

test('the build gate has English copy', async () => {
  setLanguage('en')
  const html = await renderPage('/-/build/draft-1', false)
  expect(html).toContain('You don’t belong to a department')
  expect(html).toContain('Ask your administrator to add you to a department, then reopen this page.')
  expect(html).toContain('Organization &amp; people')
  expect(html).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
})

test.each([false, true])('AI template-customization entry is gated only without membership: hasGroup=%s', async (hasGroup) => {
  const html = await renderPage('/new', hasGroup)
  expect(html).toContain(createText.customizeWithAi)
  const actions = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].filter((match) => match[2]?.includes(createText.customizeWithAi))
  expect(actions.length).toBeGreaterThan(0)
  for (const action of actions) expect(action[1]?.includes('disabled=""')).toBe(!hasGroup)
  if (hasGroup) expect(html).not.toContain(text.page.noGroup.body)
  else expect(html).toContain(text.page.noGroup.body)
})

test('beginBuild rejects an empty group before listing or creating any platform draft', async () => {
  const fetch = spyOn(globalThis, 'fetch')
  try {
    await expect(beginBuild('project-1', 'Create inventory', { groupId: '', ownerSubject: 'owner-1' })).rejects.toThrow(text.page.noGroup.body)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
  }
})

test.each(['ai_policy_pending', 'ai_policy_denied', 'ai_model_denied', 'ai_model_unresolved', 'ai_approval_policy_denied'] as const)('policy %s keeps both AI entries visible, disabled and explained', async (reason) => {
  const html = await renderPage('/new', true, { codexAvailable: false, codexUnavailableReason: reason, codexPolicy: 'default' })
  expect(html).toContain(aiPolicyExplanation(reason, 'default')!)
  const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)]
  const build = buttons.find((match) => match[2]?.includes(copy.create.start.build))
  expect(build).toBeDefined()
  expect(build![1]).toContain('disabled=""')
  const customize = buttons.filter((match) => match[2]?.includes(createText.customizeWithAi))
  expect(customize.length).toBeGreaterThan(0)
  for (const button of customize) expect(button[1]).toContain('disabled=""')
})

test.each(['runtime', 'credential'] as const)('%s keeps the existing hidden AI entry behavior', async (reason) => {
  const html = await renderPage('/new', true, { codexAvailable: false, codexUnavailableReason: reason })
  expect(html).not.toContain(createText.customizeWithAi)
  expect(html).not.toContain(copy.create.start.build)
})
