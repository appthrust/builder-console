import { describe, expect, test } from 'bun:test'
import { isOneOf, type PreviewWorkspace } from '../../../model/contracts/build'
import { previewDatabaseStatus } from '../../../features/build/implement/runtime'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import type { MyWorkspace } from '../../../model/contracts/workspace'
import { deleteDevWorkspaceContract, extendDevWorkspaceLeaseContract, getDevWorkspaceContract, listDevWorkspacesContract, restartDevWorkspaceContract, stopDevWorkspaceContract } from './workspace'

const SECRET = 'SENTINEL-workspace-91d4'
const at = '2026-11-13T00:00:00Z'
const ready = { type: 'Ready', status: 'True', reason: 'PreviewListening', lastTransitionTime: at }
/** A DevWorkspace as Platform marshals it (DevWorkspaceRead): Go never omits `conditions`. */
const wireWorkspace = {
  id: 'ws-1', projectId: 'project-1', scope: 'applicationDraft', draftId: 'draft-1', displayName: '見積の作業場所', ownerUserId: 'owner-1',
  phase: 'Ready', branchName: 'appthrust/draft-1', baseRef: 'main', previewUrl: '/api/v1/projects/project-1/dev-workspaces/ws-1/proxy/preview/',
  previewDatabase: { engine: 'PostgreSQL', ready: true, resetGeneration: 0 }, conditions: [ready],
}
const domainWorkspace: PreviewWorkspace = {
  id: 'ws-1', projectId: 'project-1', scope: 'applicationDraft', draftId: 'draft-1', displayName: '見積の作業場所', ownerUserId: 'owner-1',
  phase: { kind: 'known', value: 'Ready' }, branchName: 'appthrust/draft-1', baseRef: 'main', previewUrl: '/api/v1/projects/project-1/dev-workspaces/ws-1/proxy/preview/',
  previewDatabase: { engine: { kind: 'known', value: 'PostgreSQL' }, ready: true, resetGeneration: 0 }, conditions: [{ ...ready, status: { kind: 'known', value: 'True' } }],
}
const without = <K extends keyof typeof wireWorkspace>(key: K) => Object.fromEntries(Object.entries(wireWorkspace).filter(([name]) => name !== key))
/** Whether the workspace reads as running its preview: an unknown phase or condition status never does. */
const previewReady = (workspace: PreviewWorkspace) => isOneOf(workspace.phase, 'Ready') && workspace.conditions.some((condition) => condition.type === 'Ready' && isOneOf(condition.status, 'True'))

describe('DevWorkspace read (platformApiGetDevWorkspace)', () => {
  test('wire variants', () => {
    assertWireContractCases(getDevWorkspaceContract, [
      { name: 'the marshalled workspace is the domain workspace', variant: 'present', path: '/', wire: wireWorkspace, expect: { accept: true, value: domainWorkspace, check: (workspace) => expect(previewReady(workspace)).toBe(true) } },
      { name: 'no preview URL yet', variant: 'absent', path: '/previewUrl', wire: without('previewUrl'), expect: { accept: true, check: (workspace) => expect(workspace.previewUrl).toBeUndefined() } },
      { name: 'a null preview URL is broken, not "no preview"', variant: 'null', path: '/previewUrl', wire: { ...wireWorkspace, previewUrl: null }, expect: { accept: false, issues: [{ path: '/previewUrl', code: 'invalid_type' }] } },
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

/** A row of `GET dev-workspaces?owner=me` as Platform 0.1.8 marshals it (`state`, `lease`, `allowedActions`, `sourceVolume`). */
const actions = { open: true, stop: true, start: false, restart: true, extendLease: true, keepLonger: false, delete: true, commit: true, blockedBy: {} }
const wireRow = {
  ...wireWorkspace, ownedByCaller: true, state: 'Ready', lastActivityAt: at,
  lease: { lastActivityAt: at, expiresAt: '2026-11-13T01:00:00Z', ttlSeconds: 3600, source: 'default' },
  sourceVolume: { state: 'Retained', releaseAt: '2026-11-20T00:00:00Z', retention: { class: null, project: null, effective: null, source: 'none', policyValid: true } },
  runtime: { ready: true, editorReady: true, previewReady: true, codexReady: true, claudeReady: false, sandboxRuntime: 'GVisor' },
  allowedActions: actions,
}
const domainRow: MyWorkspace = {
  id: 'ws-1', projectId: 'project-1', displayName: '見積の作業場所', draftId: 'draft-1', ownedByCaller: true, lastActivityAt: at,
  scope: { kind: 'known', value: 'applicationDraft' }, state: { kind: 'known', value: 'Ready' },
  lease: { lastActivityAt: at, expiresAt: '2026-11-13T01:00:00Z', ttlSeconds: 3600 },
  sourceVolume: { state: { kind: 'known', value: 'Retained' }, releaseAt: '2026-11-20T00:00:00Z' },
  allowedActions: actions,
}
const summary = { total: 1, active: 1, sleeping: 0, stopped: 0, retainedSourceVolumes: 1, idleRetained: 0, degraded: 0, retired: 0 }
const wireList = { data: [wireRow], meta: { total: 1 }, summary, idleAfter: '168h0m0s' }
const listWith = (row: unknown) => ({ ...wireList, data: [row] })

describe('My workspaces list (platformApiListDevWorkspaces, owner=me)', () => {
  test('wire variants', () => {
    assertWireContractCases(listDevWorkspacesContract, [
      { name: 'a row keeps only what the drawer shows', variant: 'present', path: '/', wire: wireList, expect: { accept: true, value: { data: [domainRow], summary, idleAfter: '168h0m0s' } } },
      { name: 'no workspaces', variant: 'empty', path: '/data', wire: { ...wireList, data: [], summary: { ...summary, total: 0, active: 0, retainedSourceVolumes: 0 } }, expect: { accept: true, check: (list) => expect(list.data).toEqual([]) } },
      { name: 'an unknown state is unknown, never running', variant: 'unknown', path: '/data/*/state', wire: listWith({ ...wireRow, state: SECRET }), expect: { accept: true, check: (list) => expect(list.data[0]?.state).toEqual({ kind: 'unknown' }) } },
      { name: 'a server without `state` reads the state its phase stands for', variant: 'absent', path: '/data/*/state', wire: listWith({ ...wireRow, state: undefined, phase: 'Stopping' }), expect: { accept: true, check: (list) => expect(list.data[0]?.state).toEqual({ kind: 'known', value: 'Stopped' }) } },
      { name: 'without `state`, an unknown phase is an unknown state', variant: 'unknown', path: '/data/*/phase', wire: listWith({ ...wireRow, state: undefined, phase: SECRET }), expect: { accept: true, check: (list) => expect(list.data[0]?.state).toEqual({ kind: 'unknown' }) } },
      { name: 'an unknown scope is unknown', variant: 'unknown', path: '/data/*/scope', wire: listWith({ ...wireRow, scope: SECRET }), expect: { accept: true, check: (list) => expect(list.data[0]?.scope).toEqual({ kind: 'unknown' }) } },
      { name: 'an unknown source volume state is unknown', variant: 'unknown', path: '/data/*/sourceVolume/state', wire: listWith({ ...wireRow, sourceVolume: { state: SECRET } }), expect: { accept: true, check: (list) => expect(list.data[0]?.sourceVolume?.state).toEqual({ kind: 'unknown' }) } },
      { name: 'an unknown lease source or sandbox runtime does not break the row', variant: 'unknown', path: '/data/*/lease/source', wire: listWith({ ...wireRow, lease: { ...wireRow.lease, source: SECRET }, runtime: { ...wireRow.runtime, sandboxRuntime: SECRET } }), expect: { accept: true, check: (list) => expect(list.data[0]?.lease).toEqual(domainRow.lease) } },
      { name: 'a server without allowed actions offers none', variant: 'absent', path: '/data/*/allowedActions', wire: listWith({ ...wireRow, allowedActions: undefined }), expect: { accept: true, check: (list) => expect(list.data[0]?.allowedActions).toBeUndefined() } },
      { name: 'a Retired row keeps when Platform deletes it', variant: 'present', path: '/data/*/retired', wire: listWith({ ...wireRow, state: 'Retired', phase: 'Failed', retired: { at, reason: 'RuntimeTargetReplaced', deleteAt: '2026-11-20T00:00:00Z' } }), expect: { accept: true, check: (list) => { expect(list.data[0]?.state).toEqual({ kind: 'known', value: 'Retired' }); expect(list.data[0]?.retired?.deleteAt).toBe('2026-11-20T00:00:00Z') } } },
      { name: 'broken allowed actions are broken, not "nothing allowed"', variant: 'unknown', path: '/data/*/allowedActions', wire: listWith({ ...wireRow, allowedActions: { ...actions, delete: SECRET } }), expect: { accept: false, issues: [{ path: '/data/*/allowedActions/delete', code: 'invalid_type' }] } },
      { name: 'a summary is required', variant: 'absent', path: '/summary', wire: { ...wireList, summary: undefined }, expect: { accept: false, issues: [{ path: '/summary', code: 'missing' }] } },
      { name: 'idleAfter is required', variant: 'absent', path: '/idleAfter', wire: { ...wireList, idleAfter: undefined }, expect: { accept: false, issues: [{ path: '/idleAfter', code: 'missing' }] } },
      { name: 'null data is broken', variant: 'null', path: '/data', wire: { ...wireList, data: null }, expect: { accept: false, issues: [{ path: '/data', code: 'invalid_type' }] } },
    ])
  })
})

describe('My workspaces writes (extend-lease, stop, delete)', () => {
  const operation = { id: 'op-2', type: 'devWorkspace.extendLease', state: 'accepted', writeChannel: 'A', resource: { kind: 'DevWorkspace', id: 'ws-1', projectId: 'project-1' }, createdAt: at, links: { self: '/api/v1/operations/op-2' } }
  const wireWrite = { ...wireRow, operation, resource: wireRow }

  test('extend-lease and stop read the written row', () => {
    for (const contract of [extendDevWorkspaceLeaseContract, stopDevWorkspaceContract]) {
      assertWireContractCases(contract, [
        { name: 'the written workspace is the answer\'s resource', variant: 'present', path: '/resource', wire: wireWrite, expect: { accept: true, value: domainRow } },
        { name: 'an answer without its resource is broken', variant: 'absent', path: '/resource', wire: { ...wireRow, operation }, expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
        { name: 'an unknown state of the written workspace is unknown', variant: 'unknown', path: '/resource/state', wire: { ...wireWrite, resource: { ...wireRow, state: SECRET } }, expect: { accept: true, check: (workspace) => expect(workspace.state).toEqual({ kind: 'unknown' }) } },
      ])
    }
  })

  test('delete reads the accepted workspace id', () => {
    assertWireContractCases(deleteDevWorkspaceContract, [
      { name: 'the receipt names the workspace', variant: 'present', path: '/operation', wire: { pendingSync: false, operation: { ...operation, type: 'devWorkspace.delete' } }, expect: { accept: true, value: { id: 'ws-1' } } },
      { name: 'an answer without its receipt is broken', variant: 'absent', path: '/operation', wire: { pendingSync: false }, expect: { accept: false, issues: [{ path: '/operation', code: 'missing' }] } },
    ])
  })
})
