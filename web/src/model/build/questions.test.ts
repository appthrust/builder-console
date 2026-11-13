import { describe, expect, test } from 'bun:test'
import type { ExcelAnalysisEntity } from '@appthrust/api-schema/platform-api'
import { turnOf } from '../../api/testing/build-domain'
import { analysisFrom } from '../../api/testing/excel-domain'
import { buildCopy, textJa } from './copy'
import { textEn } from './copy.en'
import { currentLanguage, setLanguage } from '../../shell/language'
import { shareScopeLabel } from '../access'
import { conversationTurns, importedRowCount, isFirstTurn, isKickoffReply, isPrepareTurn, prepareAnswers, prepareShareLabel, replyOptions } from './questions'

const turn = (id: string, userMessage: string, minute: number, extra: Record<string, unknown> = {}) => turnOf({
  kind: 'conversation',
  id, userMessage, status: 'succeeded', startedAt: `2026-10-10T00:0${minute}:00Z`, devWorkspaceId: 'ws-1', ...extra,
})
const openingReplies = ['見積作成', '見積作成アプリ', 'みんなの見積作成']
const opening = turn('t-prepare', buildCopy.questions.prepareTurn, 1, { suggestedReplies: openingReplies })

describe('用意する answers', () => {
  test('maps the name and each offered share choice to the publish scope', () => {
    for (const [label, scope] of [['自分だけ', 'private'], ['自分の課', 'group'], ['全社', 'company']] as const) {
      expect(prepareAnswers([opening, turn('t-name', '見積作成アプリ', 2), turn('t-share', label, 3)])).toEqual({ name: '見積作成アプリ', shareChoice: scope, turnIds: ['t-prepare', 't-name', 't-share'], open: false })
    }
  })
  test('stays open while the AI is still asking, including a pending reply', () => {
    expect(prepareAnswers([opening]).open).toBe(true)
    expect(prepareAnswers([opening, turn('t-name', '見積作成', 2, { status: 'running' })])).toEqual({ name: '見積作成', turnIds: ['t-prepare', 't-name'], open: true })
    expect(prepareAnswers([turn('t-prepare', buildCopy.questions.prepareTurn, 1, { suggestedReplies: openingReplies, status: 'failed' })]).open).toBe(false)
    // A reply in a state this console does not know was still said: it is not dropped like a failed one.
    expect(prepareAnswers([opening, turn('t-name', '見積作成', 2, { status: 'reviewing' })])).toEqual({ name: '見積作成', turnIds: ['t-prepare', 't-name'], open: true })
  })
  test('accepts written answers, ignores failed turns and earlier conversation', () => {
    const earlier = turn('t-old', '人事担当者のみ', 0)
    expect(prepareAnswers([earlier, opening, turn('t-failed', '「営業見積」', 2, { status: 'failed' }), turn('t-name', '「営業見積」', 3), turn('t-share', '営業部のチームだけ', 4)]))
      .toEqual({ name: '営業見積', shareChoice: 'group', turnIds: ['t-prepare', 't-name', 't-share'], open: false })
    expect(prepareAnswers([opening, turn('t-name', '見積作成', 2), turn('t-share', '会社全体に見せたい', 3)]).shareChoice).toBe('company')
  })
  test.each([
    ['入退室・開閉管理でよい', '入退室・開閉管理'],
    ['入退室・金庫管理にしたい', '入退室・金庫管理'],
    ['セキュリティ記録管理にしたい', 'セキュリティ記録管理'],
    ['ほかの名前にしたい', undefined],
  ])('extracts the real opening chip %s without storing its choice wording', (reply, name) => {
    const preparing = { ...opening, suggestedReplies: ['入退室・開閉管理でよい', '入退室・金庫管理にしたい', 'セキュリティ記録管理にしたい', 'ほかの名前にしたい'] }
    expect(prepareAnswers([preparing, turn('t-reply', reply, 2)]))
      .toEqual({ ...(name ? { name } : {}), turnIds: ['t-prepare', 't-reply'], open: true })
  })
  test.each([
    ['入退室・金庫管理にしたい', '入退室・金庫管理'],
    ['セキュリティ記録管理にしたい', 'セキュリティ記録管理'],
    ['ISMS記録管理にしたい', 'ISMS記録管理'],
    ['ほかの名前にしたい', undefined],
  ])('extracts the real follow-up chip %s using the same rules', (reply, name) => {
    const followup = turn('t-another', 'ほかの名前にしたい', 2, {
      assistantMessage: '公開するときの名前は何にしますか？',
      suggestedReplies: ['入退室・金庫管理にしたい', 'セキュリティ記録管理にしたい', 'ISMS記録管理にしたい', 'ほかの名前にしたい'],
    })
    expect(prepareAnswers([opening, followup, turn('t-reply', reply, 3)]))
      .toEqual({ ...(name ? { name } : {}), turnIds: ['t-prepare', 't-another', 't-reply'], open: true })
  })
  test('strips the documented Japanese choice endings and quotes, with or without an offered chip', () => {
    for (const ending of ['でよい', 'でいい', 'で良い', 'でOK', 'で大丈夫', 'でお願いします', 'にしたい', 'にする', 'にします', 'にして', 'にしてください', 'がよい', 'がいい']) {
      for (const polite of ['', 'です', 'ですね']) {
        for (const name of ['営業見積', '「営業見積」', '『営業見積』', '"営業見積"', '“営業見積”']) {
          const reply = `${name}${ending}${polite}`
          for (const suggestedReplies of [[], [reply]]) {
            expect(prepareAnswers([{ ...opening, suggestedReplies }, turn('t-name', reply, 2)]).name).toBe('営業見積')
          }
        }
      }
    }
    expect(prepareAnswers([opening, turn('t-name', '「営業見積でお願いします」', 2)]).name).toBe('営業見積')
    expect(prepareAnswers([opening, turn('t-name', '「営業見積」でお願いします。', 2)]).name).toBe('営業見積')
  })
  test.each(['Sales is fine', 'Sales is fine.', 'Use Sales', 'Call it Sales', 'Use "Sales"', 'Call it “Sales”', 'Please use Sales', 'Sales is OK'])('extracts the English name from %s', (reply) => {
    const preparing = { ...opening, userMessage: textEn.questions.prepareTurn, suggestedReplies: [reply] }
    expect(prepareAnswers([preparing, turn('t-name', reply, 2)])).toEqual({ name: 'Sales', turnIds: ['t-prepare', 't-name'], open: true })
  })
  test.each([
    'ほかの名前にしたい', '別の名前にしたい', '名前を変えたい', 'まだ決めていない', 'あとで決める',
    '提案して', '提案してください。', 'おすすめは？', '候補を出して', '候補を出してください',
    'Another name', 'Something else', 'Suggest one', 'Not sure', 'Suggest a name', 'I want to change the name', "I'll decide later",
    "I haven't decided yet", 'What do you recommend?', 'Recommend a name', 'Give me some options', 'I’m not sure yet', 'I’ll decide later',
    '別の名前がいいです', 'Use Another name', 'Something else is fine',
  ])('keeps %s in the name exchange even when it is an offered chip', (reply) => {
    for (const suggestedReplies of [[], [reply]]) {
      const preparing = { ...opening, suggestedReplies }
      const undecided = turn('t-undecided', reply, 2)
      expect(prepareAnswers([preparing, undecided])).toEqual({ turnIds: ['t-prepare', 't-undecided'], open: true })
      expect(prepareAnswers([preparing, undecided, turn('t-name', '営業見積', 3)]))
        .toEqual({ name: '営業見積', turnIds: ['t-prepare', 't-undecided', 't-name'], open: true })
    }
  })
  test('APT-792 keeps alternative-name and suggestion requests open until an actual name and audience arrive', () => {
    const exchange = [opening, turn('t-another', 'ほかの名前にしたい', 2), turn('t-suggest', '提案して', 3)]
    expect(prepareAnswers(exchange)).toEqual({ turnIds: ['t-prepare', 't-another', 't-suggest'], open: true })
    const named = [...exchange, turn('t-name', 'チーム台帳にしたい', 4)]
    expect(prepareAnswers(named)).toEqual({ name: 'チーム台帳', turnIds: ['t-prepare', 't-another', 't-suggest', 't-name'], open: true })
    expect(prepareAnswers([...named, turn('t-share', '会社全体に見せたい', 5)]))
      .toEqual({ name: 'チーム台帳', shareChoice: 'company', turnIds: ['t-prepare', 't-another', 't-suggest', 't-name', 't-share'], open: false })
  })
  test.each(['まだ決めていない', 'あとで決める', '提案して', 'おすすめは？', 'Not sure', "I'll decide later", 'Suggest one', 'What do you recommend?'])('keeps the audience question open on %s without replacing the captured name', (reply) => {
    const exchange = [opening, turn('t-name', '営業見積', 2), turn('t-undecided', reply, 3)]
    expect(prepareAnswers(exchange)).toEqual({ name: '営業見積', turnIds: ['t-prepare', 't-name', 't-undecided'], open: true })
    expect(prepareAnswers([...exchange, turn('t-share', '全社', 4)]))
      .toEqual({ name: '営業見積', shareChoice: 'company', turnIds: ['t-prepare', 't-name', 't-undecided', 't-share'], open: false })
  })
  test('the first unrelated request bounds the exchange; later names never reopen it', () => {
    for (const reply of ['一覧に検索をつけてください。', 'Add search to the list.', '長'.repeat(41), '営業\n見積']) {
      const exchange = [{ ...opening, suggestedReplies: [reply] }, turn('t-another', 'ほかの名前にしたい', 2), turn('t-request', reply, 3)]
      expect(prepareAnswers([...exchange, turn('t-name', '営業見積', 4)]))
        .toEqual({ turnIds: ['t-prepare', 't-another'], open: false })
    }
    const named = [opening, turn('t-name', '営業見積', 2)]
    expect(prepareAnswers([...named, turn('t-other', '一覧に検索をつけてください。', 3), turn('t-share', '全社', 4)]))
      .toEqual({ name: '営業見積', turnIds: ['t-prepare', 't-name'], open: false })
    expect(prepareAnswers([...named, turn('t-share', '全社', 3), turn('t-later', '別名', 4)]))
      .toEqual({ name: '営業見積', shareChoice: 'company', turnIds: ['t-prepare', 't-name', 't-share'], open: false })
  })
  test('failed suggestions are ignored, pending suggestions stay open, and only the latest preparation prompt counts', () => {
    const exchange = [opening, turn('t-another', 'ほかの名前にしたい', 2), turn('t-failed', '一覧に検索をつけてください。', 3, { status: 'failed' }), turn('t-suggest', '提案して', 4, { status: 'running' })]
    expect(prepareAnswers(exchange)).toEqual({ turnIds: ['t-prepare', 't-another', 't-suggest'], open: true })
    expect(prepareAnswers([...exchange, turn('t-new', textEn.questions.prepareTurn, 5), turn('t-name', 'New name', 6)]))
      .toEqual({ name: 'New name', turnIds: ['t-new', 't-name'], open: true })
  })
  test('persisted preferences remain authoritative, even if an old name was a non-name reply', () => {
    const preferences = { name: 'ほかの名前にしたい' }
    expect(prepareAnswers([opening, turn('t-another', preferences.name, 2), turn('t-name', '営業見積', 3)], preferences))
      .toEqual({ name: preferences.name, turnIds: ['t-prepare', 't-another', 't-name'], open: true })
    expect(preferences).toEqual({ name: 'ほかの名前にしたい' })
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
    // A turn stored before `kind` existed reads as a conversation turn; a kind this console does not know is not one.
    const legacy = turnOf({ id: 'legacy', status: 'succeeded', startedAt: '2026-10-10T00:04:00Z', devWorkspaceId: 'ws-1', userMessage: '昔の返事' })
    expect(conversationTurns([legacy]).map((item) => item.id)).toEqual(['legacy'])
    expect(conversationTurns([turn('t-new', '新しい種類', 5, { kind: 'voice-note' })])).toEqual([])
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
  const analysis = analysisFrom({ summary: '', bullets: [], capabilities: [], flows: [], findings: [], workbooks: [{ workbookId: 'wb-000000000001', role: 'records', summary: '' }], entities: [entity, { ...entity, name: '顧客', kind: 'master', importRows: 2 }] })
  expect(importedRowCount(analysis)).toBe(5)
})
