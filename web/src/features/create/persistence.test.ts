import { describe, expect, test } from 'bun:test'
import type { BusinessApp } from '../../api/console-unverified'
import { initialValues } from './form'
import { clearCreateSession, readCreateSession, restoreCreateDraft, saveCreateSession, type CreateSession } from './persistence'

const person = { id: 'p1', subject: 's1', pending: false, displayName: '山田', email: 'yamada@example.test', avatarVersion: null }
const draft: BusinessApp = {
  id: 'app-draft', slug: 'stock', displayName: '在庫管理', description: '備品の在庫', icon: '', tags: ['備品'], guide: '', capabilities: [], screenshots: [],
  group: { id: 'sales', path: 'sales', name: '営業部' }, owners: [person], createdBy: person,
  stackId: null, appName: 'stock', share: { scope: 'group', groupIds: ['sales'], extraPersonIds: [] },
  createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
}
function storage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
}
const session: CreateSession = {
  version: 1, step: 'confirm', values: { ...initialValues('sales'), entry: 'template', templateId: 'biz-inventory-postgres', displayName: '在庫管理', description: '備品の在庫', urlName: 'stock' },
  seed: { template: 'biz-inventory-postgres', intent: '備品を数えたい' },
  progress: { draft, sourceRepositoryId: 'stock-src', sourceRepositoryOrigin: { kind: 'template', appName: 'stock' } }, phase: 'platform', failure: { message: '一時的な問題' },
}

describe('create session', () => {
  test('answers, current step, phase and resource ids survive a JSON storage round trip', () => {
    const target = storage()
    saveCreateSession(session, target)
    expect(readCreateSession(draft.id, target)).toEqual(session)
    expect(readCreateSession(undefined, target)).toEqual(session)
    clearCreateSession(draft.id, target)
    expect(readCreateSession(draft.id, target)).toBeUndefined()
    expect(readCreateSession(undefined, target)).toBeUndefined()
  })
  test('a new attempt saves under new before a console draft exists', () => {
    const target = storage()
    const fresh: CreateSession = { ...session, step: 'details', progress: {} }
    saveCreateSession(fresh, target)
    expect(readCreateSession(undefined, target)).toEqual(fresh)
  })
  test('malformed, incompatible or inaccessible storage does not block creation', () => {
    const target = storage()
    for (const raw of ['{broken', '{"version":2}', '{"version":1,"values":{}}']) {
      target.setItem('builder-console:create:new', raw)
      expect(readCreateSession(undefined, target)).toBeUndefined()
    }
    expect(readCreateSession(undefined, { getItem() { throw new Error('denied') } })).toBeUndefined()
  })
  test('resume restores server name, description, group and share while retaining source progress', () => {
    const changed = { ...draft, displayName: '営業の在庫', description: '営業で使う備品', group: { id: 'team', path: 'sales/team', name: '営業1課' }, share: { scope: 'private' as const, groupIds: [], extraPersonIds: [] } }
    const restored = restoreCreateDraft(changed, { ...session, step: 'share' })
    expect(restored.step).toBe('confirm')
    expect(restored.values).toMatchObject({ displayName: changed.displayName, description: changed.description, groupId: 'team', scope: 'private', shareGroupIds: [] })
    expect(restored.progress).toEqual({ ...session.progress, draft: changed })
    expect(restored.phase).toBeUndefined()
  })
  test('without stored origin, the draft is kept and the user chooses how to finish it', () => {
    const restored = restoreCreateDraft(draft)
    expect(restored.step).toBe('start')
    expect(restored.progress.draft?.id).toBe(draft.id)
    expect(restored.values.displayName).toBe(draft.displayName)
  })
})
