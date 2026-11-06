// The only place the route tree is assembled.
import { accountRoute } from './account'
import { adminPlatformRoute } from './admin-platform'
import { appByIdRoute } from './app-by-id'
import { buildRoute } from './build'
import { companyRoute } from './company'
import { draftsRoute } from './drafts'
import { helpRoute } from './help'
import { excel2appRoute } from './excel2app'
import { homeRoute } from './home'
import { improveRoute } from './improve'
import { mineRoute } from './mine'
import { newRoute } from './new'
import { personRoute } from './person'
import { proposalRoute, proposalsRoute } from './proposals'
import { requestAccessRoute } from './request-access'
import { resourceRoute } from './resource'
import { rootRoute } from './root'

export const routeTree = rootRoute.addChildren([
  homeRoute,
  mineRoute,
  draftsRoute,
  accountRoute,
  companyRoute,
  helpRoute,
  newRoute,
  excel2appRoute,
  buildRoute,
  improveRoute,
  proposalRoute,
  proposalsRoute,
  adminPlatformRoute,
  appByIdRoute,
  personRoute,
  requestAccessRoute,
  resourceRoute,
])
