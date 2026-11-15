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
  // The created identity is authoritative even when its old plan is unreadable; never recreate/bind to display it.
  const stackId = draft.createdApplicationStackId ?? lookup.input.stacks.find((stack) => stack.applicationId === draft.createdApplicationId)?.id
  const appView = app ? lookup.viewFor(app) : stackId && draft.createdApplicationId
    ? lookup.viewFor({ id: draft.createdApplicationId, stackId, createdAt: draft.createdAt }) : undefined
  const creationAccess = useCreatedAppAccess(projectId, appView?.unreadableStack || appView?.unreadableBuild ? undefined : app, appView?.platform?.publish)
  const releases = lookup.input.releasesByApplication[draft.createdApplicationId ?? '']?.components.flatMap((component) => component.releases) ?? []
  const released = draft.creationPlanUnreadable && draft.createdApplicationId ? Boolean(appView?.url) : implementedReleaseReady(appView?.platform, releases, { draftId: draft.id, initialReleaseId, taskCount: tasks.length, tasks })
  const url = released ? appView?.platform?.publish?.publicUrl ?? appView?.platform?.publish?.tailnetUrl : undefined
  const shareText = app ? deriveAccess(appView?.platform?.publish?.access, app, groups, creationAccess.error instanceof AccessForbiddenError ? 'forbidden' : creationAccess.error ? 'failed' : undefined).label : shareScopeLabel('private')
  return { appView, creationAccess, released, url, shareText }
}
