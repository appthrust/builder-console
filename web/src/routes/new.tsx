import { createRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { NewAppPage } from '../features/create'
import { rootRoute } from './root'

export const newRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/new',
  validateSearch: z.object({
    group: z.string().optional(),
    resume: z.string().optional(),
    template: z.string().optional(),
    intent: z.string().optional(),
    step: z.enum(['start', 'details', 'share', 'confirm']).optional(),
  }),
  component: function NewRoute() {
    const { group } = newRoute.useSearch()
    return <NewAppPage defaultGroupPath={group || undefined} />
  },
})
