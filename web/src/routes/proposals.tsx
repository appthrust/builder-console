import { createRoute } from '@tanstack/react-router'
import { ProposalPage, ProposalsPage } from '../features/proposals/proposal-page'
import { rootRoute } from './root'

export const proposalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/proposals',
  validateSearch: (search: Record<string, unknown>): { applicationId?: string } => ({ applicationId: typeof search.applicationId === 'string' ? search.applicationId : undefined }),
  component: function ProposalListRoute() {
    const { applicationId } = proposalsRoute.useSearch()
    return <ProposalsPage applicationId={applicationId} />
  },
})

export const proposalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/proposals/$id',
  component: function ProposalDetailRoute() {
    const { id } = proposalRoute.useParams()
    return <ProposalPage key={id} id={id} />
  },
})
