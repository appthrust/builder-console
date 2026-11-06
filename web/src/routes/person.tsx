import { useSuspenseQuery } from '@tanstack/react-query'
import { createRoute, redirect } from '@tanstack/react-router'
import { directoryLinks } from '../api/console'
import { meQuery, personQuery } from '../api/queries'
import { PersonPage } from '../features/discover'
import { notFoundOn404 } from './resource'
import { rootRoute } from './root'

/**
 * `/-/people/<id>`: profiles live in the Directory, so this redirects to its
 * public profile page. Without a linked Directory (`directoryPublicURL` empty)
 * a minimal in-console card stands in; an unknown person is the not-found page.
 */
export const personRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/people/$personId',
  loader: async ({ context, params }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    if (me.directoryPublicURL) throw redirect({ href: directoryLinks.person(me.directoryPublicURL, params.personId), replace: true })
    await context.queryClient.ensureQueryData(personQuery(params.personId)).catch(notFoundOn404)
  },
  component: function PersonRoute() {
    const { personId } = personRoute.useParams()
    const { data: profile } = useSuspenseQuery(personQuery(personId))
    return <PersonPage key={profile.person.id} profile={profile} />
  },
})
