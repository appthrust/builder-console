import { ORPCError } from '@orpc/client'
import { Store } from '@tanstack/react-store'

/** Latches until a full-page sign-in; never discard draft/query/session data here. */
export const sessionExpiryStore = new Store(false)

function expiredError() {
  return new ORPCError('SESSION_EXPIRED', { status: 401, message: 'Session expired' })
}

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof ORPCError && error.code === 'SESSION_EXPIRED'
}

export function assertSessionActive(): void {
  if (sessionExpiryStore.state) throw expiredError()
}

/** JSON APIs never redirect to a page. Manual redirects also catch cross-origin IAM without CORS. */
export function checkSessionResponse(response: Response): Response {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (response.status === 401 || response.type === 'opaqueredirect' || response.redirected
    || (response.status >= 300 && response.status < 400 && response.status !== 304)
    || (response.ok && (contentType === 'text/html' || contentType === 'application/xhtml+xml'))) {
    sessionExpiryStore.setState(() => true)
    throw expiredError()
  }
  return response
}

/** Re-enter the edge's OIDC flow at the same draft URL; no tokens or API redirects enter the SPA. */
export function signInAgain(): void {
  window.location.assign(window.location.href)
}
