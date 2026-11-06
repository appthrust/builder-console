import { createRoute } from '@tanstack/react-router'
import { DraftsPage } from '../features/discover'
import { rootRoute } from './root'

export const draftsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/drafts',
  component: DraftsPage,
})
