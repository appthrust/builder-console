import { createHash } from 'node:crypto'
import { beforeEach, expect, test } from 'bun:test'
import { ApplicationDraft, ApplicationDraftConversationTurn, ApplicationDraftWorkbookAddResponse, ApplicationDraftWorkbookListResponse, type ApplicationDraftWorkbook, ApplicationDraftWorkbookLimits, ExcelAnalysis, UiDesign } from '@appthrust/api-schema/platform-api'
import { toDraftWorkbook } from '../features/excel2app/model'
import { SAMPLE_SETS } from '../features/excel2app/samples'
import { parseAssistantMessage } from '../model/build/messages'
import { parseSpec } from '../model/build/spec'
import { platformRoutes } from './mock-platform'

const project = '/api/v1/projects/commerce'
const workbook: ApplicationDraftWorkbook = {
  fileName: '対応台帳.xlsx',
  sheets: [{ name: '対応台帳', rows: [['番号', '担当者', '期限', '状態'], [1, '田中', '2026-10-30', '未着手'], [2, '佐藤', '2026-10-31', '完了']], validations: { 3: ['未着手', '対応中', '完了'] }, mergedRanges: 0 }],
}

async function call(method: string, path: string, body?: unknown, key?: string) {
  const url = new URL(path, 'http://mock.test')
  const response = await platformRoutes(new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), url)
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  return { status: response.status, body: await response.json() }
}

async function createDraft() {
  const created = await call('POST', `${project}/application-drafts`, { title: '対応台帳', intent: 'Excel から対応台帳を作る' })
  expect(created.status).toBe(201)
  return `${project}/application-drafts/${created.body.resource.id}`
}

async function add(path: string, grid = workbook, key?: string) {
  const response = await call('POST', `${path}/workbooks`, grid, key)
  expect(response.status).toBe(201)
  return ApplicationDraftWorkbookAddResponse.parse(response.body)
}

async function advance() { await call('POST', '/api/v1/__mock/advance') }

async function completeTurn(path: string, kind: 'excel-analysis' | 'ui-design', message = '') {
  const created = await call('POST', `${path}/conversation-turns`, { kind, message })
  expect(created.status).toBe(202)
  expect(created.body.resource).toMatchObject({ kind, status: 'pending' })
  await advance()
  const settled = await call('GET', `${path}/conversation-turns/${created.body.resource.id}`)
  expect(settled.status).toBe(200)
  return ApplicationDraftConversationTurn.parse(settled.body)
}

beforeEach(async () => { await call('POST', '/api/v1/__mock/reset') })

test('set membership is ordered, grids are scoped to the draft, and lists never expose grids', async () => {
  const path = await createDraft()
  const other = await createDraft()
  expect((await call('GET', `${path}/workbooks`)).body).toEqual({ data: [], meta: { total: 0 } })
  const first = await add(path, workbook, 'first')
  const second = await add(path, { ...workbook, fileName: '別の台帳.xlsx' }, 'second')
  expect(second.draft.source?.workbooks.map((member) => member.id)).toEqual([first.workbook.id, second.workbook.id])
  expect(second.draft.source?.revision).toBe(second.draft.updatedAt)
  expect(Date.parse(second.draft.source!.revision)).toBeGreaterThan(Date.parse(first.draft.source!.revision))
  expect(await call('GET', `${path}/workbooks/${first.workbook.id}`)).toEqual({ status: 200, body: workbook })
  expect((await call('GET', `${other}/workbooks/${first.workbook.id}`)).status).toBe(404)
  expect((await call('GET', `${path.replace('/commerce/', '/elsewhere/')}/workbooks`)).status).toBe(404)
  const listed = (await call('GET', `${path}/workbooks`)).body
  expect(ApplicationDraftWorkbookListResponse.parse(listed).meta.total).toBe(2)
  expect(JSON.stringify(listed)).not.toContain('田中')
  expect(JSON.stringify((await call('GET', `${project}/application-drafts`)).body)).not.toContain('田中')
  expect((await call('DELETE', path)).status).toBe(202)
  expect((await call('GET', `${path}/workbooks/${first.workbook.id}`)).status).toBe(404)
  expect((await call('POST', `${path}/workbooks`, workbook)).status).toBe(404)
})

test('ids are key-derived, digests hash stored JSON, and replays preserve revision, readings and analysis', async () => {
  const path = await createDraft()
  const added = await add(path, workbook, 'same-file')
  const id = `wb-${createHash('sha256').update(`commerce/${added.draft.id}/same-file`).digest('hex').slice(0, 12)}`
  expect(added.workbook).toMatchObject({ id, bytes: Buffer.byteLength(JSON.stringify(workbook)), digest: createHash('sha256').update(JSON.stringify(workbook)).digest('hex') })
  await completeTurn(path, 'excel-analysis')
  const before = (await call('GET', path)).body
  const replay = await add(path, workbook, 'same-file')
  expect(replay.workbook).toEqual(added.workbook)
  expect(replay.draft).toEqual(before)
  expect(await call('POST', `${path}/workbooks`, { ...workbook, fileName: 'changed.xlsx' }, 'same-file')).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } })
  expect(await call('POST', `${path}/workbooks`, workbook, 'different-file')).toMatchObject({ status: 409, body: { error: { code: 'conflict', details: { reason: 'WorkbookDuplicate', workbookId: id } } } })
  const other = await createDraft()
  expect((await add(other, workbook, 'same-file')).workbook.id).not.toBe(id)
  expect((await call('GET', `${path}/workbooks`)).body.data[0].reading).toBeDefined()
})

function paddedWorkbook(index: number): ApplicationDraftWorkbook {
  const grid = { fileName: `${index}.xlsx`, sheets: [{ name: '台帳', rows: [['']] }] }
  grid.sheets[0]!.rows[0]![0] = 'a'.repeat(ApplicationDraftWorkbookLimits.maxWorkbookBytes - Buffer.byteLength(JSON.stringify(grid)))
  return grid
}

test('per-workbook byte limits use UTF-8 and rejected changes leave membership unchanged', async () => {
  const path = await createDraft()
  const grid = paddedWorkbook(0)
  expect((await add(path, grid)).workbook.bytes).toBe(512 * 1024)
  grid.sheets[0]!.rows[0]![0] += 'あ'
  expect(await call('POST', `${path}/workbooks`, grid)).toMatchObject({ status: 413, body: { error: { code: 'payload_too_large', details: { reason: 'WorkbookTooLarge' } } } })
  expect((await call('POST', `${path}/workbooks`, { fileName: 'empty.xlsx', sheets: [] })).status).toBe(400)
  expect((await call('GET', `${path}/workbooks`)).body.meta.total).toBe(1)
})

test.each([
  [{ name: '台帳', rows: null }, { reason: 'WorkbookSheetInvalid', sheet: '台帳' }],
  [{ name: '台帳', rows: Array.from({ length: 5001 }, () => []) }, { reason: 'WorkbookSheetInvalid', sheet: '台帳', row: 5001 }],
  [{ name: '台帳', rows: [null] }, { reason: 'WorkbookRowInvalid', sheet: '台帳', row: 1 }],
  [{ name: '台帳', rows: [Array(201).fill(null)] }, { reason: 'WorkbookRowInvalid', sheet: '台帳', row: 1 }],
  [{ name: '台帳', rows: [[{ invalid: true }]] }, { reason: 'WorkbookCellInvalid', sheet: '台帳', row: 1, column: 1 }],
  [{ name: '台帳', rows: [], validations: { '01': ['a'] } }, { reason: 'WorkbookValidationInvalid', sheet: '台帳' }],
  [{ name: '台帳', rows: [], validations: { '0': null } }, { reason: 'WorkbookValidationInvalid', sheet: '台帳', column: 1 }],
  [{ name: '台帳', rows: [], formulas: [{ row: -1, column: 0, formula: 'A1' }] }, { reason: 'WorkbookFormulaInvalid', sheet: '台帳', column: 1 }],
  [{ name: '台帳', rows: [], mergedRanges: -1 }, { reason: 'WorkbookSheetInvalid', sheet: '台帳' }],
])('grid errors retain R19 reasons and one-based coordinates: %j', async (sheet, details) => {
  const path = await createDraft()
  expect(await call('POST', `${path}/workbooks`, { fileName: 'invalid.xlsx', sheets: [sheet] })).toMatchObject({ status: 400, body: { error: { code: 'invalid_argument', details } } })
  expect((await call('GET', `${path}/workbooks`)).body.meta.total).toBe(0)
})

test('twenty workbooks are accepted; replay and duplicate checks precede the set-full gate', async () => {
  const path = await createDraft()
  for (let index = 0; index < 20; index++) await add(path, { ...workbook, fileName: `${index}.xlsx` }, `file-${index}`)
  expect(await call('POST', `${path}/workbooks`, { ...workbook, fileName: '21.xlsx' })).toMatchObject({ status: 409, body: { error: { details: { reason: 'WorkbookSetFull' } } } })
  expect((await call('POST', `${path}/workbooks`, { ...workbook, fileName: '0.xlsx' }, 'file-0')).status).toBe(201)
  expect(await call('POST', `${path}/workbooks`, { ...workbook, fileName: '0.xlsx' })).toMatchObject({ status: 409, body: { error: { details: { reason: 'WorkbookDuplicate' } } } })
  expect((await call('GET', `${path}/workbooks`)).body.meta.total).toBe(20)
})

test('set bytes and sheets accept the exact boundary and reject the next member without storing it', async () => {
  const bytesPath = await createDraft()
  for (let index = 0; index < 8; index++) await add(bytesPath, paddedWorkbook(index))
  expect(await call('POST', `${bytesPath}/workbooks`, workbook)).toMatchObject({ status: 413, body: { error: { code: 'payload_too_large', details: { reason: 'WorkbookSetTooLarge' } } } })
  expect((await call('GET', `${bytesPath}/workbooks`)).body.meta.total).toBe(8)
  const sheetsPath = await createDraft()
  for (let index = 0; index < 4; index++) await add(sheetsPath, { fileName: `${index}.xlsx`, sheets: Array.from({ length: 50 }, (_, sheet) => ({ name: `${sheet}`, rows: [] })) })
  expect(await call('POST', `${sheetsPath}/workbooks`, workbook)).toMatchObject({ status: 413, body: { error: { details: { reason: 'WorkbookSetTooLarge' } } } })
  expect((await call('GET', `${sheetsPath}/workbooks`)).body.meta.total).toBe(4)
})

test('one advance reads every member and produces one integrated analysis only on the draft', async () => {
  const path = await createDraft()
  const files = SAMPLE_SETS.find((sample) => sample.id === 'orders')!.workbooks
  const ids: string[] = []
  for (const file of files) ids.push((await add(path, toDraftWorkbook(file))).workbook.id)
  const started = (await call('POST', `${path}/conversation-turns`, { kind: 'excel-analysis', message: '' })).body.resource
  expect(started.excelProgress).toEqual({ stage: 'reading', workbooks: ids.map((workbookId, index) => ({ workbookId, state: index === 0 ? 'reading' : 'pending' })) })
  expect((await call('GET', path)).body.excelAnalysis).toBeUndefined()
  await advance()
  const rawTurn = (await call('GET', `${path}/conversation-turns/${started.id}`)).body
  expect(rawTurn).not.toHaveProperty('analysis')
  const turn = ApplicationDraftConversationTurn.parse(rawTurn)
  expect(turn.status).toBe('succeeded')
  expect(turn.excelProgress).toEqual({ stage: 'designing', workbooks: ids.map((workbookId) => ({ workbookId, state: 'read' })) })
  const draft = ApplicationDraft.parse((await call('GET', path)).body)
  const analysis = ExcelAnalysis.parse(draft.excelAnalysis)
  expect(analysis.entities[0]?.sources).toHaveLength(2)
  expect(analysis.entities[0]?.importRows).toBe(6)
  expect(analysis.entities[0]?.fields.find((field) => field.name === '得意先コード')?.referenceEntity).toBe('得意先マスタ')
  expect(parseSpec(draft.specMarkdown).spec.records.map((record) => record.name)).toEqual(analysis.entities.map((entity) => entity.name))
  expect(turn.specMarkdown).toBe(draft.specMarkdown)
  const assistant = parseAssistantMessage(turn.assistantMessage ?? '')
  expect(assistant.summary).toBe(analysis.summary)
  expect(assistant.changed).toEqual(turn.changed!)
  expect(assistant.question).toBeTruthy()
  const list = (await call('GET', `${path}/workbooks`)).body
  expect(ApplicationDraftWorkbookListResponse.parse(list).data.every((entry) => entry.reading?.workbookId === entry.workbook.id)).toBe(true)
  for (const entry of list.data) { expect(entry).not.toHaveProperty('grid'); expect(entry).not.toHaveProperty('sheets') }
})

test('set changes clear derived artifacts, keep remaining readings, and removing the last member clears source', async () => {
  const path = await createDraft()
  const first = await add(path, workbook, 'file')
  await completeTurn(path, 'excel-analysis')
  await completeTurn(path, 'ui-design', '__init__')
  const savedReading = (await call('GET', `${path}/workbooks`)).body.data[0].reading
  const second = await add(path, { ...workbook, fileName: '翌月.xlsx' })
  expect(second.draft.excelAnalysis).toBeUndefined()
  expect(second.draft.uiDesign).toBeUndefined()
  expect(Date.parse(second.draft.source!.revision)).toBeGreaterThan(Date.parse(first.draft.source!.revision))
  const started = (await call('POST', `${path}/conversation-turns`, { kind: 'excel-analysis', message: '' })).body.resource
  expect(started.excelProgress.workbooks.map((item: { state: string }) => item.state)).toEqual(['reused', 'reading'])
  await advance()
  expect((await call('GET', `${path}/conversation-turns/${started.id}`)).body.excelProgress.workbooks.map((item: { state: string }) => item.state)).toEqual(['reused', 'read'])
  expect((await call('GET', `${path}/workbooks`)).body.data[0].reading).toEqual(savedReading)
  const removed = await call('DELETE', `${path}/workbooks/${second.workbook.id}`)
  expect(removed.status).toBe(200)
  expect(removed.body.excelAnalysis).toBeUndefined()
  expect(removed.body.uiDesign).toBeUndefined()
  expect(Date.parse(removed.body.source.revision)).toBeGreaterThan(Date.parse(second.draft.source!.revision))
  expect((await call('GET', `${path}/workbooks/${second.workbook.id}`)).status).toBe(404)
  expect((await call('GET', `${path}/workbooks`)).body.data[0].reading).toEqual(savedReading)
  expect((await call('DELETE', `${path}/workbooks/${second.workbook.id}`)).status).toBe(404)
  const empty = await call('DELETE', `${path}/workbooks/${first.workbook.id}`)
  expect(empty.body.source).toBeUndefined()
  expect((await call('GET', `${path}/workbooks`)).body).toEqual({ data: [], meta: { total: 0 } })
  expect(await call('POST', `${path}/conversation-turns`, { kind: 'excel-analysis', message: '' })).toMatchObject({ status: 412, body: { error: { details: { reason: 'WorkbookMissing' } } } })
  // Deletion also deletes the old reading, even when an idempotency key recreates the same id.
  const recreated = await add(path, workbook, 'file')
  expect(recreated.workbook.id).toBe(first.workbook.id)
  expect((await call('GET', `${path}/workbooks`)).body.data[0]).toEqual({ workbook: recreated.workbook })
})

test.each(['conversation', 'excel-analysis', 'ui-design'] as const)('quota failure preserves %s artifacts and retry succeeds without a hidden local fallback', async (kind) => {
  const path = await createDraft()
  const added = await add(path)
  await completeTurn(path, 'excel-analysis')
  const before = ApplicationDraft.parse((await call('GET', path)).body)
  const message = kind === 'ui-design' ? '__init__' : '読み取ってください'
  await call('POST', '/api/v1/__mock/ai-quota', { exhausted: true })
  const started = (await call('POST', `${path}/conversation-turns`, { kind, message })).body.resource
  await advance()
  const failed = (await call('GET', `${path}/conversation-turns/${started.id}`)).body
  expect(failed).toMatchObject({ kind, userMessage: message, status: 'failed' })
  expect(failed.error).toContain('no credits remaining')
  expect(failed.finishedAt).toBeDefined()
  const stopped = ApplicationDraft.parse((await call('GET', path)).body)
  expect(stopped.specMarkdown).toBe(before.specMarkdown)
  expect(stopped.excelAnalysis).toEqual(before.excelAnalysis)
  expect((await call('GET', `${path}/workbooks/${added.workbook.id}`)).body).toEqual(workbook)
  await call('POST', '/api/v1/__mock/ai-quota', { exhausted: false })
  const retry = (await call('POST', `${path}/conversation-turns`, { kind, message })).body.resource
  if (kind === 'excel-analysis') expect(retry.excelProgress.workbooks[0].state).toBe('reused')
  await advance()
  expect((await call('GET', `${path}/conversation-turns/${retry.id}`)).body).toMatchObject({ status: 'succeeded', devWorkspaceId: stopped.devWorkspaceId })
})

test('UI turns persist entity-keyed designs and undo without overwriting unrelated specification sections', async () => {
  const path = await createDraft()
  await add(path)
  await completeTurn(path, 'excel-analysis')
  const initial = await completeTurn(path, 'ui-design', '__init__')
  expect(UiDesign.parse(initial.uiDesign).lists['対応台帳']?.layout).toBe('table')
  await call('PATCH', path, { specMarkdown: `${initial.specMarkdown}\n\n## 10. 補足\n利用者が追記した要件` })
  const changed = await completeTurn(path, 'ui-design', '一覧をカード表示にして')
  expect(changed.uiDesign?.lists['対応台帳']?.layout).toBe('cards')
  expect(changed.specMarkdown?.match(/^## 9\. 画面の決定/gm)).toHaveLength(1)
  expect(changed.specMarkdown).toContain('## 10. 補足\n利用者が追記した要件')
  const undone = await completeTurn(path, 'ui-design', `ひとつ前の設計に戻してください\n\`\`\`json\n${JSON.stringify(initial.uiDesign)}\n\`\`\``)
  expect(undone.uiDesign).toEqual(initial.uiDesign)
  expect((await call('GET', `${path}/conversation-turns/${changed.id}`)).body.uiDesign.lists['対応台帳'].layout).toBe('cards')
})

test('missing-set, codex, busy, role and kind-sensitive replay gates are retained', async () => {
  const path = await createDraft()
  const turns = `${path}/conversation-turns`
  expect(await call('POST', turns, { kind: 'excel-analysis', message: '' })).toMatchObject({ status: 412, body: { error: { code: 'failed_precondition', details: { reason: 'WorkbookMissing' } } } })
  const added = await add(path, workbook, 'file')
  await call('POST', '/api/v1/__mock/codex', { available: false })
  expect((await call('POST', turns, { kind: 'excel-analysis', message: '' })).status).toBe(412)
  await call('POST', '/api/v1/__mock/codex', { available: true })
  const payload = { kind: 'excel-analysis', message: '読み取って' }
  const first = await call('POST', turns, payload, 'same-turn')
  expect((await call('POST', turns, payload, 'same-turn')).body.resource.id).toBe(first.body.resource.id)
  expect((await call('POST', turns, { kind: 'ui-design', message: payload.message }, 'same-turn')).status).toBe(409)
  expect((await call('POST', `${path}/creation-plan-generations`)).status).toBe(409)
  for (const [method, route, body] of [['POST', `${path}/workbooks`, workbook], ['DELETE', `${path}/workbooks/${added.workbook.id}`, undefined]] as const) {
    expect(await call(method, route, body, 'file')).toMatchObject({ status: 409, body: { error: { details: { reason: 'DraftBusy' } } } })
  }
  await advance()
  await call('POST', `${path}/creation-plan-generations`)
  expect(await call('POST', `${path}/workbooks`, workbook, 'file')).toMatchObject({ status: 409, body: { error: { details: { reason: 'DraftBusy' } } } })
  await call('POST', '/api/v1/__mock/role', { role: 'Viewer' })
  expect((await call('POST', `${path}/workbooks`, workbook)).status).toBe(403)
  expect((await call('DELETE', `${path}/workbooks/${added.workbook.id}`)).status).toBe(403)
})

test('creation freezes membership before replay and missing-member checks, while ordinary conversation remains available', async () => {
  const path = await createDraft()
  const added = await add(path, workbook, 'file')
  const payload = { kind: 'ui-design', message: '__init__' }
  const initial = await call('POST', `${path}/conversation-turns`, payload, 'before-creation')
  await advance()
  await call('POST', `${path}/creation-plan-generations`)
  for (let step = 0; step < 4; step++) await advance()
  const validation = (await call('POST', `${path}/creation-plan-validations`)).body.resource
  const begun = (await call('POST', `${path}/creation-executions`, { clientRequestId: 'excel-create', creationPlanFingerprint: validation.creationPlanFingerprint })).body.resource
  await call('POST', `${path}/creation-executions/${begun.creationExecutions[0].id}/run`)
  for (let step = 0; step < 6; step++) await advance()
  expect((await call('GET', path)).body.createdApplicationId).toBeTruthy()
  for (const [method, route, body] of [['POST', `${path}/workbooks`, workbook], ['DELETE', `${path}/workbooks/wb-ffffffffffff`, undefined]] as const) {
    expect(await call(method, route, body, 'file')).toMatchObject({ status: 409, body: { error: { details: { reason: 'ApplicationCreated' } } } })
  }
  expect((await call('GET', `${path}/workbooks/${added.workbook.id}`)).body).toEqual(workbook)
  for (const kind of ['excel-analysis', 'ui-design']) expect(await call('POST', `${path}/conversation-turns`, { kind, message: '変更' })).toMatchObject({ status: 409, body: { error: { details: { reason: 'ApplicationCreated' } } } })
  expect((await call('POST', `${path}/conversation-turns`, payload, 'before-creation')).body.resource.id).toBe(initial.body.resource.id)
  expect((await call('POST', `${path}/conversation-turns`, { kind: 'conversation', message: '公開名を相談したい' })).status).toBe(202)
})

test('autoAdvance settles the same staged turn and reset clears all workbook artifacts', async () => {
  const path = await createDraft()
  const added = await add(path)
  const turn = (await call('POST', `${path}/conversation-turns`, { kind: 'excel-analysis', message: '' })).body.resource
  expect((await call('GET', `${path}/conversation-turns/${turn.id}`)).body.status).toBe('pending')
  await call('POST', '/api/v1/__mock/plan-generation', { autoAdvance: true })
  expect((await call('GET', path)).body.excelAnalysis).toBeDefined()
  expect((await call('GET', `${path}/conversation-turns/${turn.id}`)).body.excelProgress.stage).toBe('designing')
  await call('POST', '/api/v1/__mock/reset')
  const reusedPath = await createDraft()
  expect(reusedPath).toBe(path)
  expect((await call('GET', `${reusedPath}/workbooks/${added.workbook.id}`)).status).toBe(404)
  expect((await call('GET', `${reusedPath}/workbooks`)).body.meta.total).toBe(0)
})

test('non-Excel drafts can still initialize UI design from their specification', async () => {
  const path = await createDraft()
  await call('PATCH', path, { specMarkdown: '---\nspec:\n  name: 作業管理\n  records:\n    - name: 作業\n      fields: [タイトル, 担当者]\n---\n# 利用者が書いた仕様' })
  const initialized = await completeTurn(path, 'ui-design', '__init__')
  expect(initialized.uiDesign).toMatchObject({ appName: '作業管理', lists: { 作業: { layout: 'table', columns: ['タイトル', '担当者'] } } })
  expect(initialized.specMarkdown).toContain('# 利用者が書いた仕様')
})
