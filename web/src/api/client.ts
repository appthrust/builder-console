// Platform transport: the typed oRPC client over the shared contract. It
// returns undecoded outputs; the gateway (gateway.ts) is the only reader that
// turns them into domain values. Screens never touch fetch or headers directly.
//
// The console is served same-origin with a reverse proxy: `/api/*` goes to the
// Platform API, and the Authorization header is attached by the OIDC edge
// (Envoy) in front of the console. The SPA never sees or requests a token.
import { createORPCClient } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import { platformRouter } from './contracts/define'
import type { PlatformOperationMeta } from './contracts/platform/workspace-http-wire'
import { assertSessionActive, checkSessionResponse } from './session-expiry'

/** Per-call context: the caller's idempotency key, and an observer of the HTTP status (the gateway checks success statuses). */
export type PlatformClientContext = { idempotencyKey?: string; onResponseStatus?: (status: number) => void }
export type PlatformApiClient = ContractRouterClient<typeof platformRouter, PlatformClientContext>

const READ_TIMEOUT_MS = 8_000

type FetchImpl = (request: Request) => Promise<Response>
type PlatformFetch = (request: Request, operation?: PlatformOperationMeta) => Promise<Response>

/** The transport properties an operation declares in its contract (`oc.meta`); none for most. */
export function platformOperationMeta(operationId: string | undefined): PlatformOperationMeta {
  const procedure = operationId === undefined ? undefined : (platformRouter as Record<string, { '~orpc'?: { meta?: PlatformOperationMeta } } | undefined>)[operationId]
  return procedure?.['~orpc']?.meta ?? {}
}

/**
 * Session latch, Idempotency-Key for writes, read timeout and manual redirects around `fetchImpl`.
 * A credential exchange never carries an Idempotency-Key: each call is a fresh authorization, not a replayable write.
 * Nothing here retries; a failed call is the caller's to surface.
 */
export function createPlatformFetch(fetchImpl: FetchImpl): PlatformFetch {
  return async (request, operation = {}) => {
    assertSessionActive()
    const headers = new Headers(request.headers)
    const read = request.method === 'GET' || request.method === 'HEAD'
    if (operation.credentialExchange) headers.delete('Idempotency-Key')
    else if (!read && !headers.has('Idempotency-Key')) {
      headers.set('Idempotency-Key', crypto.randomUUID())
    }
    const signal = read
      ? AbortSignal.any([request.signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
      : request.signal
    return checkSessionResponse(await fetchImpl(new Request(request, { headers, signal, redirect: 'manual' })))
  }
}

const defaultFetch = createPlatformFetch((request) => fetch(request))

/**
 * A Platform API client. `fetch` is the network call under the session and
 * idempotency handling (tests inject it); `origin` defaults to the page origin,
 * read per request, so creating the default never touches `window`.
 */
export function createPlatformTransport(options: { fetch?: FetchImpl; origin?: () => string } = {}): PlatformApiClient {
  const send = options.fetch ? createPlatformFetch(options.fetch) : defaultFetch
  // Contract paths already start with `/api/v1`, so the base is the bare origin
  // (an `/api` suffix would produce `/api/api/v1/...`).
  const link = new OpenAPILink<PlatformClientContext>(platformRouter, {
    url: options.origin ?? (() => window.location.origin),
    headers: ({ context }) => context.idempotencyKey ? { 'Idempotency-Key': context.idempotencyKey } : {},
    // `path` is the router key: the operation whose declared properties apply to this call.
    fetch: (request, _init, _options, path) => send(request, platformOperationMeta(path[0])),
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
