// Console transport (`/api/console/*` and `/config`, served by cmd/server).
// Same-origin JSON; the OIDC edge attaches Authorization, the SPA never sees a
// token. People, groups and memberships belong to the Directory built-in app;
// the console server proxies its API under `/api/console/directory/*`.
//
// The transport returns undecoded bodies (`unknown`): the gateway
// (gateway.ts) decodes every success against its operation contract. Error
// bodies are parsed into the safe `ConsoleApiError` envelope, never cast.
import { error as canonicalError } from './contracts/console/schema/schemas'
import type { HttpMethod } from './boundary'
import { copy } from '../copy'
import { assertSessionActive, checkSessionResponse } from './session-expiry'

/** `error` is a stable snake_case code. */
export type ApiError = { error: string; message: string; details?: unknown }
/**
 * Non-2xx console response. `code` is the contract's stable snake_case error.
 * `transient` = no contract envelope came back: a 5xx from a proxy or gateway
 * in front of the console server (e.g. during a rollout), or no response at
 * all. Retrying shortly is the fix, so the message says exactly that.
 */
export class ConsoleApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  readonly transient: boolean

  constructor(status: number, body: Partial<ApiError> | undefined) {
    const code = typeof body?.error === 'string' ? body.error : undefined
    const transient = code === undefined && (status === 0 || status >= 500)
    super(transient ? copy.errors.transient : body?.message || `console api ${status}`)
    this.name = 'ConsoleApiError'
    this.status = status
    this.code = code ?? (status === 404 ? 'not_found' : 'unknown')
    this.details = body?.details
    this.transient = transient
  }
}

export function isConsoleError(error: unknown, code?: string): error is ConsoleApiError {
  return error instanceof ConsoleApiError && (code === undefined || error.code === code)
}

const consoleErrorBody = canonicalError.extend({
  error: canonicalError.shape.error.optional().catch(undefined),
  message: canonicalError.shape.message.optional().catch(undefined),
})

const READ_TIMEOUT_MS = 8_000

type Fetcher = (input: string, init: RequestInit) => Promise<Response>

/** One call; `path` is same-origin and absolute (`/api/console/...` or `/config`). */
export interface ConsoleRequest {
  method: HttpMethod
  path: string
  /** JSON body; a `FormData` body is sent as multipart (the browser sets the boundary). */
  body?: unknown
  cache?: RequestCache
}

/** A success body: JSON (still unknown), nothing at all, or bytes that are not JSON. */
export type ConsoleBody = { kind: 'json'; value: unknown } | { kind: 'empty' } | { kind: 'invalid' }

export interface ConsoleResponse {
  status: number
  body: ConsoleBody
}

export interface ConsoleTransport {
  /** Resolves with any 2xx; rejects with ConsoleApiError for other answers, or the session-expiry error. */
  send(request: ConsoleRequest): Promise<ConsoleResponse>
}

async function readBody(response: Response): Promise<ConsoleBody> {
  if (response.status === 204) return { kind: 'empty' }
  let text: string
  try {
    text = await response.text()
  } catch {
    return { kind: 'invalid' }
  }
  if (text === '') return { kind: 'empty' }
  try {
    return { kind: 'json', value: JSON.parse(text) as unknown }
  } catch {
    return { kind: 'invalid' }
  }
}

export function createConsoleTransport(fetcher: Fetcher = (input, init) => fetch(input, init)): ConsoleTransport {
  return {
    async send({ method, path, body, cache }) {
      assertSessionActive()
      const read = method === 'GET'
      const form = body instanceof FormData
      const json = body !== undefined && !form
      let response: Response
      try {
        response = await fetcher(path, {
          method,
          headers: json ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
          body: form ? body : json ? JSON.stringify(body) : undefined,
          credentials: 'same-origin',
          redirect: 'manual',
          signal: read ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined,
          ...(cache ? { cache } : {}),
        })
      } catch {
        // Network failure or read timeout: nothing answered (status 0).
        throw new ConsoleApiError(0, undefined)
      }
      checkSessionResponse(response)
      const answer = await readBody(response)
      if (!response.ok) {
        const parsed = answer.kind === 'json' ? consoleErrorBody.safeParse(answer.value) : undefined
        throw new ConsoleApiError(response.status, parsed?.success ? parsed.data : undefined)
      }
      return { status: response.status, body: answer }
    },
  }
}

export const consoleTransport = createConsoleTransport()

export const screenshotUrl = (appId: string, screenshotId: string) =>
  `/api/console/apps/${encodeURIComponent(appId)}/screenshots/${encodeURIComponent(screenshotId)}`

/** Directory public URLs; `base` is `Me.directoryPublicURL` (no trailing slash needed). */
const directoryBase = (base: string) => base.replace(/\/+$/, '')

/** A person's profile picture, served by the Directory; `version` is `Person.avatarVersion`, so a new picture gets a new URL. */
export const avatarUrl = (base: string, personId: string, version: string) =>
  `${directoryBase(base)}/api/directory/v1/people/${encodeURIComponent(personId)}/avatar?v=${encodeURIComponent(version)}`

export const directoryLinks = {
  person: (base: string, personId: string) => `${directoryBase(base)}/people/${encodeURIComponent(personId)}`,
  /** The signed-in person's own page (name, picture). */
  you: (base: string) => `${directoryBase(base)}/people/me`,
  groups: (base: string) => `${directoryBase(base)}/groups`,
  group: (base: string, groupId: string) => `${directoryBase(base)}/groups/${encodeURIComponent(groupId)}`,
}
