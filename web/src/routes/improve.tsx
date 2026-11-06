import { createRoute, redirect, type ErrorComponentProps } from '@tanstack/react-router'
import { buildDraftOptions } from '../api/build-queries'
import { isPlatformNotFound } from '../api/platform-error'
import { meQuery, useMe } from '../api/queries'
import { DraftNotFound } from '../features/build/draft-not-found'
import { ImprovePage } from '../features/improve/improve-page'
import { isImprovementDraft } from '../model/improve'
import { paths } from './paths'
import { RouteError, rootRoute } from './root'

export const improveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/improve/$draftId',
  loader: async ({ context, params }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    const draft = await context.queryClient.ensureQueryData(buildDraftOptions(me.projectId, params.draftId))
    // A creation session opened by an improve link belongs to the build page.
    if (!isImprovementDraft(draft)) throw redirect({ href: paths.build(draft.id), replace: true })
  },
  errorComponent: function ImproveRouteError(props: ErrorComponentProps) {
    const me = useMe().data
    if (isPlatformNotFound(props.error)) return <div className="p-5"><DraftNotFound email={me.person.email} /></div>
    return <RouteError {...props} />
  },
  component: function ImproveRoute() {
    const { draftId } = improveRoute.useParams()
    return <ImprovePage key={draftId} draftId={draftId} />
  },
})
