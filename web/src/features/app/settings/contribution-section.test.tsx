// 提案の受け付け (WF-06) over the real section, queries, gateway and contracts against the in-memory Console mock:
// the switch shows the rule it makes, turning it off and saving PATCHes `contribution.scope` = `off` and the
// record follows; an app open to the company keeps `company` while the switch stays on; an unknown scope offers
// nothing to save.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { appQuery, meQuery } from '../../../api/queries/console'
import { queryClient as appQueryClient } from '../../../api/queries/shared'
import { createConsoleMockFetch, resetMocks, type ConsoleMockFetch } from '../../../api/testing/console-mock-fetch'
import { copy } from '../../../copy'
import type { BusinessApp } from '../../../model/contracts/console'
import { setLanguage } from '../../../shell/language'
import { UnsavedChangesProvider } from '../../../ui/use-unsaved-changes-guard'
import { preserveLanguage } from '../../../../test/language'
import { text } from '../copy'
import { ContributionSection, contributionScopeFor } from './contribution-section'

const APP = 'a-keihi'

let mock: ConsoleMockFetch
let client: QueryClient
let root: Root | undefined
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
  // Radix Switch checks `closest('form') instanceof HTMLFormElement`; the shared DOM preload does not expose it.
  const form = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement')
  Object.defineProperty(globalThis, 'HTMLFormElement', { configurable: true, value: window.HTMLFormElement })
  restore.push(() => form ? Object.defineProperty(globalThis, 'HTMLFormElement', form) : Reflect.deleteProperty(globalThis, 'HTMLFormElement'))
  restore.push(() => warn.mockRestore())
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  client?.clear()
  globalThis.fetch = originalFetch
  for (const undo of restore.splice(0).reverse()) undo()
})

async function settle(rounds = 12) {
  for (let tick = 0; tick < rounds; tick++) await act(async () => { await Bun.sleep(5) })
}

/** The section on the live app record, the way the settings tab passes it; `override` replaces the record once. */
async function render(override?: (app: BusinessApp) => BusinessApp) {
  client = new QueryClient({ defaultOptions: { queries: { ...appQueryClient.getDefaultOptions().queries, retryDelay: 0, refetchInterval: false, refetchOnWindowFocus: false } } })
  await client.fetchQuery(meQuery)
  const app = await client.fetchQuery(appQuery(APP))
  if (override) client.setQueryData(appQuery(APP).queryKey, override(app))
  function Live() {
    const current = useQuery({ ...appQuery(APP), staleTime: Infinity }).data
    return current ? <ContributionSection app={current} canEdit /> : null
  }
  const rootRoute = createRootRoute()
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null })
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><RouterContextProvider router={router}><UnsavedChangesProvider><Live /></UnsavedChangesProvider></RouterContextProvider></QueryClientProvider>)
  })
  await settle()
  return app
}

const section = () => container.querySelector<HTMLElement>('#contribution')!
const toggle = () => section().querySelector<HTMLButtonElement>('[role="switch"]')!
const saveButton = () => [...section().querySelectorAll('button')].find((item) => item.textContent?.trim() === copy.app.settings.save)!
const patches = () => mock.requests.filter((item) => item.method === 'PATCH' && item.path === `/api/console/apps/${APP}`)

test('on writes group, keeps an existing company scope, and off writes off', () => {
  expect(contributionScopeFor(true, 'off')).toBe('group')
  expect(contributionScopeFor(true, 'group')).toBe('group')
  expect(contributionScopeFor(true, 'company')).toBe('company')
  expect(contributionScopeFor(false, 'company')).toBe('off')
})

test('the switch shows the rule; turning it off and saving PATCHes off and the record follows', async () => {
  const app = await render()
  expect(app.contribution.scope).toEqual({ kind: 'known', value: 'group' })
  expect(section().getAttribute('aria-label')).toBe(text.settings.contribution)
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  expect(section().textContent).toContain(text.settings.contributionSwitch)
  expect(section().textContent).toContain(text.settings.contributionHelp)
  const rule = section().querySelector('[data-testid="contribution-rule"]')!
  expect(rule.textContent).toContain(text.settings.contributionWhoGroup(app.group.name))
  expect(rule.textContent).toContain(text.settings.contributionReviewer)
  expect(saveButton().disabled).toBe(true)

  await act(async () => { toggle().click() })
  await settle(2)
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(section().textContent).toContain(text.settings.contributionOff)
  expect(section().querySelector('[data-testid="contribution-rule"]')).toBeNull()
  expect(saveButton().disabled).toBe(false)

  await act(async () => { section().querySelector('form')!.requestSubmit() })
  await settle()
  expect(patches().map((item) => item.status)).toEqual([200])
  expect(client.getQueryData<BusinessApp>(appQuery(APP).queryKey)?.contribution.scope).toEqual({ kind: 'known', value: 'off' })
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(section().querySelector('[role="status"]')?.textContent).toBe(copy.app.settings.saved)
  expect(saveButton().disabled).toBe(true)
  // The mock stored it: a fresh read says off.
  const reread = await (await mock.fetch(`/api/console/apps/${APP}`)).json() as { contribution: { scope: string } }
  expect(reread.contribution.scope).toBe('off')
})

test('an app open to the company stays company while on, with the company rule', async () => {
  await render((app) => ({ ...app, contribution: { scope: { kind: 'known', value: 'company' } } }))
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  expect(section().querySelector('[data-testid="contribution-rule"]')!.textContent).toContain(text.settings.contributionWhoCompany)
  expect(saveButton().disabled).toBe(true)
})

test('an unknown scope is named as such and offers no switch or save', async () => {
  await render((app) => ({ ...app, contribution: { scope: { kind: 'unknown' } } }))
  expect(section().textContent).toContain(text.unsupported.contribution)
  expect(toggle().disabled).toBe(true)
  expect(saveButton().disabled).toBe(true)
})
