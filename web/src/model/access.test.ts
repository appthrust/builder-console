import { describe, expect, test } from 'bun:test'
import { publishAccessOf } from '../api/testing/app-domain'
import { sharingCopy } from '../copy/sharing'
import { text } from '../features/app/copy'
import * as model from './access'
import { accessRequest, movePerson, shareScopeLabel } from './access'

// Access fixtures are wire literals read by the production reader.
const accessOf = (wire: unknown) => (wire === undefined ? undefined : publishAccessOf(wire))
const deriveAccess = (wire: unknown, ...rest: Parameters<typeof model.deriveAccess> extends [unknown, ...infer R] ? R : never) => model.deriveAccess(accessOf(wire), ...rest)
const matchesAccess = (wire: unknown, scope: Parameters<typeof model.matchesAccess>[1]) => model.matchesAccess(accessOf(wire), scope)

const share = { scope: 'private' as const, groupIds: [], extraPersonIds: ['viewer'] }
const app = { share, owners: [{ id: 'owner' }] }
const external = { defaultAction: 'Allow' as const, ruleCount: 0, external: { appInstallation: 'builder-console', path: '/authz' } }

test('publish audiences share the dialog vocabulary and name the owning group', () => {
  expect(['private', 'group', 'company'].map((scope) => shareScopeLabel(scope as 'private' | 'group' | 'company'))).toEqual(['自分だけ', 'グループ', '全社'])
  expect(shareScopeLabel('group', '営業部')).toBe('営業部')
  expect(shareScopeLabel('private', '営業部')).toBe('自分だけ')
})

describe('app URL access, not console intent', () => {
  test('scope maps onto the platform contract', () => {
    expect(accessRequest('public')).toEqual({ mode: 'Public' })
    expect(accessRequest('company')).toEqual({ mode: 'Authenticated' })
    for (const scope of ['private', 'group'] as const) expect(accessRequest(scope)).toEqual({ mode: 'Authenticated', externalAuthorization: { appInstallation: 'builder-console' } })
  })
  test('an actually public URL never claims limited access', () => {
    expect(deriveAccess({ mode: 'Public' }, app)).toMatchObject({ label: '公開中（誰でも）', applied: false })
    expect(deriveAccess(undefined, app)).toMatchObject({ label: '未適用（基盤の権限が必要）', applied: false })
  })
  test.each(['private', 'group'] as const)('a rejected %s write reports failure while warning that the URL remains public', (scope) => {
    const intended = { ...app, share: { ...share, scope } }
    expect(deriveAccess({ mode: 'Public' }, intended, [], 'failed')).toEqual({
      state: 'failed', applied: false, label: '公開範囲の反映に失敗（現在は誰でもアクセスできます）',
    })
  })
  test('a rejected change is not reported as applied even when the previous policy matches saved metadata', () => {
    expect(deriveAccess({ mode: 'Public' }, { ...app, share: { ...share, scope: 'public' } }, [], 'failed')).toMatchObject({ state: 'failed', applied: false })
    expect(deriveAccess({ mode: 'Authenticated', authorization: external }, app, [], 'failed')).toEqual({
      state: 'failed', applied: false, label: '公開範囲の反映に失敗',
    })
  })
  test('mode, authorizer and pending all have to match', () => {
    expect(matchesAccess({ mode: 'Authenticated' }, 'private')).toBe(false)
    expect(matchesAccess({ mode: 'Authenticated', authorization: external }, 'company')).toBe(false)
    expect(matchesAccess({ mode: 'Authenticated', authorization: external }, 'private')).toBe(true)
    expect(matchesAccess({ mode: 'Authenticated', authorization: { ...external, external: { appInstallation: 'other', path: '/authz' } } }, 'private')).toBe(false)
    expect(matchesAccess({ mode: 'Authenticated', authorization: external, pending: { reason: 'PolicyReferencesPending', message: '' } }, 'private')).toBe(false)
  })
  test('pending and forbidden never report success', () => {
    expect(deriveAccess({ mode: 'Authenticated', authorization: external, pending: { reason: 'ExternalAuthorizerNotReady', message: '' } }, app)).toMatchObject({ label: '反映中', applied: false })
    expect(deriveAccess({ mode: 'Public' }, app, [], 'forbidden')).toMatchObject({ label: '未適用（基盤の権限が必要）', applied: false })
  })
  test('limited count deduplicates owners and viewers and names shared groups', () => {
    expect(deriveAccess({ mode: 'Authenticated', authorization: external }, app).label).toBe('限定（2 人）')
    expect(deriveAccess({ mode: 'Authenticated', authorization: external }, { ...app, share: { ...share, scope: 'group', groupIds: ['g'], extraPersonIds: ['owner', 'viewer'] } }, [{ id: 'g', name: '営業部' }]).label).toBe('限定（2 人・営業部）')
    expect(deriveAccess({ mode: 'Authenticated' }, { ...app, share: { ...share, scope: 'company' } }).label).toBe('社員のみ')
  })
})

test('role moves use one disjoint owner/share patch and guard the last owner', () => {
  const promoted = movePerson(app, 'viewer', 'editor')
  expect(promoted).toEqual({ ownerIds: ['owner', 'viewer'], share: { ...share, extraPersonIds: [] } })
  const demoted = movePerson({ ...app, owners: [{ id: 'owner' }, { id: 'viewer' }], share: promoted.share }, 'viewer', 'viewer')
  expect(demoted).toEqual({ ownerIds: ['owner'], share })
  expect(movePerson(app, 'viewer', 'remove').share.extraPersonIds).toEqual([])
  expect(() => movePerson(app, 'owner', 'remove')).toThrow('編集できる人を 1 人以上残してください。')
})

describe('values this console does not know grant nothing', () => {
  test('an unknown access mode is neither public nor limited, and is never applied', () => {
    for (const scope of ['private', 'group', 'company', 'public'] as const) expect(matchesAccess({ mode: 'Restricted' }, scope)).toBe(false)
    expect(deriveAccess({ mode: 'Restricted', authorization: external }, app)).toMatchObject({ applied: false, label: sharingCopy.status.unapplied })
    expect(deriveAccess({ mode: 'Restricted' }, app, [], 'failed').label).toBe(sharingCopy.status.failed)
  })
  test('an unknown share scope matches no observed policy and says it cannot be handled', () => {
    const unknown = { ...app, share: { ...share, scope: { kind: 'unknown' as const } } }
    expect(matchesAccess({ mode: 'Public' }, { kind: 'unknown' })).toBe(false)
    expect(matchesAccess({ mode: 'Authenticated', authorization: external }, { kind: 'unknown' })).toBe(false)
    expect(deriveAccess({ mode: 'Authenticated', authorization: external }, unknown)).toEqual({ state: 'unapplied', applied: false, label: text.unsupported.share })
    // An exposed URL is still said to be public.
    expect(deriveAccess({ mode: 'Public' }, unknown).label).toBe(sharingCopy.status.public)
  })
})
