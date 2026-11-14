import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { isOneOf, type PreviewWorkspace } from '../../../model/contracts/build'
import { previewDatabaseStatus } from '../../../features/build/implement/runtime'
import { isResponseContractError } from '../../boundary'
import { platformErrorEnvelope } from '../../platform-error'
import { atConsoleOrigin } from '../../testing/console-origin'
import { createTestGateway } from '../../testing/gateway'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import { createDevWorkspaceHTTPSessionContract, getDevWorkspaceContract, isPreviewOrigin, previewSessionReadyContract, restartDevWorkspaceContract } from './workspace'

const SECRET = 'SENTINEL-workspace-91d4'
const GRANT = 'SENTINEL-grant-eyJhbGciOiJFUzI1NiJ9.e30.c2ln'
const at = '2026-11-13T00:00:00Z'
const PUBLISH_UID = '7d0f3c52-9a41-4f7e-8b52-3c1f0e6a9b10'
const HEX = '0123456789abcdef0123456789abcdef'
const ORIGIN = `https://pv-${HEX}.project-1.appthrust.test`
/** The Console these answers are read by: the preview origins it may trust sit beside it. */
const CONSOLE = 'https://console.project-1.appthrust.test'
let leaveConsole: () => void
beforeEach(() => { leaveConsole = atConsoleOrigin(CONSOLE) })
afterEach(() => leaveConsole())
const ready = { type: 'Ready', status: 'True', reason: 'PreviewListening', lastTransitionTime: at }
const endpoint = { target: 'preview', state: 'Ready', url: `${ORIGIN}/`, publishUID: PUBLISH_UID, sessionPath: '/api/v1/projects/project-1/dev-workspaces/ws-1/http-sessions' }
/** A DevWorkspace as Platform marshals it (DevWorkspaceRead): Go never omits `conditions`. */
const wireWorkspace = {
  id: 'ws-1', projectId: 'project-1', scope: 'applicationDraft', draftId: 'draft-1', displayName: '見積の作業場所', ownerUserId: 'owner-1',
  phase: 'Ready', branchName: 'appthrust/draft-1', baseRef: 'main', previewUrl: `${ORIGIN}/`, httpEndpoints: [endpoint],
  previewDatabase: { engine: 'PostgreSQL', ready: true, resetGeneration: 0 }, conditions: [ready],
}
const domainWorkspace: PreviewWorkspace = {
  id: 'ws-1', projectId: 'project-1', scope: 'applicationDraft', draftId: 'draft-1', displayName: '見積の作業場所', ownerUserId: 'owner-1',
  phase: { kind: 'known', value: 'Ready' }, branchName: 'appthrust/draft-1', baseRef: 'main',
  preview: { state: { kind: 'known', value: 'Ready' }, origin: ORIGIN, publishUID: PUBLISH_UID },
  previewDatabase: { engine: { kind: 'known', value: 'PostgreSQL' }, ready: true, resetGeneration: 0 }, conditions: [{ ...ready, status: { kind: 'known', value: 'True' } }],
}
const without = <K extends keyof typeof wireWorkspace>(key: K) => Object.fromEntries(Object.entries(wireWorkspace).filter(([name]) => name !== key))
const withEndpoint = (change: Record<string, unknown>) => ({ ...wireWorkspace, httpEndpoints: [{ ...endpoint, ...change }] })
/** Whether the workspace reads as running its preview: an unknown phase or condition status never does. */
const previewReady = (workspace: PreviewWorkspace) => isOneOf(workspace.phase, 'Ready') && workspace.conditions.some((condition) => condition.type === 'Ready' && isOneOf(condition.status, 'True'))
/** Origins that are not this Project's preview origins, as a Ready endpoint URL (`/` appended) or a grant's origin. */
const foreignOrigins = [
  ['a sibling app of the Project', 'https://ai-app.project-1.appthrust.test'],
  ['another Project', `https://pv-${HEX}.project-2.appthrust.test`],
  ['another domain', `https://pv-${HEX}.project-1.example.test`],
  ['a suffix spoof', `${ORIGIN}.evil.test`],
  ['a pv- label one digit short', `https://pv-${HEX.slice(1)}.project-1.appthrust.test`],
  ['a pv- label one digit long', `https://pv-${HEX}0.project-1.appthrust.test`],
  ['upper-case hex', `https://pv-${HEX.toUpperCase()}.project-1.appthrust.test`],
  ['a port', `${ORIGIN}:8443`],
  ['userinfo', `https://user@pv-${HEX}.project-1.appthrust.test`],
  ['the Console itself', CONSOLE],
  ['a percent-encoded dot in the Project domain', `https://pv-${HEX}.project-1%2Eappthrust.test`],
  ['a percent-encoded pv- label', `https://pv-%30${HEX.slice(1)}.project-1.appthrust.test`],
] as const

test('only https://pv-<32 lowercase hex>.<the Console\'s project domain> is a preview origin', () => {
  expect(isPreviewOrigin(ORIGIN, CONSOLE)).toBe(true)
  for (const [, origin] of foreignOrigins) expect(isPreviewOrigin(origin, CONSOLE)).toBe(false)
  expect(isPreviewOrigin(`http://pv-${HEX}.project-1.appthrust.test`, CONSOLE)).toBe(false)
  expect(isPreviewOrigin(`${ORIGIN}/`, CONSOLE)).toBe(false)
  // A page that is not `https://console.<project-domain>` trusts no preview origin at all.
  for (const embedder of ['http://localhost:5199', 'https://console.project-1.appthrust.test:8443', 'https://app.project-1.appthrust.test', 'http://console.project-1.appthrust.test']) {
    expect(isPreviewOrigin(ORIGIN, embedder)).toBe(false)
  }
})

describe('DevWorkspace read (platformApiGetDevWorkspace)', () => {
  test('wire variants', () => {
    assertWireContractCases(getDevWorkspaceContract, [
      { name: 'the marshalled workspace is the domain workspace', variant: 'present', path: '/', wire: wireWorkspace, expect: { accept: true, value: domainWorkspace, check: (workspace) => expect(previewReady(workspace)).toBe(true) } },
      {
        name: 'the legacy same-origin preview URL is never part of the domain value', variant: 'present', path: '/previewUrl',
        wire: { ...wireWorkspace, previewUrl: '/api/v1/projects/project-1/dev-workspaces/ws-1/proxy/preview/' },
        expect: { accept: true, value: domainWorkspace, check: (workspace) => expect(JSON.stringify(workspace)).not.toContain('proxy/preview') },
      },
      // Legacy same-origin preview (remove at migration stage 5): only a never-moved workspace keeps its proxy path.
      {
        name: 'a workspace without an endpoint or the receipt keeps its relative legacy URL', variant: 'present', path: '/previewUrl',
        wire: { ...without('httpEndpoints'), previewUrl: '/api/v1/projects/project-1/dev-workspaces/ws-1/proxy/preview/' },
        expect: { accept: true, check: (workspace) => expect(workspace.legacyPreviewUrl).toBe('/api/v1/projects/project-1/dev-workspaces/ws-1/proxy/preview/') },
      },
      {
        name: 'the DirectPreviewActivated=True receipt drops the legacy URL whatever its age', variant: 'present', path: '/conditions',
        wire: { ...without('httpEndpoints'), previewUrl: '/api/v1/projects/project-1/dev-workspaces/ws-1/proxy/preview/', conditions: [ready, { type: 'DirectPreviewActivated', status: 'True', reason: 'PreviewEndpointReady', lastTransitionTime: '2020-01-01T00:00:00Z' }] },
        expect: { accept: true, check: (workspace) => expect(workspace.legacyPreviewUrl).toBeUndefined() },
      },
      {
        name: 'a receipt that is not True keeps the legacy URL', variant: 'unknown', path: '/conditions/*/status',
        wire: { ...without('httpEndpoints'), previewUrl: '/api/v1/projects/project-1/dev-workspaces/ws-1/proxy/preview/', conditions: [ready, { type: 'DirectPreviewActivated', status: 'Unknown' }] },
        expect: { accept: true, check: (workspace) => expect(workspace.legacyPreviewUrl).toBe('/api/v1/projects/project-1/dev-workspaces/ws-1/proxy/preview/') },
      },
      ...['https://elsewhere.example/api/v1/projects/project-1/dev-workspaces/ws-1/proxy/preview/', '//elsewhere.example/api/v1/x', '/proxy/preview/'].map((previewUrl) => ({
        name: `a previewUrl that is not a Platform API proxy path (${previewUrl}) is never a legacy URL`, variant: 'unknown' as const, path: '/previewUrl',
        wire: { ...without('httpEndpoints'), previewUrl },
        expect: { accept: true as const, check: (workspace: PreviewWorkspace) => expect(workspace.legacyPreviewUrl).toBeUndefined() },
      })),
      { name: 'an older Platform without endpoints has no preview', variant: 'absent', path: '/httpEndpoints', wire: without('httpEndpoints'), expect: { accept: true, check: (workspace) => expect(workspace.preview).toBeUndefined() } },
      { name: 'no endpoint published yet', variant: 'empty', path: '/httpEndpoints', wire: { ...wireWorkspace, httpEndpoints: [] }, expect: { accept: true, check: (workspace) => expect(workspace.preview).toBeUndefined() } },
      { name: 'null endpoints are broken, not "no preview"', variant: 'null', path: '/httpEndpoints', wire: { ...wireWorkspace, httpEndpoints: null }, expect: { accept: false, issues: [{ path: '/httpEndpoints', code: 'invalid_type' }] } },
      {
        name: 'a Pending endpoint has no URL and its reason is kept', variant: 'absent', path: '/httpEndpoints/*/url',
        wire: withEndpoint({ state: 'Pending', url: undefined, reason: 'ProjectionPending' }),
        expect: { accept: true, check: (workspace) => expect(workspace.preview).toEqual({ state: { kind: 'known', value: 'Pending' }, publishUID: PUBLISH_UID, reason: 'ProjectionPending' }) },
      },
      { name: 'a null reason reads as none', variant: 'null', path: '/httpEndpoints/*/reason', wire: withEndpoint({ reason: null }), expect: { accept: true, value: domainWorkspace } },
      { name: 'a Ready endpoint without its URL is broken, not "not ready"', variant: 'absent', path: '/httpEndpoints/*/url', wire: withEndpoint({ url: undefined }), expect: { accept: false, issues: [{ path: '/httpEndpoints/*/url', code: 'invalid_value' }] } },
      { name: 'a non-HTTPS endpoint URL is broken', variant: 'unknown', path: '/httpEndpoints/*/url', wire: withEndpoint({ url: 'http://pv.project-1.appthrust.test/' }), expect: { accept: false, issues: [{ path: '/httpEndpoints/*/url', code: 'invalid_value' }] } },
      { name: 'a publication UID that is not a canonical UUID is broken', variant: 'unknown', path: '/httpEndpoints/*/publishUID', wire: withEndpoint({ publishUID: SECRET }), expect: { accept: false, issues: [{ path: '/httpEndpoints/*/publishUID', code: 'invalid_value' }] } },
      {
        name: 'an unknown endpoint state is the explicit unknown variant, never Ready', variant: 'unknown', path: '/httpEndpoints/*/state',
        wire: withEndpoint({ state: SECRET, url: undefined }),
        expect: { accept: true, check: (workspace) => { expect(workspace.preview?.state).toEqual({ kind: 'unknown' }); expect(JSON.stringify(workspace)).not.toContain(SECRET) } },
      },
      {
        name: 'an endpoint of a target this console does not know is left out', variant: 'unknown', path: '/httpEndpoints/*/target',
        wire: { ...wireWorkspace, httpEndpoints: [{ target: SECRET, state: 'Ready' }, endpoint] },
        expect: { accept: true, value: domainWorkspace },
      },
      ...foreignOrigins.map(([name, origin]) => ({
        name: `a Ready endpoint on ${name} is an unknown state: nothing is embedded and no grant is asked for`, variant: 'unknown' as const, path: '/httpEndpoints/*/url',
        wire: withEndpoint({ url: `${origin}/` }),
        expect: { accept: true as const, check: (workspace: PreviewWorkspace) => expect(workspace.preview).toEqual({ state: { kind: 'unknown' }, publishUID: PUBLISH_UID }) },
      })),
      {
        name: 'a Ready endpoint URL with a path keeps its origin only', variant: 'present', path: '/httpEndpoints/*/url', wire: withEndpoint({ url: `${ORIGIN}/start` }),
        expect: { accept: true, check: (workspace) => expect(workspace.preview?.origin).toBe(ORIGIN) },
      },
      { name: 'two preview endpoints are broken, never "pick one"', variant: 'unknown', path: '/httpEndpoints', wire: { ...wireWorkspace, httpEndpoints: [endpoint, endpoint] }, expect: { accept: false, issues: [{ path: '/httpEndpoints', code: 'invalid_value' }] } },
      { name: 'no preview database', variant: 'absent', path: '/previewDatabase', wire: without('previewDatabase'), expect: { accept: true, check: (workspace) => expect(workspace.previewDatabase).toBeUndefined() } },
      { name: 'a null preview database is broken', variant: 'null', path: '/previewDatabase', wire: { ...wireWorkspace, previewDatabase: null }, expect: { accept: false, issues: [{ path: '/previewDatabase', code: 'invalid_type' }] } },
      { name: 'a preview database with a broken readiness is broken, not "not ready"', variant: 'unknown', path: '/previewDatabase', wire: { ...wireWorkspace, previewDatabase: { engine: 'PostgreSQL', ready: SECRET, resetGeneration: 0 } }, expect: { accept: false, issues: [{ path: '/previewDatabase/ready', code: 'invalid_type' }] } },
      {
        name: 'an unknown database engine is the explicit unknown variant: the workspace is read, only its database is unsupported', variant: 'unknown', path: '/previewDatabase/engine',
        wire: { ...wireWorkspace, previewDatabase: { engine: SECRET, ready: true, resetGeneration: 0 } },
        expect: { accept: true, check: (workspace) => {
          expect(workspace.previewDatabase?.engine).toEqual({ kind: 'unknown' })
          expect(previewDatabaseStatus(workspace, [])).toBe('unsupported')
          expect(previewReady(workspace)).toBe(true)
          expect(JSON.stringify(workspace)).not.toContain(SECRET)
        } },
      },
      { name: 'a database engine that is not a string is broken, not unknown', variant: 'unknown', path: '/previewDatabase/engine', wire: { ...wireWorkspace, previewDatabase: { engine: 5, ready: true, resetGeneration: 0 } }, expect: { accept: false, issues: [{ path: '/previewDatabase/engine', code: 'invalid_type' }] } },
      { name: 'a preview database without its engine is broken', variant: 'absent', path: '/previewDatabase/engine', wire: { ...wireWorkspace, previewDatabase: { ready: true, resetGeneration: 0 } }, expect: { accept: false, issues: [{ path: '/previewDatabase/engine', code: 'missing' }] } },
      { name: 'no conditions yet', variant: 'empty', path: '/conditions', wire: { ...wireWorkspace, conditions: [] }, expect: { accept: true, check: (workspace) => { expect(workspace.conditions).toEqual([]); expect(previewReady(workspace)).toBe(false) } } },
      { name: 'conditions are required (Go never omits them)', variant: 'absent', path: '/conditions', wire: without('conditions'), expect: { accept: false, issues: [{ path: '/conditions', code: 'missing' }] } },
      { name: 'null conditions (a nil slice) are a failure, not "no conditions"', variant: 'null', path: '/conditions', wire: { ...wireWorkspace, conditions: null }, expect: { accept: false, issues: [{ path: '/conditions', code: 'invalid_type' }] } },
      {
        name: 'unknown and server-only fields are dropped', variant: 'unknown', path: '/',
        wire: { ...wireWorkspace, podName: SECRET, environmentSecretName: SECRET, sessionToken: SECRET },
        expect: { accept: true, value: domainWorkspace, check: (workspace) => expect(JSON.stringify(workspace)).not.toContain(SECRET) },
      },
      {
        name: 'an unknown phase is the explicit unknown variant: never Ready, the value is not kept', variant: 'unknown', path: '/phase',
        wire: { ...wireWorkspace, phase: SECRET },
        expect: { accept: true, check: (workspace) => { expect(workspace.phase).toEqual({ kind: 'unknown' }); expect(previewReady(workspace)).toBe(false); expect(JSON.stringify(workspace)).not.toContain(SECRET) } },
      },
      {
        name: 'an unknown condition status is the explicit unknown variant: never True', variant: 'unknown', path: '/conditions',
        wire: { ...wireWorkspace, conditions: [{ ...ready, status: SECRET }] },
        expect: { accept: true, check: (workspace) => { expect(workspace.conditions[0]?.status).toEqual({ kind: 'unknown' }); expect(previewReady(workspace)).toBe(false) } },
      },
      { name: 'a phase that is not a string is broken, not unknown', variant: 'unknown', path: '/phase', wire: { ...wireWorkspace, phase: 7 }, expect: { accept: false, issues: [{ path: '/phase', code: 'invalid_type' }] } },
      { name: 'an absent phase is broken', variant: 'absent', path: '/phase', wire: without('phase'), expect: { accept: false, issues: [{ path: '/phase', code: 'missing' }] } },
      { name: 'a null condition status is broken, not unknown', variant: 'null', path: '/conditions', wire: { ...wireWorkspace, conditions: [{ ...ready, status: null }] }, expect: { accept: false, issues: [{ path: '/conditions/*/status', code: 'invalid_type' }] } },
      { name: 'a condition without a type is broken', variant: 'absent', path: '/conditions', wire: { ...wireWorkspace, conditions: [{ status: 'True' }] }, expect: { accept: false, issues: [{ path: '/conditions/*/type', code: 'missing' }] } },
      { name: 'required id absent', variant: 'absent', path: '/id', wire: without('id'), expect: { accept: false, issues: [{ path: '/id', code: 'missing' }] } },
      { name: 'required displayName broken', variant: 'unknown', path: '/displayName', wire: { ...wireWorkspace, displayName: { text: SECRET } }, expect: { accept: false, issues: [{ path: '/displayName', code: 'invalid_type' }] } },
    ])
  })

  test('read by a page that is not the Console, a Ready endpoint is an unknown state', () => {
    leaveConsole()
    leaveConsole = atConsoleOrigin('http://localhost:5199')
    const decoded = getDevWorkspaceContract.parse(wireWorkspace)
    expect(decoded.ok && decoded.value.preview).toEqual({ state: { kind: 'unknown' }, publishUID: PUBLISH_UID })
  })
})

describe('DevWorkspace restart (platformApiRestartDevWorkspace)', () => {
  const operation = { id: 'op-1', type: 'dev-workspace.restart', state: 'accepted', writeChannel: 'A', resource: { kind: 'DevWorkspace', id: 'ws-1', projectId: 'project-1' }, createdAt: at, links: { self: '/api/v1/operations/op-1' } }
  /** The mutation answer: the read model at the top level (legacy), the receipt, and the written `resource`. */
  const wireRestart = { ...wireWorkspace, operation, resource: wireWorkspace }

  test('wire variants', () => {
    assertWireContractCases(restartDevWorkspaceContract, [
      { name: 'the restarted workspace is the answer\'s resource', variant: 'present', path: '/resource', wire: wireRestart, expect: { accept: true, value: domainWorkspace } },
      { name: 'the receipt and the top-level copy are not read', variant: 'unknown', path: '/', wire: { resource: wireWorkspace, operation: SECRET, phase: SECRET }, expect: { accept: true, value: domainWorkspace } },
      { name: 'an answer without its resource is broken', variant: 'absent', path: '/resource', wire: { ...wireWorkspace, operation }, expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
      { name: 'a null resource is broken', variant: 'null', path: '/resource', wire: { ...wireRestart, resource: null }, expect: { accept: false, issues: [{ path: '/resource', code: 'invalid_type' }] } },
      {
        name: 'an unknown phase of the restarted workspace is unknown, not Ready', variant: 'unknown', path: '/resource/phase',
        wire: { ...wireRestart, resource: { ...wireWorkspace, phase: SECRET } },
        expect: { accept: true, check: (workspace) => { expect(workspace.phase).toEqual({ kind: 'unknown' }); expect(previewReady(workspace)).toBe(false) } },
      },
      {
        name: 'an unknown condition status of the restarted workspace is unknown', variant: 'unknown', path: '/resource/conditions',
        wire: { ...wireRestart, resource: { ...wireWorkspace, conditions: [{ ...ready, status: SECRET }] } },
        expect: { accept: true, check: (workspace) => expect(workspace.conditions[0]?.status).toEqual({ kind: 'unknown' }) },
      },
      { name: 'empty conditions of the restarted workspace', variant: 'empty', path: '/resource/conditions', wire: { ...wireRestart, resource: { ...wireWorkspace, conditions: [] } }, expect: { accept: true, check: (workspace) => expect(workspace.conditions).toEqual([]) } },
      { name: 'null conditions of the restarted workspace are broken', variant: 'null', path: '/resource/conditions', wire: { ...wireRestart, resource: { ...wireWorkspace, conditions: null } }, expect: { accept: false, issues: [{ path: '/resource/conditions', code: 'invalid_type' }] } },
      { name: 'a restarted workspace without its id is broken', variant: 'absent', path: '/resource/id', wire: { ...wireRestart, resource: without('id') }, expect: { accept: false, issues: [{ path: '/resource/id', code: 'missing' }] } },
      { name: 'a restarted workspace with a broken preview database is broken', variant: 'unknown', path: '/resource/previewDatabase', wire: { ...wireRestart, resource: { ...wireWorkspace, previewDatabase: { engine: 'PostgreSQL', ready: true, resetGeneration: SECRET } } }, expect: { accept: false, issues: [{ path: '/resource/previewDatabase/resetGeneration', code: 'invalid_type' }] } },
      { name: 'an unknown database engine of the restarted workspace is unknown', variant: 'unknown', path: '/resource/previewDatabase/engine', wire: { ...wireRestart, resource: { ...wireWorkspace, previewDatabase: { engine: SECRET, ready: true, resetGeneration: 0 } } }, expect: { accept: true, check: (workspace) => expect(workspace.previewDatabase?.engine).toEqual({ kind: 'unknown' }) } },
    ])
  })
})

const wireSession = { target: 'preview', origin: ORIGIN, exchangeUrl: `${ORIGIN}/__appthrust/session/${PUBLISH_UID}`, grant: GRANT, expiresAt: at, renewAfterSeconds: 30, publishUID: PUBLISH_UID }
const session = (change: Record<string, unknown>) => ({ resource: { ...wireSession, ...change } })

describe('workspace HTTP session (platformApiCreateDevWorkspaceHTTPSession)', () => {
  test('wire variants', () => {
    assertWireContractCases(createDevWorkspaceHTTPSessionContract, [
      {
        name: 'the grant answer is the domain session', variant: 'present', path: '/resource', wire: { resource: wireSession },
        expect: { accept: true, value: { origin: ORIGIN, publishUID: PUBLISH_UID, exchangeUrl: wireSession.exchangeUrl, grant: GRANT, expiresAt: at, renewAfterSeconds: 30 } },
      },
      { name: 'an answer without its resource is broken', variant: 'absent', path: '/resource', wire: {}, expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
      { name: 'an exchange URL outside the granted origin is broken: the grant is never sent there', variant: 'unknown', path: '/resource/exchangeUrl', wire: session({ exchangeUrl: `https://evil.project-1.appthrust.test/__appthrust/session/${PUBLISH_UID}` }), expect: { accept: false, issues: [{ path: '/resource/exchangeUrl', code: 'invalid_value' }] } },
      ...foreignOrigins.map(([name, origin]) => ({
        name: `a grant for ${name} is broken: it is never sent anywhere`, variant: 'unknown' as const, path: '/resource/origin',
        wire: session({ origin, exchangeUrl: `${origin}/__appthrust/session/${PUBLISH_UID}` }),
        expect: { accept: false as const, issues: [{ path: '/resource/origin', code: 'invalid_value' as const }] },
      })),
      { name: 'an exchange URL for another publication is broken', variant: 'unknown', path: '/resource/exchangeUrl', wire: session({ exchangeUrl: `${ORIGIN}/__appthrust/session/00000000-0000-4000-8000-000000000001` }), expect: { accept: false, issues: [{ path: '/resource/exchangeUrl', code: 'invalid_value' }] } },
      { name: 'an origin with a port or path is broken', variant: 'unknown', path: '/resource/origin', wire: session({ origin: `${ORIGIN}:8443` }), expect: { accept: false, issues: [{ path: '/resource/origin', code: 'invalid_value' }] } },
      { name: 'a plain-HTTP origin is broken', variant: 'unknown', path: '/resource/origin', wire: session({ origin: 'http://pv.project-1.appthrust.test' }), expect: { accept: false, issues: [{ path: '/resource/origin', code: 'invalid_value' }] } },
      { name: 'an empty grant is broken', variant: 'empty', path: '/resource/grant', wire: session({ grant: '' }), expect: { accept: false, issues: [{ path: '/resource/grant', code: 'invalid_value' }] } },
      { name: 'a null grant is broken', variant: 'null', path: '/resource/grant', wire: session({ grant: null }), expect: { accept: false, issues: [{ path: '/resource/grant', code: 'invalid_type' }] } },
      { name: 'another renewal interval is broken (the contract fixes 30 s)', variant: 'unknown', path: '/resource/renewAfterSeconds', wire: session({ renewAfterSeconds: 300 }), expect: { accept: false, issues: [{ path: '/resource/renewAfterSeconds', code: 'invalid_value' }] } },
      { name: 'another target is broken', variant: 'unknown', path: '/resource/target', wire: session({ target: 'editor' }), expect: { accept: false, issues: [{ path: '/resource/target', code: 'invalid_value' }] } },
    ])
  })

  /** A gateway whose Platform transport records each request and answers with `answer`. */
  function recordingGateway(answer: () => Response) {
    const requests: Request[] = []
    const platformFetch = mock(async (request: Request) => { requests.push(request); return answer() })
    return { requests, platformFetch, gateway: createTestGateway({ platformFetch }) }
  }
  const input = { projectId: 'project-1', id: 'ws-1', target: 'preview' as const, publishUID: PUBLISH_UID, embedderOrigin: 'https://console.project-1.appthrust.test' }

  test('the credential exchange carries no Idempotency-Key, even when the caller holds one; other writes keep theirs', async () => {
    const { requests, gateway } = recordingGateway(() => Response.json({ resource: wireSession }))
    await gateway.platform(createDevWorkspaceHTTPSessionContract, input)
    await gateway.platform(createDevWorkspaceHTTPSessionContract, input, { idempotencyKey: 'caller-key' })
    expect(requests.map((request) => request.headers.has('Idempotency-Key'))).toEqual([false, false])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/v1/projects/project-1/dev-workspaces/ws-1/http-sessions')
    expect(await requests[0]!.json()).toEqual({ target: 'preview', publishUID: PUBLISH_UID, embedderOrigin: 'https://console.project-1.appthrust.test' })
    // The grant travels in the answer body only: never in the request URL.
    expect(requests.every((request) => !request.url.includes(GRANT))).toBe(true)

    const restart = recordingGateway(() => Response.json({ resource: wireWorkspace }, { status: 202 }))
    await restart.gateway.platform(restartDevWorkspaceContract, { projectId: 'project-1', id: 'ws-1' })
    await restart.gateway.platform(restartDevWorkspaceContract, { projectId: 'project-1', id: 'ws-1' }, { idempotencyKey: 'held-key' })
    expect(restart.requests[0]!.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(restart.requests[1]!.headers.get('Idempotency-Key')).toBe('held-key')
  })

  test.each([
    ['503 workspace_session_unavailable', () => Response.json({ error: { code: 'unavailable', message: 'signer not ready', details: { reason: 'workspace_session_unavailable' } } }, { status: 503 })],
    ['403 workspace_session_credential_not_allowed', () => Response.json({ error: { code: 'permission_denied', message: 'A verified OIDC user token is required for workspace HTTP sessions.', details: { reason: 'workspace_session_credential_not_allowed' } } }, { status: 403 })],
  ])('a refused exchange (%s) is surfaced once: nothing retries or replays it', async (_name, answer) => {
    const { platformFetch, gateway } = recordingGateway(answer)
    const error = await gateway.platform(createDevWorkspaceHTTPSessionContract, input).catch((caught: unknown) => caught)
    expect(platformFetch).toHaveBeenCalledTimes(1)
    expect(platformErrorEnvelope(error)?.details?.reason).toBe(answer().status === 503 ? 'workspace_session_unavailable' : 'workspace_session_credential_not_allowed')
  })

  test('an unreadable 2xx is a contract failure whose report never carries the grant', async () => {
    const reports: unknown[] = []
    const platformFetch = mock(async () => Response.json({ resource: { ...wireSession, renewAfterSeconds: 'soon' } }))
    const gateway = createTestGateway({ platformFetch, reportFailure: (report) => reports.push(report) })
    const error = await gateway.platform(createDevWorkspaceHTTPSessionContract, input).catch((caught: unknown) => caught)
    expect(isResponseContractError(error)).toBe(true)
    expect(platformFetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(reports)).not.toContain(GRANT)
    expect(JSON.stringify(error)).not.toContain(GRANT)
    expect(String(error)).not.toContain(GRANT)
  })
})

describe('preview session check (GET <exchangeUrl>/ready)', () => {
  test('wire variants', () => {
    assertWireContractCases(previewSessionReadyContract, [
      { name: 'the fixed Ready answer', variant: 'present', path: '/', wire: { state: 'Ready', publishUID: PUBLISH_UID, expiresAt: at }, expect: { accept: true, value: { state: 'Ready', publishUID: PUBLISH_UID, expiresAt: at } } },
      { name: 'any other state is broken, never Ready', variant: 'unknown', path: '/state', wire: { state: SECRET, publishUID: PUBLISH_UID, expiresAt: at }, expect: { accept: false, issues: [{ path: '/state', code: 'invalid_value' }] } },
      { name: 'an answer without its publication is broken', variant: 'absent', path: '/publishUID', wire: { state: 'Ready', expiresAt: at }, expect: { accept: false, issues: [{ path: '/publishUID', code: 'missing' }] } },
    ])
  })
})
