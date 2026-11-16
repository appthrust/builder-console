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
import { paths } from '../../routes/paths'
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

test('creation resolves the current group only when the caller belongs to it, else the membership root, else no group', async () => {
  const [seed] = await gateway.console(groupsContract, undefined)
  if (!seed) throw new Error('Missing directory fixture')
  const parent: Group = { ...seed, id: 'parent', parentId: null }
  const child: Group = { ...seed, id: 'child', parentId: parent.id }
  const other: Group = { ...seed, id: 'other', parentId: null }
  const groups = [child, other, parent]
  const me = { effectiveGroupIds: [child.id, parent.id] }
  // A group the caller only looks at (or that only shares with them) is never where their app goes.
  expect(resolveBuildGroup(me, groups, other)).toBe(parent.id)
  // A descendant of a membership is a membership (inherited downwards).
  expect(resolveBuildGroup(me, groups, child)).toBe(child.id)
  expect(resolveBuildGroup(me, groups)).toBe(parent.id)
  // An ancestor of a membership is not one.
  expect(resolveBuildGroup({ effectiveGroupIds: [child.id] }, groups, parent)).toBe(child.id)
  expect(resolveBuildGroup({ effectiveGroupIds: ['unlisted'] }, groups)).toBeUndefined()
  expect(resolveBuildGroup({ effectiveGroupIds: [] }, groups, other)).toBeUndefined()
})

async function renderPage(path: '/new' | '/-/build/draft-1' | '/-/excel2app', hasGroup: boolean, availability?: Partial<ApplicationDraftCreationToolRegistryResponse>) {
  const [{ BuildPage }, { NewAppPage }, { Excel2AppPage }] = await Promise.all([import('./build-page'), import('../create/new-app-page'), import('../excel2app/page')])
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
  const excelRoute = createRoute({ getParentRoute: () => root, path: '/-/excel2app', component: () => <Excel2AppPage /> })
  const router = createRouter({ routeTree: root.addChildren([newRoute, buildRoute, excelRoute]), history: createMemoryHistory({ initialEntries: [path] }), isServer: true })
  await router.load()
  const page = path === '/new' ? <NewAppPage /> : path === '/-/excel2app' ? <Excel2AppPage /> : <BuildPage draftId="draft-1" />
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider>{page}</UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>)
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

test('a no-group caller can start no creation entry on /new, Excel included, and reads why once', async () => {
  const html = await renderPage('/new', false)
  expect(html).toContain('data-testid="create-no-group"')
  expect(html).toContain(text.page.noGroup.title)
  expect(html.split(text.page.noGroup.body)).toHaveLength(2)
  expect(html).toContain('href="/company"')
  const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)]
  for (const label of [copy.create.start.build, createText.customizeWithAi, copy.create.start.upload.title, copy.create.start.excel.title, copy.create.next]) {
    const matches = buttons.filter((match) => match[2]?.includes(label))
    expect({ label, found: matches.length > 0 }).toEqual({ label, found: true })
    for (const match of matches) expect({ label, disabled: match[1]?.includes('disabled=""') }).toEqual({ label, disabled: true })
  }
  const templates = buttons.filter((match) => match[1]?.includes('data-testid="template-'))
  expect(templates.length).toBeGreaterThan(0)
  for (const template of templates) expect(template[1]).toContain('disabled=""')
  // The Excel entry is not a link: following it would make a Platform draft on the first upload.
  expect(html).not.toContain(`href="${paths.excel2app()}"`)
})

test('a member opens the Excel entry from /new as a link, without the group notice', async () => {
  const html = await renderPage('/new', true)
  expect(html).toContain(`href="${paths.excel2app()}"`)
  expect(html).not.toContain('data-testid="create-no-group"')
})

test('the Excel page opened directly without a group shows the guidance and never starts the draft flow', async () => {
  const fetch = spyOn(globalThis, 'fetch')
  try {
    const html = await renderPage('/-/excel2app', false)
    expect(html).toContain('data-testid="excel2app-no-group"')
    expect(html).toContain(text.page.noGroup.body)
    expect(html).toContain('href="/company"')
    expect(html).not.toContain('data-testid="excel2app-drop"')
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
  }
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
