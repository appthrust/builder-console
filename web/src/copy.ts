// All console wording lives in catalogs: ./copy (shell, apps, sharing,
// access-request) plus feature/model-local copy modules. Each catalog is a
// Japanese tree (owning keys and signatures) and an English sibling of the same
// type, joined with `localized()` so call sites read `copy.section.key` and get
// the current language. No screen hardcodes user-facing text.
import type { ComponentReasonKey } from './model/contracts/app'
import { apps, reasonCopy, reasonHelp as reasonHelpJa } from './copy/apps'
import { appsEn, reasonCopyEn, reasonHelpEn } from './copy/apps.en'
import { shell } from './copy/shell'
import { shellEn } from './copy/shell.en'
import { currentLanguage, localized } from './shell/language'

const appsByLanguage = {
  ja: { apps, reasonCopy, reasonHelp: reasonHelpJa },
  en: { apps: appsEn, reasonCopy: reasonCopyEn, reasonHelp: reasonHelpEn },
}

export const copy = localized({
  ja: { ...shell, ...appsByLanguage.ja.apps },
  en: { ...shellEn, ...appsByLanguage.en.apps },
})

export type { ConsoleStatus } from './copy/apps'

export const reasonHelp = localized({ ja: appsByLanguage.ja.reasonHelp, en: appsByLanguage.en.reasonHelp })

/** Plain-language explanation of a component-summaries reasonKey. */
export function reasonText(reasonKey: ComponentReasonKey): string {
  return appsByLanguage[currentLanguage()].reasonCopy[reasonKey]
}

/** Relative time in the current language; `now` is injectable for tests. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string | undefined {
  if (!iso) return undefined
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return undefined
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  const relative = copy.relative
  if (minutes < 1) return relative.justNow
  if (minutes < 60) return relative.minutes(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return relative.hours(hours)
  return relative.days(Math.floor(hours / 24))
}
