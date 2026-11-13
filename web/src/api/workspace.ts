import type { RestartDevWorkspaceRequest } from '@appthrust/api-schema/platform-api'
import type { PreviewWorkspace } from '../model/contracts/build'
import { getDevWorkspaceContract, restartDevWorkspaceContract } from './contracts/platform/workspace'
import { apiGateway } from './gateway'

/** Runtime URLs stay on the console proxy. The edge, not JavaScript, adds Authorization. */
export function devWorkspaceProxyUrl(url: string): string {
  const parsed = new URL(url, window.location.origin)
  if (!parsed.pathname.startsWith('/api/v1/')) {
    throw new Error('DevWorkspace returned a URL outside the Platform API proxy')
  }
  return `${parsed.pathname}${parsed.search}`
}

export function getWorkspace(projectId: string, workspaceId: string, signal: AbortSignal): Promise<PreviewWorkspace> {
  return apiGateway.platform(getDevWorkspaceContract, { projectId, id: workspaceId }, { signal })
}

/** Restarts the workspace runtime; `resetPreviewDatabase` also discards its preview database. */
export function restartWorkspace(projectId: string, workspaceId: string, body: RestartDevWorkspaceRequest): Promise<PreviewWorkspace> {
  return apiGateway.platform(restartDevWorkspaceContract, { projectId, id: workspaceId, ...body })
}

/**
 * The HTTP status of the preview page the iframe will load, or undefined when
 * nothing answered. Only the status is read: the page is the app's HTML, not
 * an API answer, and a proxy's error body is never kept or rendered.
 */
export async function previewStatus(url: string, signal: AbortSignal): Promise<number | undefined> {
  try {
    const response = await fetch(url, { method: 'GET', cache: 'no-store', signal })
    void response.body?.cancel().catch(() => {})
    return response.status
  } catch {
    // Network failures and request timeouts mean "not yet", just like a gateway 503.
    return undefined
  }
}
