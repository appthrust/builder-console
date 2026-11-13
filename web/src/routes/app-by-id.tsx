import { createRoute, redirect } from '@tanstack/react-router'
import { appQuery } from '../api/queries/console'
import { paths } from './paths'
import { notFoundOn404 } from './resource'
import { rootRoute } from './root'

/** Permanent id URL `/-/apps/<id>` (notifications, external links): replaced by the app's current path. */
export const appByIdRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/apps/$appId',
  loader: async ({ context, params }) => {
    const app = await context.queryClient.ensureQueryData(appQuery(params.appId)).catch(notFoundOn404)
    throw redirect({ href: paths.app(app.group.path, app.slug), replace: true })
  },
})
