import { createRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { Excel2AppPage } from '../features/excel2app'
import { rootRoute } from './root'

export const excel2appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/excel2app',
  // `draft` is the application draft the workbook was stored on; a reload resumes it.
  validateSearch: z.object({ draft: z.string().min(1).optional() }),
  component: function Excel2AppRoute() {
    const { draft } = excel2appRoute.useSearch()
    // The page retains its own newly created draft and resets on other draft navigation.
    return <Excel2AppPage draftId={draft} />
  },
})
