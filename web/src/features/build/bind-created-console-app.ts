import { ConsoleApiError, isConsoleError } from '../../api/console'
import { type BusinessApp, type ConsoleApi } from '../../api/console-unverified'
import { bindCreatedApp, ensureDraft, type AppDetails } from '../create/submit'
import { text } from './copy'

/** Older servers answered 404 for a bad group on create; preserve its operation and diagnostics. */
export class ConsoleAppCreationError extends ConsoleApiError {
  constructor(cause: ConsoleApiError) {
    super(cause.status, { error: cause.code, message: cause.message, details: cause.details })
    this.name = 'ConsoleAppCreationError'
    this.cause = cause
  }
}

/**
 * Resume console registration after the platform stack already exists. A saved
 * console id is only a hint: not_found clears it before creating a replacement.
 * Reuse a slug collision only in the requested group and never steal another
 * stack's record. Persist the selected id before binding so a retry keeps it.
 */
export async function bindCreatedConsoleApp(
  request: AppDetails,
  resume: { stackId: string; createdAppId?: string },
  deps: { console: ConsoleApi['apps']; onCreatedAppId: (appId: string | undefined) => void },
): Promise<BusinessApp> {
  const apps = await deps.console.list({ scope: 'mine' })
  let kept = apps.find((app) => app.stackId === resume.stackId)
  if (kept) {
    deps.onCreatedAppId(kept.id)
    return kept
  }
  if (!request.urlName) throw new Error(text.session.missingAppName)

  let previous: BusinessApp | undefined
  if (resume.createdAppId) {
    try {
      previous = await deps.console.get(resume.createdAppId)
    } catch (error) {
      if (!isConsoleError(error, 'not_found')) throw error
      deps.onCreatedAppId(undefined)
    }
  }
  try {
    kept = await ensureDraft(request, { draft: previous }, deps.console)
  } catch (error) {
    if (!previous && isConsoleError(error, 'not_found') && error.status === 404) throw new ConsoleAppCreationError(error)
    if (!isConsoleError(error, 'slug_taken')) throw error
    const current = await deps.console.list({ scope: 'mine' })
    kept = current.find((app) => app.slug === request.urlName && app.group.id === request.groupId)
    if (!kept || (kept.stackId && kept.stackId !== resume.stackId)) throw error
  }
  deps.onCreatedAppId(kept.id)
  return bindCreatedApp(deps.console, kept, resume.stackId, request.urlName)
}
