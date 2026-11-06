import { isValidSlug } from '../api/console'

export type AccessDenialReason = 'unknown_app' | 'unknown_person' | 'not_visible'

/** Unknown denial reasons deliberately keep the ordinary request form. */
export function stateFromReason(reason: string | undefined): AccessDenialReason {
  return reason === 'unknown_app' || reason === 'unknown_person' ? reason : 'not_visible'
}

/** The app lives beside the console: `console.<host>` serves `<app>.<host>`, always over HTTPS. */
export function appOrigin(appName: string, consoleHost: string): string | undefined {
  if (!isValidSlug(appName) || appName === 'console') return undefined
  return `https://${appName}.${consoleHost.replace(/^console\./, '')}`
}
