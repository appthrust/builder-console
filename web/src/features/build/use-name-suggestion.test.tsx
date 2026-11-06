import { afterEach, beforeEach, expect, mock, spyOn, test, type Mock } from 'bun:test'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConsoleApiError, consoleApi } from '../../api/console'
import { classifyBuildFailure } from '../../model/build/failure'
import { useNameSuggestion } from './use-name-suggestion'

const draft: ApplicationDraft = {
  id: 'draft-name', projectId: 'project-name', title: 'Contacts', intent: 'Contacts', phase: 'planned',
  ownerUserId: 'owner', specMarkdown: '', architectureMarkdown: '', createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z',
  creationExecutions: [],
  creationPlan: { summary: 'Contacts', markdown: '', representation: [], toolPlan: [], applicationStackRequest: {
    templateId: 'web', web: { componentName: 'web' }, database: { componentName: 'db' }, connection: { connectionName: 'db' },
    applicationName: 'different-app-name', source: { kind: 'sample-image', imageRef: 'example.test/app:v1' },
    publish: { enabled: true, customDomain: 'project.test', hostnamePattern: 'wildcard', subdomain: 'contacts' },
  } },
}
const failure = classifyBuildFailure('Another publish already uses this URL.', undefined, 'prepare')
let queryClient: QueryClient
let root: Root
let container: HTMLDivElement
let fetch: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
let resolve: Mock<typeof consoleApi.resolve>
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const originalFetch = globalThis.fetch

beforeEach(() => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage })
  fetch = mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({ data: [], meta: { total: 0 } }))
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  resolve = spyOn(consoleApi, 'resolve').mockRejectedValue(new ConsoleApiError(404, { error: 'not_found', message: 'not found' }))
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  queryClient.clear()
  container.remove()
  globalThis.fetch = originalFetch
  resolve.mockRestore()
  if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
})

function Harness({ conflict = true, current = draft }: { conflict?: boolean; current?: ApplicationDraft }) {
  const suggestion = useNameSuggestion(current, conflict ? failure : undefined, 'sales/east')
  return <span>{suggestion}</span>
}
async function render(conflict = true, current = draft) {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><Harness conflict={conflict} current={current} /></QueryClientProvider>))
  await act(async () => {
    await Promise.all(queryClient.getQueryCache().getAll().map((query) => query.promise))
    root.render(<QueryClientProvider client={queryClient}><Harness conflict={conflict} current={current} /></QueryClientProvider>)
  })
}

test('checks numbered planned publish names against both console paths and platform applications', async () => {
  fetch.mockResolvedValue(Response.json({ data: [{ id: 'other', projectId: draft.projectId, templateId: 'web', applicationName: 'contacts-3', sourceKind: 'sample-image', pendingSync: false }], meta: { total: 1 } }))
  resolve.mockImplementation(async (path) => {
    if (path === '/sales/east/contacts-2') return { kind: 'app', id: 'taken', currentPath: path }
    throw new ConsoleApiError(404, { error: 'not_found', message: 'not found' })
  })
  await render()
  expect(container.textContent).toBe('contacts-4')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(new URL((fetch.mock.calls[0]![0] as Request).url).pathname).toBe(`/api/v1/projects/${draft.projectId}/application-stacks`)
  expect(resolve.mock.calls.map(([path]) => path)).toEqual(['/sales/east/contacts-2', '/sales/east/contacts-3', '/sales/east/contacts-4'])
  await render(false)
  expect(container.textContent).toBe('')
})

test('does not offer an unchecked suffix when every candidate is occupied', async () => {
  resolve.mockImplementation(async (path) => ({ kind: 'app', id: 'taken', currentPath: path }))
  await render()
  expect(container.textContent).toBe('')
  expect(resolve).toHaveBeenCalledTimes(8)
})

test('rechecks availability when the draft gains its own stack without changing its URL name', async () => {
  fetch.mockImplementation(async () => Response.json({ data: [{ id: 'mine', projectId: draft.projectId, templateId: 'web', applicationName: 'contacts-2', sourceKind: 'sample-image', pendingSync: false }], meta: { total: 1 } }))
  await render()
  expect(container.textContent).toBe('contacts-3')
  await render(true, { ...draft, createdApplicationStackId: 'mine' })
  expect(container.textContent).toBe('contacts-2')
  expect(fetch).toHaveBeenCalledTimes(2)
})
