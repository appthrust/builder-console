// The Platform API's error envelope (`{ error: { code, message, details } }`)
// of a failed oRPC call. `OpenAPILink` does not unwrap it: the HTTP body sits
// under `ORPCError.data.body`, next to `status` and `headers`
// (platform-error.test.ts pins this through a real link). A bare `data.error`
// or `data.message` is accepted too, for errors built by hand.
import { ORPCError } from '@orpc/client'
import { ConsoleApiError } from './console'

export interface PlatformErrorEnvelope {
  status?: number
  code?: string
  message?: string
  details?: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** The envelope of a failed Platform API call; undefined when the error carries none. */
export function platformErrorEnvelope(error: unknown): PlatformErrorEnvelope | undefined {
  const data = record(record(error)?.data)
  if (!data) return undefined
  const body = record(data.body) ?? data
  const status = error instanceof ORPCError ? error.status : typeof data.status === 'number' ? data.status : undefined
  const envelope = record(body.error)
  if (envelope) {
    return { status, code: text(envelope.code), message: text(envelope.message), details: record(envelope.details) }
  }
  const message = text(body.message)
  return message ? { status, message } : undefined
}

/** The Platform API rejected the edge-issued credentials even after a fresh sign-in. */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof ORPCError && error.status === 401
}

/** The Platform API answered 404: the resource is gone or is not visible to this account. Retrying cannot help. */
export function isPlatformNotFound(error: unknown): boolean {
  return platformErrorEnvelope(error)?.status === 404 || (error instanceof ORPCError && error.status === 404)
}

/**
 * How Platform refused a new repository at its repository destination
 * (platform-api internal/repositorydestination/request.go:20-32, reason in
 * `details.reason`): `changed` = 409 DestinationChanged, the revision the user
 * saw is no longer current; `mismatch` = 409 DestinationMismatch, the request
 * asserted another connection/owner/image; `blocked` = 412 (403 for
 * NotVisible) with a documented blocker. Anything else is not a destination
 * answer. The reason itself is never shown.
 */
export type DestinationRejection = 'changed' | 'mismatch' | 'blocked'

/** Documented blockers and the status each mutation answers with. */
const DESTINATION_BLOCKERS: Record<string, number> = {
  NotConfigured: 412, Ambiguous: 412, NotFound: 412, Deleting: 412, NotReady: 412, MissingCapability: 412, NotVisible: 403,
  UnsupportedProvider: 412, ImageAccessNotConfigured: 412, ImageAccessAmbiguous: 412, ImageAccessNotReady: 412,
}

export function destinationRejection(error: unknown): DestinationRejection | undefined {
  const envelope = platformErrorEnvelope(error)
  const reason = envelope?.details?.reason
  if (typeof reason !== 'string' || envelope?.status === undefined) return undefined
  if (envelope.status === 409) return reason === 'DestinationChanged' ? 'changed' : reason === 'DestinationMismatch' ? 'mismatch' : undefined
  return Object.hasOwn(DESTINATION_BLOCKERS, reason) && DESTINATION_BLOCKERS[reason] === envelope.status ? 'blocked' : undefined
}

/** Gateway answers while no Platform API Pod is ready (Envoy during a rollout) or no answer at all. */
const TRANSIENT_STATUSES = new Set([0, 502, 503, 504])
/** Envoy's no-upstream body and the browsers' fetch network-failure messages (Chrome, Firefox, Safari). */
const NO_ANSWER = /upstream connect error|Failed to fetch|NetworkError|Load failed/

/**
 * The call failed because nothing behind the edge answered — a rollout gap or a
 * network blip — so the same request succeeds shortly. True for a console
 * `transient` error (status 0 or 5xx without a contract code), a Platform API
 * 0/502/503/504 or Envoy's `upstream connect error` text, a fetch network
 * failure and a read timeout. A 4xx or any coded API error is an answer, never
 * transient.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof ConsoleApiError) return error.transient
  // The read timeout (`AbortSignal.timeout` in the client): nothing answered, like the console's status 0.
  if (error instanceof DOMException) return error.name === 'TimeoutError'
  const envelope = platformErrorEnvelope(error)
  if (envelope?.code) return false
  const status = error instanceof ORPCError ? error.status : envelope?.status
  if (status !== undefined && status >= 400 && status < 500) return false
  if (status !== undefined && TRANSIENT_STATUSES.has(status)) return true
  const body = record(record(error)?.data)?.body
  const texts = [error instanceof Error ? error.message : undefined, typeof body === 'string' ? body : undefined, envelope?.message]
  return texts.some((value) => value !== undefined && NO_ANSWER.test(value))
}
