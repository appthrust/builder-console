// Dev-only in-memory `/api/console/v1/build-sessions*` (APT-753 S4-0 contract;
// served through mock-console). Mirrors the contract's wire rules so the SPA
// can be exercised before the server handlers exist:
// - every answer carries `Cache-Control: no-store`; Session/Turn/PublishResult
//   answers carry the session `ETag` ("bs-<version>"), a created Turn its `Location`;
// - writes need `Idempotency-Key` (428 without), all but create also `If-Match`
//   (428 without, 412 `version_conflict` with `details.currentVersion` when stale);
//   a replay (same key, same request) answers the original success before any
//   version check, the same key with another request is 409 `idempotency_conflict`;
// - one active turn per session (409 `session_busy`); sessions are the caller's
//   only (another person's id is 404).
// Progress: `advance` on an initializing session creates its Platform draft
// (through the Platform mock) and reserves the opening turn; every GET of an
// active turn moves it one step (accepted → running → validating → reply).
// A conversation whose intent is `change` (or an `auto` message asking for a change: 「…にして」「…を追加」)
// ends in `awaiting_confirmation` with a proposed spec that adds the message as a rule; `resolution`
// accepts (new revision) or keeps it. `suggestions` (or an `auto` message asking for 候補/提案/おすすめ)
// answers with two concrete candidates; 「ほかの名前」 or `undecided` keeps an open decision. These are
// the mock's stand-in for the model; a real reply comes from the server's validated AgentTurn output.
// A plan turn writes the confirmed spec to the Platform draft (syncing_spec), starts a Platform plan
// generation (starting_plan) and follows it (planning; it settles with the Platform mock's `plan-generation`
// toggles); success records `session.plan` (current), an accepted spec change after it marks the plan stale,
// and a Platform creation execution on the draft moves the session to `created` (no more turns). Publish
// preferences are written to the draft too. The resolver answers console-v1 for a draft a session owns, else
// platform-v1 (the Platform draft read that follows decides whether the draft exists).
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import {
  buildCreateSession, buildETag, buildIdempotencyKey, buildPublishInput, buildResolution, buildTurnRequest,
  type buildConversationTurn, type buildPlanTurn, type buildPublishResult, type buildSession, type buildSpecRevision,
} from '../api/contracts/console/schema/build-sessions'
// A cycle (mock-console → here → mock-platform → mock-console); neither side reads the other at load time.
import { MOCK_PROJECT_ID, platformRoutes } from './mock-platform'
import { parseSpec, serializeSpec } from '../model/build/spec'

type SessionWire = z.input<typeof buildSession>
type ConversationTurnWire = z.input<typeof buildConversationTurn>
type PlanTurnWire = z.input<typeof buildPlanTurn>
type TurnWire = ConversationTurnWire | PlanTurnWire
type SpecRevisionWire = z.input<typeof buildSpecRevision>
type PublishWire = z.input<typeof buildPublishResult>

interface Stored {
  owner: string
  intent: string
  session: SessionWire
  turns: TurnWire[]
  revisions: SpecRevisionWire[]
}
interface Replay { request: string; status: number; body: unknown; headers: Record<string, string> }

const PROMPT_VERSION = 'new-app-conversation/1.0.0'
const POLL_AFTER_MS = 1_000
const BASE = '/api/console/v1/build-sessions'

let sessions = new Map<string, Stored>()
let replays = new Map<string, Replay>()

export function resetBuildSessions() {
  sessions = new Map()
  replays = new Map()
}

const stamp = () => new Date().toISOString()
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const etag = (version: number) => `"bs-${version}"`
const NO_STORE = { 'Cache-Control': 'no-store' }

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } })
}
function fail(status: number, error: string, message: string, details?: Record<string, unknown>): Response {
  return answer(status, { error, message, ...(details ? { details } : {}) })
}
const notFound = () => fail(404, 'not_found', 'build session not found', { resource: 'session' })
const pointer = (path: readonly PropertyKey[]) => `/${path.map(String).join('/')}`

function invalid(issues: readonly { path: readonly PropertyKey[] }[]): Response {
  return fail(400, 'invalid_argument', 'request does not match the contract', { field: pointer(issues[0]?.path ?? []) })
}

function specMarkdown(intent: string): string {
  const name = intent.split(/[\n。！？]/, 1)[0]!.slice(0, 40) || 'アプリ'
  return `---\nspec:\n  name: ${JSON.stringify(name)}\n  oneLine: ${JSON.stringify(intent.split('\n', 1)[0]!.slice(0, 120))}\n  users: 社員\n  screens: []\n  records: []\n  rules: []\n  approval: none\n  importFrom: none\n---\n${intent}\n`
}

function bump(stored: Stored, changes: Partial<SessionWire>) {
  stored.session = { ...stored.session, ...changes, version: stored.session.version + 1, updatedAt: stamp() }
}

function sessionAnswer(stored: Stored, status = 200): Response {
  return answer(status, stored.session, { ETag: etag(stored.session.version) })
}

function idle(stored: Stored, changes: Partial<SessionWire> = {}) {
  const { activeTurnId: _active, ...rest } = stored.session
  stored.session = { ...rest, ...changes, version: stored.session.version + 1, updatedAt: stamp(), capabilities: { canConverse: true, canRequestPlan: true }, nextAction: 'none' }
}

type ReplyKind = 'change' | 'suggestions' | 'undecided' | 'answer'

/** What the stand-in model does with a request: the typed intent first, then the words of an `auto` message. */
function replyKind(request: ConversationTurnWire['request']): ReplyKind {
  if (request.intent === 'change' || request.intent === 'suggestions' || request.intent === 'undecided') return request.intent
  if (request.intent !== 'auto') return 'answer'
  if (/ほかの名前|別の名前/.test(request.message)) return 'undecided'
  if (/候補|提案|おすすめ/.test(request.message)) return 'suggestions'
  if (/にして|を追加|に変えて|にしたい/.test(request.message)) return 'change'
  return 'answer'
}

function reply(turn: ConversationTurnWire, kind: ReplyKind) {
  const changed = kind === 'change'
  const suggestions = kind === 'suggestions'
  const asks = kind === 'answer'
  return {
    schemaVersion: 1 as const, turnId: turn.id, attempt: turn.attempt, baseSpecRevision: turn.baseSpecRevision,
    answer: changed ? '仕様の変更案をまとめました。反映するか選んでください。' : suggestions ? '候補を二つ挙げます。' : kind === 'undecided' ? 'いまの名前は変えずに、別の名前を一緒に考えましょう。' : 'ご質問の点を確認しました。',
    summary: changed ? '依頼の内容を仕様に加えます' : '',
    changes: changed ? [turn.request.message.slice(0, 200)] : [],
    candidates: suggestions ? [{ id: 'first', label: '申請ノート', description: '申請を記録して承認まで追えます' }, { id: 'second', label: '申請ボード', description: '申請の状況を一覧で見られます' }] : [],
    openDecisions: kind === 'undecided' ? [{ topic: 'アプリ名', wish: turn.request.message.slice(0, 200) }] : [],
    nextQuestion: asks ? 'ほかに決めたいことはありますか？' : null,
    suggestedReplies: asks ? [{ id: 'nothing-more', label: '特にない', message: '特にありません' }, { id: 'approval', label: '承認の流れ', message: '承認の流れを決めたい' }] : [],
    specChanged: changed,
  }
}

/** The proposed specification of a change: the confirmed one with the request added as a rule. */
function proposedMarkdown(current: string, message: string): string {
  const { spec, body } = parseSpec(current)
  return serializeSpec({ ...spec, rules: [...spec.rules, message.slice(0, 200)] }, body)
}

/** A Platform draft call made by the mock server (the Platform mock's own routes, as the real server's adapter would). */
async function platform(method: string, path: string, body?: unknown): Promise<Response | undefined> {
  const url = new URL(`/api/v1/projects/${MOCK_PROJECT_ID}/application-drafts/${path}`, 'http://mock.local')
  return platformRoutes(new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), url)
}

/**
 * One observation of the active turn: it moves one step, as the server would after observing Platform. A plan
 * turn writes the confirmed specification to the draft (syncing_spec), starts a Platform plan generation
 * (starting_plan) and follows it (planning); success records `session.plan` on the revision it was made from.
 */
async function observe(stored: Stored, turn: TurnWire): Promise<TurnWire> {
  const now = stamp()
  const progress = (stage: NonNullable<TurnWire['progress']>['stage']) => ({ stage, observedAt: now, activity: [] })
  let next: TurnWire = turn
  if (turn.kind === 'conversation') {
    if (turn.state === 'accepted' || turn.state === 'dispatching') next = { ...turn, state: 'running', progress: progress('thinking'), nextAction: 'observe', updatedAt: now }
    else if (turn.state === 'running') next = { ...turn, state: 'validating', progress: progress('validating'), nextAction: 'observe', updatedAt: now }
    else if (turn.state === 'validating') {
      const kind = replyKind(turn.request)
      if (kind === 'change') {
        const markdown = proposedMarkdown(stored.session.specification.markdown, turn.request.message)
        bump(stored, { nextAction: 'confirm' })
        next = { ...turn, state: 'awaiting_confirmation', progress: progress('awaiting_confirmation'), nextAction: 'confirm', reply: reply(turn, kind), proposedSpec: { sha256: sha256(markdown), markdown }, sessionVersion: stored.session.version, updatedAt: now }
      } else {
        idle(stored)
        next = { ...turn, state: 'succeeded', nextAction: 'none', reply: reply(turn, kind), sessionVersion: stored.session.version, updatedAt: now }
      }
    }
  } else {
    const draftId = stored.session.draftId!
    const failed = (error: 'draft_spec_conflict' | 'service_unavailable' | 'agent_failed', message: string) => {
      idle(stored, { lifecycle: stored.session.plan ? 'planned' : 'specifying' })
      return { ...turn, state: 'failed' as const, nextAction: 'none' as const, failure: { error, message }, sessionVersion: stored.session.version, updatedAt: now }
    }
    if (turn.state === 'accepted') {
      const synced = await platform('PATCH', draftId, { specMarkdown: stored.session.specification.markdown })
      next = synced?.ok
        ? { ...turn, state: 'syncing_spec', progress: progress('syncing_spec'), projection: { state: 'syncing' }, updatedAt: now }
        : { ...failed('draft_spec_conflict', 'the draft specification could not be written'), projection: { state: 'conflict' } }
    } else if (turn.state === 'syncing_spec') next = { ...turn, state: 'starting_plan', progress: progress('starting_plan'), projection: { state: 'applied', appliedRevision: turn.specRevision }, updatedAt: now }
    else if (turn.state === 'starting_plan') {
      const started = await platform('POST', `${draftId}/creation-plan-generations`, {})
      const generation = started?.ok ? ((await started.json()) as { resource: { id: string } }).resource.id : undefined
      next = generation ? { ...turn, state: 'planning', platformGenerationId: generation, updatedAt: now } : failed('service_unavailable', 'the plan generation could not be started')
    } else if (turn.state === 'planning') {
      const read = await platform('GET', `${draftId}/creation-plan-generations/${turn.platformGenerationId}`)
      const status = read?.ok ? ((await read.json()) as { status: string }).status : undefined
      if (status === 'succeeded') {
        idle(stored, { lifecycle: 'planned', projection: { state: 'applied', appliedRevision: turn.specRevision }, plan: { specRevision: turn.specRevision, stale: false } })
        next = { ...turn, state: 'succeeded', nextAction: 'none', sessionVersion: stored.session.version, updatedAt: now }
      } else if (status === 'failed') next = failed('agent_failed', 'the plan generation failed')
    }
  }
  stored.turns = stored.turns.map((item) => item.id === turn.id ? next : item)
  return next
}

/**
 * The write preconditions in contract order: headers present (428), well-formed (400), replay lookup
 * (original success, or 409 for another request with the same key), then the handler's version check.
 */
async function write(request: Request, owner: string, path: string, conditional: boolean, handler: (body: unknown, version: number) => Response | Promise<Response>): Promise<Response> {
  const key = request.headers.get('Idempotency-Key')
  const match = request.headers.get('If-Match')
  if (key === null || (conditional && match === null)) return fail(428, 'precondition_required', conditional ? 'Idempotency-Key and If-Match are required' : 'Idempotency-Key is required')
  if (!buildIdempotencyKey.safeParse(key).success) return fail(400, 'invalid_argument', 'malformed Idempotency-Key', { field: '/Idempotency-Key' })
  if (conditional && !buildETag.safeParse(match).success) return fail(400, 'invalid_argument', 'malformed If-Match', { field: '/If-Match' })
  let body: unknown
  try { body = JSON.parse(await request.text()) } catch { return fail(400, 'invalid_argument', 'request body is not JSON') }
  const canonical = `${request.method} ${path} ${JSON.stringify(body)}`
  const scope = `${owner}|${request.method} ${path}|${key}`
  const replay = replays.get(scope)
  if (replay) return replay.request === canonical ? answer(replay.status, replay.body, replay.headers) : fail(409, 'idempotency_conflict', 'this key was used for another request')
  const response = await handler(body, conditional ? Number(/^"bs-(\d+)"$/.exec(match!)![1]) : 0)
  if (response.ok) {
    const headers: Record<string, string> = {}
    for (const name of ['ETag', 'Location']) { const value = response.headers.get(name); if (value) headers[name] = value }
    replays.set(scope, { request: canonical, status: response.status, body: await response.clone().json(), headers })
  }
  return response
}

const stale = (stored: Stored, version: number) => version !== stored.session.version
  ? fail(412, 'version_conflict', '別の操作で更新されました。', { currentVersion: stored.session.version })
  : undefined

async function advance(stored: Stored): Promise<Response> {
  const active = stored.turns.find((turn) => turn.id === stored.session.activeTurnId)
  if (stored.session.lifecycle === 'initializing') {
    const url = new URL(`/api/v1/projects/${MOCK_PROJECT_ID}/application-drafts`, 'http://mock.local')
    const created = await platformRoutes(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: stored.intent }) }), url)
    if (!created?.ok) return fail(503, 'service_unavailable', 'the Platform draft could not be created', { retryable: true })
    const draftId = ((await created.json()) as { resource: { id: string } }).resource.id
    const now = stamp()
    const turn: ConversationTurnWire = {
      id: crypto.randomUUID(), ordinal: 1, kind: 'conversation', state: 'accepted', baseSpecRevision: 0, sessionVersion: stored.session.version + 1,
      createdAt: now, updatedAt: now, progress: { stage: 'accepted', observedAt: now, activity: [] }, nextAction: 'observe', pollAfterMs: POLL_AFTER_MS,
      request: { kind: 'conversation', message: stored.intent.slice(0, 4000), intent: 'auto', baseSpecRevision: 0 }, attempt: 0, promptVersion: PROMPT_VERSION,
    }
    stored.turns.push(turn)
    bump(stored, { lifecycle: 'specifying', draftId, activeTurnId: turn.id, nextAction: 'observe', capabilities: { canConverse: false, canRequestPlan: false } })
    return sessionAnswer(stored, 202)
  }
  if (active?.kind === 'conversation' && active.state === 'repair_required' && active.attempt === 0) {
    bump(stored, { nextAction: 'observe' })
    stored.turns = stored.turns.map((turn) => turn.id === active.id ? { ...active, state: 'dispatching', attempt: 1, nextAction: 'observe', sessionVersion: stored.session.version, updatedAt: stamp() } : turn)
    return sessionAnswer(stored, 202)
  }
  return fail(409, 'conflict', 'there is no step to advance')
}

function createTurn(stored: Stored, body: unknown): Response {
  const parsed = buildTurnRequest.safeParse(body)
  if (!parsed.success) return invalid(parsed.error.issues)
  const { session } = stored
  if (session.activeTurnId) return fail(409, 'session_busy', 'a turn is still running')
  if (session.lifecycle !== 'specifying' && session.lifecycle !== 'planned') return fail(409, 'conflict', 'this session does not accept turns now')
  const request = parsed.data
  const revision = request.kind === 'conversation' ? request.baseSpecRevision : request.specRevision
  if (revision !== session.specification.revision) return fail(409, 'conflict', 'the specification revision is not current', { field: request.kind === 'conversation' ? '/baseSpecRevision' : '/specRevision' })
  if (request.kind === 'conversation' ? !session.capabilities.canConverse : !session.capabilities.canRequestPlan) return fail(409, 'conflict', 'this action is not available now')
  const now = stamp()
  const common = {
    id: crypto.randomUUID(), ordinal: stored.turns.length + 1, baseSpecRevision: session.specification.revision, sessionVersion: session.version + 1,
    createdAt: now, updatedAt: now, nextAction: 'observe' as const, pollAfterMs: POLL_AFTER_MS, progress: { stage: 'accepted' as const, observedAt: now, activity: [] },
  }
  const turn: TurnWire = request.kind === 'conversation'
    ? { ...common, kind: 'conversation', state: 'accepted', request, attempt: 0, promptVersion: PROMPT_VERSION }
    : { ...common, kind: 'request_plan', state: 'accepted', specRevision: request.specRevision, projection: { state: 'pending' } }
  stored.turns.push(turn)
  bump(stored, { activeTurnId: turn.id, nextAction: 'observe', capabilities: { canConverse: false, canRequestPlan: false }, ...(request.kind === 'request_plan' ? { lifecycle: 'planning' as const } : {}) })
  return answer(202, turn, { ETag: etag(stored.session.version), Location: `${BASE}/${session.id}/turns/${turn.id}` })
}

function resolveTurn(stored: Stored, turnId: string, body: unknown): Response {
  const parsed = buildResolution.safeParse(body)
  if (!parsed.success) return invalid(parsed.error.issues)
  const turn = stored.turns.find((item) => item.id === turnId)
  if (!turn || turn.kind !== 'conversation') return fail(404, 'not_found', 'turn not found')
  if (turn.resolution) return turn.resolution.decision === parsed.data.decision ? answer(200, turn, { ETag: etag(stored.session.version) }) : fail(409, 'conflict', 'this turn was already decided')
  if (turn.state !== 'awaiting_confirmation' || !turn.proposedSpec) return fail(409, 'conflict', 'this turn has nothing to confirm')
  const accept = parsed.data.decision === 'accept_spec'
  const revision = stored.session.specification.revision + 1
  if (accept) stored.revisions.push({ revision, sha256: turn.proposedSpec.sha256, markdown: turn.proposedSpec.markdown, sourceTurnId: turn.id, createdAt: stamp() })
  // A plan made from an earlier revision no longer matches the accepted specification.
  const plan = accept && stored.session.plan ? { plan: { ...stored.session.plan, stale: stored.session.plan.specRevision !== revision } } : {}
  idle(stored, accept ? { specification: { revision, sha256: turn.proposedSpec.sha256, markdown: turn.proposedSpec.markdown }, ...plan } : {})
  const next: ConversationTurnWire = { ...turn, state: 'succeeded', nextAction: 'none', resolution: parsed.data, sessionVersion: stored.session.version, updatedAt: stamp() }
  stored.turns = stored.turns.map((item) => item.id === turn.id ? next : item)
  return answer(200, next, { ETag: etag(stored.session.version) })
}

/** `/api/console/v1/build-sessions…` for the signed-in `owner` (a Project member or not); undefined for any other path. */
export async function buildSessionRoutes(request: Request, url: URL, caller: { owner: string; member: boolean }): Promise<Response | undefined> {
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return undefined
  const { owner } = caller
  if (!caller.member) return fail(403, 'forbidden', 'not a member of this Project')
  const [id, sub, subId, action] = url.pathname.slice(BASE.length).split('/').filter(Boolean).map(decodeURIComponent)
  const method = request.method
  const page = <T>(items: T[]): Response => {
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20
    const offset = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : 0
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail(400, 'invalid_argument', 'limit must be 1–50', { field: '/limit' })
    if (!Number.isInteger(offset) || offset < 0) return fail(400, 'invalid_argument', 'unknown cursor', { field: '/cursor' })
    const next = offset + limit < items.length ? String(offset + limit) : undefined
    return answer(200, { items: items.slice(offset, offset + limit), ...(next ? { nextCursor: next } : {}) })
  }

  if (!id) {
    if (method === 'GET') return page([...sessions.values()].filter((stored) => stored.owner === owner).map((stored) => stored.session))
    if (method !== 'POST') return undefined
    return write(request, owner, url.pathname, false, (body) => {
      const parsed = buildCreateSession.safeParse(body)
      if (!parsed.success) return invalid(parsed.error.issues)
      const now = stamp()
      const markdown = specMarkdown(parsed.data.intent)
      const stored: Stored = {
        owner, intent: parsed.data.intent, turns: [],
        revisions: [{ revision: 0, sha256: sha256(markdown), markdown, sourceTurnId: null, createdAt: now }],
        session: {
          id: crypto.randomUUID(), kind: 'new-app', engine: 'console-v1', version: 1, lifecycle: 'initializing', groupId: parsed.data.groupId, locale: parsed.data.locale,
          createdAt: now, updatedAt: now, specification: { revision: 0, sha256: sha256(markdown), markdown }, projection: { state: 'not_requested' },
          capabilities: { canConverse: false, canRequestPlan: false }, nextAction: 'advance', pollAfterMs: POLL_AFTER_MS,
        },
      }
      sessions.set(stored.session.id, stored)
      return sessionAnswer(stored, 202)
    })
  }
  if (id === 'resolve' && !sub && method === 'GET') {
    const draftId = url.searchParams.get('draftId')
    if (!draftId) return fail(400, 'invalid_argument', 'draftId is required', { field: '/draftId' })
    const owned = [...sessions.values()].find((stored) => stored.owner === owner && stored.session.draftId === draftId)
    return answer(200, owned ? { engine: 'console-v1', sessionId: owned.session.id } : { engine: 'platform-v1', draftId })
  }
  const stored = sessions.get(id)
  if (!stored || stored.owner !== owner) return notFound()
  const path = url.pathname

  if (!sub && method === 'GET') {
    // Creation runs on the Platform draft; once an execution exists the session is created and takes no more turns.
    if (stored.session.lifecycle === 'planned' && stored.session.draftId) {
      const read = await platform('GET', stored.session.draftId)
      const draft = read?.ok ? (await read.json()) as { creationExecutions?: unknown[] } : undefined
      if (draft?.creationExecutions?.length) bump(stored, { lifecycle: 'created', nextAction: 'none', capabilities: { canConverse: false, canRequestPlan: false } })
    }
    return sessionAnswer(stored)
  }
  if (sub === 'advance' && !subId && method === 'POST') return write(request, owner, path, true, (_, version) => stale(stored, version) ?? advance(stored))
  if (sub === 'archive' && !subId && method === 'POST') {
    return write(request, owner, path, true, (_, version) => {
      const conflict = stale(stored, version)
      if (conflict) return conflict
      if (stored.session.activeTurnId) return fail(409, 'session_busy', 'a turn is still running')
      bump(stored, { lifecycle: 'archived', archivedAt: stamp(), nextAction: 'none', capabilities: { canConverse: false, canRequestPlan: false } })
      return sessionAnswer(stored, 202)
    })
  }
  if (sub === 'publish-preferences' && !subId && method === 'PATCH') {
    return write(request, owner, path, true, async (body, version) => {
      const conflict = stale(stored, version)
      if (conflict) return conflict
      const parsed = buildPublishInput.safeParse(body)
      if (!parsed.success) return invalid(parsed.error.issues)
      bump(stored, {})
      // The typed preference is the draft's publish preference (design §12); the sync state says whether it landed.
      const synced = stored.session.draftId ? await platform('PATCH', stored.session.draftId, { publishPreferences: parsed.data }) : undefined
      const sync: PublishWire['sync'] = !synced ? { state: 'pending' } : synced.ok ? { state: 'applied' } : { state: 'failed', failure: { error: 'service_unavailable', message: 'the draft publish preferences could not be written' } }
      const result: PublishWire = { desired: parsed.data, sessionVersion: stored.session.version, sync }
      return answer(202, result, { ETag: etag(stored.session.version) })
    })
  }
  if (sub === 'spec-revisions' && subId && !action && method === 'GET') {
    const revision = stored.revisions.find((item) => String(item.revision) === subId)
    return revision ? answer(200, revision) : fail(404, 'not_found', 'revision not found')
  }
  if (sub !== 'turns') return undefined
  if (!subId && method === 'GET') return page(stored.turns)
  if (!subId && method === 'POST') return write(request, owner, path, true, (body, version) => stale(stored, version) ?? createTurn(stored, body))
  const turn = stored.turns.find((item) => item.id === subId)
  if (!turn) return fail(404, 'not_found', 'turn not found', { resource: 'operation' })
  if (!action && method === 'GET') {
    const observed = turn.id === stored.session.activeTurnId ? await observe(stored, turn) : turn
    return answer(200, observed, { ETag: etag(stored.session.version) })
  }
  if (action === 'resolution' && method === 'POST') return write(request, owner, path, true, (body, version) => stale(stored, version) ?? resolveTurn(stored, turn.id, body))
  return undefined
}
