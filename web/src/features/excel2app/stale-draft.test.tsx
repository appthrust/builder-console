// A draft read that is older than this flow's own writes must not undo them
// (use-excel2app-draft.ts `receive`): a turn appended after an earlier saved
// change keeps both, and nothing is sent again because the turn went missing.
import { afterEach, beforeEach, expect, spyOn, test, type Mock } from 'bun:test'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as api from '../../api/build'
import { buildKeys } from '../../api/queries/build'
import * as excelQueries from '../../api/queries/excel'
import { keys } from '../../api/queries/shared'
import { draftOf, turnOf } from '../../api/testing/build-domain'
import { workbookListFrom } from '../../api/testing/excel-domain'
import type { BuildDraft } from '../../model/contracts/build'
import { serializeSpec } from '../../model/build/spec'
import { UI_DESIGN_INIT, useExcel2AppDraft } from './use-excel2app-draft'

const projectId = 'project-stale'
const at = '2026-11-13T00:00:00Z'
const WB = 'wb-00000000000a'
const summary = { id: WB, fileName: '受注台帳.xlsx', sheetCount: 1, rowCount: 3, truncated: false, bytes: 100, digest: 'b'.repeat(64), addedAt: at }
/** An analysed set without a design yet: entering the preview asks for the default design (one ui-design turn). */
const analysed: ApplicationDraft = {
  id: 'draft-stale', projectId, title: '受注台帳', intent: 'Excel から作る', phase: 'specifying', specMarkdown: serializeSpec({ name: '受注台帳', users: [], screens: [], records: [], rules: [] }, '# 受注\n'), architectureMarkdown: '',
  creationExecutions: [], ownerUserId: 'user-1', createdAt: at, updatedAt: at,
  source: { kind: 'excel', revision: at, workbooks: [summary] },
  excelAnalysis: { summary: '受注を記録する', bullets: [], capabilities: [], workbooks: [{ workbookId: WB, role: 'records', summary: '' }], entities: [], flows: [], findings: [] },
}
const BODY = '# 受注\n\n担当者ごとに見たい\n'
/** The saved specification: the unchanged front-matter and the edited body. */
const SAVED = analysed.specMarkdown.replace(/# 受注\n$/, BODY)
const queryKey = buildKeys.draft(projectId, analysed.id)

let client: QueryClient
let root: Root
interface FlowUnderTest {
  draft?: BuildDraft
  setHint(hint: string): void
  spec: { save(body: string): Promise<boolean> }
  design: { init(): void }
}
let flow: FlowUnderTest
let server: ApplicationDraft
let update: Mock<typeof api.updateDraft>
let createTurn: Mock<typeof api.createTurn>
let getDraft: Mock<typeof api.getDraft>
let spies: { mockRestore(): void }[]

function Harness() {
  const current = useExcel2AppDraft(projectId, analysed.id)
  useLayoutEffect(() => { flow = current })
  return null
}

beforeEach(async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchInterval: false } } })
  client.setQueryData(keys.creationTools(projectId), { codexAvailable: true })
  server = analysed
  client.setQueryData(queryKey, draftOf(server))
  // The in-memory server: each write changes it and answers what it wrote; a read answers it as it is.
  update = spyOn(api, 'updateDraft').mockImplementation(async (_projectId, _id, payload) => {
    server = { ...server, ...payload } as ApplicationDraft
    return draftOf(server)
  })
  createTurn = spyOn(api, 'createTurn').mockImplementation(async (_projectId, _id, request) => {
    const turn = { id: `turn-${(server.conversationTurns?.length ?? 0) + 1}`, kind: request.kind ?? 'conversation', userMessage: request.message, status: 'pending' as const, startedAt: at, devWorkspaceId: 'ws-1' }
    server = { ...server, conversationTurns: [...(server.conversationTurns ?? []), turn] }
    return turnOf(turn)
  })
  getDraft = spyOn(api, 'getDraft').mockImplementation(async () => draftOf(server))
  spies = [
    update, createTurn, getDraft,
    spyOn(excelQueries, 'listWorkbooks').mockImplementation(async () => workbookListFrom({ data: [{ workbook: summary }], meta: { total: 1 } })),
  ]
  root = createRoot(document.createElement('div'))
  await act(async () => { root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>) })
})

afterEach(async () => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0))
  await act(async () => { root.unmount() })
  client.clear()
  for (const spy of spies) spy.mockRestore()
})

/** What the flow and the cache now hold: the saved specification and the ui-design turns. */
function held(draft: BuildDraft | undefined) {
  return { spec: draft?.specMarkdown, designTurns: draft?.conversationTurns.map((turn) => turn.userMessage) }
}

test('a draft poll that started before a saved change and a turn answers after both: it cannot put back the older draft, and the turn is not sent again', async () => {
  // The poll reads the draft as it was before either write; its answer arrives last.
  const poll = Promise.withResolvers<BuildDraft>()
  getDraft.mockImplementationOnce(() => poll.promise)
  const before = draftOf(server)
  let polled: Promise<unknown> = Promise.resolve()
  await act(async () => { polled = client.refetchQueries({ queryKey }) })
  expect(getDraft).toHaveBeenCalledTimes(1)

  await act(async () => { expect(await flow.spec.save(BODY)).toBe(true) })
  await act(async () => { flow.design.init() })
  await act(async () => { await Bun.sleep(0) })
  expect(createTurn).toHaveBeenCalledTimes(1)

  await act(async () => {
    poll.resolve(before)
    await polled
  })
  const expected = { spec: SAVED, designTurns: [UI_DESIGN_INIT] }
  expect(held(client.getQueryData<BuildDraft>(queryKey))).toEqual(expected)
  expect(held(flow.draft)).toEqual(expected)
  // Entering the preview again finds the turn on its way: nothing is sent twice.
  await act(async () => { flow.design.init() })
  await act(async () => { await Bun.sleep(0) })
  expect(createTurn).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledTimes(1)
  expect(server.conversationTurns?.map((turn) => turn.userMessage)).toEqual([UI_DESIGN_INIT])
})

test('a render before the cache notification reaches the flow cannot make the turn build on the draft before the saved change', async () => {
  // React Query's observer notification for the saved change is held back; the flow re-renders for its own state meanwhile.
  const pending: (() => void)[] = []
  notifyManager.setScheduler((callback) => { pending.push(callback) })
  await act(async () => { expect(await flow.spec.save(BODY)).toBe(true) })
  await act(async () => { flow.setHint('担当者ごとに') })
  expect(flow.draft?.specMarkdown).toBe(SAVED)
  await act(async () => { flow.design.init() })
  await act(async () => { await Bun.sleep(0) })
  expect(createTurn).toHaveBeenCalledTimes(1)
  expect(held(client.getQueryData<BuildDraft>(queryKey))).toEqual({ spec: SAVED, designTurns: [UI_DESIGN_INIT] })

  notifyManager.setScheduler((callback) => setTimeout(callback, 0))
  await act(async () => {
    for (const callback of pending.splice(0)) callback()
    await Bun.sleep(5)
  })
  expect(held(flow.draft)).toEqual({ spec: SAVED, designTurns: [UI_DESIGN_INIT] })
  await act(async () => { flow.design.init() })
  expect(createTurn).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledTimes(1)
})
