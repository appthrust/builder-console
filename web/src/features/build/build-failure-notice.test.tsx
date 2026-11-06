import { expect, spyOn, test } from 'bun:test'
import type { ApplicationDraft, BuildFailure } from '@appthrust/api-schema/platform-api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import * as api from '../../api/build'
import { BuildFailureNotice } from './build-failure-notice'

const at = '2026-11-01T00:00:00Z'
const failure: BuildFailure = { lines: ['./lib/fourm-seed.ts', "Module not found: '[workspace]' <script>"], kind: 'module-not-found', observedAt: at, buildRef: 'https://github.com/acme/app/actions/runs/1' }
const draft: ApplicationDraft = { id: 'repair-draft', projectId: 'pj-demo', title: '台帳', kind: 'improvement', intent: failure.lines.join('\n'), phase: 'specifying', specMarkdown: '', architectureMarkdown: '', creationExecutions: [], ownerUserId: 'owner', createdAt: at, updatedAt: at }
function envelope<T extends { id: string }>(resource: T) {
  return { ...resource, resource, operation: { id: 'operation', type: 'applicationDraft.create', state: 'accepted' as const, writeChannel: 'W' as const, resource: { kind: 'ApplicationDraft', id: resource.id, projectId: 'pj-demo' }, createdAt: at, links: { self: '/api/v1/operations/operation' } } }
}

test('cause is plain escaped text; viewers and successful builds have no repair button', () => {
  const html = renderToStaticMarkup(<BuildFailureNotice failure={failure} projectId="pj-demo" stackId="stack-web" title="台帳" canEdit={false} />)
  expect(html).toContain('ビルドが失敗しました。原因:')
  expect(html).toContain('Module not found:')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('AI に直させる')
  expect(renderToStaticMarkup(<BuildFailureNotice failure={undefined} projectId="pj-demo" stackId="stack-web" title="台帳" canEdit />)).toBe('')
})

test('one click creates an improvement draft and sends exactly the cause lines as its first turn', async () => {
  const create = spyOn(api, 'createDraft').mockResolvedValue(envelope(draft))
  const turn = spyOn(api, 'createTurn').mockImplementation(async (_projectId, _draftId, payload) => envelope({ id: 'turn-1', kind: 'conversation' as const, userMessage: payload.message, status: 'pending' as const, startedAt: at, devWorkspaceId: 'workspace' }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const rootRoute = createRootRoute()
  const route = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <BuildFailureNotice failure={failure} projectId="pj-demo" stackId="stack-web" title="台帳" canEdit /> })
  const destination = createRoute({ getParentRoute: () => rootRoute, path: '/-/improve/$draftId', component: () => <p>改善</p> })
  const router = createRouter({ routeTree: rootRoute.addChildren([route, destination]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  try {
    await router.load()
    await act(async () => { root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>) })
    const button = container.querySelector<HTMLButtonElement>('[data-testid="repair-build-with-ai"]')
    expect(button?.textContent).toContain('AI に直させる')
    await act(async () => { button!.click() })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('pj-demo', { kind: 'improvement', applicationStackId: 'stack-web', title: '台帳', intent: failure.lines.join('\n') })
    expect(turn).toHaveBeenCalledWith('pj-demo', 'repair-draft', { message: failure.lines.join('\n') })
    expect(router.state.location.pathname).toBe('/-/improve/repair-draft')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
    create.mockRestore()
    turn.mockRestore()
  }
})
