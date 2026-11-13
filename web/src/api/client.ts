// Platform transport: the typed oRPC client over the shared contract. It
// returns undecoded outputs; the gateway (gateway.ts) is the only reader that
// turns them into domain values. Screens never touch fetch or headers directly.
//
// The console is served same-origin with a reverse proxy: `/api/*` goes to the
// Platform API, and the Authorization header is attached by the OIDC edge
// (Envoy) in front of the console. The SPA never sees or requests a token.
import { platformApiRouter } from '@appthrust/api-schema/platform-api-router'
import { createORPCClient, ORPCError } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import { assertSessionActive, checkSessionResponse } from './session-expiry'

/** Per-call context: the caller's idempotency key, and an observer of the HTTP status (the gateway checks success statuses). */
export type PlatformClientContext = { idempotencyKey?: string; onResponseStatus?: (status: number) => void }
export type PlatformApiClient = ContractRouterClient<typeof platformApiRouter, PlatformClientContext>

const READ_TIMEOUT_MS = 8_000

type FetchImpl = (request: Request) => Promise<Response>

/** Session latch, Idempotency-Key for writes, read timeout and manual redirects around `fetchImpl`. */
export function createPlatformFetch(fetchImpl: FetchImpl): FetchImpl {
  return async (request) => {
    assertSessionActive()
    const headers = new Headers(request.headers)
    const read = request.method === 'GET' || request.method === 'HEAD'
    if (!read && !headers.has('Idempotency-Key')) {
      headers.set('Idempotency-Key', crypto.randomUUID())
    }
    const signal = read
      ? AbortSignal.any([request.signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
      : request.signal
    return checkSessionResponse(await fetchImpl(new Request(request, { headers, signal, redirect: 'manual' })))
  }
}

export const platformFetch = createPlatformFetch((request) => fetch(request))

/**
 * A Platform API client. `fetch` is the network call under the session and
 * idempotency handling (tests inject it); `origin` defaults to the page origin,
 * read per request, so creating the default never touches `window`.
 */
export function createPlatformTransport(options: { fetch?: FetchImpl; origin?: () => string } = {}): PlatformApiClient {
  const send = options.fetch ? createPlatformFetch(options.fetch) : platformFetch
  // Contract paths already start with `/api/v1`, so the base is the bare origin
  // (an `/api` suffix would produce `/api/api/v1/...`).
  const link = new OpenAPILink<PlatformClientContext>(platformApiRouter, {
    url: options.origin ?? (() => window.location.origin),
    headers: ({ context }) => context.idempotencyKey ? { 'Idempotency-Key': context.idempotencyKey } : {},
    fetch: (request) => send(request),
    clientInterceptors: [
      async ({ next, context }) => {
        const response = await next()
        context.onResponseStatus?.(response.status)
        return response
      },
    ],
  })
  return createORPCClient(link)
}

export const client: PlatformApiClient = createPlatformTransport()

/** The Platform API rejected the edge-issued credentials even after a fresh sign-in. */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof ORPCError && error.status === 401
}
