// The console's display language (TanStack Store). Shared with the Dashboard
// through the same cookie (`appthrust-language`, dashboard/src/lib/i18n/
// translations.ts) so a person moving between the two keeps one choice.
// Precedence: cookie → ja (the console's audience and source wording).
import { Store } from '@tanstack/react-store'
import { useSelector } from '@tanstack/react-store'

export type Language = 'ja' | 'en'

export const LANGUAGES: readonly Language[] = ['ja', 'en']

const COOKIE_NAME = 'appthrust-language'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export function isLanguage(value: unknown): value is Language {
  return value === 'ja' || value === 'en'
}

function readCookie(cookie: string): Language | undefined {
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== COOKIE_NAME) continue
    const value = decodeURIComponent(rest.join('='))
    return isLanguage(value) ? value : undefined
  }
  return undefined
}

/** The saved choice, else Japanese. Browser language is not consulted. */
export function resolveInitialLanguage(cookie: string): Language {
  return readCookie(cookie) ?? 'ja'
}

export const languageStore = new Store<{ language: Language }>({
  language: typeof document === 'undefined' ? 'ja' : resolveInitialLanguage(document.cookie),
})

export function currentLanguage(): Language {
  return languageStore.state.language
}

export function locale(language: Language = currentLanguage()): 'ja-JP' | 'en-US' {
  return language === 'ja' ? 'ja-JP' : 'en-US'
}

/** Persists the choice (cookie, one year) and updates `<html lang>`. */
export function setLanguage(language: Language) {
  if (typeof document !== 'undefined') {
    document.cookie = `${COOKIE_NAME}=${language}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax`
    document.documentElement.lang = language
  }
  languageStore.setState((state) => (state.language === language ? state : { language }))
}

export function useLanguage(): Language {
  return useSelector(languageStore, (state) => state.language)
}

/**
 * A wording catalog that reads as the current language's tree on every property
 * access, so `text.section.key` and `text.section.label(n)` call sites stay as
 * they are and models/API code outside React see the same language as screens.
 * The Japanese tree owns the keys and signatures; `en` must match its shape.
 */
export function localized<T extends object>(trees: { ja: T; en: T }): T {
  return new Proxy(trees.ja, {
    get(_target, key) {
      return Reflect.get(trees[currentLanguage()], key)
    },
  })
}

if (typeof document !== 'undefined') document.documentElement.lang = currentLanguage()
