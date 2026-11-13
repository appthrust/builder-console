// The created app as the build screen shows it, shared by both build engines
// (extracted unchanged from the legacy build page, APT-753): its Platform view,
// the access it is being given, whether the implemented release is live, its
// URL once it is, and the sentence saying who can open it.
import { AccessForbiddenError } from '../../api/access'
import { implementedReleaseReady } from '../../model/app'
import { deriveAccess, shareScopeLabel } from '../../model/access'
import type { BuildDraft } from '../../model/contracts/build'
import type { BusinessApp, Group } from '../../model/contracts/console'
import { useAppViews } from '../app/use-app-views'
import { useCreatedAppAccess } from '../create/access'
import type { ImplementationState } from './implement'

export function useCreatedAppView({ projectId, draft, app, groups, initialReleaseId, tasks }: {
  projectId: string
  draft: BuildDraft
  app?: BusinessApp
  groups: Group[]
  initialReleaseId?: string
  tasks: ImplementationState['tasks']
}) {
  const lookup = useAppViews(projectId)
  const appView = app ? lookup.viewFor(app) : undefined
  const creationAccess = useCreatedAppAccess(projectId, app, appView?.platform?.publish)
  const releases = lookup.input.releasesByApplication[draft.createdApplicationId ?? '']?.components.flatMap((component) => component.releases) ?? []
  const released = implementedReleaseReady(appView?.platform, releases, { draftId: draft.id, initialReleaseId, taskCount: tasks.length, tasks })
  const url = released ? appView?.platform?.publish?.publicUrl ?? appView?.platform?.publish?.tailnetUrl : undefined
  const shareText = app ? deriveAccess(appView?.platform?.publish?.access, app, groups, creationAccess.error instanceof AccessForbiddenError ? 'forbidden' : creationAccess.error ? 'failed' : undefined).label : shareScopeLabel('private')
  return { appView, creationAccess, released, url, shareText }
}
