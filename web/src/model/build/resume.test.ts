import { describe, expect, test } from 'bun:test'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { draftOf } from '../../api/testing/build-domain'
import * as model from './resume'

/** The fixture the production reader resumed (fixtures carry distinct ids per call). */
const findResumableDraft = <T extends { id: string }>(drafts: readonly T[], intent: string) => {
  const found = model.findResumableDraft(drafts.map(draftOf), intent)
  return found && drafts.find((draft) => draft.id === found.id)
}
import { textJa } from './copy'
import { textEn } from './copy.en'
import { currentLanguage, setLanguage } from '../../shell/language'

const base: ApplicationDraft = {
  id: 'd', projectId: 'pj', title: '在庫', intent: '在庫管理したい', phase: 'specifying', specMarkdown: '', architectureMarkdown: '',
  creationExecutions: [], ownerUserId: 'u1', createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
}

describe('pressing AI と作る again resumes instead of multiplying', () => {
  test('the newest unfinished draft with the same words wins; appended replies and whitespace are ignored', () => {
    const older = { ...base, id: 'old', updatedAt: '2026-10-09T01:00:00Z' }
    const newer = { ...base, id: 'new', phase: 'planned' as const, intent: '在庫管理したい\n\n### 追記\n\n質問してください\n\n### 追記\n\nCSV も', updatedAt: '2026-10-09T02:00:00Z' }
    expect(findResumableDraft([older, newer], ' 在庫管理したい\n')?.id).toBe('new')
  })
  test('different words, created apps and archived drafts never resume', () => {
    expect(findResumableDraft([base], '在庫管理したい。')).toBeUndefined()
    expect(findResumableDraft([{ ...base, phase: 'created' }], base.intent)).toBeUndefined()
    expect(findResumableDraft([{ ...base, createdApplicationStackId: 'stack-1' }], base.intent)).toBeUndefined()
    expect(findResumableDraft([{ ...base, phase: 'archived' }], base.intent)).toBeUndefined()
    expect(findResumableDraft([base], '  ')).toBeUndefined()
  })
  test('saved drafts resume across languages with translated reply and publication markers', () => {
    const originalLanguage = currentLanguage()
    try {
      for (const language of ['en', 'ja'] as const) {
        setLanguage(language)
        for (const copy of [textJa, textEn]) {
          const draft = { ...base, intent: `${base.intent}\n\n${copy.intent.reply}\n\nCSV\n\n${copy.intent.publish}` }
          expect(findResumableDraft([draft], base.intent)).toBe(draft)
          const published = { ...base, intent: `${base.intent}\n\n${copy.intent.publish}` }
          expect(findResumableDraft([published], base.intent)).toBe(published)
        }
      }
    } finally {
      setLanguage(originalLanguage)
    }
  })
})
