import { createRoute } from '@tanstack/react-router'
import { AdminPlatformPage } from '../features/admin'
import { rootRoute } from './root'

export const adminPlatformRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/admin/platform',
  component: AdminPlatformPage,
})
