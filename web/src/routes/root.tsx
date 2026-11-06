import { useQueryClient, useQueryErrorResetBoundary, type QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet, useRouter, useRouterState, type ErrorComponentProps } from '@tanstack/react-router'
import { FileQuestion } from 'lucide-react'
import { useEffect } from 'react'
import { isConsoleError } from '../api/console'
import { groupsQuery, meQuery } from '../api/queries'
import { copy } from '../copy'
import { Shell } from '../shell/shell'
import { EmptyState, LinkButton, Loading, LoadFailed, UnsavedChangesProvider, useDocumentTitle } from '../ui'
import { paths } from './paths'
import { nearestGroupAncestor } from './resource-path'

export type RouterContext = { queryClient: QueryClient }

/** 404 for unknown URLs, reserved paths, and groups/apps the caller cannot see (existence is not revealed). */
export function NotFound({ attemptedPath }: { attemptedPath?: string } = {}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const path = attemptedPath ?? pathname
  const groups = useQueryClient().getQueryData(groupsQuery.queryKey) ?? []
  const ancestor = nearestGroupAncestor(path, groups)
  useDocumentTitle(copy.notFound.title)
  return (
    <div className="mx-auto max-w-md py-12">
      <EmptyState
        icon={<FileQuestion />}
        heading="h1"
        title={copy.notFound.title}
        body={<>{copy.notFound.body}<span className="mt-3 block text-xs">{copy.notFound.attemptedPath}</span><span className="mt-1 block break-all font-mono text-xs">{path}</span></>}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <LinkButton href={paths.home} tone="primary">{copy.notFound.home}</LinkButton>
            {ancestor ? <LinkButton href={paths.group(ancestor.path)}>{copy.notFound.ancestor(ancestor.name)}</LinkButton> : null}
          </div>
        }
      />
    </div>
  )
}

/** In-page load failure (inside the shell). Retry re-runs the route's loaders and resets failed suspense queries. */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter()
  const queryErrorResetBoundary = useQueryErrorResetBoundary()
  useEffect(() => queryErrorResetBoundary.reset(), [queryErrorResetBoundary])
  if (isConsoleError(error, 'not_found')) return <NotFound />
  return (
    <div className="mx-auto max-w-xl py-8">
      <LoadFailed error={error} onRetry={() => void router.invalidate()} />
    </div>
  )
}

export function RoutePending() {
  return <Loading />
}

/** The caller or the group list could not be loaded: there is no shell to show yet. */
function RootError(props: ErrorComponentProps) {
  useDocumentTitle(copy.common.loadFailed)
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <RouteError {...props} />
    </div>
  )
}

function RootPending() {
  useDocumentTitle(copy.common.loading)
  return (
    <div className="mx-auto flex max-w-xl justify-center px-6 py-24">
      <Loading />
    </div>
  )
}

function RootTitle() {
  useDocumentTitle(copy.nav.home)
  return null
}

function NotFoundRoute() {
  const attemptedPath = useRouterState({ select: (state) => state.location.pathname })
  return <NotFound attemptedPath={attemptedPath} />
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    if (!me.notMember) await context.queryClient.ensureQueryData(groupsQuery)
  },
  component: () => (
    <>
      <RootTitle />
      <UnsavedChangesProvider>
        <Shell><Outlet /></Shell>
      </UnsavedChangesProvider>
    </>
  ),
  errorComponent: RootError,
  pendingComponent: RootPending,
  notFoundComponent: NotFoundRoute,
})
