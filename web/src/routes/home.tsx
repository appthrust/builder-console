import { createRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { HomePage } from '../features/discover'
import { rootRoute } from './root'

export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: z.object({ q: z.string().default('') }),
  component: function HomeRoute() {
    const { q } = homeRoute.useSearch()
    return <HomePage q={q} />
  },
})
