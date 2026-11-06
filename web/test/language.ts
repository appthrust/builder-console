import { languageStore } from '../src/shell/language'

/** Restore both the console store and the browser preference shared with Dashboard. */
export function preserveLanguage(): () => void {
  const state = languageStore.state
  const browserDocument = typeof document === 'undefined' ? undefined : document
  const cookie = browserDocument?.cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('appthrust-language='))
  const htmlLanguage = browserDocument?.documentElement.getAttribute('lang')

  return () => {
    languageStore.setState(() => state)
    if (!browserDocument) return
    // Calling setLanguage(previous) here would create a cookie even when the
    // test started without one, overriding Dashboard's browser-language fallback.
    browserDocument.cookie = cookie
      ? `${cookie}; Path=/; SameSite=Lax`
      : 'appthrust-language=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    if (htmlLanguage == null) browserDocument.documentElement.removeAttribute('lang')
    else browserDocument.documentElement.setAttribute('lang', htmlLanguage)
  }
}
