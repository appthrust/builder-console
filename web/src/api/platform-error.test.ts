import { describe, expect, test } from 'bun:test'
import { platformApiRouter } from '@appthrust/api-schema/platform-api-router'
import { createORPCClient, ORPCError } from '@orpc/client'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import type { PlatformApiClient } from './client'
import { ConsoleApiError } from './console'
import { isTransientError, platformErrorEnvelope } from './platform-error'
import { classifyBuildFailure } from '../model/build/failure'

/** A client on the real contract and link whose fetch always answers `response`. */
function clientAnswering(response: () => Response): PlatformApiClient {
  const link = new OpenAPILink(platformApiRouter, { url: 'http://platform.test', fetch: async () => response() })
  return createORPCClient(link)
}

const stackRequest = {
  projectId: 'pj',
  templateId: 'nextjs-postgres',
  application: { name: 'test' },
  source: { kind: 'sample-image', imageRef: 'ghcr.io/a/b:1' },
} as never

describe('platformErrorEnvelope', () => {
  test('reads the 409 envelope a real OpenAPILink puts under data.body', async () => {
    const message = 'Platform delivery is converging; retry the same request in a few seconds.'
    const client = clientAnswering(() =>
      Response.json({ error: { code: 'conflict', message, details: { reason: 'delivery_pending', retryAfterSeconds: 5 } } }, { status: 409 })
    )
    const error = await client.platformApiCreateApplicationStack(stackRequest).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ORPCError)
    // The shape the console must read (not `data.error`).
    expect((error as ORPCError<string, { body: unknown; status: number }>).data).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict', message } },
    })
    expect(platformErrorEnvelope(error)).toEqual({
      status: 409,
      code: 'conflict',
      message,
      details: { reason: 'delivery_pending', retryAfterSeconds: 5 },
    })
  })

  test('a real policy 412 preserves details through the client and failure classifier', async () => {
    const details = { reason: 'ai_approval_policy_denied', policy: 'default' }
    const client = clientAnswering(() => Response.json({ error: { code: 'failed_precondition', message: 'runtime unavailable', details } }, { status: 412 }))
    const error = await client.platformApiCreateApplicationStack(stackRequest).catch((caught: unknown) => caught)
    const envelope = platformErrorEnvelope(error)
    expect(envelope).toMatchObject({ status: 412, code: 'failed_precondition', details })
    expect(classifyBuildFailure(envelope!.message!, envelope?.status, 'turn', undefined, envelope?.code, undefined, undefined, envelope?.details).kind).toBe('policy')
  })

  test('a non-JSON error body has no envelope', async () => {
    const client = clientAnswering(() => new Response('upstream connect error', { status: 503, headers: { 'Content-Type': 'text/plain' } }))
    const error = await client.platformApiCreateApplicationStack(stackRequest).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ORPCError)
    expect(platformErrorEnvelope(error)).toBeUndefined()
  })

  test('accepts a bare data.error or data.message', () => {
    expect(platformErrorEnvelope(new ORPCError('CONFLICT', { status: 409, data: { error: { code: 'conflict', message: 'm' } } }))).toEqual({
      status: 409,
      code: 'conflict',
      message: 'm',
      details: undefined,
    })
    expect(platformErrorEnvelope(new ORPCError('BAD_REQUEST', { status: 400, data: { message: 'bad' } }))).toEqual({ status: 400, message: 'bad' })
    expect(platformErrorEnvelope(new Error('plain'))).toBeUndefined()
  })
})

describe('isTransientError', () => {
  const platformError = (response: () => Response) =>
    clientAnswering(response).platformApiCreateApplicationStack(stackRequest).catch((caught: unknown) => caught)
  const text = (body: string, status: number) => () => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })
  const coded = (code: string, status: number) => () => Response.json({ error: { code, message: code } }, { status })

  test.each([
    ['Envoy 503 text body (no Pod ready)', true, text('upstream connect error or disconnect/reset before headers', 503)],
    ['bare 502', true, text('', 502)],
    ['bare 504', true, text('gateway timeout', 504)],
    ['500 with Envoy text body', true, text('upstream connect error or disconnect/reset before headers', 500)],
    ['500 without a body', false, text('', 500)],
    ['coded 503', false, coded('unavailable', 503)],
    ['coded 409', false, coded('conflict', 409)],
    ['coded 400', false, coded('invalid_argument', 400)],
    ['uncoded 404', false, text('not found', 404)],
  ] as const)('platform answer through a real link: %s → transient %p', async (_name, transient, response) => {
    expect(isTransientError(await platformError(response))).toBe(transient)
  })

  test('a fetch network failure through a real link is transient', async () => {
    const link = new OpenAPILink(platformApiRouter, {
      url: 'http://platform.test',
      fetch: async () => { throw new TypeError('Failed to fetch') },
    })
    const error = await createORPCClient<PlatformApiClient>(link).platformApiCreateApplicationStack(stackRequest).catch((caught: unknown) => caught)
    expect(isTransientError(error)).toBe(true)
  })

  test.each([
    ['console status 0 (no answer)', true, new ConsoleApiError(0, undefined)],
    ['console gateway 503', true, new ConsoleApiError(503, undefined)],
    ['console coded 502', false, new ConsoleApiError(502, { error: 'upstream_unavailable', message: 'down' })],
    ['console 404', false, new ConsoleApiError(404, undefined)],
    ['console coded 400', false, new ConsoleApiError(400, { error: 'invalid_slug', message: 'bad' })],
    ['hand-built ORPC 503', true, new ORPCError('SERVICE_UNAVAILABLE', { status: 503 })],
    ['hand-built ORPC 403', false, new ORPCError('FORBIDDEN', { status: 403 })],
    ['Chrome fetch failure', true, new TypeError('Failed to fetch')],
    ['Firefox fetch failure', true, new TypeError('NetworkError when attempting to fetch resource.')],
    ['Safari fetch failure', true, new TypeError('Load failed')],
    ['a TypeError from code', false, new TypeError("Cannot read properties of undefined (reading 'data')")],
    ['read timeout', true, new DOMException('The operation timed out.', 'TimeoutError')],
    ['abort', false, new DOMException('The operation was aborted.', 'AbortError')],
    ['plain error', false, new Error('Console config contains an invalid projectId')],
    ['undefined', false, undefined],
  ] as const)('%s → transient %p', (_name, transient, error) => {
    expect(isTransientError(error)).toBe(transient)
  })
})
