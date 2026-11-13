import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from 'bun:test'
import type { ApplicationDraft, ApplicationDraftConversationTurn } from '@appthrust/api-schema/platform-api'
import { ORPCError } from '@orpc/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useLayoutEffect, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as api from '../../api/build'
import { draftOf, turnOf, generationOf } from '../../api/testing/build-domain'
import { appOf } from '../../api/testing/catalog-domain'
import type { BuildDraft } from '../../model/contracts/build'
import { buildKeys } from '../../api/queries/build'
import { consoleKeys } from '../../api/queries/console'
import type { BusinessApp } from '../../model/contracts/console'
import { type Me } from '../../model/contracts/console'
import { keys } from '../../api/queries/shared'
import { sessionExpiryStore } from '../../api/session-expiry'
import { buildCopy } from '../../model/build/copy'
import { shareScopeLabel } from '../../model/access'
import { composeBuildIntent } from '../../model/build/questions'
import { parseSpec, serializeSpec } from '../../model/build/spec'
import type { BuildFailure, BuildMessage, BuildPrimary, BuildStage } from '../../model/build/types'
import * as appViews from '../app/use-app-views'
import * as implement from './implement'
import * as binding from './bind-created-console-app'
import { useUnfinished, type UnfinishedItem } from '../discover/drafts'
import { forgetBuildSession, initialSession, readBuildSession, saveBuildSession, type BuildSession } from './session'
import { useBuildSession } from './use-build-session'

const me: Me = {
  projectId: 'project-session-test', person: { id: 'person-1', subject: 'owner-1', pending: false, email: 'owner@example.test', displayName: 'Owner', avatarVersion: null },
  effectiveGroupIds: ['sales'], managedGroupIds: [], isConsoleAdmin: false, canCreateApps: true,
  teamSlug: 'team', directoryPublicURL: '', migration: { pending: false, people: 0, groups: 0, memberships: 0 },
}
const at = '2026-10-26T00:00:00Z'
const turn = (id: string, userMessage: string, minute: number): ApplicationDraftConversationTurn => ({
  id, kind: 'conversation', userMessage, status: 'succeeded', startedAt: `2026-10-26T00:0${minute}:00Z`, devWorkspaceId: 'workspace-1',
})
const draft: ApplicationDraft = {
  id: 'draft-session-test', projectId: me.projectId, title: '見積台帳', intent: '見積を作る', phase: 'specifying',
  specMarkdown: serializeSpec({ name: '見積台帳', users: [], screens: [], records: [], rules: [], importFrom: 'excel' }, '# 詳細\n'),
  architectureMarkdown: '', creationExecutions: [], ownerUserId: me.person.subject, createdAt: at, updatedAt: at,
  conversationTurns: [turn('prepare', buildCopy.questions.prepareTurn, 0), turn('name', '営業見積', 1)],
}
const initial = initialSession({ projectId: me.projectId, ownerSubject: me.person.subject, groupId: 'sales', baseIntent: draft.intent })
const queryKey = buildKeys.draft(me.projectId, draft.id)
const conflict = new ORPCError('CONFLICT', { status: 409, data: { body: { error: { message: 'application draft creation is running; wait for it to finish before updating the draft' } } } })
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
let client: QueryClient
let root: Root
let container: HTMLDivElement
let build: {
  session: BuildSession; failure?: BuildFailure; prepareOpen: boolean; app?: BusinessApp; messages: BuildMessage[]
  result: { stage: BuildStage; primary: BuildPrimary }
  send(text: string): void
  requestPlan(): void
  retry(context?: 'turn' | 'plan' | 'prepare' | 'implement' | 'publish'): void
  patch(next: Partial<BuildSession>): void
  published(): Promise<void>
}
let implementation = implementationFixture()
let update: Mock<typeof api.updateDraft>
let createTurn: Mock<typeof api.createTurn>
let restore: (() => void)[]
let timers: Map<number, { run(): void; delay: number }>
let implementationEnabled: boolean

function implementationFixture() {
  const state: implement.ImplementationState = { phase: 'done', tasks: [] }
  return {
    state: { ...state, previewUrl: undefined, previewStatus: 'preparing' as const, retryPending: false }, pending: false, requestFailure: undefined,
    previewDatabaseReset: { busy: false, pending: false, error: undefined, reset: mock(async () => true) },
    start: mock(), confirm: mock(), startPending: mock(), retry: mock(), skipTask: mock(), requestChange: mock(async () => true),
  }
}


function Harness({ capture }: { capture(value: typeof build): void }) {
  const current = useSyncExternalStore(
    (listener) => client.getQueryCache().subscribe(listener),
    () => client.getQueryData<BuildDraft>(queryKey)!,
  )
  const session = useBuildSession(current, me, 'sales')
  useLayoutEffect(() => { capture(session) }, [capture, session])
  return null
}
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={client}><Harness capture={(value) => { build = value }} /></QueryClientProvider>) })
}
async function mount(current = draft, session: BuildSession = initial) {
  saveBuildSession(current.id, session)
  client.setQueryData(queryKey, draftOf(current))
  await render()
}
async function fireRetry() {
  const entry = timers.entries().next().value
  if (!entry) throw new Error('Missing scheduled name retry')
  const [id, timer] = entry
  timers.delete(id)
  await act(async () => { timer.run() })
  return timer.delay
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage })
  const clockSpy = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-26T00:05:00Z'))
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  client.setQueryData(keys.sourceRepositories(me.projectId), { data: [] })
  client.setQueryData(keys.createConnections(me.projectId), { sources: [], registries: [], domains: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  implementation = implementationFixture()
  const implementationSpy = spyOn(implement, 'useImplementation').mockImplementation((input) => { implementationEnabled = input.enabled; return implementation })
  const viewsSpy = spyOn(appViews, 'useAppViews').mockReturnValue({
    input: { applications: [], stacks: [], publishes: [], componentSummaries: [], releasesByApplication: {} },
    loading: false, failed: false, error: undefined, stale: false, updatedAt: 0, refetching: false, refetch: mock(),
    viewFor: () => ({ status: 'deploying', label: '', text: '', second: '', draft: false }),
  })
  update = spyOn(api, 'updateDraft').mockImplementation(async (_projectId, _draftId, payload) => {
    const current = client.getQueryData<BuildDraft>(queryKey)!
    const patch = draftOf({ ...draft, title: current.title, intent: current.intent, specMarkdown: current.specMarkdown, publishPreferences: current.publishPreferences, ...payload })
    return { ...current, title: patch.title, intent: patch.intent, specMarkdown: patch.specMarkdown, publishPreferences: patch.publishPreferences }
  })
  createTurn = spyOn(api, 'createTurn').mockImplementation(async (_projectId, _draftId, payload) =>
    turnOf(turn('share', payload.message, 2)))
  const getDraft = spyOn(api, 'getDraft').mockImplementation(async () => client.getQueryData<BuildDraft>(queryKey)!)
  timers = new Map()
  let nextTimer = 0
  const timeoutSpy = spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number) => {
    if (typeof handler !== 'function') throw new Error('Expected a retry callback')
    const id = ++nextTimer
    timers.set(id, { run: () => handler(), delay: delay ?? 0 })
    return id
  }) as typeof window.setTimeout)
  const clearSpy = spyOn(window, 'clearTimeout').mockImplementation((id) => { timers.delete(Number(id)) })
  restore = [implementationSpy, viewsSpy, update, createTurn, getDraft, timeoutSpy, clearSpy, clockSpy].map((spy) => () => spy.mockRestore())
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  client.clear()
  container.remove()
  forgetBuildSession(draft.id)
  sessionExpiryStore.setState(() => false)
  for (const reset of restore.reverse()) reset()
  if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
})

describe('kickoff to plan handoff', () => {
  const kickoff = turn('kickoff', buildCopy.questions.kickoffReply, 4)
  const unplanned = { ...draft, conversationTurns: [kickoff] }

  function mockGeneration() {
    const generation = spyOn(api, 'createGeneration').mockImplementation(async () =>
      generationOf({ id: 'plan-1', status: 'pending', startedAt: '2026-10-26T00:05:00Z', devWorkspaceId: 'workspace-1' }))
    restore.push(() => generation.mockRestore())
    return generation
  }

  test('accepted kickoff waits for succeeded, then requests exactly one generation without a lease', async () => {
    const generation = mockGeneration()
    createTurn.mockImplementation(async (_projectId, _draftId, payload) =>
      turnOf({ ...kickoff, userMessage: payload.message, status: 'pending' }))
    await mount({ ...unplanned, conversationTurns: [turn('opening', buildCopy.questions.firstTurn, 0)] })
    await act(async () => { build.send(buildCopy.questions.kickoffReply) })
    expect(createTurn).toHaveBeenCalledTimes(1)
    expect(build.session).toMatchObject({ pending: [], planRequested: true })
    expect(generation).not.toHaveBeenCalled()
    await act(async () => { client.setQueryData(queryKey, draftOf({ ...unplanned, conversationTurns: [kickoff] })) })
    expect(generation).toHaveBeenCalledTimes(1)
    expect(build.session.planRequested).toBe(false)
    await render()
    expect(generation).toHaveBeenCalledTimes(1)
  })

  test.each(['saved', 'missing', 'invalid'] as const)('reload with %s session recovers succeeded kickoff from the draft', async (storage) => {
    const generation = mockGeneration()
    if (storage === 'saved') saveBuildSession(draft.id, initial)
    else if (storage === 'invalid') sessionStorage.setItem(`builder-console:build:${draft.id}`, '{')
    else forgetBuildSession(draft.id)
    client.setQueryData(queryKey, draftOf(unplanned))
    await render()
    expect(generation).toHaveBeenCalledTimes(1)
    expect(createTurn).not.toHaveBeenCalled()
    await act(async () => { root.render(null) })
    await render()
    expect(generation).toHaveBeenCalledTimes(1)
  })


  test.each(['pending', 'succeeded'] as const)('reload observes an existing %s generation instead of sending another', async (status) => {
    const generation = mockGeneration()
    const current: ApplicationDraft = {
      ...unplanned, phase: status === 'succeeded' ? 'planned' : 'specifying',
      creationPlan: status === 'succeeded' ? { summary: '見積を管理する', markdown: '# 見積', representation: ['ApplicationStack'] } : undefined,
      creationPlanGenerations: [{ id: 'existing', status, startedAt: '2026-10-26T00:05:00Z', devWorkspaceId: 'workspace-1' }],
    }
    await mount(current, { ...initial, planRequested: true })
    expect(generation).not.toHaveBeenCalled()
  })

  test('a generation accepted before reload is read back instead of duplicated', async () => {
    const generation = mockGeneration()
    const getDraft = spyOn(api, 'getDraft').mockResolvedValue(draftOf({
      ...unplanned, creationPlanGenerations: [{ id: 'already-accepted', status: 'pending', startedAt: '2026-10-26T00:05:00Z', devWorkspaceId: 'workspace-1' }],
    }))
    restore.push(() => getDraft.mockRestore())
    await mount(unplanned, { ...initial, planRequested: true })
    expect(generation).not.toHaveBeenCalled()
    expect(client.getQueryData<ApplicationDraft>(queryKey)?.creationPlanGenerations?.[0]?.id).toBe('already-accepted')
  })

  test('the primary action sends one kickoff and one plan, even on a double click', async () => {
    const generation = mockGeneration()
    await mount({ ...unplanned, conversationTurns: [turn('opening', buildCopy.questions.firstTurn, 0)] })
    expect(build.result.primary).toMatchObject({ action: 'plan', enabled: true })
    await act(async () => { build.requestPlan(); build.requestPlan() })
    expect(createTurn).toHaveBeenCalledTimes(1)
    expect(generation).toHaveBeenCalledTimes(1)
  })

  test('turn admission conflict retains the kickoff reservation and retries after its block', async () => {
    const generation = mockGeneration()
    let tick: (() => void) | undefined
    const interval = spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler) => {
      tick = handler as () => void
      return 987
    }) as typeof window.setInterval)
    restore.push(() => interval.mockRestore())
    createTurn.mockRejectedValueOnce(conflict)
    await mount({ ...unplanned, conversationTurns: [turn('opening', buildCopy.questions.firstTurn, 0)] })
    await act(async () => { build.send(buildCopy.questions.kickoffReply) })
    expect(build.session.planRequested).toBe(true)
    expect(build.session.pending).toHaveLength(1)
    expect(generation).not.toHaveBeenCalled()
    spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-26T00:05:04Z'))
    if (!tick) throw new Error('Pending reply clock missing')
    await act(async () => { tick!() })
    expect(createTurn).toHaveBeenCalledTimes(2)
    expect(build.session.pending).toEqual([])
    expect(generation).toHaveBeenCalledTimes(1)
  })

  test('session expiry during handoff settles without losing intent and sign-in resumes once', async () => {
    const generation = mockGeneration()
    generation.mockImplementationOnce(async () => {
      sessionExpiryStore.setState(() => true)
      throw new ORPCError('SESSION_EXPIRED', { status: 401 })
    })
    await mount(unplanned, { ...initial, planRequested: true })
    expect(build.failure).toBeUndefined()
    expect(readBuildSession(draft.id)?.planRequested).toBe(true)
    expect(generation).toHaveBeenCalledTimes(1)
    await act(async () => { root.render(null) })
    sessionExpiryStore.setState(() => false)
    await render()
    expect(generation).toHaveBeenCalledTimes(2)
    expect(generation.mock.calls[0]?.[3]).toBe(generation.mock.calls[1]?.[3])
    expect(build.session.planRequested).toBe(false)
  })
})

describe('preparation name synchronization', () => {
  test('APT-792 leaves the draft untouched and sends suggestion requests to the open conversation', async () => {
    const current = {
      ...draft,
      conversationTurns: [
        { ...turn('prepare', buildCopy.questions.prepareTurn, 0), suggestedReplies: ['入退室・開閉管理でよい', '入退室・金庫管理にしたい', 'セキュリティ記録管理にしたい', 'ほかの名前にしたい'] },
        { ...turn('another', 'ほかの名前にしたい', 1), suggestedReplies: ['入退室・金庫管理にしたい', 'セキュリティ記録管理にしたい', 'ISMS記録管理にしたい', 'ほかの名前にしたい'] },
      ],
    }
    await mount(current)
    expect(update).not.toHaveBeenCalled()
    expect(build.prepareOpen).toBe(true)
    await act(async () => { build.send('提案して') })
    expect(createTurn.mock.calls.map((call) => call[2])).toEqual([{ message: '提案して' }])
    expect(implementation.requestChange).not.toHaveBeenCalled()
    expect(build.prepareOpen).toBe(true)
    expect(update).not.toHaveBeenCalled()
    expect(client.getQueryData<ApplicationDraft>(queryKey)).toMatchObject({ title: draft.title, specMarkdown: draft.specMarkdown })
    expect(client.getQueryData<ApplicationDraft>(queryKey)?.publishPreferences).toBeUndefined()
  })
  test('a concrete follow-up name writes only the extracted name to preferences, title and spec', async () => {
    await mount({
      ...draft,
      conversationTurns: [
        turn('prepare', buildCopy.questions.prepareTurn, 0), turn('another', 'ほかの名前にしたい', 1),
        turn('suggest', '提案して', 2), turn('name', '「営業見積」でお願いします', 3),
      ],
    })
    expect(update).toHaveBeenCalledTimes(1)
    const payload = update.mock.calls[0]![2]
    expect(payload).toMatchObject({ title: '営業見積', publishPreferences: { name: '営業見積' } })
    expect(parseSpec(payload.specMarkdown!).spec.name).toBe('営業見積')
    expect(build.prepareOpen).toBe(true)
  })
  test('an already-stored mistaken name is not silently repaired from newer name answers', async () => {
    const name = 'ほかの名前にしたい'
    const { spec, body } = parseSpec(draft.specMarkdown)
    const current = {
      ...draft, title: name, specMarkdown: serializeSpec({ ...spec, name }, body), publishPreferences: { name },
      conversationTurns: [turn('prepare', buildCopy.questions.prepareTurn, 0), turn('another', name, 1), turn('name', '営業見積にしたい', 2)],
    }
    await mount(current)
    expect(update).not.toHaveBeenCalled()
    expect(client.getQueryData<BuildDraft>(queryKey)).toEqual(draftOf(current))
  })
  test.each([
    [true, 'idle'], [false, 'starting-workspace'], [false, 'running'], [false, 'pushing'],
  ] as const)('saves title/preferences while implementation pending=%s phase=%s and defers spec alignment', async (pending, phase) => {
    implementation.pending = pending
    implementation.state.phase = phase
    await mount()
    expect(update.mock.calls.map((call) => call[2])).toEqual([{ title: '営業見積', publishPreferences: { name: '営業見積' } }])
    expect(build.failure).toBeUndefined()
    expect(build.session.messages).toEqual([])
    expect(build.prepareOpen).toBe(true)

    implementation.pending = false
    implementation.state.phase = 'done'
    await render()
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[0]?.slice(0, 2)).toEqual([me.projectId, draft.id])
    const payload = update.mock.calls[1]![2]
    expect(payload.title).toBeUndefined()
    expect(parseSpec(payload.specMarkdown!)).toEqual({ spec: { ...parseSpec(draft.specMarkdown).spec, name: '営業見積' }, body: '# 詳細\n' })
    await render()
    expect(update).toHaveBeenCalledTimes(2)
    expect(build.failure).toBeUndefined()
    expect(build.session.messages).toEqual([])
  })

  test('a 409 keeps audience replies flowing and retries preferences during implementation', async () => {
    update.mockRejectedValueOnce(conflict)
    await mount()
    expect(update).toHaveBeenCalledTimes(1)
    expect(build.failure).toBeUndefined()
    expect(build.session.messages).toEqual([])
    expect([...timers.values()].map((timer) => timer.delay)).toEqual([1000])

    await act(async () => { build.send(shareScopeLabel('group')) })
    expect(createTurn).toHaveBeenCalledTimes(1)
    expect(build.session.pending).toEqual([])
    expect(build.prepareOpen).toBe(false)
    expect(build.session.messages.some((message) => message.role === 'notice')).toBe(false)
    implementation.state.phase = 'running'
    await render()
    await fireRetry()
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[1]![2]).toEqual({ title: '営業見積', publishPreferences: { name: '営業見積', shareScope: 'group' } })
    implementation.state.phase = 'done'
    await render()
    expect(update).toHaveBeenCalledTimes(3)
    expect(client.getQueryData<ApplicationDraft>(queryKey)?.publishPreferences).toEqual({ name: '営業見積', shareScope: 'group' })
    expect(build.failure).toBeUndefined()
  })

  test('repeated conflicts use capped backoff without failed-turn notices', async () => {
    update.mockRejectedValue(conflict)
    await mount()
    for (const delay of [1000, 3000, 10000, 30000, 30000]) {
      expect(await fireRetry()).toBe(delay)
      expect(build.failure).toBeUndefined()
      expect(build.session.messages).toEqual([])
    }
    expect(update).toHaveBeenCalledTimes(6)
    await act(async () => { root.render(null) })
    expect(timers.size).toBe(0)
  })

  test('non-conflict errors remain visible as preparation failures, never failed AI turns', async () => {
    update.mockRejectedValueOnce(new ORPCError('FORBIDDEN', { status: 403 }))
    await mount()
    expect(update).toHaveBeenCalledTimes(1)
    expect(build.failure).toBeDefined()
    expect(build.session.messages.at(-1)).toMatchObject({ role: 'notice', retry: 'prepare' })
    expect(timers.size).toBe(0)
  })

  test('only the title is patched if the AI already aligned the specification name', async () => {
    const { spec, body } = parseSpec(draft.specMarkdown)
    await mount({ ...draft, specMarkdown: serializeSpec({ ...spec, name: '営業見積' }, body) })
    expect(update.mock.calls.map((call) => call[2])).toEqual([{ title: '営業見積', publishPreferences: { name: '営業見積' } }])
  })
})

test.each(['private', 'group', 'company'] as const)('an Excel hand-off skips Q&A and preserves publish audience %s', async (shareChoice) => {
  const publishName = '営業見積'
  const { spec, body } = parseSpec(draft.specMarkdown)
  const excel: ApplicationDraft = {
    ...draft, title: publishName, specMarkdown: serializeSpec({ ...spec, name: publishName }, body),
    publishPreferences: { name: publishName, shareScope: shareChoice },
    conversationTurns: [
      { ...turn('analysis', 'この Excel を読み取ってください', 0), kind: 'excel-analysis' },
      { ...turn('design', '__init__', 1), kind: 'ui-design' },
    ],
    creationExecutions: [{ id: 'execution-1', attempt: 1, status: 'running', startedAt: at, runStartedAt: at, steps: [] }],
  }
  await mount(excel)
  expect(build.prepareOpen).toBe(false)
  expect(build.session.pending).toEqual([])
  expect(client.getQueryData<ApplicationDraft>(queryKey)?.publishPreferences).toEqual({ name: publishName, shareScope: shareChoice })
  expect(readBuildSession(draft.id)).not.toHaveProperty('publishName')
  expect(createTurn).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
  await act(async () => {
    client.setQueryData(queryKey, draftOf({ ...excel, creationExecutions: [{ ...excel.creationExecutions[0]!, status: 'succeeded' }] }))
  })
  expect(build.prepareOpen).toBe(false)
  expect(createTurn).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

// Browser stories saw an intermittent 409 on conversation-turns: a draft poll that started before the hidden 用意する
// turn was sent answered after it, put back the draft without that turn, and the turn was queued and sent again.
test('a draft read in flight when the hidden preparation turn is answered cannot overwrite it: the turn is sent once', async () => {
  const preparing: ApplicationDraft = {
    ...draft, phase: 'creating', conversationTurns: [turn('opening', buildCopy.questions.firstTurn, 0)],
    creationExecutions: [{ id: 'execution-1', attempt: 1, status: 'running', startedAt: at, runStartedAt: at, steps: [] }],
  }
  const before = draftOf(preparing)
  saveBuildSession(draft.id, initial)
  client.setQueryData(queryKey, before)
  // The poll read the draft before the turn existed; its answer arrives only after the turn's.
  const poll = Promise.withResolvers<BuildDraft>()
  const polled = client.fetchQuery({ queryKey, queryFn: () => poll.promise, staleTime: 0 }).catch(() => undefined)
  await render()
  expect(createTurn).toHaveBeenCalledTimes(1)
  expect(createTurn.mock.calls[0]?.[2]).toEqual({ message: buildCopy.questions.prepareTurn })
  await act(async () => {
    poll.resolve(before)
    await polled
  })
  await render()
  expect(client.getQueryData<BuildDraft>(queryKey)?.conversationTurns.map((item) => item.userMessage)).toContain(buildCopy.questions.prepareTurn)
  expect(build.session.pending).toEqual([])
  expect(createTurn).toHaveBeenCalledTimes(1)
})

test('a saved implementation can retry before the console app binding loads', async () => {
  const current = { ...draft, createdApplicationStackId: 'stack-1', publishPreferences: { name: '営業見積', shareScope: 'group' as const } }
  implementation.state.phase = 'failed'
  await mount(current)
  expect(build.app).toBeUndefined()
  expect(implementationEnabled).toBe(true)
  await act(async () => { build.retry('implement') })
  expect(implementation.retry).toHaveBeenCalledTimes(1)
})

test('fresh tabs and legacy sessions show the original opening rather than composed metadata', async () => {
  const composed = composeBuildIntent(draft.intent, ['検索する'], true)
  await mount({ ...draft, intent: composed }, { ...initial, baseIntent: composed })
  expect(build.messages[0]).toMatchObject({ role: 'user', text: draft.intent })
})

test.each([true, false])('a failed creation step becomes a URL name choice (structured=%s)', async (structured) => {
  await mount({
    ...draft, conversationTurns: [],
    creationExecutions: [{
      id: 'execution-conflict', attempt: 1, status: 'failed', startedAt: at, finishedAt: at,
      error: 'Creation validation failed',
      steps: [{ id: 'stack-validate', tool: 'appthrust.applicationStack.validate', status: 'failed',
        message: structured ? 'URL gate rejected the planned destination' : 'Another publish already uses this URL.',
        ...(structured ? { detail: { reason: 'PublishURLConflict' } } : {}),
      }],
    }],
  })
  expect(build.failure).toMatchObject({ kind: 'name-taken', reasonCode: 'PublishURLConflict', title: buildCopy.failure.urlNameTaken })
  expect(build.session.messages.at(-1)).toMatchObject({ role: 'notice', retry: 'prepare', title: buildCopy.failure.urlNameTaken })
})

test.each(['turn', 'plan'] as const)('a recorded %s quota failure resumes only on manual retry', async (context) => {
  const error = 'Codex task failed: Codex error: stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at <REDACTED>'
  const operation = { id: 'quota-failed', status: 'failed' as const, startedAt: at, finishedAt: at, devWorkspaceId: 'workspace-1', error }
  const generation = spyOn(api, 'createGeneration').mockImplementation(async () =>
    generationOf({ id: 'resumed-plan', status: 'pending', startedAt: at, devWorkspaceId: 'workspace-1' }))
  restore.push(() => generation.mockRestore())
  await mount({
    ...draft, conversationTurns: context === 'turn' ? [{ ...turn('quota-failed', '一覧を作る', 0), ...operation }] : [turn('kickoff', buildCopy.questions.kickoffReply, 0)],
    creationPlanGenerations: context === 'plan' ? [operation] : [],
  }, { ...initial, planRequested: true })
  expect(build.failure).toMatchObject({ kind: 'quota', ...buildCopy.failure.quota })
  expect(build.session.messages.at(-1)).toMatchObject({ role: 'notice', title: buildCopy.failure.quota.title, detail: buildCopy.failure.quota.reason })
  expect(build.session.messages.at(-1)).toHaveProperty('retry', context)
  expect(build.session.planRetries).toBe(0)
  expect(build.session.planRequested).toBe(false)
  expect(timers.size).toBe(0)
  expect(createTurn).not.toHaveBeenCalled()
  expect(generation).not.toHaveBeenCalled()
  await render()
  expect(createTurn).not.toHaveBeenCalled()
  expect(generation).not.toHaveBeenCalled()
  await act(async () => { build.retry(context) })
  expect(build.failure).toBeUndefined()
  if (context === 'turn') {
    expect(createTurn).toHaveBeenCalledTimes(1)
    expect(createTurn.mock.calls[0]?.[2]).toEqual({ message: '一覧を作る' })
    expect(generation).not.toHaveBeenCalled()
  } else {
    expect(generation).toHaveBeenCalledTimes(1)
    expect(createTurn).not.toHaveBeenCalled()
  }
})

test.each(['turn', 'plan'] as const)('a recorded %s policy failure never retries automatically or offers retry', async (context) => {
  const operation = { id: 'policy-failed', status: 'failed' as const, startedAt: at, finishedAt: at, devWorkspaceId: 'workspace-1', error: 'ai_approval_policy_denied' }
  const generation = spyOn(api, 'createGeneration')
  restore.push(() => generation.mockRestore())
  await mount({
    ...draft, conversationTurns: context === 'turn' ? [{ ...turn('policy-failed', '一覧を作る', 0), ...operation }] : [turn('kickoff', buildCopy.questions.kickoffReply, 0)],
    creationPlanGenerations: context === 'plan' ? [operation] : [],
  }, { ...initial, planRequested: true })
  expect(build.failure?.kind).toBe('policy')
  expect(build.session.messages.at(-1)).not.toHaveProperty('retry')
  expect(build.session.planRetries).toBe(0)
  expect(build.session.planRequested).toBe(false)
  await render()
  expect(createTurn).not.toHaveBeenCalled()
  expect(generation).not.toHaveBeenCalled()
})

test('a turn admission failure retains the policy detail instead of the generic 412 message', async () => {
  createTurn.mockRejectedValue(new ORPCError('PRECONDITION_FAILED', {
    status: 412, data: { body: { error: { code: 'failed_precondition', message: 'runtime unavailable', details: { reason: 'ai_approval_policy_denied', policy: 'default' } } } },
  }))
  await mount()
  await act(async () => { build.send('一覧を作る') })
  expect(build.failure?.kind).toBe('policy')
  expect(build.failure?.reason).toContain('「default」')
  expect(build.session.messages.at(-1)).not.toHaveProperty('retry')
  await render()
  expect(createTurn).toHaveBeenCalledTimes(1)
})

const publishedAt = '2026-10-26T00:03:00Z'
const publishedDraft: ApplicationDraft = {
  ...draft, phase: 'created', createdApplicationId: 'app-platform', createdApplicationStackId: 'stack-1',
  conversationTurns: [], publishedAt, publishPreferences: { name: draft.title, shareScope: 'group' },
}
// The bind answer's wire; the bind step reads it through the app contract.
const publishedApp = {
  id: 'app-console', slug: 'ledger', displayName: draft.title, description: '', icon: '', tags: [], guide: '', capabilities: [], screenshots: [],
  group: { id: 'sales', path: 'sales', name: 'Sales' }, owners: [me.person], stackId: 'stack-1', appName: 'app-platform',
  share: { scope: 'group', groupIds: ['sales'], extraPersonIds: [] }, createdBy: me.person, createdAt: at, updatedAt: at,
}

async function mountPublished(current = publishedDraft, session = initial) {
  const bind = spyOn(binding, 'bindCreatedConsoleApp').mockResolvedValue(appOf(publishedApp))
  restore.push(() => bind.mockRestore())
  await mount(current, session)
}

test('a fresh tab restores publication and never starts implementation', async () => {
  implementation.state.phase = 'idle'
  await mountPublished()
  expect(build.result).toMatchObject({ stage: 'publish', primary: { action: 'continue', enabled: true } })
  expect(implementationEnabled).toBe(false)
  expect(implementation.start).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

test('continuing affects only this published version and a newer publication is shown again', async () => {
  implementation.state.phase = 'idle'
  await mountPublished()
  await act(async () => { build.patch({ continuedAfterPublishAt: publishedAt }) })
  expect(build.result.stage).toBe('build')
  expect(implementationEnabled).toBe(true)
  expect(implementation.start).toHaveBeenCalledTimes(1)
  expect(readBuildSession(draft.id)?.continuedAfterPublishAt).toBe(publishedAt)
  await act(async () => { client.setQueryData(queryKey, draftOf({ ...publishedDraft, publishedAt: '2026-10-26T00:04:00Z' })) })
  expect(build.result).toMatchObject({ stage: 'publish', primary: { action: 'continue' } })
  expect(implementationEnabled).toBe(false)
})

test('pending replies and later runs prevent the published stage', async () => {
  const pending = [{ text: '検索を追加', at }]
  await mountPublished(publishedDraft, { ...initial, pending })
  expect(build.result.stage).toBe('build')
  expect(implementationEnabled).toBe(true)
  await act(async () => {
    build.patch({ pending: [] })
    client.setQueryData(queryKey, draftOf({
      ...publishedDraft,
      implementationRuns: [{ id: 'impl-later', status: 'succeeded', startedAt: '2026-10-26T00:04:00Z', devWorkspaceId: 'ws-1', taskIds: [], tasks: [] }],
    }))
  })
  expect(build.result.stage).toBe('build')
  expect(implementationEnabled).toBe(true)
})

test('sending a change remembers the publication being continued even after the reply is consumed', async () => {
  await mountPublished()
  await act(async () => { build.send('検索を追加') })
  expect(build.session.continuedAfterPublishAt).toBe(publishedAt)
  expect(build.session.pending).toHaveLength(1)
  await act(async () => { build.patch({ pending: [] }) })
  expect(build.result.stage).toBe('build')
})

test('publication persists after app updates and failed persistence retries only the draft command', async () => {
  await mountPublished(publishedDraft, { ...initial, continuedAfterPublishAt: publishedAt })
  const error = new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 })
  update.mockRejectedValueOnce(error)
  await act(async () => { await build.published() })
  expect(update.mock.calls.map((call) => call[2])).toEqual([{ markPublished: true }])
  expect(build.result.stage).toBe('build')
  expect(build.session.continuedAfterPublishAt).toBe(publishedAt)
  expect(build.failure).toBeDefined()
  expect(build.session.messages.at(-1)).toMatchObject({ role: 'notice', retry: 'publish' })
  update.mockImplementation(async () => draftOf({ ...publishedDraft, publishedAt: '2026-10-26T00:04:00Z' }))
  await act(async () => { build.retry() })
  expect(update.mock.calls.map((call) => call[2])).toEqual([{ markPublished: true }, { markPublished: true }])
  expect(build.failure).toBeUndefined()
  expect(build.session.messages.some((message) => message.role === 'notice')).toBe(false)
  expect(build.session.continuedAfterPublishAt).toBeUndefined()
  expect(client.getQueryData<ApplicationDraft>(queryKey)?.publishedAt).toBe('2026-10-26T00:04:00Z')
  expect(build.result).toMatchObject({ stage: 'publish', primary: { action: 'continue' } })
  expect(implementation.retry).not.toHaveBeenCalled()
})

test('the drafts list uses server publication, regardless of a tab continuation or pending reply', async () => {
  let items: UnfinishedItem[] = []
  function DraftListHarness() {
    const result = useUnfinished(me, { poll: false })
    useLayoutEffect(() => { items = result.items }, [result.items])
    return null
  }
  saveBuildSession(draft.id, { ...initial, continuedAfterPublishAt: publishedAt, pending: [{ text: '検索を追加', at }] })
  client.setQueryData(consoleKeys.apps({ scope: 'mine' }), [])
  client.setQueryData(buildKeys.drafts(me.projectId), { data: [draftOf(publishedDraft)] })
  await act(async () => { root.render(<QueryClientProvider client={client}><DraftListHarness /></QueryClientProvider>) })
  expect(items).toMatchObject([{ kind: 'build', stage: 'publish' }])
  await act(async () => {
    client.setQueryData(buildKeys.drafts(me.projectId), { data: [draftOf({
      ...publishedDraft,
      implementationRuns: [{ id: 'impl-later', status: 'running', startedAt: '2026-10-26T00:04:00Z', devWorkspaceId: 'ws-1', taskIds: [], tasks: [] }],
    })] })
    root.render(<QueryClientProvider client={client}><DraftListHarness /></QueryClientProvider>)
  })
  expect(items).toMatchObject([{ kind: 'build', stage: 'build' }])
})
