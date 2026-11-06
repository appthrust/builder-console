import type { RestartDevWorkspaceRequest } from '@appthrust/api-schema/platform-api'
import { client } from './client'

/** Runtime URLs stay on the console proxy. The edge, not JavaScript, adds Authorization. */
export function devWorkspaceProxyUrl(url: string): string {
  const parsed = new URL(url, window.location.origin)
  if (!parsed.pathname.startsWith('/api/v1/')) {
    throw new Error('DevWorkspace returned a URL outside the Platform API proxy')
  }
  return `${parsed.pathname}${parsed.search}`
}

export function getWorkspace(projectId: string, workspaceId: string, signal: AbortSignal) {
  return client.platformApiGetDevWorkspace({ projectId, id: workspaceId }, { signal })
}

/** Restarts the workspace runtime; `resetPreviewDatabase` also discards its preview database. */
export function restartWorkspace(projectId: string, workspaceId: string, body: RestartDevWorkspaceRequest) {
  return client.platformApiRestartDevWorkspace({ projectId, id: workspaceId, ...body })
}
