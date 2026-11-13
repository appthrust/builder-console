// Test seam: `fetch` over the in-memory Console and Platform mocks, recording
// every request the code under test makes (method, path, precondition headers,
// status) and optionally rewriting one answer on its way back, so tests run the
// real transports, gateway and contracts against faithful server behaviour.
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'

export interface RecordedRequest {
  method: string
  path: string
  status: number
  idempotencyKey: string | null
  ifMatch: string | null
}

/** Replaces one answer: `body` rewrites a successful JSON answer; `response` answers instead of the mock. */
export interface Rewrite {
  method: string
  path: RegExp
  once: boolean
  body?: (wire: Record<string, unknown>) => unknown
  response?: () => Response
}

export interface ConsoleMockFetch {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  requests: RecordedRequest[]
  rewrites: Rewrite[]
  count(method: string, path: RegExp): number
}

export function createConsoleMockFetch(): ConsoleMockFetch {
  const requests: RecordedRequest[] = []
  const rewrites: Rewrite[] = []
  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init)
    const url = new URL(request.url)
    const rewrite = rewrites.find((item) => item.method === request.method && item.path.test(url.pathname + url.search))
    if (rewrite?.once) rewrites.splice(rewrites.indexOf(rewrite), 1)
    const record = (status: number) => requests.push({ method: request.method, path: url.pathname + url.search, status, idempotencyKey: request.headers.get('Idempotency-Key'), ifMatch: request.headers.get('If-Match') })
    if (rewrite?.response) {
      const replaced = rewrite.response()
      record(replaced.status)
      return replaced
    }
    const response = await (url.pathname.startsWith('/api/console/') ? consoleRoutes : platformRoutes)(request, url)
    record(response?.status ?? 404)
    if (!response) return Response.json({ error: 'not_found', message: 'unhandled' }, { status: 404 })
    if (!rewrite?.body || !response.ok) return response
    return Response.json(rewrite.body((await response.json()) as Record<string, unknown>), { status: response.status, headers: response.headers })
  }
  return {
    fetch,
    requests,
    rewrites,
    count: (method, path) => requests.filter((item) => item.method === method && path.test(item.path)).length,
  }
}

/** Reseeds both mocks. */
export async function resetMocks(): Promise<void> {
  const platform = new URL('/api/v1/__mock/reset', 'http://mock.test')
  await platformRoutes(new Request(platform, { method: 'POST' }), platform)
  const console = new URL('/api/console/__mock/reset', 'http://mock.test')
  await consoleRoutes(new Request(console, { method: 'POST' }), console)
}
