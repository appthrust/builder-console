import { createRoute } from '@tanstack/react-router'
import { HelpPage } from '../features/discover'
import { rootRoute } from './root'

export const helpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/help',
  component: HelpPage,
})
