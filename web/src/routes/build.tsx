import { createRoute, notFound, redirect, type ErrorComponentProps } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { isConsoleError } from '../api/console'
import { buildDraftOptions } from '../api/queries/build'
import { buildResolveOptions, buildSessionOptions } from '../api/queries/build-sessions'
import { isPlatformNotFound } from '../api/platform-error'
import { meQuery } from '../api/queries/console'
import { readRetryDelay, retryReadQuery } from '../api/queries/shared'
import { BuildPage } from '../features/build/build-page'
import { ConsoleBuildPage } from '../features/build/console-build-page'
import { isImprovementDraft } from '../model/improve'
import { paths } from './paths'
import { DraftNotFoundPage, notFoundOnDraft404 } from '../features/build/draft-not-found'
import { RouteError, rootRoute } from './root'

/** Which engine opens this draft URL; decided by the server's resolver, never by a flag or this tab's storage. */
export type BuildRouteEngine = { engine: 'console-v1'; sessionId: string } | { engine: 'platform-v1' }

const isNotFound = (error: unknown) => isPlatformNotFound(error) || isConsoleError(error, 'not_found')

/**
 * The build route's loader. Every open asks the resolver (C12): an existing console-v1 session opens with the
 * new engine whatever the new-session flag says; anything else is a legacy draft and opens as before. A failed
 * resolution (403, 503, an unreadable answer) is an error, never "no session": it does not fall back to legacy.
 */
export async function loadBuildRoute(queryClient: QueryClient, draftId: string): Promise<BuildRouteEngine> {
  const me = await queryClient.ensureQueryData(meQuery)
  const resolved = await queryClient.fetchQuery({ ...buildResolveOptions(draftId), retry: retryReadQuery, retryDelay: readRetryDelay }).catch((error: unknown) => {
    // A 404 is an answer (deleted, or another account's draft), rendered by the not-found page.
    if (isNotFound(error)) throw notFound()
    throw error
  })
  if (resolved.engine === 'console-v1') {
    await queryClient.ensureQueryData({ ...buildSessionOptions(resolved.sessionId), retry: retryReadQuery, retryDelay: readRetryDelay }).catch((error: unknown) => {
      if (isNotFound(error)) throw notFound()
      throw error
    })
    return { engine: 'console-v1', sessionId: resolved.sessionId }
  }
  const draft = await queryClient.ensureQueryData(buildDraftOptions(me.projectId, draftId)).catch(notFoundOnDraft404)
  // An improvement session has its own page; the build session never runs one.
  if (isImprovementDraft(draft)) throw redirect({ href: paths.improve(draft.id), replace: true })
  return { engine: 'platform-v1' }
}

/** The page for the engine the loader resolved. */
export function BuildRouteView({ draftId, loaded }: { draftId: string; loaded: BuildRouteEngine }) {
  return loaded.engine === 'console-v1'
    ? <ConsoleBuildPage key={loaded.sessionId} sessionId={loaded.sessionId} />
    : <BuildPage key={draftId} draftId={draftId} />
}

export const buildRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/build/$draftId',
  loader: ({ context, params }) => loadBuildRoute(context.queryClient, params.draftId),
  notFoundComponent: DraftNotFoundPage,
  // A draft or session deleted while the page is open fails a later read the same way.
  errorComponent: function BuildRouteError(props: ErrorComponentProps) {
    if (isNotFound(props.error)) return <DraftNotFoundPage />
    return <RouteError {...props} />
  },
  component: function BuildRoute() {
    const { draftId } = buildRoute.useParams()
    return <BuildRouteView draftId={draftId} loaded={buildRoute.useLoaderData()} />
  },
})
