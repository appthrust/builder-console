import { createRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { DirectoryPage } from '../features/discover'
import { rootRoute } from './root'

export const companyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/company',
  validateSearch: z.object({ q: z.string().optional() }),
  component: function CompanyRoute() {
    const search = companyRoute.useSearch()
    return <DirectoryPage q={search.q ?? ''} />
  },
})
