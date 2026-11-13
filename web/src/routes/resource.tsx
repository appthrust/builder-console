// `/<group-path>[/<app-slug>][/-/<tab>]` (ux-design §7.1.1). The console API
// decides whether the path is a group, an app or its directory entry (resolve) and follows the
// redirect table: a moved/renamed group or app reached through an old path is
// replaced with its current path, keeping the sub-page and query.
import { useSuspenseQuery } from '@tanstack/react-query'
import { createRoute, notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { isConsoleError } from '../api/console'
import { appQuery, directoryEntryQuery, groupsQuery, resolveQuery, useGroups } from '../api/queries/console'
import { AppPage } from '../features/app'
import { EntryPage, GroupPage } from '../features/discover'
import { paths, type AppTab, type GroupTab } from './paths'
import { parseResourcePath } from './resource-path'
import { NotFound, rootRoute } from './root'

const GROUP_TABS: Record<string, GroupTab> = { apps: 'apps', members: 'members' }
const APP_TABS: Record<string, AppTab> = { guide: 'guide', data: 'data', releases: 'releases', settings: 'settings', logs: 'logs' }

/** `.catch` handler for loaders: a console 404 (unknown or invisible) renders the not-found page. */
export function notFoundOn404(error: unknown): never {
  if (isConsoleError(error, 'not_found')) throw notFound()
  throw error
}

export type ResourceMatch =
  | { kind: 'group'; id: string; groupPath: string; tab: GroupTab }
  | { kind: 'app'; id: string; groupPath: string; tab: AppTab }
  | { kind: 'entry'; id: string; groupPath: string }

export const resourceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$',
  // データ tab deep link (paths.appData); other pages ignore these.
  validateSearch: z.object({ table: z.string().optional(), q: z.string().optional(), row: z.string().optional() }),
  loader: async ({ context: { queryClient }, params, location }): Promise<ResourceMatch> => {
    const parsed = parseResourcePath(params._splat ?? '')
    if (!parsed) throw notFound()
    const resolved = await queryClient.ensureQueryData(resolveQuery(`/${parsed.path}`)).catch(notFoundOn404)
    if (resolved.kind === 'entry' && parsed.sub !== null) throw notFound()
    const currentPath = resolved.currentPath.replace(/^\/+|\/+$/g, '')
    if (currentPath !== parsed.path) {
      queryClient.setQueryData(resolveQuery(`/${currentPath}`).queryKey, resolved)
      const sub = parsed.sub ? `/-/${encodeURIComponent(parsed.sub)}` : ''
      throw redirect({ href: `${paths.group(currentPath)}${sub}${location.searchStr}`, replace: true })
    }
    if (resolved.kind === 'group') {
      const tab = parsed.sub === null ? 'front' : Object.hasOwn(GROUP_TABS, parsed.sub) ? GROUP_TABS[parsed.sub] : null
      if (!tab) throw notFound()
      // Groups come from the Directory list; a group created since the last poll needs one fresh read.
      const known = (await queryClient.ensureQueryData(groupsQuery)).find((candidate) => candidate.id === resolved.id)
      const group = known ?? (await queryClient.fetchQuery({ ...groupsQuery, staleTime: 0 })).find((candidate) => candidate.id === resolved.id)
      if (!group) throw notFound()
      return { kind: 'group', id: group.id, groupPath: group.path, tab }
    }
    if (resolved.kind === 'entry') {
      const entry = await queryClient.ensureQueryData(directoryEntryQuery(resolved.id)).catch(notFoundOn404)
      return { kind: 'entry', id: entry.id, groupPath: entry.group.path }
    }
    const tab = parsed.sub === null ? 'overview' : Object.hasOwn(APP_TABS, parsed.sub) ? APP_TABS[parsed.sub] : null
    if (!tab) throw notFound()
    const app = await queryClient.ensureQueryData(appQuery(resolved.id)).catch(notFoundOn404)
    return { kind: 'app', id: app.id, groupPath: app.group.path, tab }
  },
  component: function ResourceRoute() {
    const match = resourceRoute.useLoaderData()
    if (match.kind === 'group') return <GroupResource id={match.id} tab={match.tab} />
    if (match.kind === 'entry') return <EntryResource id={match.id} />
    return <AppResource id={match.id} tab={match.tab} />
  },
})

// Pages read the live query (polling, mutations) rather than the loader snapshot.
function GroupResource({ id, tab }: { id: string; tab: GroupTab }) {
  const group = useGroups().data.find((candidate) => candidate.id === id)
  // Deleted in the Directory while open.
  if (!group) return <NotFound />
  return <GroupPage group={group} tab={tab} />
}

function AppResource({ id, tab }: { id: string; tab: AppTab }) {
  const { data: app } = useSuspenseQuery(appQuery(id))
  return <AppPage key={app.id} app={app} tab={tab} />
}

function EntryResource({ id }: { id: string }) {
  const { data: entry } = useSuspenseQuery(directoryEntryQuery(id))
  return <EntryPage entry={entry} />
}
