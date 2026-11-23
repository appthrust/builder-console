import { afterEach, expect, spyOn, test } from 'bun:test'
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { shareAccessQuery, type ShareAccess } from '../../api/sharing'
import { sharingCopy as words } from '../../copy/sharing'
import { ShareManagement, organizationGroupsDisabledReason } from './share-management'
import { appReader } from '../../api/contracts/console/readers'
import { readFileSync } from 'node:fs'

const fixtures: { schema: string; body: unknown }[] = JSON.parse(readFileSync(new URL('../../../../cmd/server/internal/api/testdata/console-wire.json', import.meta.url), 'utf8'))
const app = { ...appReader.parse(fixtures.find((item) => item.schema === 'App')!.body), stackId: 'stack', shareSync: 'applied' }
const ready: ShareAccess = {
  bindings: [], canManageBindings: true, isOwner: true, shareSync: 'applied',
  organizationGroups: { declared: true, accepted: true, roles: ['member'] },
  organizationSource: { sourceUID: 'source', ready: true, initialSyncComplete: true, appliedVersion: 'v1', consecutiveFailures: 0 },
}
let root: Root | undefined
let container: HTMLDivElement
let client: QueryClient
const restores: (() => void)[] = []
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
  client?.clear()
  for (const restore of restores.splice(0)) restore()
})
async function mount(value: ShareAccess) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(shareAccessQuery(app.id).queryKey, value)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<QueryClientProvider client={client}><ShareManagement app={app} open /></QueryClientProvider>))
}

const disabledCases: { name: string; data: ShareAccess; reason: string }[] = [
  { name: 'undeclared', data: { ...ready, organizationGroups: { declared: false, accepted: false, roles: [] } }, reason: words.organization.undeclared },
  { name: 'offered only', data: { ...ready, organizationGroups: { ...ready.organizationGroups, accepted: false } }, reason: words.organization.unaccepted },
  { name: 'acceptance applying', data: { ...ready, organizationGroups: { ...ready.organizationGroups, roles: [] } }, reason: words.organization.applying },
  { name: 'source absent', data: { ...ready, organizationSource: undefined }, reason: words.organization.unavailable },
  { name: 'initial sync pending', data: { ...ready, organizationSource: { ...ready.organizationSource!, initialSyncComplete: false } }, reason: words.organization.syncing },
  { name: 'authority absent', data: { ...ready, canManageBindings: false }, reason: words.organization.denied },
]
test.each(disabledCases)('organization groups control is disabled: $name', async ({ data, reason }) => {
  const requests: string[] = []
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (input) => { requests.push(String(input)); return new Response(null, { status: 403 }) }) as typeof globalThis.fetch)
  restores.push(() => fetch.mockRestore())
  await mount(data)
  const control = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(control.disabled).toBe(true)
  await act(async () => control.click())
  expect(container.textContent).toContain(reason)
  expect(requests).toEqual([])
})

test('accepted organization groups still require disclosure confirmation', async () => {
  expect(organizationGroupsDisabledReason(ready)).toBeUndefined()
  const requests: string[] = []
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (input) => { requests.push(String(input)); return new Response(null, { status: 403 }) }) as typeof globalThis.fetch)
  restores.push(() => fetch.mockRestore())
  await mount(ready)
  const control = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(control.disabled).toBe(false)
  await act(async () => control.click())
  expect(document.body.textContent).toContain(words.organization.confirm('member', false))
  expect(requests).toEqual([])
})

test('cutover cannot start merely by reading the recipient diff', async () => {
  const requests: string[] = []
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`)
    return Response.json({ applicationUID: 'uid', candidateDigest: 'sha256:version', diffDigest: 'diff', shareRevision: 'revision', bindingETag: 'etag', addedCount: 1, removedCount: 1, unresolvedCount: 0, added: [{ principal: 'u_added', displayName: 'Added Person' }], removed: [{ principal: 'u_removed', displayName: 'Removed Person' }], oldAuthenticated: false, newAuthenticated: false })
  }) as typeof globalThis.fetch)
  restores.push(() => fetch.mockRestore())
  await mount(ready)
  const compare = [...container.querySelectorAll('button')].find((button) => button.textContent === words.cutover.compare)!
  const rendered = Promise.withResolvers<void>()
  const observer = new MutationObserver(() => { if (container.textContent?.includes('Added Person')) rendered.resolve() })
  observer.observe(container, { childList: true, subtree: true })
  try {
    await act(async () => { compare.click() })
    await rendered.promise
  } finally { observer.disconnect() }
  expect(container.textContent).toContain('Added Person')
  expect(container.textContent).toContain('Removed Person')
  expect(requests).toEqual([`GET /api/console/apps/${app.id}/share-diff`])
  const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent === words.cutover.confirm)!
  await act(async () => confirm.click())
  expect(document.body.textContent).toContain(words.cutover.confirmation)
  expect(requests).toHaveLength(1)
})

test('restore is offered only after cutover and requires a sealed previous digest', async () => {
  notifyManager.setScheduler((callback) => callback())
  restores.push(() => notifyManager.setScheduler((callback) => setTimeout(callback, 0)))
  const requests: string[] = []
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (input) => { requests.push(String(input)); return new Response(null, { status: 403 }) }) as typeof globalThis.fetch)
  restores.push(() => fetch.mockRestore())
  await mount(ready)
  const restoreButton = () => [...container.querySelectorAll('button')].find((button) => button.textContent === words.cutover.restore)
  expect(restoreButton()).toBeUndefined()
  const state: ShareAccess = { ...ready, cutover: { id: 'cutover', applicationUID: 'uid', direction: 'activate', phase: 'AppEnforced', reason: '', previousDigest: '', cookieIsolationVerified: true } }
  await act(async () => { client.setQueryData(shareAccessQuery(app.id).queryKey, state) })
  expect(restoreButton()?.disabled).toBe(true)
  await act(async () => restoreButton()!.click())
  expect(requests).toEqual([])
})
