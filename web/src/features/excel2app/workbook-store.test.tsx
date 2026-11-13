import { afterEach, beforeEach, expect, mock, spyOn, test, type Mock } from 'bun:test'
import type { ApplicationDraft, ApplicationDraftWorkbook, ApplicationDraftWorkbookSummary, ExcelAnalysis } from '@appthrust/api-schema/platform-api'
import { ORPCError } from '@orpc/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as api from '../../api/build'
import { draftOf, turnOf } from '../../api/testing/build-domain'
import type { BuildDraft } from '../../model/contracts/build'
import { buildKeys } from '../../api/queries/build'
import { keys } from '../../api/queries/shared'
import type { BuildFailure } from '../../model/build/types'
import type { CollectedWorkbook } from './collect'
import type { WorkbookGrid } from './model'
import { SAMPLE_SETS } from './samples'
import { useExcel2AppDraft, type AnalysisProblem, type CollectionResult } from './use-excel2app-draft'
import * as xlsx from './xlsx'

const projectId = 'project-workbook-store'
const at = '2026-11-01T00:00:00Z'
const draft: ApplicationDraft = {
  id: 'draft-workbook', projectId, title: '台帳', intent: 'Excel から作る', phase: 'specifying',
  specMarkdown: '', architectureMarkdown: '', creationExecutions: [], ownerUserId: 'user-1', createdAt: at, updatedAt: at,
}
const workbook = SAMPLE_SETS[0]!.workbooks[0]!
const summary: ApplicationDraftWorkbookSummary = { id: 'wb-000000000001', fileName: workbook.fileName, sheetCount: 3, rowCount: 28, bytes: 100, digest: 'a'.repeat(64), truncated: false, addedAt: at }
const error = (status: number, reason: string, details: Record<string, unknown> = {}) => new ORPCError(status === 400 ? 'BAD_REQUEST' : 'CONFLICT', {
  status, data: { body: { error: { code: 'invalid_argument', message: reason, details: { reason, ...details } } } },
})

interface FlowUnderTest {
  draft?: BuildDraft
  files: CollectedWorkbook[]
  collecting: boolean
  readOnly: boolean
  offline: boolean
  reading?: ExcelAnalysis
  addFiles(files: readonly File[]): Promise<CollectionResult | undefined>
  addSample(grids: readonly WorkbookGrid[]): Promise<CollectionResult | undefined>
  retryFile(key: string): Promise<void>
  removeWorkbook(key: string, workbookId?: string): Promise<void>
  startAnalysis(): Promise<void>
  setHint(hint: string): void
  analysis: { problem?: AnalysisProblem; failure?: BuildFailure; continueOffline(): Promise<void>; retry(): void }
}
let client: QueryClient
let root: Root
let container: HTMLDivElement
let flow: FlowUnderTest
let drafts: Map<string, ApplicationDraft>
let grids: Map<string, ApplicationDraftWorkbook>
let create: Mock<typeof api.createDraft>
let update: Mock<typeof api.updateDraft>
let add: Mock<typeof api.addWorkbook>
let removeDraft: Mock<typeof api.deleteDraft>
let removeWorkbook: Mock<typeof api.removeWorkbook>
let get: Mock<typeof api.getDraft>
let list: Mock<typeof api.listWorkbooks>
let grid: Mock<typeof api.getWorkbook>
let turn: Mock<typeof api.createTurn>
let parse: Mock<typeof xlsx.readXlsx>
let confirm: Mock<(message?: string) => boolean>

function Harness({ draftId }: { draftId?: string }) {
  const current = useExcel2AppDraft(projectId, draftId)
  useLayoutEffect(() => { flow = current })
  return null
}
async function render(draftId?: string) {
  await act(async () => { root.render(<QueryClientProvider client={client}><Harness draftId={draftId} /></QueryClientProvider>) })
}
function seedDraft(value: ApplicationDraft) {
  drafts.set(value.id, value)
  client.setQueryData(buildKeys.draft(projectId, value.id), draftOf(value))
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  client.setQueryData(keys.creationTools(projectId), { codexAvailable: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  drafts = new Map()
  grids = new Map()
  let nextId = 0
  let nextWorkbook = 0
  create = spyOn(api, 'createDraft').mockImplementation(async (_projectId, payload) => {
    const next = { ...draft, ...payload, id: `draft-${++nextId}` }
    drafts.set(next.id, next)
    return draftOf(next)
  })
  update = spyOn(api, 'updateDraft').mockImplementation(async (_projectId, id, payload) => {
    const next = { ...drafts.get(id)!, ...payload }
    drafts.set(id, next)
    return draftOf(next)
  })
  add = spyOn(api, 'addWorkbook').mockImplementation(async (_projectId, id, payload) => {
    const member = { ...summary, id: `wb-${String(++nextWorkbook).padStart(12, '0')}`, fileName: payload.fileName }
    grids.set(member.id, payload)
    const current = drafts.get(id)!
    const next: ApplicationDraft = { ...current, source: { kind: 'excel', revision: at, workbooks: [...(current.source?.workbooks ?? []), member] }, excelAnalysis: undefined, uiDesign: undefined }
    drafts.set(id, next)
    return { draft: draftOf(next), workbook: member }
  })
  removeDraft = spyOn(api, 'deleteDraft').mockImplementation(async (_projectId, id) => {
    drafts.delete(id)
    return { deleted: true, id }
  })
  removeWorkbook = spyOn(api, 'removeWorkbook').mockImplementation(async (_projectId, id, workbookId) => {
    const current = drafts.get(id)!
    const members = current.source!.workbooks.filter((member) => member.id !== workbookId)
    const next: ApplicationDraft = { ...current, source: members.length ? { kind: 'excel', revision: at, workbooks: members } : undefined, excelAnalysis: undefined, uiDesign: undefined }
    drafts.set(id, next)
    grids.delete(workbookId)
    return draftOf(next)
  })
  get = spyOn(api, 'getDraft').mockImplementation(async (_projectId, id) => draftOf(drafts.get(id)!))
  list = spyOn(api, 'listWorkbooks').mockImplementation(async (_projectId, id) => {
    const data = (drafts.get(id)?.source?.workbooks ?? []).map((workbook) => ({ workbook }))
    return { data, meta: { total: data.length } }
  })
  grid = spyOn(api, 'getWorkbook').mockImplementation(async (_projectId, _id, workbookId) => grids.get(workbookId)!)
  turn = spyOn(api, 'createTurn').mockImplementation(async (_projectId, id, request) => {
    const result = { id: 'turn-1', kind: request.kind ?? 'conversation', userMessage: request.message || 'Analyze workbooks', status: 'pending' as const, startedAt: at, devWorkspaceId: 'ws-1' }
    drafts.set(id, { ...drafts.get(id)!, conversationTurns: [result] })
    return turnOf(result)
  })
  parse = spyOn(xlsx, 'readXlsx').mockImplementation(async (file) => ({ ...workbook, fileName: file.name }))
  // The shared DOM preload has no window.confirm; install a stub instead of spying on a missing property.
  confirm = mock(() => true)
  Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirm })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  client.clear()
  container.remove()
  for (const spy of [create, update, add, removeDraft, removeWorkbook, get, list, grid, turn, parse]) spy.mockRestore()
  Reflect.deleteProperty(window, 'confirm')
})

test.each([false, true])('failed first POST deletes the new draft or reuses it when deletion fails=%s', async (cleanupFails) => {
  if (cleanupFails) removeDraft.mockRejectedValue(new Error('Delete unavailable'))
  add.mockRejectedValueOnce(error(413, 'WorkbookTooLarge')).mockRejectedValueOnce(error(400, 'WorkbookRowInvalid'))
  await render()
  await act(async () => { await flow.addFiles([new File([], 'a.xlsx')]) })
  expect(flow.files.at(-1)?.state).toBe('tooLarge')
  expect(drafts.size).toBe(cleanupFails ? 1 : 0)
  await render()
  await act(async () => { await flow.addFiles([new File([], 'b.xlsx')]) })
  expect(flow.files.at(-1)?.state).toBe('invalid')
  expect(drafts.size).toBe(cleanupFails ? 1 : 0)
  expect(create).toHaveBeenCalledTimes(cleanupFails ? 1 : 2)
  expect(update).not.toHaveBeenCalled()
  expect(removeDraft).toHaveBeenCalledTimes(cleanupFails ? 1 : 2)
  if (cleanupFails) expect(add.mock.calls.map((call) => call[1])).toEqual(['draft-1', 'draft-1'])
})

test('files parse and store one at a time; one failure does not block later files or start AI', async () => {
  const gate = Promise.withResolvers<WorkbookGrid>()
  parse.mockImplementationOnce(() => gate.promise).mockRejectedValueOnce(new Error('Invalid ZIP'))
  await render()
  let pending: Promise<CollectionResult | undefined>
  await act(async () => { pending = flow.addFiles(['first.xlsx', 'bad.xlsx', 'third.xlsx', 'notes.txt', '~$skip.xlsx'].map((name) => new File([], name))) })
  expect(parse).toHaveBeenCalledTimes(1)
  expect(add).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(flow.collecting).toBe(true)
  await act(async () => { gate.resolve({ ...workbook, fileName: 'first.xlsx' }); await pending! })
  expect(add.mock.calls.map((call) => call[2].fileName)).toEqual(['first.xlsx', 'third.xlsx'])
  expect(flow.files.map((file) => [file.fileName, file.state])).toEqual([['first.xlsx', 'stored'], ['third.xlsx', 'stored'], ['bad.xlsx', 'unreadable'], ['notes.txt', 'unsupported']])
  expect(create).toHaveBeenCalledTimes(1)
  expect(turn).not.toHaveBeenCalled()
  expect(flow.collecting).toBe(false)
})

test('retry keeps the Idempotency-Key and existing draft; starting patches set intent before the turn with its hint', async () => {
  seedDraft(draft)
  add.mockRejectedValueOnce(new Error('Network unavailable'))
  await render(draft.id)
  await act(async () => { await flow.addFiles([new File([], 'April.xlsx')]) })
  const failed = flow.files[0]!
  expect(failed.state).toBe('failed')
  await act(async () => { await flow.retryFile(failed.key) })
  expect(add.mock.calls[0]![3]).toBe(add.mock.calls[1]![3])
  expect(removeDraft).not.toHaveBeenCalled()
  expect(flow.files[0]?.state).toBe('stored')
  await act(async () => { flow.setHint('April and May belong together') })
  await act(async () => { await flow.startAnalysis() })
  expect(update.mock.calls.at(-1)?.[2]).toMatchObject({ title: 'April', intent: expect.stringContaining('April.xlsx') })
  expect(turn.mock.calls[0]?.[2]).toEqual({ kind: 'excel-analysis', message: 'April and May belong together' })
  expect(flow.draft?.source?.workbooks).toHaveLength(1)
})

test.each([
  [{ sheet: '台帳', row: 2 }, { sheet: '台帳', row: 2 }],
  [{ sheet: 3, row: -1 }, undefined],
  [{ sheet: '台帳', row: '2' }, { sheet: '台帳', row: undefined }],
] as const)('400 keeps only valid location details: %j', async (details, location) => {
  add.mockRejectedValue(error(400, 'WorkbookRowInvalid', details!))
  await render()
  await act(async () => { await flow.addFiles([new File([], 'invalid.xlsx')]) })
  expect(flow.files[0]?.state).toBe('invalid')
  expect(flow.files[0]?.location).toEqual(location)
})

test('a sample stores all members and starts exactly one analysis after the last POST', async () => {
  await render()
  await act(async () => { await flow.addSample([{ ...workbook, fileName: 'April.xlsx' }, { ...workbook, fileName: 'May.xlsx' }]) })
  expect(add).toHaveBeenCalledTimes(2)
  expect(turn).toHaveBeenCalledTimes(1)
  expect(update.mock.calls[0]?.[2].intent).toContain('1')
  expect(flow.draft?.source?.workbooks).toHaveLength(2)
})

test('analysis requires confirmation before set changes; cancelling never writes and removing the last clears the source', async () => {
  const analysed: ApplicationDraft = { ...draft, source: { kind: 'excel', revision: at, workbooks: [summary] }, excelAnalysis: { summary: 'Done', bullets: [], capabilities: [], entities: [], workbooks: [{ workbookId: summary.id, role: 'unused', summary: '' }], flows: [], findings: [] } }
  seedDraft(analysed)
  await render(draft.id)
  confirm.mockReturnValue(false)
  await act(async () => { await flow.addFiles([new File([], 'May.xlsx')]); await flow.removeWorkbook(summary.id, summary.id) })
  expect(add).not.toHaveBeenCalled()
  expect(removeWorkbook).not.toHaveBeenCalled()
  expect(flow.draft?.excelAnalysis).toEqual(analysed.excelAnalysis)
  confirm.mockReturnValue(true)
  await act(async () => { await flow.removeWorkbook(summary.id, summary.id) })
  expect(flow.draft?.source).toBeUndefined()
  expect(flow.draft?.excelAnalysis).toBeUndefined()
  expect(flow.files).toEqual([])
})

test.each([[412, 'WorkbookMissing', 'unavailable'], [500, 'insufficient_quota', 'quota']] as const)('analysis rejection %s is explicit and never runs local inference', async (status, reason, problem) => {
  seedDraft({ ...draft, source: { kind: 'excel', revision: at, workbooks: [summary] } })
  turn.mockRejectedValue(error(status, reason))
  await render(draft.id)
  await act(async () => { await flow.startAnalysis() })
  expect(flow.analysis.problem).toBe(problem)
  expect(flow.reading).toBeUndefined()
  expect(flow.offline).toBe(false)
  expect(turn).toHaveBeenCalledTimes(1)
})

test('analysis admission preserves the policy name even when tools still say available', async () => {
  seedDraft({ ...draft, source: { kind: 'excel', revision: at, workbooks: [summary] } })
  turn.mockRejectedValue(new ORPCError('PRECONDITION_FAILED', {
    status: 412, data: { body: { error: { code: 'failed_precondition', message: 'runtime unavailable', details: { reason: 'ai_approval_policy_denied', policy: 'default' } } } },
  }))
  await render(draft.id)
  await act(async () => { await flow.startAnalysis() })
  expect(flow.analysis.problem).toBe('policy')
  expect(flow.analysis.failure?.reason).toContain('「default」')
  expect(flow.offline).toBe(false)
  expect(flow.reading).toBeUndefined()
  expect(turn).toHaveBeenCalledTimes(1)
})

test('an ApplicationCreated conflict makes further uploads, removals and analysis read-only', async () => {
  seedDraft(draft)
  add.mockRejectedValue(error(409, 'ApplicationCreated'))
  await render(draft.id)
  await act(async () => { await flow.addFiles([new File([], 'April.xlsx')]) })
  expect(flow.readOnly).toBe(true)
  await act(async () => { await flow.addFiles([new File([], 'May.xlsx')]); await flow.removeWorkbook('missing', summary.id); await flow.startAnalysis() })
  expect(add).toHaveBeenCalledTimes(1)
  expect(removeWorkbook).not.toHaveBeenCalled()
  expect(turn).not.toHaveBeenCalled()
})

test('a later successful file reuses the draft retained after failed cleanup', async () => {
  removeDraft.mockRejectedValue(new Error('Delete unavailable'))
  add.mockRejectedValueOnce(error(400, 'WorkbookRowInvalid'))
  await render()
  await act(async () => { await flow.addFiles([new File([], 'bad.xlsx')]) })
  await render()
  await act(async () => { await flow.addFiles([new File([], 'good.xlsx')]) })
  expect(create).toHaveBeenCalledTimes(1)
  expect(add.mock.calls.map((call) => call[1])).toEqual(['draft-1', 'draft-1'])
  expect(flow.draft?.source?.workbooks.map((member) => member.fileName)).toEqual(['good.xlsx'])
})

test('explicit offline continuation integrates the whole set and saves only its specification', async () => {
  client.setQueryData(keys.creationTools(projectId), { codexAvailable: false })
  await render()
  await act(async () => { await flow.addFiles([new File([], 'April.xlsx'), new File([], 'May.xlsx')]) })
  await act(async () => { await flow.analysis.continueOffline() })
  expect(flow.offline).toBe(true)
  expect(flow.reading?.workbooks).toHaveLength(2)
  expect(flow.reading?.entities.find((entity) => entity.kind === 'records')?.sources).toHaveLength(2)
  expect(flow.draft?.specMarkdown).toContain('April.xlsx')
  expect(flow.draft?.specMarkdown).toContain('May.xlsx')
  expect(flow.draft?.excelAnalysis).toBeUndefined()
  expect(turn).not.toHaveBeenCalled()
})

test('offline continuation is not allowed just because a turn failed while AI is available', async () => {
  await render()
  await act(async () => { await flow.addFiles([new File([], 'April.xlsx')]); await flow.analysis.continueOffline() })
  expect(flow.offline).toBe(false)
  expect(update).not.toHaveBeenCalled()
})

test('a partially stored sample stays in collection instead of silently analysing a smaller set', async () => {
  add.mockRejectedValueOnce(error(413, 'WorkbookTooLarge'))
  await render()
  let result: CollectionResult | undefined
  await act(async () => { result = await flow.addSample([{ ...workbook, fileName: 'April.xlsx' }, { ...workbook, fileName: 'May.xlsx' }]) })
  expect(result?.analysisRequested).toBe(false)
  expect(flow.files.some((file) => file.state === 'tooLarge')).toBe(true)
  expect(flow.draft?.source?.workbooks).toHaveLength(1)
  expect(turn).not.toHaveBeenCalled()
})

test('resuming a failed staged turn retries its original hint', async () => {
  seedDraft({ ...draft, source: { kind: 'excel', revision: at, workbooks: [summary] }, conversationTurns: [{ id: 'failed-1', kind: 'excel-analysis', userMessage: 'Keep the monthly ledgers together', status: 'failed', startedAt: at, devWorkspaceId: 'ws-1', error: 'Reading interrupted' }] })
  await render(draft.id)
  await act(async () => { flow.analysis.retry() })
  expect(turn.mock.calls[0]?.[2]).toEqual({ kind: 'excel-analysis', message: 'Keep the monthly ledgers together' })
})

test.each([[412, 'WorkbookMissing'], [409, 'ApplicationCreated']] as const)('binding a new draft to its URL retains rejected sample analysis state (%s)', async (status, reason) => {
  turn.mockRejectedValue(error(status, reason))
  await render()
  let result: CollectionResult | undefined
  await act(async () => { result = await flow.addSample([workbook]) })
  expect(result?.analysisRequested).toBe(true)
  const files = flow.files
  await render(result!.id)
  expect(flow.files).toEqual(files)
  expect(flow.draft?.id).toBe(result!.id)
  expect(flow.readOnly).toBe(status === 409)
  expect(flow.analysis.problem).toBe(status === 412 ? 'unavailable' : undefined)
  expect(turn).toHaveBeenCalledTimes(1)
})

test('binding a created draft retains failed file rows and retry keys alongside stored members', async () => {
  parse.mockRejectedValueOnce(new Error('Unreadable ZIP'))
  await render()
  let result: CollectionResult | undefined
  await act(async () => { result = await flow.addFiles([new File([], 'broken.xlsx'), new File([], 'saved.xlsx')]) })
  const before = flow.files
  expect(before.map((file) => file.state)).toEqual(['stored', 'unreadable'])
  await render(result!.id)
  expect(flow.files).toEqual(before)
  expect(flow.draft?.source?.workbooks).toHaveLength(1)
  expect(turn).not.toHaveBeenCalled()
})
