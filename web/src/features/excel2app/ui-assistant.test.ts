import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
import { excelAnalysisOf, type Accent, type CompleteUiDesign } from '../../model/contracts/excel'
import { textJa } from './assistant-copy'
import { designFromReadings } from './design'
import { planApp, type AppPlan } from './model'
import { SAMPLE_SETS } from './samples'
import { applyInstruction, suggestedInstructions } from './ui-assistant'
import { defaultUiDesign, screenId } from './ui-design'

const sample = SAMPLE_SETS[0].workbooks[0]
const plan = planApp(excelAnalysisOf(designFromReadings([{
  grid: sample,
  summary: { id: 'wb-000000000001', fileName: sample.fileName, sheetCount: sample.sheets.length, rowCount: 0, truncated: false, bytes: 1, digest: '0'.repeat(64), addedAt: '2026-11-01T00:00:00Z' },
}])), '不具合管理台帳')
const entity = plan.entities[0].name
const initial = () => defaultUiDesign(plan)
const apply = (instruction: string, design = initial()) => applyInstruction(design, plan, instruction)
const listId = screenId('list', entity)
const formId = screenId('form', entity)
const dashboardId = screenId('dashboard', entity)

const originalCookie = document.cookie
const originalDocumentLanguage = document.documentElement.getAttribute('lang')
let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())
afterAll(() => {
  expect(document.cookie).toBe(originalCookie)
  expect(document.documentElement.getAttribute('lang')).toBe(originalDocumentLanguage)
})

describe('applyInstruction', () => {
  test.each(['一覧をカード表示に', 'カードで見たい', 'Show the list as cards'])('sets card layout: %s', (instruction) => {
    const result = apply(instruction)
    expect(result.design.lists[entity].layout).toBe('cards')
    expect(result.changed).toBe(true)
    expect(result.focusScreenId).toBe(listId)
    expect(result.reply).toBe(textJa.reply.layout(entity, 'cards'))
  })

  test.each(['一覧を表に戻して', 'テーブル表示に', 'Show the list as a table'])('sets table layout: %s', (instruction) => {
    const result = apply(instruction, apply('一覧をカード表示に').design)
    expect(result.design.lists[entity].layout).toBe('table')
  })

  test('applies color, screen order, and column removal without leaking negation', () => {
    for (const design of [initial(), apply('ダッシュボードを最後に', apply('色分けしない', apply('写真を追加して').design).design).design]) {
      const result = apply('状態を色分けして、ダッシュボードを最初に。写真の列はいらない', design)
      expect(result.design.lists[entity].colorField).toBe('状態')
      expect(result.design.screens[0].id).toBe(dashboardId)
      expect(result.design.lists[entity].columns).not.toContain('写真')
      // Explicit column wording still limits removal to the list.
      expect(result.design.forms[entity].fields).toContain('写真')
      expect(result.design.notes).toEqual([])
      expect(result.focusScreenId).toBe(listId)
      expect(result.reply.split('\n')).toHaveLength(3)
      expect(result.reply).toContain(textJa.reply.color(entity, '状態'))
      expect(result.reply).toContain(textJa.reply.screenOrder('ダッシュボード', textJa.position.first))
      expect(result.reply).toContain(textJa.reply.fields(entity, textJa.scope.list, ['写真'], false))
      expect(result.reply).not.toContain('色分けしません')
    }
  })

  test('a bare removal in a compound instruction affects both list and form', () => {
    const result = apply('状態を色分けして、ダッシュボードを最初に。写真はいらない', apply('写真を追加して').design)
    expect(result.design.lists[entity].colorField).toBe('状態')
    expect(result.design.screens[0].id).toBe(dashboardId)
    expect(result.design.lists[entity].columns).not.toContain('写真')
    expect(result.design.forms[entity].fields).not.toContain('写真')
    expect(result.changed).toBe(true)
    expect(result.focusScreenId).toBe(formId)
    expect(result.reply).toContain(textJa.reply.fields(entity, textJa.scope.both, ['写真'], false))
  })

  test.each([
    '一覧をカード表示にして色を青に',
    '一覧をカード表示にしてから色を青に',
    '一覧をカード表示にし、色を青に',
    '一覧をカード表示に、色を青に',
    '一覧をカード表示に。色を青に',
    '一覧をカード表示に，色を青に',
    '一覧をカード表示に\n色を青に',
    '一覧をカード表示にそれから色を青に',
    '一覧をカード表示に、あと色を青に',
    'Show the list as cards, set accent to blue',
    'Show the list as cards and set accent to blue',
    'Show the list as cards then set accent to blue',
    'Show the list as cards, and then set accent to blue',
  ])('applies layout and accent across clause joins: %s', (instruction) => {
    const result = apply(instruction)
    expect(result.design.lists[entity].layout).toBe('cards')
    expect(result.design.accent).toBe('blue')
    expect(result.design.notes).toEqual([])
    expect(result.changed).toBe(true)
    expect(result.focusScreenId).toBe(listId)
    expect(result.reply).toBe(`${textJa.reply.layout(entity, 'cards')}\n${textJa.reply.accent('青')}`)
  })

  test('applies clauses to the evolving design and preserves the last screen focus', () => {
    const result = apply('写真はいらない、写真を追加して、ダッシュボードを最後に、色を青に')
    expect(result.design.lists[entity].columns).toContain('写真')
    expect(result.design.forms[entity].fields).toContain('写真')
    expect(result.design.screens.at(-1)?.id).toBe(dashboardId)
    expect(result.focusScreenId).toBe(dashboardId)
    expect(result.changed).toBe(true)
    expect(result.design.notes).toEqual([])
    expect(result.reply.split('\n')).toHaveLength(4)
  })

  test('combines no-ops without losing earlier changes or adding undo entries', () => {
    const first = apply('一覧をカード表示にして色を青に')
    const repeated = apply('一覧をカード表示にして色を青に', first.design)
    expect(repeated.changed).toBe(false)
    expect(repeated.reply).toBe([
      textJa.reply.unchanged(textJa.reply.layout(entity, 'cards')),
      textJa.reply.unchanged(textJa.reply.accent('青')),
    ].join('\n'))
    expect(apply('一覧をカード表示にして色を緑に').changed).toBe(true)
    expect(apply('一覧を表にして色を青に').changed).toBe(true)
  })

  test('identifies unmatched clauses in mixed replies, including matched no-ops', () => {
    const note = '印刷用レイアウトを用意して'
    const result = apply(`${note}、一覧をカード表示にして、通知をメールで`)
    expect(result.design.lists[entity].layout).toBe('cards')
    expect(result.design.notes).toEqual([note, '通知をメールで'])
    expect(result.reply).toBe([
      textJa.reply.noteClause(note),
      textJa.reply.layout(entity, 'cards'),
      textJa.reply.noteClause('通知をメールで'),
    ].join('\n'))
    expect(result.focusScreenId).toBe(listId)
    expect(result.changed).toBe(true)
    const noOp = apply(`一覧を表に、${note}`)
    expect(noOp.reply).toContain(textJa.reply.noteClause(note))
    expect(noOp.reply).not.toContain(textJa.reply.note)
    expect(noOp.changed).toBe(true)
  })

  test('uses the existing fallback once when no clauses match', () => {
    const result = apply('印刷用レイアウトを用意して、通知をメールで')
    expect(result.design.notes).toEqual(['印刷用レイアウトを用意して', '通知をメールで'])
    expect(result.reply).toBe(textJa.reply.note)
    expect(result.changed).toBe(true)
    expect(result.focusScreenId).toBeUndefined()
  })

  test.each(['加熱温度(℃)', '工程・担当', '工程、担当', '工程，担当', '確認してから入力', 'あと工程', 'Design and development', 'Heat, then cool'])('protects known field names from splitting: %s', (name) => {
    const named: AppPlan = {
      ...plan,
      entities: [{ ...plan.entities[0], fields: [...plan.entities[0].fields, { ...plan.entities[0].fields.find((field) => field.name === '担当者')!, name }] }],
    }
    const result = applyInstruction(defaultUiDesign(named), named, `${name}はいらない、色を青に`)
    expect(result.design.forms[entity].fields).not.toContain(name)
    expect(result.design.accent).toBe('blue')
    expect(result.design.notes).toEqual([])
    expect(result.reply.split('\n')).toHaveLength(2)
    expect(result.reply).toContain(name)
  })

  test('protects quoted names and resolves renamed screens in later clauses', () => {
    const title = '確認してから、あと入力 and review'
    const result = apply(`一覧の名前を「${title}」にして、${title}を最後に、色を青に`)
    expect(result.design.screens.at(-1)).toMatchObject({ id: listId, title })
    expect(result.design.accent).toBe('blue')
    expect(result.design.notes).toEqual([])
    expect(result.reply.split('\n')).toHaveLength(3)
    expect(result.focusScreenId).toBe(listId)
    expect(apply('アプリ名を「青、それから緑」にして、色を紫に').design).toMatchObject({ appName: '青、それから緑', accent: 'violet' })
  })

  test('keeps polite suffixes with their clauses and notes verbatim', () => {
    const result = apply('アプリ名を品質管理に変更してください、印刷用にしてほしい、色を青に')
    expect(result.design.appName).toBe('品質管理')
    expect(result.design.accent).toBe('blue')
    expect(result.design.notes).toEqual(['印刷用にしてほしい'])
  })

  test('localizes combined replies and note acknowledgements in English', () => {
    setLanguage('en')
    const result = apply('Show the list as cards and set accent to blue then email notifications')
    expect(result.reply).toBe(`The “${entity}” list uses cards.\nThe app's accent color is blue.\nSaved “email notifications” as a note.`)
    expect(result.design.notes).toEqual(['email notifications'])
  })

  test('hides and restores a bare field across list and form without altering the plan', () => {
    const shown = apply('写真を追加して').design
    expect(shown.lists[entity].columns).toContain('写真')
    expect(shown.forms[entity].fields).toContain('写真')
    const hidden = apply('写真はいらない', shown)
    expect(hidden.design.lists[entity].columns).not.toContain('写真')
    expect(hidden.design.forms[entity].fields).not.toContain('写真')
    expect(hidden.focusScreenId).toBe(formId)
    expect(plan.entities[0].fields.some((field) => field.name === '写真')).toBe(true)
    expect(apply('写真を戻して', hidden.design).design.forms[entity].fields).toContain('写真')
  })

  test.each(['写真の列は不要', '一覧の「写真」を非表示に', 'Hide the 写真 column'])('limits column hiding to the list: %s', (instruction) => {
    const shown = apply('写真を追加して').design
    const result = apply(instruction, shown)
    expect(result.design.lists[entity].columns).not.toContain('写真')
    expect(result.design.forms[entity].fields).toContain('写真')
    expect(result.focusScreenId).toBe(listId)
  })

  test('matches quoted, abbreviated, and normalized field names', () => {
    expect(apply('担当を先頭に').design.lists[entity].columns[0]).toBe('担当者')
    expect(apply('「不具合内容」を一覧に追加').design.lists[entity].columns).toContain('不具合内容')
    expect(apply('ｎｏ の列は不要').design.lists[entity].columns).not.toContain('No')
  })

  test('reorders fields to first, last, numeric positions, and relative to another field', () => {
    expect(apply('担当者を先頭に').design.lists[entity].columns[0]).toBe('担当者')
    expect(apply('工程を最後に').design.lists[entity].columns.at(-1)).toBe('工程')
    expect(apply('担当者を2番目に').design.lists[entity].columns[1]).toBe('担当者')
    const result = apply('担当者を状態の後に').design.lists[entity].columns
    expect(result.indexOf('担当者')).toBe(result.indexOf('状態') + 1)
    const form = apply('登録フォームの担当者を先頭に')
    expect(form.design.forms[entity].fields[0]).toBe('担当者')
    expect(form.focusScreenId).toBe(formId)
  })

  test('required fields stay editable and are removed from required when hidden', () => {
    const hidden = apply('登録フォームの担当者を削除').design
    const required = apply('担当者を必須に', hidden)
    expect(required.design.forms[entity].fields).toContain('担当者')
    expect(required.design.forms[entity].required).toContain('担当者')
    expect(required.focusScreenId).toBe(formId)
    const optional = apply('担当者は必須にしない', required.design)
    expect(optional.design.forms[entity].required).not.toContain('担当者')
    expect(optional.design.forms[entity].fields).toContain('担当者')
    expect(apply('フォームの担当者はいらない', required.design).design.forms[entity].required).not.toContain('担当者')
  })

  test('color coding can be enabled and disabled without changing the accent', () => {
    const plain = apply('色分けしない')
    expect(plain.design.lists[entity].colorField).toBeUndefined()
    const colored = apply('状態を色分け', plain.design)
    expect(colored.design.lists[entity].colorField).toBe('状態')
    expect(colored.focusScreenId).toBe(listId)
    expect(colored.design.accent).toBe('teal')
    expect(apply('状態の色分けを解除', colored.design).design.lists[entity].colorField).toBeUndefined()
  })

  test('groups, sorts, searches, and filters independently', () => {
    const grouped = apply('工程でグループ化')
    expect(grouped.design.lists[entity].groupBy).toBe('工程')
    expect(apply('グループ化を解除', grouped.design).design.lists[entity].groupBy).toBeUndefined()
    expect(apply('期限で並べ替えて').design.lists[entity].sortBy).toBe('期限')
    expect(apply('期限順に').design.lists[entity].sortBy).toBe('期限')
    const noSearch = apply('検索はいらない')
    expect(noSearch.design.lists[entity].searchable).toBe(false)
    expect(apply('検索を有効に', noSearch.design).design.lists[entity].searchable).toBe(true)
    const filtered = apply('担当者のフィルターを追加')
    expect(filtered.design.lists[entity].filters).toContain('担当者')
    expect(apply('担当者の絞り込みはいらない', filtered.design).design.lists[entity].filters).not.toContain('担当者')
    expect(apply('担当者の絞り込みはいらない', filtered.design).design.forms[entity].fields).toContain('担当者')
  })

  test.each(['登録フォームは 1 列で', 'フォームを１列に', 'Use a one column form'])('uses a one-column form: %s', (instruction) => {
    const result = apply(instruction)
    expect(result.design.forms[entity].twoColumns).toBe(false)
    expect(result.focusScreenId).toBe(formId)
    expect(apply('登録フォームは2列で', result.design).design.forms[entity].twoColumns).toBe(true)
  })

  test('renames the app before interpreting words inside the name', () => {
    expect(apply('アプリ名を「青いカード」にして').design.appName).toBe('青いカード')
    expect(apply('アプリ名を品質管理に').design.appName).toBe('品質管理')
    expect(apply('アプリ名を品質管理に変更してください').design.appName).toBe('品質管理')
  })

  test('renames a screen while preserving its identity and lets the new name target it', () => {
    const result = apply('一覧の名前を「対応案件」に')
    expect(result.design.screens.find((screen) => screen.id === listId)?.title).toBe('対応案件')
    expect(result.focusScreenId).toBe(listId)
    expect(apply('対応案件を最後に', result.design).design.screens.at(-1)?.id).toBe(listId)
    expect(apply('進捗ボードを「対応状況」に変更').design.screens.find((screen) => screen.kind === 'board')?.title).toBe('対応状況')
  })

  test('hides, shows, and reorders screens without dropping their configuration', () => {
    const hidden = apply('進捗ボードはいらない')
    expect(hidden.design.screens.find((screen) => screen.kind === 'board')?.hidden).toBe(true)
    expect(hidden.design.screens.find((screen) => screen.id === hidden.focusScreenId)?.hidden).toBe(false)
    const shown = apply('進捗ボードを表示して', hidden.design)
    expect(shown.design.screens.find((screen) => screen.kind === 'board')?.hidden).toBe(false)
    expect(shown.focusScreenId).toBe(screenId('board', entity))
    const last = apply('ダッシュボードを最後に').design
    expect(last.screens.at(-1)?.id).toBe(dashboardId)
    expect(apply('ダッシュボードを最初に', last).design.screens[0].id).toBe(dashboardId)
    expect(apply('進捗ボードを一覧の前に').design.screens[1].kind).toBe('board')
  })

  test.each<[string, Accent]>([
    ['色を緑に', 'teal'], ['色を青に', 'blue'], ['色を紫に', 'violet'], ['色を琥珀に', 'amber'], ['色を赤に', 'rose'], ['色をグレーに', 'stone'],
    ['green', 'teal'], ['blue', 'blue'], ['purple', 'violet'], ['amber', 'amber'], ['red', 'rose'], ['gray', 'stone'], ['grey', 'stone'],
  ])('sets accent: %s', (instruction, accent) => {
    const result = apply(instruction)
    expect(result.design.accent).toBe(accent)
    expect(result.reply).toContain(textJa.accent[accent])
  })

  test('changes density both ways', () => {
    const compact = apply('コンパクトにして')
    expect(compact.design.density).toBe('compact')
    expect(apply('ゆったり表示に', compact.design).design.density).toBe('comfortable')
  })

  test('adds overdue and grouped dashboard cards without duplicates', () => {
    const empty = { ...initial(), dashboard: { cards: [] } }
    const overdue = apply('期限切れの件数を出して', empty)
    expect(overdue.design.dashboard.cards).toEqual([{ id: 'overdue:期限', title: textJa.card.overdue, kind: 'overdue', field: '期限' }])
    expect(overdue.focusScreenId).toBe(dashboardId)
    const grouped = apply('工程別の件数', overdue.design)
    expect(grouped.design.dashboard.cards[1]).toMatchObject({ kind: 'countBy', field: '工程', title: textJa.card.countBy('工程') })
    const repeated = apply('工程別の件数', grouped.design)
    expect(repeated.design.dashboard.cards).toHaveLength(2)
    expect(repeated.changed).toBe(false)
    expect(apply('数量の合計を出して', empty).design.dashboard.cards[0]).toMatchObject({ kind: 'sum', field: '数量' })
  })

  test('uses notes for unsupported instructions instead of pretending to implement them', () => {
    const instruction = '印刷用レイアウトを用意して'
    const result = apply(instruction)
    expect(result.design.notes).toEqual([instruction])
    expect(result.reply).toBe(textJa.reply.note)
    expect(result.changed).toBe(true)
    expect(result.focusScreenId).toBeUndefined()
    expect(apply('架空項目で色分け').design.notes).toEqual(['架空項目で色分け'])
    expect(apply('担当者を真っ赤にして').design.notes).toEqual(['担当者を真っ赤にして'])
    expect(apply('期限を昇順で並べ替えて').design.notes).toEqual(['期限を昇順で並べ替えて'])
  })

  test('empty instructions and already-applied requests do not create undo entries', () => {
    expect(apply('  ').changed).toBe(false)
    const cards = apply('一覧をカード表示に').design
    const result = apply('一覧をカード表示に', cards)
    expect(result.changed).toBe(false)
    expect(result.design).not.toBe(cards)
    expect(result.reply).toBe(textJa.reply.unchanged(textJa.reply.layout(entity, 'cards')))
    expect(result.focusScreenId).toBe(listId)
  })

  test('never mutates deeply frozen input, including nested arrays', () => {
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.freeze(value)
        Object.values(value).forEach(freeze)
      }
    }
    const design = initial()
    const before = structuredClone(design)
    freeze(design)
    for (const instruction of ['一覧をカード表示に', '写真はいらない', '担当者を先頭に', '状態を色分けしない', '工程でグループ化', '担当者を必須に', '進捗ボードはいらない', '工程別の件数', 'アプリ名を管理に', 'メモを残す']) {
      const result = apply(instruction, design)
      expect(result.design).not.toBe(design)
      expect(design).toEqual(before)
    }
  })

  test('targets a named records entity rather than the first one', () => {
    const another: AppPlan = {
      ...plan,
      entities: [...plan.entities, { ...plan.entities[0], name: '修理記録' }],
      screens: [...plan.screens, { kind: 'list', entity: '修理記録' }, { kind: 'form', entity: '修理記録' }],
    }
    const result = applyInstruction(defaultUiDesign(another), another, '修理記録の一覧をカード表示に')
    expect(result.design.lists['修理記録'].layout).toBe('cards')
    expect(result.design.lists[entity].layout).toBe('table')
    expect(result.focusScreenId).toBe(screenId('list', '修理記録'))
  })
})

describe('suggestedInstructions', () => {
  test('offers 3–5 unique applicable chips, omitting already configured color coding', () => {
    const design = initial()
    const suggestions = suggestedInstructions(design, plan)
    expect(suggestions.length).toBeGreaterThanOrEqual(3)
    expect(suggestions.length).toBeLessThanOrEqual(5)
    expect(new Set(suggestions).size).toBe(suggestions.length)
    expect(suggestions).not.toContain(textJa.suggest.color('状態'))
    expect(suggestions).toContain(textJa.suggest.layout('cards'))
    for (const suggestion of suggestions) {
      const result = apply(suggestion, design)
      expect(result.changed).toBe(true)
      expect(result.design.notes).toEqual([])
    }
    const plain = apply('色分けしない').design
    expect(suggestedInstructions(plain, plan)).toContain(textJa.suggest.color('状態'))
  })

  test('chips adapt after layout, form, density, and group changes', () => {
    let design: CompleteUiDesign = initial()
    for (const instruction of ['一覧をカード表示に', '登録フォームは1列で', '工程でグループ化', 'コンパクトにして']) design = apply(instruction, design).design
    const suggestions = suggestedInstructions(design, plan)
    expect(suggestions).not.toContain(textJa.suggest.layout('cards'))
    expect(suggestions).not.toContain(textJa.suggest.formColumns(false))
    expect(suggestions).not.toContain(textJa.suggest.group('工程'))
    for (const suggestion of suggestions) expect(apply(suggestion, design).changed).toBe(true)
  })

  test('localized English chips are also actionable', () => {
    setLanguage('en')
    const design = apply('色分けしない').design
    for (const suggestion of suggestedInstructions(design, plan)) {
      const result = apply(suggestion, design)
      expect(result.changed).toBe(true)
      expect(result.design.notes).toEqual([])
    }
    expect(apply('blue').reply).toContain('blue')
  })

  test('still offers three actionable chips when no records entity was inferred', () => {
    const emptyPlan: AppPlan = { ...plan, entities: [], screens: [] }
    const design = defaultUiDesign(emptyPlan)
    const suggestions = suggestedInstructions(design, emptyPlan)
    expect(suggestions).toHaveLength(3)
    for (const suggestion of suggestions) {
      const result = applyInstruction(design, emptyPlan, suggestion)
      expect(result.changed).toBe(true)
      expect(result.design.notes).toEqual([])
    }
  })
})

describe('a field of a kind this console does not know', () => {
  const unknownKind: AppPlan = { ...plan, entities: [{ ...plan.entities[0], fields: [...plan.entities[0].fields, { name: '署名欄', kind: { kind: 'unknown' } }] }] }

  test('never becomes a form input: the default form leaves it out, asking for it stays a note', () => {
    const design = defaultUiDesign(unknownKind)
    expect(design.forms[entity].fields).not.toContain('署名欄')
    for (const instruction of ['登録フォームに署名欄を追加', '署名欄を必須に']) {
      const result = applyInstruction(design, unknownKind, instruction)
      expect(result.design.forms[entity]).toEqual(design.forms[entity])
      expect(result.design.notes).toEqual([instruction])
    }
  })

  test('is not read as a date, choice or number', () => {
    const design = defaultUiDesign(unknownKind)
    expect(design.lists[entity].filters).not.toContain('署名欄')
    expect(design.forms[entity].required).not.toContain('署名欄')
    expect(design.dashboard.cards.map((card) => card.field)).not.toContain('署名欄')
  })
})
