import { createRoute, redirect, type ErrorComponentProps } from '@tanstack/react-router'
import { buildDraftOptions } from '../api/build-queries'
import { isPlatformNotFound } from '../api/platform-error'
import { meQuery, useMe } from '../api/queries'
import { BuildPage } from '../features/build/build-page'
import { isImprovementDraft } from '../model/improve'
import { paths } from './paths'
import { DraftNotFound } from '../features/build/draft-not-found'
import { RouteError, rootRoute } from './root'

export const buildRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/build/$draftId',
  loader: async ({ context, params }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    const draft = await context.queryClient.ensureQueryData(buildDraftOptions(me.projectId, params.draftId))
    // An improvement session has its own page; the build session never runs one.
    if (isImprovementDraft(draft)) throw redirect({ href: paths.improve(draft.id), replace: true })
  },
  // The loader's draft GET is the usual failure point; a 404 is an answer
  // (deleted, or another account's draft), not something a reload fixes.
  errorComponent: function BuildRouteError(props: ErrorComponentProps) {
    const me = useMe().data
    if (isPlatformNotFound(props.error)) return <div className="p-5"><DraftNotFound email={me.person.email} /></div>
    return <RouteError {...props} />
  },
  component: function BuildRoute() {
    const { draftId } = buildRoute.useParams()
    return <BuildPage key={draftId} draftId={draftId} />
  },
})
