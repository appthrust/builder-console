import { describe, expect, test } from 'bun:test'
import type { ApplicationDraft, ApplicationDraftConversationTurn } from '@appthrust/api-schema/platform-api'
import { completeUiDesign, excelAnalysisOf, uiDesignOf, type CompleteUiDesign } from '../../model/contracts/excel'
import { draftOf, readEachFirst, readFirst, turnOf } from '../../api/testing/build-domain'
import { serializeSpec } from '../../model/build/spec'
import { textJa } from './copy'
import { fromDraftWorkbook, planApp, toDraftWorkbook } from './model'
import { designFromReadings } from './design'
import { SAMPLE_SETS } from './samples'
import { defaultUiDesign } from './ui-design'
import { analysisTitle as domainAnalysisTitle, classifyStoreError, currentTurns as domainCurrentTurns, designMessages as domainDesignMessages, designStack as domainDesignStack, fileStem, handOffPatch, isApplicationCreated, latestSaver, resumeStep as domainResumeStep, specParts, undoMessage, UI_DESIGN_INIT } from './use-excel2app-draft'

const currentTurns = readFirst(draftOf, domainCurrentTurns)
const resumeStep = readFirst(draftOf, domainResumeStep)
const designMessages = readEachFirst(turnOf, domainDesignMessages)
const designStack = readEachFirst(turnOf, domainDesignStack)
const analysisTitle = (draft: ApplicationDraft, turn: ApplicationDraftConversationTurn | undefined) => domainAnalysisTitle(draftOf(draft), turn === undefined ? undefined : turnOf(turn))

const workbook = SAMPLE_SETS[0]!.workbooks[0]!
const summary = { id: 'wb-000000000001', fileName: workbook.fileName, sheetCount: 3, rowCount: 28, truncated: false, bytes: 100, digest: 'a'.repeat(64), addedAt: '2026-10-26T00:01:00Z' }
const plan = planApp(excelAnalysisOf(designFromReadings([{ summary, grid: workbook }])), fileStem(workbook.fileName))
/** Designs as the ui-design turns carry them on the wire (complete: every kind known). */
const design: CompleteUiDesign = defaultUiDesign(plan)
const cards: CompleteUiDesign = { ...design, lists: Object.fromEntries(Object.entries(design.lists).map(([entity, list]) => [entity, { ...list, layout: 'cards' as const }])) }

const turn = (id: string, userMessage: string, minute: number, extra: Partial<ApplicationDraftConversationTurn> = {}): ApplicationDraftConversationTurn => ({
  kind: 'ui-design', id, userMessage, status: 'succeeded', startedAt: `2026-10-26T00:0${minute}:00Z`, devWorkspaceId: 'ws-1', ...extra,
})

const draft: ApplicationDraft = {
  id: 'draft-1', projectId: 'project-1', title: '不具合管理台帳', intent: 'Excel「不具合管理台帳.xlsx」から業務アプリを作る', phase: 'specifying', specMarkdown: '', architectureMarkdown: '',
  creationExecutions: [], ownerUserId: 'user-1', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z',
}
const source = { kind: 'excel' as const, revision: summary.addedAt, workbooks: [summary] }

describe('stored workbook', () => {
  test('dates become ISO day strings and validation columns string keys, and both convert back', () => {
    const grid = { fileName: 'a.xlsx', sheets: [{ name: 'S', rows: [['日付', '状態'], [new Date('2026-10-01T00:00:00Z'), '未着手']], validations: { 1: ['未着手', '完了'] }, mergedRanges: 0 }] }
    const stored = toDraftWorkbook(grid)
    expect(stored.sheets[0]!.rows[1]).toEqual(['2026-10-01', '未着手'])
    expect(stored.sheets[0]!.validations).toEqual({ 1: ['未着手', '完了'] })
    expect(fromDraftWorkbook(stored).sheets[0]!.validations).toEqual({ 1: ['未着手', '完了'] })
    expect(fileStem('不具合管理台帳.xlsx')).toBe('不具合管理台帳')
    expect(fileStem('macro.XLSM')).toBe('macro')
  })
  test('blank rows and cells the reader leaves out are sent as [] and null, never as null rows the API rejects', () => {
    // readXlsx fills the grid by coordinate, so a blank row between a title and a header is a hole.
    const rows: (string | Date | null)[][] = []
    rows[0] = ['4M変更管理台帳']
    rows[2] = ['管理No', '申請日']
    rows[3] = []
    rows[3][1] = new Date('2026-10-01T00:00:00Z')
    const body = JSON.parse(JSON.stringify(toDraftWorkbook({ fileName: 'a.xlsx', sheets: [{ name: 'S', rows }] })))
    expect(body.sheets[0].rows).toEqual([['4M変更管理台帳'], [], ['管理No', '申請日'], [null, '2026-10-01']])
  })
})

describe('resume', () => {
  test('resumes at the step the draft state implies', () => {
    expect(resumeStep(draft, false)).toBe(0)
    expect(resumeStep({ ...draft, source }, false)).toBe(0)
    expect(resumeStep({ ...draft, source, conversationTurns: [turn('t-analysis', 'Analyze workbooks', 1, { kind: 'excel-analysis', status: 'running' })] }, false)).toBe(1)
    expect(resumeStep({ ...draft, source }, true)).toBe(2)
    expect(resumeStep({ ...draft, source, conversationTurns: [turn('t-init', UI_DESIGN_INIT, 2, { status: 'running' })] }, true)).toBe(3)
    expect(resumeStep({ ...draft, source, uiDesign: design }, true)).toBe(3)
  })
  test('turns before the set revision no longer count, including for unstarted sets', () => {
    const old = turn('t-old', UI_DESIGN_INIT, 0)
    const replaced = { ...draft, source, conversationTurns: [old, turn('t-new', '一覧をカード表示に', 3)] }
    expect(currentTurns(replaced).map((item) => item.id)).toEqual(['t-new'])
    expect(resumeStep({ ...draft, source, conversationTurns: [old] }, true)).toBe(2)
    expect(resumeStep({ ...draft, source, conversationTurns: [{ ...old, kind: 'excel-analysis' }] }, false)).toBe(0)
    expect(currentTurns({ ...draft, source, conversationTurns: [turn('boundary', 'Analyze workbooks', 1)] }).map((item) => item.id)).toEqual(['boundary'])
  })
})

describe('specification', () => {
  test('keeps the front-matter verbatim and edits only the body', () => {
    const markdown = serializeSpec({ name: '不具合管理台帳', users: [], screens: [], records: [], rules: [] }, '# 仕様書\n\n## 1. 概要\n')
    const { frontMatter, body } = specParts(markdown)
    expect(body).toBe('# 仕様書\n\n## 1. 概要\n')
    expect(`${frontMatter}${body}`).toBe(markdown)
    expect(specParts('# 前置きなし')).toEqual({ frontMatter: '', body: '# 前置きなし' })
  })
  test('text typed while a slow save runs is saved after it, and 次へ waits for that save', async () => {
    let latest: string | undefined = 'A'
    const patched: string[] = []
    const pending: ((saved: boolean) => void)[] = []
    const save = latestSaver(
      (body) => {
        const { promise, resolve } = Promise.withResolvers<boolean>()
        patched.push(body)
        pending.push(resolve)
        return promise
      },
      () => latest,
      (body) => { if (latest === body) latest = undefined },
    )
    const blurA = save()
    latest = 'B'
    const blurB = save()
    const next = save()
    expect(patched).toEqual(['A'])
    pending.shift()!(true)
    await blurA
    await Promise.resolve()
    expect(patched).toEqual(['A', 'B'])
    let settled = false
    void next.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    pending.shift()!(true)
    expect(await blurB).toBe(true)
    expect(await next).toBe(true)
    expect(patched).toEqual(['A', 'B'])
    expect(latest).toBeUndefined()
    expect(await save()).toBe(true)
    expect(patched).toEqual(['A', 'B'])
  })
})

describe('screen design turns', () => {
  const init = turn('t-init', UI_DESIGN_INIT, 1, { uiDesign: design, assistantMessage: '## 要約\n6 画面を用意しました。\n## 次の質問\nほかに変えたいところはありますか？' })
  const change = turn('t-cards', '一覧をカード表示に', 2, { uiDesign: cards, assistantMessage: '## 要約\n一覧をカード表示にしました。' })
  const undo = turn('t-undo', undoMessage(design), 3, { uiDesign: design, assistantMessage: '## 要約\nひとつ前の画面に戻しました。' })

  test('undo history: each change pushes, each undo pops, so it survives a reload', () => {
    expect(designStack([init])).toEqual([uiDesignOf(design)])
    expect(designStack([init, change])).toEqual([uiDesignOf(design), uiDesignOf(cards)])
    expect(designStack([init, change, undo])).toEqual([uiDesignOf(design)])
    expect(designStack([init, change, turn('t-failed', '色を青に', 3, { status: 'failed' })])).toEqual([uiDesignOf(design), uiDesignOf(cards)])
  })

  test('an undo sends back exactly the complete design the stack read; a design with an unknown part cannot be sent', () => {
    const [read] = designStack([init])
    const back = completeUiDesign(read!)
    expect(back).toEqual(design)
    expect(JSON.parse(undoMessage(back!).split('```json\n')[1]!.replace(/\n```$/, ''))).toEqual(JSON.parse(JSON.stringify(design)))
    const newer = turn('t-newer', '予定表を追加', 4, { uiDesign: { ...design, screens: [...design.screens, { id: 'calendar:x', kind: 'calendar' as never, entity: 'x', title: '予定表', hidden: false }] } })
    expect(completeUiDesign(designStack([init, newer]).at(-1)!)).toBeUndefined()
  })
  test('the chat shows instructions and reply summaries, never __init__ or the undo JSON', () => {
    const failed = turn('t-failed', '色を青に', 4, { status: 'failed', error: 'AI が止まりました' })
    const running = turn('t-running', '密度をコンパクトに', 5, { status: 'running' })
    expect(designMessages([init, change, undo, failed, running])).toEqual([
      { role: 'assistant', text: '6 画面を用意しました。' },
      { role: 'user', text: '一覧をカード表示に' },
      { role: 'assistant', text: '一覧をカード表示にしました。' },
      { role: 'user', text: textJa.preview.undoMessage },
      { role: 'assistant', text: 'ひとつ前の画面に戻しました。' },
      { role: 'user', text: '色を青に' },
      { role: 'assistant', text: 'AI が止まりました', failed: true },
      { role: 'user', text: '密度をコンパクトに', pending: true },
    ])
  })
  test('the undo request carries the previous design as JSON within one turn message', () => {
    const message = undoMessage(design)
    expect(message.startsWith(textJa.preview.undoRequest)).toBe(true)
    expect(JSON.parse(message.slice(message.indexOf('{'), message.lastIndexOf('}') + 1))).toEqual(design)
    expect(message.length).toBeLessThanOrEqual(4000)
  })
})

describe('naming and hand-off', () => {
  const named = serializeSpec({ name: '不具合・改善管理', users: [], screens: [], records: [], rules: [] }, '# 仕様書\n')
  const analysis = turn('t-analysis', 'Analyze workbooks', 1, { kind: 'excel-analysis' })
  const analysed = { ...draft, source, specMarkdown: named, conversationTurns: [analysis] }

  test('the title follows the name the analysis wrote, only after it succeeded and while no app is being made', () => {
    expect(analysisTitle(analysed, analysis)).toBe('不具合・改善管理')
    expect(analysisTitle({ ...analysed, title: '不具合・改善管理' }, analysis)).toBeUndefined()
    expect(analysisTitle(analysed, { ...analysis, status: 'running' })).toBeUndefined()
    expect(analysisTitle(analysed, undefined)).toBeUndefined()
    expect(analysisTitle({ ...analysed, specMarkdown: '# 前置きなし' }, analysis)).toBeUndefined()
    expect(analysisTitle({ ...analysed, createdApplicationStackId: 'stack-1' }, analysis)).toBeUndefined()
    expect(analysisTitle({ ...analysed, creationExecutions: [{ id: 'exec-1', attempt: 1, status: 'running', startedAt: '2026-10-26T00:01:00Z', steps: [] }] }, analysis)).toBeUndefined()
  })

  test('the publish preferences travel with title and specification name alignment, never session storage', () => {
    const publish = { name: '品質不具合アプリ', shareScope: 'company' as const }
    const patch = handOffPatch(analysed, named, publish)
    expect(patch.title).toBe(publish.name)
    expect(patch.publishPreferences).toEqual(publish)
    expect(specParts(patch.specMarkdown!).body).toBe('# 仕様書\n')
    expect(patch.specMarkdown).toContain('name: 品質不具合アプリ')
    const unchangedName = { name: '不具合・改善管理', shareScope: 'group' as const }
    expect(handOffPatch({ ...analysed, title: unchangedName.name }, named, unchangedName)).toEqual({ publishPreferences: unchangedName })
    expect(handOffPatch(analysed, named, unchangedName)).toEqual({ title: unchangedName.name, publishPreferences: unchangedName })
    // Without front-matter the document stays as written.
    const privateChoice = { name: 'X', shareScope: 'private' as const }
    expect(handOffPatch({ ...analysed, specMarkdown: '# 前置きなし' }, '# 前置きなし', privateChoice)).toEqual({ title: 'X', publishPreferences: privateChoice })
    // The fallback's screen decisions are sent even when the name already matches.
    expect(handOffPatch({ ...analysed, title: unchangedName.name }, `${named}\n## 9. 画面の決定\n`, unchangedName)).toEqual({ specMarkdown: `${named}\n## 9. 画面の決定\n`, publishPreferences: unchangedName })
  })
})

test('only the ApplicationCreated conflict makes Excel preparation read-only', () => {
  const error = (status: number, reason: string) => ({ data: { status, body: { error: { code: 'conflict', details: { reason } } } } })
  expect(isApplicationCreated(error(409, 'ApplicationCreated'))).toBe(true)
  expect(isApplicationCreated(error(409, 'DraftBusy'))).toBe(false)
  expect(isApplicationCreated(error(412, 'ApplicationCreated'))).toBe(false)
  expect(isApplicationCreated(new Error('ApplicationCreated'))).toBe(false)
})

test.each([
  [400, 'WorkbookRowInvalid', 'invalid'],
  [409, 'WorkbookDuplicate', 'duplicate'],
  [409, 'WorkbookSetFull', 'setFull'],
  [409, 'DraftBusy', 'busy'],
  [409, 'ApplicationCreated', 'created'],
  [409, 'IdempotencyConflict', 'failed'],
  [413, 'WorkbookSetTooLarge', 'setTooLarge'],
  [413, 'WorkbookTooLarge', 'tooLarge'],
  [500, 'WorkbookDuplicate', 'failed'],
] as const)('file admission status %s / %s maps to %s', (status, reason, problem) => {
  expect(classifyStoreError({ data: { status, body: { error: { code: 'conflict', details: { reason } } } } }).problem).toBe(problem)
})
