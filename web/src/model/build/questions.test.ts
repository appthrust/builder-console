import { describe, expect, test } from 'bun:test'
import type { ApplicationDraftConversationTurn, ExcelAnalysisEntity } from '@appthrust/api-schema/platform-api'
import { buildCopy, textJa } from './copy'
import { textEn } from './copy.en'
import { currentLanguage, setLanguage } from '../../shell/language'
import { shareScopeLabel } from '../access'
import { conversationTurns, importedRowCount, isFirstTurn, isKickoffReply, isPrepareTurn, prepareAnswers, prepareShareLabel, replyOptions } from './questions'

const turn = (id: string, userMessage: string, minute: number, extra: Partial<ApplicationDraftConversationTurn> = {}): ApplicationDraftConversationTurn => ({
  kind: 'conversation',
  id, userMessage, status: 'succeeded', startedAt: `2026-10-10T00:0${minute}:00Z`, devWorkspaceId: 'ws-1', ...extra,
})
const opening = turn('t-prepare', buildCopy.questions.prepareTurn, 1, { suggestedReplies: ['見積作成', '見積作成アプリ', 'みんなの見積作成'] })

describe('用意する answers', () => {
  test('maps the name and each offered share choice to the publish scope', () => {
    for (const [label, scope] of [['自分だけ', 'private'], ['自分の課', 'group'], ['全社', 'company']] as const) {
      expect(prepareAnswers([opening, turn('t-name', '見積作成アプリ', 2), turn('t-share', label, 3)])).toEqual({ name: '見積作成アプリ', shareChoice: scope, turnIds: ['t-prepare', 't-name', 't-share'], open: false })
    }
  })
  test('stays open while the AI is still asking, including a pending reply', () => {
    expect(prepareAnswers([opening]).open).toBe(true)
    expect(prepareAnswers([opening, turn('t-name', '見積作成', 2, { status: 'running' })])).toEqual({ name: '見積作成', turnIds: ['t-prepare', 't-name'], open: true })
    expect(prepareAnswers([{ ...opening, status: 'failed' }]).open).toBe(false)
  })
  test('accepts written answers, ignores failed turns and earlier conversation', () => {
    const earlier = turn('t-old', '人事担当者のみ', 0)
    expect(prepareAnswers([earlier, opening, turn('t-failed', '「営業見積」', 2, { status: 'failed' }), turn('t-name', '「営業見積」', 3), turn('t-share', '営業部のチームだけ', 4)]))
      .toEqual({ name: '営業見積', shareChoice: 'group', turnIds: ['t-prepare', 't-name', 't-share'], open: false })
    expect(prepareAnswers([opening, turn('t-name', '見積作成', 2), turn('t-share', '会社全体に見せたい', 3)]).shareChoice).toBe('company')
  })
  test('a sentence asking for something else is not a name, and nothing before the preparation prompt counts', () => {
    expect(prepareAnswers([opening, turn('t-request', '一覧に検索をつけてください。', 2)])).toEqual({ turnIds: ['t-prepare'], open: false })
    expect(prepareAnswers([opening, turn('t-share', '全社', 2)])).toEqual({ shareChoice: 'company', turnIds: ['t-prepare', 't-share'], open: false })
    expect(prepareAnswers([turn('t-name', '見積作成', 0)])).toEqual({ turnIds: [], open: false })
    expect(prepareAnswers(undefined)).toEqual({ turnIds: [], open: false })
  })
  test('only conversation turns are replies: Excel → app turns never enter the exchange or the intent', () => {
    const analysis = turn('t-excel', 'この Excel を読み取ってください', 2, { kind: 'excel-analysis' })
    const design = turn('t-ui', '__init__', 3, { kind: 'ui-design' })
    expect(conversationTurns([opening, analysis, design]).map((item) => item.id)).toEqual(['t-prepare'])
    const legacy: { id: string; kind?: ApplicationDraftConversationTurn['kind'] } = { id: 'legacy' }
    expect(conversationTurns([legacy])).toEqual([legacy])
    expect(prepareAnswers([opening, analysis, design]).open).toBe(true)
  })
  test('Excel hand-off answers skip name and audience without manufacturing conversation turns', () => {
    const preferences = { name: '営業見積', shareScope: 'group' as const }
    const answered = { name: preferences.name, shareChoice: preferences.shareScope }
    const analysis = turn('t-excel', 'この Excel を読み取ってください', 0, { kind: 'excel-analysis' })
    const design = turn('t-ui', '__init__', 1, { kind: 'ui-design' })
    expect(prepareAnswers([analysis, design], preferences)).toEqual({ ...answered, turnIds: [], open: false })
    // Re-entering from Excel also supersedes an unfinished preparation exchange.
    expect(prepareAnswers([opening, turn('t-name', '以前の名前', 2)], preferences))
      .toEqual({ ...answered, turnIds: ['t-prepare', 't-name'], open: false })
  })
  test('owner group choices and legacy answers share the same vocabulary', () => {
    expect(prepareShareLabel('自分の課', '営業部')).toBe('営業部')
    expect(prepareShareLabel('My group')).toBe('グループ')
    expect(prepareShareLabel('変更したい')).toBe('変更したい')
    expect(prepareAnswers([opening, turn('name', '見積', 2), turn('share', '営業部', 3)], undefined, '営業部').shareChoice).toBe('group')
    expect(prepareAnswers([opening], { name: '保存済み' }).open).toBe(true)
  })
  test('offers the AI options verbatim, never 「この内容で提案して」', () => {
    const messages = [
      ...[1, 2, 3].flatMap((index) => [{ role: 'user' as const, text: `答え${index}`, at: `${index}` }, { role: 'assistant' as const, text: '', at: `${index}`, turnId: `t${index}`, options: ['a'] }]),
      { role: 'user' as const, text: buildCopy.questions.prepareTurn, at: '4' },
      { role: 'assistant' as const, text: '', at: '4', turnId: 't4', options: ['自分だけ', '自分の課', '全社'] },
    ]
    expect(replyOptions(messages)).toEqual(['自分だけ', '自分の課', '全社'])
    expect(replyOptions(messages.slice(0, 6))).toContain(buildCopy.questions.kickoffReply)
  })
})

test('prompts switch at use time and saved preparation replies remain recognizable in either language', () => {
  const originalLanguage = currentLanguage()
  try {
    for (const language of ['en', 'ja'] as const) {
      setLanguage(language)
      expect(buildCopy.questions).toEqual(language === 'en' ? textEn.questions : textJa.questions)
      for (const copy of [textJa, textEn]) {
        expect(isFirstTurn(copy.questions.firstTurn)).toBe(true)
        expect(isKickoffReply(copy.questions.kickoffReply)).toBe(true)
        expect(isPrepareTurn(copy.questions.prepareTurn)).toBe(true)
        const preparing = turn('t-prepare', copy.questions.prepareTurn, 1)
        for (const scope of ['private', 'group', 'company'] as const) {
          expect(prepareAnswers([preparing, turn('t-name', 'Sales', 2), turn('t-share', shareScopeLabel(scope), 3)]))
            .toEqual({ name: 'Sales', shareChoice: scope, turnIds: ['t-prepare', 't-name', 't-share'], open: false })
        }
      }
      const messages = [1, 2, 3].flatMap((index) => [
        { role: 'user' as const, text: 'Sales', at: `${index}` },
        { role: 'assistant' as const, text: 'Ready', at: `${index}`, turnId: `t${index}` },
      ])
      expect(replyOptions(messages)).toEqual([buildCopy.questions.kickoffReply])
      for (const copy of [textJa, textEn]) {
        expect(replyOptions([...messages, { role: 'user', text: copy.questions.kickoffReply, at: '4' }, { role: 'assistant', text: 'Ready', at: '4', turnId: 't4' }])).toEqual([])
        expect(replyOptions([...messages, { role: 'user', text: copy.questions.prepareTurn, at: '4' }, { role: 'assistant', text: 'Name?', at: '4', turnId: 't4' }])).toEqual([])
      }
    }
    expect(isFirstTurn('Sales')).toBe(false)
    expect(isKickoffReply('Sales')).toBe(false)
    expect(isPrepareTurn('Sales')).toBe(false)
  } finally {
    setLanguage(originalLanguage)
  }
})

test('imported row count uses integrated records rather than source row totals', () => {
  const entity: ExcelAnalysisEntity = {
    name: '受注', kind: 'records', fields: [{ name: '番号', kind: 'id' }], rules: [], importRows: 3,
    sources: [
      { workbookId: 'wb-000000000001', sheet: '4月', headerRow: 0, dataRows: 2, columns: [{ index: 0, field: '番号' }] },
      { workbookId: 'wb-000000000002', sheet: '5月', headerRow: 0, dataRows: 2, columns: [{ index: 0, field: '番号' }] },
    ],
  }
  expect(importedRowCount(undefined)).toBeUndefined()
  expect(importedRowCount({ entities: [] })).toBe(0)
  expect(importedRowCount({ entities: [entity, { ...entity, name: '顧客', kind: 'master', importRows: 2 }] })).toBe(5)
})
