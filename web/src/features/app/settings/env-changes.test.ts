import { describe, expect, test } from 'bun:test'
import { configOf } from '../../../api/testing/app-domain'
import { hasUnsupportedEntry, pendingRows, rebaseChanges, stageAdd, stageEdit, stageRemove, unstage, variablesToSave, type EnvChanges } from './env-changes'

const entries = configOf({ revision: 'r1', variables: [
  { key: 'APP_TITLE', state: 'configured', source: 'user', sensitive: false, value: 'mitsumori' },
  { key: 'API_TOKEN', state: 'configured', source: 'user', sensitive: true },
  { key: 'DATABASE_URL', state: 'generated', source: 'generated', sensitive: true },
] }).variables

describe('pending env changes', () => {
  test('nothing staged saves the user-owned list unchanged (secrets without their value)', () => {
    expect(variablesToSave(entries, {})).toEqual([
      { key: 'APP_TITLE', value: 'mitsumori', sensitive: false },
      { key: 'API_TOKEN', sensitive: true },
    ])
    expect(pendingRows(entries, {})).toEqual(entries)
  })

  test('add, edit and remove are staged, marked, and saved as one full list', () => {
    let changes: EnvChanges = {}
    changes = stageAdd(entries, changes, 'FEATURE_FLAG', 'on', false)
    changes = stageEdit(entries, changes, 'APP_TITLE', 'mitsumori-v2')
    changes = stageRemove(changes, 'API_TOKEN')
    expect(pendingRows(entries, changes).map((row) => [row.key, row.change, row.value])).toEqual([
      ['APP_TITLE', 'edited', 'mitsumori-v2'],
      ['API_TOKEN', 'removed', undefined],
      ['DATABASE_URL', undefined, undefined],
      ['FEATURE_FLAG', 'added', 'on'],
    ])
    expect(variablesToSave(entries, changes)).toEqual([
      { key: 'APP_TITLE', value: 'mitsumori-v2', sensitive: false },
      { key: 'FEATURE_FLAG', value: 'on', sensitive: false },
    ])
  })

  test('editing an unsaved addition keeps it an addition; removing it drops it', () => {
    const added = stageAdd(entries, {}, 'FEATURE_FLAG', 'on', false)
    expect(stageEdit(entries, added, 'FEATURE_FLAG', 'off')).toEqual({ FEATURE_FLAG: { kind: 'added', value: 'off', sensitive: false } })
    expect(stageRemove(added, 'FEATURE_FLAG')).toEqual({})
  })

  test('setting a plain value back to the saved one is no change; a secret edit always is', () => {
    const edited = stageEdit(entries, {}, 'APP_TITLE', 'other')
    expect(stageEdit(entries, edited, 'APP_TITLE', 'mitsumori')).toEqual({})
    expect(stageEdit(entries, {}, 'API_TOKEN', 'new-secret')).toEqual({ API_TOKEN: { kind: 'edited', value: 'new-secret', sensitive: true } })
    expect(variablesToSave(entries, stageEdit(entries, {}, 'API_TOKEN', 'new-secret'))).toContainEqual({ key: 'API_TOKEN', value: 'new-secret', sensitive: true })
  })

  test('re-adding a key removed before saving replaces its value; undo restores the saved row', () => {
    const removed = stageRemove({}, 'APP_TITLE')
    expect(stageAdd(entries, removed, 'APP_TITLE', 'again', true)).toEqual({ APP_TITLE: { kind: 'edited', value: 'again', sensitive: true } })
    expect(unstage(removed, 'APP_TITLE')).toEqual({})
  })
})

describe('entries this console does not know', () => {
  const future = configOf({ revision: 'r2', variables: [
    { key: 'APP_TITLE', state: 'configured', source: 'user', sensitive: false, value: 'mitsumori' },
    { key: 'MANAGED_BY_POLICY', state: 'configured', source: 'policy', sensitive: false, value: 'x' },
  ] }).variables

  test('an unknown source is never the user\'s own: not edited and not saved', () => {
    expect(variablesToSave(future, {})).toEqual([{ key: 'APP_TITLE', value: 'mitsumori', sensitive: false }])
    expect(stageEdit(future, {}, 'MANAGED_BY_POLICY', 'y')).toEqual({})
  })

  test('saving the full user-owned list is not offered while any entry is unknown', () => {
    expect(hasUnsupportedEntry(entries)).toBe(false)
    expect(hasUnsupportedEntry(future)).toBe(true)
    expect(hasUnsupportedEntry(configOf({ revision: 'r3', variables: [{ key: 'A', state: 'rotating', source: 'user', sensitive: true }] }).variables)).toBe(true)
  })
})

describe('staged changes after a save whose answer could not be read', () => {
  const saved = (variables: unknown[]) => configOf({ revision: 'r4', variables: [
    { key: 'APP_TITLE', state: 'configured', source: 'user', sensitive: false, value: 'mitsumori' },
    { key: 'DATABASE_URL', state: 'generated', source: 'generated', sensitive: true },
    ...variables,
  ] }).variables

  test('an addition the read-back shows saved is not shown or sent twice', () => {
    const changes = stageAdd(entries, {}, 'FEATURE_FLAG', 'on', false)
    const after = saved([{ key: 'FEATURE_FLAG', state: 'configured', source: 'user', sensitive: false, value: 'on' }])
    expect(rebaseChanges(after, changes)).toEqual({})
    expect(pendingRows(after, rebaseChanges(after, changes)).filter((row) => row.key === 'FEATURE_FLAG')).toHaveLength(1)
    expect(variablesToSave(after, rebaseChanges(after, changes)).filter((item) => item.key === 'FEATURE_FLAG')).toEqual([{ key: 'FEATURE_FLAG', value: 'on', sensitive: false }])
  })

  test('an addition saved with another value becomes an edit of it; one the user does not own is dropped', () => {
    const changes = stageAdd(entries, stageAdd(entries, {}, 'FEATURE_FLAG', 'on', false), 'DATABASE_HOST', 'x', false)
    const after = saved([
      { key: 'FEATURE_FLAG', state: 'configured', source: 'user', sensitive: false, value: 'off' },
      { key: 'DATABASE_HOST', state: 'generated', source: 'generated', sensitive: true },
    ])
    expect(rebaseChanges(after, changes)).toEqual({ FEATURE_FLAG: { kind: 'edited', value: 'on', sensitive: false } })
    expect(rebaseChanges(entries, changes)).toBe(changes)
  })
})
