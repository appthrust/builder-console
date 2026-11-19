import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { preserveLanguage } from '../../../test/language'
import * as api from '../../api/build'
import { draftOf, turnOf } from '../../api/testing/build-domain'
import { setLanguage } from '../../shell/language'
import { text } from './copy'
import { ImproveButton, ImproveDialog } from './entry'

const at = '2026-11-01T00:00:00Z'
const wire = (overrides: Partial<ApplicationDraft> = {}): ApplicationDraft => ({
  id: 'improve-draft', projectId: 'pj-demo', title: '台帳', kind: 'improvement', intent: '直したい', phase: 'specifying', specMarkdown: '', architectureMarkdown: '',
  creationPlanGenerations: [], conversationTurns: [], creationExecutions: [], implementationRuns: [], createdSourceRepositories: [], ownerUserId: 'owner', createdAt: at, updatedAt: at,
  ...overrides,
})

let restoreLanguage: () => void
let cleanups: (() => void | Promise<void>)[] = []
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
  restoreLanguage()
})

function spies(existing: ApplicationDraft[] = []) {
  const create = spyOn(api, 'createDraft').mockImplementation(async (_projectId, input) => draftOf(wire({ intent: input.intent })))
  const list = spyOn(api, 'listDrafts').mockResolvedValue({ data: existing.map(draftOf), unreadable: [] })
  const turn = spyOn(api, 'createTurn').mockImplementation(async (_projectId, _draftId, payload) => turnOf({ id: 'turn-1', kind: 'conversation', userMessage: payload.message, status: 'pending', startedAt: at, devWorkspaceId: 'workspace' }))
  cleanups.push(() => { create.mockRestore(); list.mockRestore(); turn.mockRestore() })
  return { create, list, turn }
}

async function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const rootRoute = createRootRoute()
  const route = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <>{node}</> })
  const destination = createRoute({ getParentRoute: () => rootRoute, path: '/-/improve/$draftId', component: () => <p>改善</p> })
  const router = createRouter({ routeTree: rootRoute.addChildren([route, destination]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  await act(async () => { root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>) })
  cleanups.push(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    client.clear()
  })
  return { router }
}

async function settle() {
  for (let tick = 0; tick < 4; tick++) await act(async () => { await Bun.sleep(5) })
}

const textarea = () => document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')
const submit = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === text.entry.submit)

/** React tracks the textarea value itself; set it the way typing does. */
function type(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function Fix({ body }: { body: string }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" data-testid="fix" onClick={() => setOpen(true)}>fix</button>
    <ImproveDialog app={{ displayName: '台帳' }} stackId="stack-web" projectId="pj-demo" open={open} onOpenChange={setOpen} draft={body} />
  </>
}

test('a draft opens the question filled in, nothing is sent until 「相談をはじめる」, and the edited text is what starts', async () => {
  const { create, turn } = spies()
  const { router } = await render(<Fix body="一覧を部署で絞り込みたいです。" />)
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="fix"]')!.click() })
  await settle()
  expect(textarea()?.value).toBe('一覧を部署で絞り込みたいです。')
  expect(create).not.toHaveBeenCalled()
  await act(async () => { type(textarea()!, '一覧を部署と期間で絞り込めるようにする') })
  await act(async () => { submit()!.click() })
  await settle()
  expect(create).toHaveBeenCalledWith('pj-demo', { kind: 'improvement', applicationStackId: 'stack-web', title: '台帳', intent: '一覧を部署と期間で絞り込めるようにする' })
  expect(turn).toHaveBeenCalledWith('pj-demo', 'improve-draft', { message: '一覧を部署と期間で絞り込めるようにする' })
  expect(router.state.location.pathname).toBe('/-/improve/improve-draft')
})

test('without a draft or a first message the button asks with an empty question, as before', async () => {
  const { create } = spies()
  await render(<ImproveButton app={{ displayName: '台帳' }} stackId="stack-web" projectId="pj-demo" />)
  await settle()
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="improve-with-ai"]')!.click() })
  await settle()
  expect(textarea()?.value).toBe('')
  expect(submit()?.disabled).toBe(true)
  expect(create).not.toHaveBeenCalled()
})

test('a caller refusal is worded first, the caller wording and tone replace the defaults', async () => {
  spies()
  const create = spyOn(api, 'createDraft').mockRejectedValue(new Error('forbidden'))
  cleanups.push(() => create.mockRestore())
  const wording = { action: '直しを提案する', title: '直しを提案する', description: (app: string) => `「${app}」の提案` }
  await render(<ImproveButton app={{ displayName: '台帳' }} stackId="stack-web" projectId="pj-demo" wording={wording} tone="secondary" draft="下書き" refusal={() => 'このアプリは、いま提案を受け付けていません。'} />)
  await settle()
  const button = document.querySelector<HTMLButtonElement>('[data-testid="improve-with-ai"]')!
  expect(button.textContent).toBe('直しを提案する')
  expect(button.className).toContain('border-stone-300')
  await act(async () => { button.click() })
  await settle()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('「台帳」の提案')
  expect(textarea()?.value).toBe('下書き')
  await act(async () => { submit()!.click() })
  await settle()
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('このアプリは、いま提案を受け付けていません。')
})

test('opened from elsewhere while a session runs on the stack, the dialog offers that session instead of a second start', async () => {
  const { create } = spies([wire({ id: 'running', createdApplicationStackId: 'stack-web' } as Partial<ApplicationDraft>)])
  const { router } = await render(<Fix body="提出の前に下書き保存がほしいです。" />)
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="fix"]')!.click() })
  await settle()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain(text.entry.openSession)
  expect(submit()?.disabled).toBe(true)
  const resume = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text.drafts.resume)!
  await act(async () => { resume.click() })
  await settle()
  expect(create).not.toHaveBeenCalled()
  expect(router.state.location.pathname).toBe('/-/improve/running')
})
