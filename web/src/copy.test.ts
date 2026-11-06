import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { copy, reasonHelp, reasonText, relativeTime } from './copy'
import { apps, reasonCopy, reasonHelp as japaneseReasonHelp } from './copy/apps'
import { appsEn, reasonCopyEn, reasonHelpEn } from './copy/apps.en'
import { accessRequestCopy } from './copy/access-request'
import { sharingCopy } from './copy/sharing'
import { currentLanguage, locale, setLanguage } from './shell/language'

const initialLanguage = currentLanguage()
const now = Date.parse('2026-10-13T12:00:00Z')

beforeEach(() => setLanguage('ja'))
afterEach(() => setLanguage(initialLanguage))

describe('language-aware copy', () => {
  test('an existing import resolves properties and function entries on every access', () => {
    expect(copy.nav.home).toBe('ホーム')
    expect(copy.nav.draftsLabel(2)).toBe('作りかけ（2 件）')
    expect(copy.language.label).toBe('言語')
    expect(copy.nav.account).toBe('アカウントの設定')
    expect(copy.account.title).toBe('アカウントの設定')
    expect(copy.account.languageSaved).toBe('この設定はこのブラウザに保存されます')

    setLanguage('en')
    expect(copy.nav.home).toBe('Home')
    expect(copy.nav.draftsLabel(2)).toBe('Drafts (2)')
    expect(copy.language.label).toBe('Language')
    expect(copy.nav.account).toBe('Account settings')
    expect(copy.account.title).toBe('Account settings')
    expect(copy.account.languageSaved).toBe('Saved in this browser')
    expect(copy.language.names).toEqual({ ja: '日本語', en: 'English' })
    expect(locale()).toBe('en-US')

    setLanguage('ja')
    expect(copy.nav.home).toBe('ホーム')
    expect(copy.nav.draftsLabel(2)).toBe('作りかけ（2 件）')
    expect(copy.language.label).toBe('言語')
    expect(copy.account.title).toBe('アカウントの設定')
    expect(copy.language.names).toEqual({ ja: '日本語', en: 'English' })
    expect(locale()).toBe('ja-JP')
  })

  test('relative time switches immediately in both directions', () => {
    const at = '2026-10-13T11:58:00Z'
    expect(relativeTime(at, now)).toBe('2 分前')

    setLanguage('en')
    expect(relativeTime(at, now)).toBe('2 minutes ago')
    expect(relativeTime('2026-10-13T11:59:00Z', now)).toBe('1 minute ago')
    expect(relativeTime('2026-10-13T11:00:00Z', now)).toBe('1 hour ago')
    expect(relativeTime('2026-10-13T10:00:00Z', now)).toBe('2 hours ago')
    expect(relativeTime('2026-10-12T12:00:00Z', now)).toBe('1 day ago')
    expect(relativeTime('2026-10-11T12:00:00Z', now)).toBe('2 days ago')
    expect(relativeTime('2026-10-13T12:00:00Z', now)).toBe('Just now')

    setLanguage('ja')
    expect(relativeTime(at, now)).toBe('2 分前')
    expect(relativeTime('2026-10-13T11:00:00Z', now)).toBe('1 時間前')
    expect(relativeTime('2026-10-12T12:00:00Z', now)).toBe('1 日前')
    expect(relativeTime('2026-10-13T12:00:00Z', now)).toBe('たった今')
  })

  test('missing, invalid, and future timestamps retain their behavior', () => {
    for (const language of ['ja', 'en'] as const) {
      setLanguage(language)
      expect(relativeTime(undefined, now)).toBeUndefined()
      expect(relativeTime('', now)).toBeUndefined()
      expect(relativeTime('not a date', now)).toBeUndefined()
      expect(relativeTime('2026-10-14T12:00:00Z', now)).toBe(copy.relative.justNow)
    }
  })

  test('app wording and reason helpers switch in both directions', () => {
    for (const language of ['ja', 'en', 'ja'] as const) {
      setLanguage(language)
      const appWords = language === 'ja' ? apps : appsEn
      const reasons = language === 'ja' ? reasonCopy : reasonCopyEn
      const help = language === 'ja' ? japaneseReasonHelp : reasonHelpEn
      expect(copy.app).toBe(appWords.app)
      expect(copy.status.live).toBe(language === 'ja' ? '公開中' : 'Live')
      expect(copy.statusText.liveVersion('v2')).toBe(appWords.statusText.liveVersion('v2'))
      expect(reasonText('ComponentReady')).toBe(reasons.ComponentReady)
      expect(reasonText('PortUnresolved')).toBe(reasons.PortUnresolved)
      expect(reasonText('ReadyConditionFalse')).toBe(language === 'ja' ? '正常に動いていません。ログを確認してください。' : 'The app is not running normally; check the logs.')
      expect(reasonHelp.PortUnresolved).toBe(help.PortUnresolved)
      expect(reasonHelp.ComponentReady).toBeUndefined()
    }
  })

  test('sharing and access request catalogs resolve the current language', () => {
    expect(sharingCopy.title).toBe('共有')
    expect(sharingCopy.status.limited(1, '')).toBe('限定（1 人）')
    expect(accessRequestCopy.title).toBe('アクセスのリクエスト')
    expect(accessRequestCopy.remaining(1)).toBe('残り 1 字')

    setLanguage('en')
    expect(sharingCopy.title).toBe('Share')
    expect(sharingCopy.status.limited(1, '')).toBe('Limited (1 person)')
    expect(sharingCopy.status.limited(2, 'Sales')).toBe('Limited (2 people · Sales)')
    expect(accessRequestCopy.title).toBe('Access request')
    expect(accessRequestCopy.remaining(1)).toBe('1 character left')
    expect(accessRequestCopy.remaining(2)).toBe('2 characters left')

    setLanguage('ja')
    expect(sharingCopy.title).toBe('共有')
    expect(sharingCopy.status.limited(2, '営業部')).toBe('限定（2 人・営業部）')
    expect(accessRequestCopy.title).toBe('アクセスのリクエスト')
    expect(accessRequestCopy.remaining(2)).toBe('残り 2 字')
  })
})
