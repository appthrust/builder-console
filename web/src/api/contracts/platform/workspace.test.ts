import { describe, expect, test } from 'bun:test'
import { isOneOf, type PreviewWorkspace } from '../../../model/contracts/build'
import { previewDatabaseStatus } from '../../../features/build/implement/runtime'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import { getDevWorkspaceContract, restartDevWorkspaceContract } from './workspace'

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
