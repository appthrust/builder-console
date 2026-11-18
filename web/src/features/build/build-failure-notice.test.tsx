import { expect, spyOn, test } from 'bun:test'
import type { ApplicationDraft, BuildFailure } from '@appthrust/api-schema/platform-api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, type ReactElement } from 'react'
import { draftOf, turnOf } from '../../api/testing/build-domain'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import * as api from '../../api/build'
import { buildKeys } from '../../api/queries/build'
import { ImproveButton } from '../improve/entry'
import { buildCopy } from '../../model/build/copy'
import { BuildFailureNotice } from './build-failure-notice'

const at = '2026-11-01T00:00:00Z'
const failure: BuildFailure = { lines: ['./lib/fourm-seed.ts', "Module not found: '[workspace]' <script>"], kind: 'module-not-found', observedAt: at, buildRef: 'https://github.com/acme/app/actions/runs/1' }
const draft: ApplicationDraft = { id: 'repair-draft', projectId: 'pj-demo', title: '台帳', kind: 'improvement', intent: failure.lines.join('\n'), phase: 'specifying', specMarkdown: '', architectureMarkdown: '', creationPlanGenerations: [], conversationTurns: [], creationExecutions: [], implementationRuns: [], createdSourceRepositories: [], ownerUserId: 'owner', createdAt: at, updatedAt: at }

test('cause is plain escaped text; viewers and successful builds have no repair button', () => {
  const html = renderToStaticMarkup(<BuildFailureNotice failure={failure} projectId="pj-demo" stackId="stack-web" title="台帳" canEdit={false} />)
  expect(html).toContain('ビルドが失敗しました。原因:')
  expect(html).toContain('Module not found:')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('AI に直させる')
  expect(renderToStaticMarkup(<BuildFailureNotice failure={undefined} projectId="pj-demo" stackId="stack-web" title="台帳" canEdit />)).toBe('')
})

async function exerciseStart(entry: ReactElement, interact: (container: HTMLDivElement, expectNoWrites: () => void) => Promise<string>) {
  const create = spyOn(api, 'createDraft').mockResolvedValue(draftOf(draft))
  const list = spyOn(api, 'listDrafts').mockResolvedValue({ data: [], unreadable: [] })
  const turn = spyOn(api, 'createTurn').mockImplementation(async (_projectId, _draftId, payload) => turnOf({ id: 'turn-1', kind: 'conversation', userMessage: payload.message, status: 'pending', startedAt: at, devWorkspaceId: 'workspace' }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(buildKeys.drafts('pj-demo'), { data: [], unreadable: [] })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const rootRoute = createRootRoute()
  const route = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => entry })
  const destination = createRoute({ getParentRoute: () => rootRoute, path: '/-/improve/$draftId', component: () => <p>改善</p> })
  const router = createRouter({ routeTree: rootRoute.addChildren([route, destination]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  try {
    await router.load()
    await act(async () => { root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>) })
    const message = await interact(container, () => {
      expect(create).not.toHaveBeenCalled()
      expect(turn).not.toHaveBeenCalled()
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('pj-demo', { kind: 'improvement', applicationStackId: 'stack-web', title: '台帳', intent: message })
    expect(turn).toHaveBeenCalledWith('pj-demo', 'repair-draft', { message })
    expect(router.state.location.pathname).toBe('/-/improve/repair-draft')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
    create.mockRestore()
    list.mockRestore()
    turn.mockRestore()
  }
}

test('one click creates an improvement draft and sends exactly the cause lines as its first turn', async () => {
  await exerciseStart(<BuildFailureNotice failure={failure} projectId="pj-demo" stackId="stack-web" title="台帳" canEdit />, async (container) => {
    const button = container.querySelector<HTMLButtonElement>('[data-testid="repair-build-with-ai"]')!
    expect(button.textContent).toContain('AI に直させる')
    await act(async () => { button.click() })
    return failure.lines.join('\n')
  })
})

test.each(['improve', 'repair'])('an oversized %s request is kept for editing; only the corrected 4000 bytes are sent', async (mode) => {
  const lines = ['在庫'.repeat(666), '欠品']
  const entry = mode === 'repair'
    ? <BuildFailureNotice failure={{ lines }} projectId="pj-demo" stackId="stack-web" title="台帳" canEdit />
    : <ImproveButton app={{ displayName: '台帳' }} projectId="pj-demo" stackId="stack-web" />
  await exerciseStart(entry, async (container, expectNoWrites) => {
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid$="-with-ai"]')!.click() })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const input = dialog.querySelector('textarea')!
    const form = dialog.querySelector('form')!
    const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, value)
        input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
      })
    }
    const original = lines.join('\n')
    if (mode === 'improve') await type(original)
    expect(input.value).toBe(original)
    expect(dialog.textContent).toContain(buildCopy.inputBytes.over(3))
    expect(submit.disabled).toBe(true)
    await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event) })
    expectNoWrites()

    const edited = '在庫'.repeat(666) + '😀'
    await type(edited)
    expect(dialog.textContent).toContain(buildCopy.inputBytes.remaining(0))
    expect(submit.disabled).toBe(false)
    await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event) })
    return edited
  })
})
