// Test seam: `fetch` over the in-memory Console and Platform mocks, recording
// every request the code under test makes (method, path, precondition headers,
// status) and optionally rewriting one answer on its way back, so tests run the
// real transports, gateway and contracts against faithful server behaviour.
import type { BuildSessionsApi } from '../build-sessions'
import type { BuildSession } from '../../model/contracts/console'
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

/**
 * Takes an idle console-v1 session (draft made, nothing running) to `created` the way the server sees it: a plan
 * turn from the current revision observed to its end, then a creation execution on its Platform draft run to its
 * end (as another client would). With `staleAfterPlan` a spec change is accepted after the plan first, so the app
 * is made from an earlier revision than the last confirmed one.
 */
export async function createSessionApp(api: BuildSessionsApi, mock: ConsoleMockFetch, sessionId: string, options: { staleAfterPlan?: boolean } = {}): Promise<BuildSession> {
  const post = (path: string, body: unknown) => mock.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  // Each read of the active turn is one server observation; stop once it no longer asks to be observed.
  const observe = async () => {
    for (let step = 0; step < 10; step++) {
      const session = await api.get(sessionId)
      if (!session.activeTurnId) return
      const { nextAction } = await api.getTurn(sessionId, session.activeTurnId)
      if (nextAction.kind === 'known' && nextAction.value !== 'observe') return
    }
  }
  await post('/api/v1/__mock/plan-generation', { autoAdvance: true })
  let session = await api.get(sessionId)
  await api.createTurn(sessionId, { kind: 'request_plan', specRevision: session.specification.revision }, { key: crypto.randomUUID(), version: session.version })
  await observe()
  if (options.staleAfterPlan) {
    session = await api.get(sessionId)
    await api.createTurn(sessionId, { kind: 'conversation', message: '貸し出しは 2 週間までにして', intent: 'change', baseSpecRevision: session.specification.revision }, { key: crypto.randomUUID(), version: session.version })
    await observe()
    session = await api.get(sessionId)
    await api.resolveTurn(sessionId, session.activeTurnId!, { decision: 'accept_spec' }, { key: crypto.randomUUID(), version: session.version })
  }
  const draftId = (await api.get(sessionId)).draftId!
  const draft = `/api/v1/projects/commerce/application-drafts/${draftId}`
  if (!(await post(`${draft}/creation-plan-validations`, {})).ok) throw new Error('the creation plan did not validate')
  const begun = await post(`${draft}/creation-executions`, { clientRequestId: crypto.randomUUID(), creationPlanFingerprint: `fp-${draftId}` })
  if (!begun.ok) throw new Error(`creation execution answered ${begun.status}`)
  const execution = ((await begun.json()) as { resource: { creationExecutions: { id: string }[] } }).resource.creationExecutions.at(-1)!
  if (!(await post(`${draft}/creation-executions/${execution.id}/run`, {})).ok) throw new Error('the creation execution did not run')
  // With autoAdvance every draft read moves the execution one step, as the Platform controller would.
  for (let step = 0; step < 20; step++) {
    const read = (await (await mock.fetch(draft)).json()) as { phase: string; creationExecutions: { status: string }[] }
    if (read.creationExecutions.at(-1)?.status !== 'running') {
      if (read.creationExecutions.at(-1)?.status !== 'succeeded') throw new Error(`the creation execution ended ${read.creationExecutions.at(-1)?.status}`)
      break
    }
  }
  session = await api.get(sessionId)
  if (session.lifecycle.kind !== 'known' || session.lifecycle.value !== 'created') throw new Error('the session did not become created')
  return session
}
