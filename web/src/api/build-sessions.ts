// NEW-APP conversation client (APT-753 S4-U1; conversation design §2): the
// twelve `/api/console/v1/build-sessions*` operations. Every answer goes
// through the gateway and its S4-0 response contract and arrives as a domain
// value. Writes carry `Idempotency-Key` (the caller's, stable per user intent)
// and, except create, `If-Match` from the session version the caller last
// read. The contract fixes the session ETag to `"bs-<version>"` for Session,
// Turn (`sessionVersion`) and PublishResult (`sessionVersion`) answers, so the
// precondition is formatted from that verified version in one place
// (`sessionETag`) instead of being read from a response header.
import type { ResponseContract } from './boundary'
import { isConsoleError, type ConsoleApiError, type ConsoleRequest } from './console'
import { buildSessionContracts } from './contracts/console/build-sessions'
import type { ConsoleOperationContract } from './contracts/define'
import { apiGateway, type ApiGateway } from './gateway'
import type {
  BuildCreateSessionInput, BuildListQuery, BuildPublishInput, BuildPublishResult, BuildResolutionInput, BuildResolveResult,
  BuildSession, BuildSessionList, BuildSpecRevision, BuildTurn, BuildTurnInput, BuildTurnList,
} from '../model/contracts/console'

const BASE = '/api/console/v1/build-sessions'

/** The strong session validator for `version`: the only place `If-Match` is formatted. */
export function sessionETag(version: number): string {
  return `"bs-${version}"`
}

/** A fresh key for a user intent that has none yet (1–128 printable ASCII, contract `Idempotency-Key`). */
export function mintIdempotencyKey(): string {
  return `bc-${crypto.randomUUID()}`
}

/**
 * Keys of intents that are the same intent in every tab: advancing, resolving
 * or archiving from one session version. Two tabs doing the same thing at the
 * same version replay one request instead of racing each other.
 */
export const intentKeys = {
  advance: (sessionId: string, version: number) => `bs/${sessionId}/advance/${version}`,
  resolution: (sessionId: string, version: number, turnId: string, decision: BuildResolutionInput['decision']) => `bs/${sessionId}/resolution/${version}/${turnId}/${decision}`,
  archive: (sessionId: string, version: number) => `bs/${sessionId}/archive/${version}`,
}

/** What a write needs besides its body: its intent key and the session version it was decided on. */
export interface BuildWrite {
  key: string
  version: number
}

/** 412 `version_conflict`: the session moved on (another tab, a reload); re-read, never resend blindly. */
export function isVersionConflict(error: unknown): error is ConsoleApiError {
  return isConsoleError(error, 'version_conflict') && error.status === 412
}

const sessionPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`
const turnPath = (id: string, turnId: string) => `${sessionPath(id)}/turns/${encodeURIComponent(turnId)}`

function pageQuery(path: string, query: BuildListQuery): string {
  const search = new URLSearchParams()
  if (query.cursor !== undefined) search.set('cursor', query.cursor)
  if (query.limit !== undefined) search.set('limit', String(query.limit))
  return search.size ? `${path}?${search}` : path
}

const writeHeaders = (write: BuildWrite) => ({ 'Idempotency-Key': write.key, 'If-Match': sessionETag(write.version) })

function operation<I, D>(contract: ResponseContract<D>, request: (input: I) => ConsoleRequest): ConsoleOperationContract<I, D> {
  return { ...contract, source: 'console', request }
}

type Write<B> = { id: string; body: B; write: BuildWrite }
type TurnWrite<B> = Write<B> & { turnId: string }

const contracts = {
  create: operation(buildSessionContracts.create, ({ body, key }: { body: BuildCreateSessionInput; key: string }) =>
    ({ method: 'POST', path: BASE, body, headers: { 'Idempotency-Key': key } })),
  list: operation(buildSessionContracts.list, (query: BuildListQuery) => ({ method: 'GET', path: pageQuery(BASE, query) })),
  get: operation(buildSessionContracts.get, (id: string) => ({ method: 'GET', path: sessionPath(id) })),
  resolve: operation(buildSessionContracts.resolve, (draftId: string) =>
    ({ method: 'GET', path: `${BASE}/resolve?${new URLSearchParams({ draftId })}` })),
  advance: operation(buildSessionContracts.advance, ({ id, write }: Write<Record<string, never>>) =>
    ({ method: 'POST', path: `${sessionPath(id)}/advance`, body: {}, headers: writeHeaders(write) })),
  createTurn: operation(buildSessionContracts.createTurn, ({ id, body, write }: Write<BuildTurnInput>) =>
    ({ method: 'POST', path: `${sessionPath(id)}/turns`, body, headers: writeHeaders(write) })),
  listTurns: operation(buildSessionContracts.listTurns, ({ id, query }: { id: string; query: BuildListQuery }) =>
    ({ method: 'GET', path: pageQuery(`${sessionPath(id)}/turns`, query) })),
  getTurn: operation(buildSessionContracts.getTurn, ({ id, turnId }: { id: string; turnId: string }) => ({ method: 'GET', path: turnPath(id, turnId) })),
  resolveTurn: operation(buildSessionContracts.resolveTurn, ({ id, turnId, body, write }: TurnWrite<BuildResolutionInput>) =>
    ({ method: 'POST', path: `${turnPath(id, turnId)}/resolution`, body, headers: writeHeaders(write) })),
  specRevision: operation(buildSessionContracts.specRevision, ({ id, revision }: { id: string; revision: number }) =>
    ({ method: 'GET', path: `${sessionPath(id)}/spec-revisions/${revision}` })),
  publishPreferences: operation(buildSessionContracts.publishPreferences, ({ id, body, write }: Write<BuildPublishInput>) =>
    ({ method: 'PATCH', path: `${sessionPath(id)}/publish-preferences`, body, headers: writeHeaders(write) })),
  archive: operation(buildSessionContracts.archive, ({ id, write }: Write<Record<string, never>>) =>
    ({ method: 'POST', path: `${sessionPath(id)}/archive`, body: {}, headers: writeHeaders(write) })),
}

export interface BuildSessionsApi {
  /** 202; the same key and body replay the original session, another body is 409 `idempotency_conflict`. */
  create(body: BuildCreateSessionInput, key: string): Promise<BuildSession>
  list(query?: BuildListQuery): Promise<BuildSessionList>
  get(id: string): Promise<BuildSession>
  /** Which engine owns this draft: an existing console-v1 session, else the legacy platform-v1 draft. */
  resolve(draftId: string): Promise<BuildResolveResult>
  /** Moves the stored next step (initialization, sync, wake, repair) on; only when the session says `advance`. */
  advance(id: string, write: BuildWrite): Promise<BuildSession>
  createTurn(id: string, body: BuildTurnInput, write: BuildWrite): Promise<BuildTurn>
  listTurns(id: string, query?: BuildListQuery): Promise<BuildTurnList>
  /** Every turn in ordinal order, following `nextCursor` to the end. */
  allTurns(id: string): Promise<BuildTurn[]>
  /** Observes the turn (the server may import a validated reply); never a new Platform write. */
  getTurn(id: string, turnId: string): Promise<BuildTurn>
  resolveTurn(id: string, turnId: string, body: BuildResolutionInput, write: BuildWrite): Promise<BuildTurn>
  specRevision(id: string, revision: number): Promise<BuildSpecRevision>
  setPublishPreferences(id: string, body: BuildPublishInput, write: BuildWrite): Promise<BuildPublishResult>
  archive(id: string, write: BuildWrite): Promise<BuildSession>
}

export function createBuildSessionsApi(gateway: Pick<ApiGateway, 'console'> = apiGateway): BuildSessionsApi {
  const api: BuildSessionsApi = {
    create: (body, key) => gateway.console(contracts.create, { body, key }),
    list: (query = {}) => gateway.console(contracts.list, query),
    get: (id) => gateway.console(contracts.get, id),
    resolve: (draftId) => gateway.console(contracts.resolve, draftId),
    advance: (id, write) => gateway.console(contracts.advance, { id, body: {}, write }),
    createTurn: (id, body, write) => gateway.console(contracts.createTurn, { id, body, write }),
    listTurns: (id, query = {}) => gateway.console(contracts.listTurns, { id, query }),
    allTurns: async (id) => {
      const turns: BuildTurn[] = []
      let cursor: string | undefined
      do {
        const page = await api.listTurns(id, { limit: 50, ...(cursor === undefined ? {} : { cursor }) })
        turns.push(...page.items)
        cursor = page.nextCursor
      } while (cursor !== undefined)
      return turns
    },
    getTurn: (id, turnId) => gateway.console(contracts.getTurn, { id, turnId }),
    resolveTurn: (id, turnId, body, write) => gateway.console(contracts.resolveTurn, { id, turnId, body, write }),
    specRevision: (id, revision) => gateway.console(contracts.specRevision, { id, revision }),
    setPublishPreferences: (id, body, write) => gateway.console(contracts.publishPreferences, { id, body, write }),
    archive: (id, write) => gateway.console(contracts.archive, { id, body: {}, write }),
  }
  return api
}

export const buildSessionsApi = createBuildSessionsApi()
