// Transport only: typed Platform API client built from the shared oRPC contract.
// Screens never touch fetch or headers directly.
//
// The console is served same-origin with a reverse proxy: `/api/*` goes to the
// Platform API, and the Authorization header is attached by the OIDC edge
// (Envoy) in front of the console. The SPA never sees or requests a token.
import { platformApiRouter } from '@appthrust/api-schema/platform-api-router'
import { createORPCClient, ORPCError } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'
import { OpenAPILink } from '@orpc/openapi-client/fetch'

type PlatformClientContext = { idempotencyKey?: string }
export type PlatformApiClient = ContractRouterClient<typeof platformApiRouter, PlatformClientContext>

const READ_TIMEOUT_MS = 8_000

// A 401 first sends the browser to `/` so the edge re-runs sign-in. Another 401
// within this window of that round-trip means the edge forwards a token the
// Platform API rejects (e.g. AudienceNotAllowed); redirecting again would loop,
// so the 401 reaches the screens, which show `copy.common.accessDenied`.
const REAUTH_WINDOW_MS = 60_000
const REAUTH_AT_KEY = 'builder-console:reauth-at'

export async function platformFetch(request: Request): Promise<Response> {
  const headers = new Headers(request.headers)
  const read = request.method === 'GET' || request.method === 'HEAD'
  if (!read && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', crypto.randomUUID())
  }
  const signal = read
    ? AbortSignal.any([request.signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
    : request.signal
  const response = await fetch(new Request(request, { headers, signal }))
  if (response.status !== 401) {
    if (response.ok) sessionStorage.removeItem(REAUTH_AT_KEY)
    return response
  }
  const lastReauthAt = Number(sessionStorage.getItem(REAUTH_AT_KEY))
  if (Date.now() - lastReauthAt < REAUTH_WINDOW_MS) return response
  sessionStorage.setItem(REAUTH_AT_KEY, String(Date.now()))
  window.location.assign('/')
  // The page is unloading; keep the call pending so screens do not flash an error.
  return new Promise<Response>(() => {})
}

// Contract paths already start with `/api/v1`, so the base is the bare origin
// (an `/api` suffix would produce `/api/api/v1/...`).
const link = new OpenAPILink<PlatformClientContext>(platformApiRouter, {
  url: () => window.location.origin,
  headers: ({ context }) => context.idempotencyKey ? { 'Idempotency-Key': context.idempotencyKey } : {},
  fetch: (request) => platformFetch(request),
})

export const client: PlatformApiClient = createORPCClient(link)

/** The Platform API rejected the edge-issued credentials even after a fresh sign-in. */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof ORPCError && error.status === 401
}
