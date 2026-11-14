import { createRoute } from '@tanstack/react-router'
import { WorkspacePreviewPage } from '../features/build/implement/preview-page'
import { rootRoute } from './root'

/** The new-tab preview viewer (`paths.workspacePreview`): the Console's own page around the workspace's preview origin. */
export const workspacePreviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/workspaces/$workspaceId/preview',
  component: function WorkspacePreviewRoute() {
    const { workspaceId } = workspacePreviewRoute.useParams()
    return <WorkspacePreviewPage key={workspaceId} workspaceId={workspaceId} />
  },
})
