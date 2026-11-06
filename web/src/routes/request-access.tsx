import { createRoute } from '@tanstack/react-router'
import { RequestAccessPage } from '../features/access-request/request-access-page'
import { rootRoute } from './root'

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    memberGate?: boolean
  }
}

export const requestAccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/request-access/$appName',
  validateSearch: (search: Record<string, unknown>): { reason?: string } => ({
    reason: typeof search.reason === 'string' ? search.reason : undefined,
  }),
  staticData: { memberGate: false },
  component: RequestAccessRoute,
})

function RequestAccessRoute() {
  const { appName } = requestAccessRoute.useParams()
  const { reason } = requestAccessRoute.useSearch()
  return <RequestAccessPage key={appName} appName={appName} reason={reason} />
}
