import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { PreviewSession } from '../model/contracts/build'
import { exchangePreviewSession } from './workspace'

const ORIGIN = 'https://pv-0123456789abcdef0123456789abcdef.project-1.appthrust.test'
const PUBLISH_UID = '7d0f3c52-9a41-4f7e-8b52-3c1f0e6a9b10'
const GRANT = 'SENTINEL-grant-eyJhbGciOiJFUzI1NiJ9.e30.c2ln'
const session: PreviewSession = { origin: ORIGIN, publishUID: PUBLISH_UID, exchangeUrl: `${ORIGIN}/__appthrust/session/${PUBLISH_UID}`, grant: GRANT, expiresAt: '2026-11-14T00:00:55Z', renewAfterSeconds: 30 }
const readyBody = { state: 'Ready', publishUID: PUBLISH_UID, expiresAt: '2026-11-14T00:00:55Z' }

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

/** Answers the exchange and then the check in order; records every call. */
function answering(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const answer = answers.shift()
    if (!answer) throw new Error('unexpected request')
    if (answer instanceof Error) throw answer
    return answer
  }) as unknown as typeof fetch
  return calls
}

describe('exchangePreviewSession', () => {
  test('the grant is POSTed once in the body to the reserved path, then the Cookie is checked; the grant is in no URL or header', async () => {
    const calls = answering(new Response(null, { status: 204 }), Response.json(readyBody))
    expect(await exchangePreviewSession(session)).toEqual({ kind: 'ready' })
    expect(calls.map(({ url, init }) => [init.method, url])).toEqual([['POST', session.exchangeUrl], ['GET', `${session.exchangeUrl}/ready`]])
    for (const { url, init } of calls) {
      expect(url).not.toContain(GRANT)
      expect(JSON.stringify(init.headers ?? {})).not.toContain(GRANT)
      expect(init).toMatchObject({ credentials: 'include', cache: 'no-store', mode: 'cors', redirect: 'error', referrerPolicy: 'no-referrer' })
    }
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ grant: GRANT })
    expect(calls[1]!.init.body).toBeUndefined()
  })

  test('a check that does not see the Cookie the exchange set means the browser refused it', async () => {
    answering(new Response(null, { status: 204 }), Response.json({ error: { code: 'unauthenticated', details: { reason: 'workspace_session_invalid' } } }, { status: 401 }))
    expect(await exchangePreviewSession(session)).toEqual({ kind: 'cookie-refused' })
  })

  test.each([401, 403, 503])('a refused exchange (%i) never reaches the check', async (status) => {
    const calls = answering(new Response(null, { status }))
    expect(await exchangePreviewSession(session)).toEqual({ kind: 'refused', status })
    expect(calls).toHaveLength(1)
  })

  test('no answer is unreachable, at the exchange or at the check', async () => {
    answering(new TypeError('Failed to fetch'))
    expect(await exchangePreviewSession(session)).toEqual({ kind: 'unreachable' })
    answering(new Response(null, { status: 204 }), new TypeError('Failed to fetch'))
    expect(await exchangePreviewSession(session)).toEqual({ kind: 'unreachable' })
  })

  test.each([
    ['a body that is not JSON', () => new Response('<html>ok</html>', { status: 200 })],
    ['another state', () => Response.json({ ...readyBody, state: 'Pending' })],
    ['another publication', () => Response.json({ ...readyBody, publishUID: '00000000-0000-4000-8000-000000000001' })],
  ])('a check answered 200 with %s is unreadable, never ready', async (_name, answer) => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      answering(new Response(null, { status: 204 }), answer())
      expect(await exchangePreviewSession(session)).toEqual({ kind: 'unreadable' })
      expect(JSON.stringify(warn.mock.calls)).not.toContain(GRANT)
    } finally {
      warn.mockRestore()
    }
  })
})
