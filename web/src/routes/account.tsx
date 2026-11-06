import { createRoute } from '@tanstack/react-router'
import { AccountPage } from '../features/account'
import { rootRoute } from './root'

export const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/account',
  component: AccountPage,
})
