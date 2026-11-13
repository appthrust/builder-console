import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { templateOf } from '../../api/testing/catalog-domain'
import { copy } from '../../copy'
import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
import { text, textJa } from './copy'
import { textEn } from './copy.en'
import { detailsSchema, firstError, shareSchema } from './form'
import { businessTemplateById, businessTemplates, joinBusinessTemplates } from './templates'

let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())

describe('create language switching', () => {
  test('wizard copy and interpolated messages switch without replacing the import', () => {
    expect(text.loadingDraft).toBe('作成途中のアプリを読み込んでいます…')
    expect(text.pageTitle(2)).toBe('新しいアプリ (2/4)')
    expect(text.unsavedChanges).toBe('入力した内容は保存されていません。この画面を離れますか？')
    expect(text.alreadyCreated('stock')).toBe('this app was already created as "stock"; finish it with that URL name')
    expect(text.sourceUnavailable).toBe('source connections unavailable')

    setLanguage('en')
    expect(text.loadingDraft).toBe('Loading your unfinished app…')
    expect(text.pageTitle(2)).toBe('New app (2/4)')
    expect(text.unsavedChanges).toBe('Your changes have not been saved. Leave this page?')
    expect(text.missingAdmin('GitHub')).toBe('Set up GitHub in Platform settings before continuing.')
    expect(text.alreadyCreated('stock')).toBe('This app was already created as "stock"; finish it with that URL name.')
    expect(text.sourceUnavailable).toBe('The GitHub connection is unavailable.')

    setLanguage('ja')
    expect(text.pageTitle(2)).toBe('新しいアプリ (2/4)')
    expect(text.missingAdmin('GitHub')).toBe('GitHubがまだ用意されていません。「基盤の設定」で用意してください。')
  })

  test('all template text and AI briefs follow the language while metadata stays fixed', () => {
    const ids = ['biz-inventory-postgres', 'biz-master-postgres', 'biz-approval-postgres', 'biz-reservation-postgres'] satisfies Array<keyof typeof textJa.templates>
    const originals = ids.map((id) => businessTemplateById(id)!)
    const icons = originals.map((template) => template.icon)
    expect(originals.map((template) => template.name)).toEqual(['在庫管理', 'マスター管理', '申請・承認', '予約・貸出'])
    expect(originals[0]!.seed).toBe('品物の在庫と入出庫を管理するアプリを作りたいです。品物の一覧、入出庫の記録、CSV の取り込み・書き出しが必要です。')
    const catalog = businessTemplates.map((template) => templateOf({
      id: template.id,
      displayName: template.name,
      category: 'business',
      generatedKind: 'ApplicationStack',
      sourceKinds: ['github-template'],
      components: [],
      availability: { available: true, sources: [{ kind: 'github-template', available: true }] },
    }))

    for (const language of ['en', 'ja', 'en'] as const) {
      setLanguage(language)
      const expected = language === 'ja' ? textJa.templates : textEn.templates
      const joined = joinBusinessTemplates(catalog)
      for (const [index, id] of ids.entries()) {
        const template = businessTemplateById(id)!
        expect(template).toBe(originals[index]!)
        expect(template).toMatchObject(expected[id])
        expect(joined[index]).toMatchObject(expected[id])
        expect(template.icon).toBe(icons[index]!)
        if (language === 'en') {
          expect([template.name, template.lead, ...template.includes, template.seed].join(' ')).not.toMatch(/[ぁ-んァ-ン一-龯]/)
        }
      }
      expect(businessTemplates.map((template) => template.id)).toEqual(ids)
      expect(businessTemplates.map((template) => template.urlWord)).toEqual(['inventory', 'master', 'approval', 'reservation'])
    }
    expect(originals[0]!.name).toBe('Inventory')
    expect(originals[0]!.seed).toBe('I want to build an app to manage inventory and incoming and outgoing stock. I need an item list, stock movement history, and CSV import and export.')
  })

  test('schemas resolve shared validation messages when parsing, not at module load', () => {
    for (const language of ['ja', 'en', 'ja'] as const) {
      setLanguage(language)
      const results = [
        [detailsSchema.shape.displayName.safeParse(' '), copy.create.details.nameRequired],
        [detailsSchema.shape.groupId.safeParse(''), copy.create.details.groupNone],
        [detailsSchema.shape.repository.safeParse(undefined), copy.create.existing.required],
        [shareSchema.shape.shareGroupIds.safeParse([]), copy.create.share.groupRequired],
      ] as const
      for (const [result, message] of results) {
        expect(result.success).toBe(false)
        if (!result.success) expect(firstError(result.error.issues)).toBe(message)
      }
      expect(shareSchema.shape.shareGroupIds.safeParse(null).success).toBe(true)
    }
  })
})
