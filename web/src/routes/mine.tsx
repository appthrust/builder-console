import { createRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { MinePage } from '../features/discover'
import { rootRoute } from './root'

export const mineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mine',
  validateSearch: z.object({ status: z.literal('problem').optional() }),
  component: function MineRoute() {
    const { status } = mineRoute.useSearch()
    return <MinePage status={status} />
  },
})
