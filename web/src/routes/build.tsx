import { createRoute, redirect, type ErrorComponentProps } from '@tanstack/react-router'
import { buildDraftOptions } from '../api/queries/build'
import { isPlatformNotFound } from '../api/platform-error'
import { meQuery } from '../api/queries/console'
import { BuildPage } from '../features/build/build-page'
import { isImprovementDraft } from '../model/improve'
import { paths } from './paths'
import { DraftNotFoundPage, notFoundOnDraft404 } from '../features/build/draft-not-found'
import { RouteError, rootRoute } from './root'

export const buildRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/build/$draftId',
  // The loader's draft GET is the usual failure point; a 404 is an answer
  // (deleted, or another account's draft), not something a reload fixes.
  loader: async ({ context, params }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    const draft = await context.queryClient.ensureQueryData(buildDraftOptions(me.projectId, params.draftId)).catch(notFoundOnDraft404)
    // An improvement session has its own page; the build session never runs one.
    if (isImprovementDraft(draft)) throw redirect({ href: paths.improve(draft.id), replace: true })
  },
  notFoundComponent: DraftNotFoundPage,
  // A draft deleted while the page is open fails a later read the same way.
  errorComponent: function BuildRouteError(props: ErrorComponentProps) {
    if (isPlatformNotFound(props.error)) return <DraftNotFoundPage />
    return <RouteError {...props} />
  },
  component: function BuildRoute() {
    const { draftId } = buildRoute.useParams()
    return <BuildPage key={draftId} draftId={draftId} />
  },
})
