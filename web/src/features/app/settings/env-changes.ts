// Pending 設定値 changes: the section stages adds, edits and removals and
// saves them with one PUT of the full user-owned list, like every other
// settings section saves on 保存.
import type { EnvVariable } from '../../../api/queries/app'
import { isOneOf } from '../../../model/contracts/build'
import type { EnvVariableEntry } from '../../../model/contracts/app'

type Entry = EnvVariableEntry
export type { EnvVariable }

export type EnvChange =
  | { kind: 'added'; value: string; sensitive: boolean }
  | { kind: 'edited'; value: string; sensitive: boolean }
  | { kind: 'removed' }

/** Staged changes by key, in the order they were made. */
export type EnvChanges = Readonly<Record<string, EnvChange>>

/** A table row: the saved entry with its staged change applied. */
export type EnvRow = Entry & { change?: EnvChange['kind'] }

/** Whether the entry is the user's own; a source this console does not know is not. */
export const isUserOwned = (entry: Pick<Entry, 'source'>) => isOneOf(entry.source, 'user')

/**
 * Saving PUTs the full user-owned list, so an entry whose source or state this
 * console does not know could be dropped or overwritten: no save is offered then.
 */
export const hasUnsupportedEntry = (entries: readonly Entry[]) => entries.some((entry) => entry.source.kind === 'unknown' || entry.state.kind === 'unknown')

const userOwned = (entries: readonly Entry[]) => entries.filter(isUserOwned)

/** Saved rows with their staged edit or removal, then the staged additions. */
export function pendingRows(entries: readonly Entry[], changes: EnvChanges): EnvRow[] {
  const rows: EnvRow[] = entries.map((entry) => {
    const change = changes[entry.key]
    if (!change || !isUserOwned(entry)) return entry
    if (change.kind !== 'edited') return { ...entry, change: change.kind }
    return { ...entry, change: 'edited', sensitive: change.sensitive, value: change.sensitive ? undefined : change.value }
  })
  for (const [key, change] of Object.entries(changes)) {
    if (change.kind !== 'added') continue
    rows.push({ key, state: { kind: 'known', value: 'configured' }, source: { kind: 'known', value: 'user' }, sensitive: change.sensitive, value: change.sensitive ? undefined : change.value, change: 'added' })
  }
  return rows
}

/** The full user-owned list to PUT: unchanged values retained (secrets without their value), edits applied, removals left out. */
export function variablesToSave(entries: readonly Entry[], changes: EnvChanges): EnvVariable[] {
  const saved = userOwned(entries).flatMap((entry): EnvVariable[] => {
    const change = changes[entry.key]
    if (change?.kind === 'removed') return []
    if (change?.kind === 'edited') return [{ key: entry.key, value: change.value, sensitive: change.sensitive }]
    return [{ key: entry.key, sensitive: entry.sensitive, ...(!entry.sensitive && entry.value !== undefined ? { value: entry.value } : {}) }]
  })
  const added = Object.entries(changes).flatMap(([key, change]): EnvVariable[] =>
    change.kind === 'added' ? [{ key, value: change.value, sensitive: change.sensitive }] : []
  )
  return [...saved, ...added]
}

/** 追加: a new key; re-adding a key removed before saving replaces its value instead. */
export function stageAdd(entries: readonly Entry[], changes: EnvChanges, key: string, value: string, sensitive: boolean): EnvChanges {
  const existing = userOwned(entries).some((entry) => entry.key === key)
  return { ...changes, [key]: existing ? { kind: 'edited', value, sensitive } : { kind: 'added', value, sensitive } }
}

/** 値を変える: an addition keeps being an addition; setting a plain value back to the saved one drops the change. */
export function stageEdit(entries: readonly Entry[], changes: EnvChanges, key: string, value: string): EnvChanges {
  const change = changes[key]
  if (change?.kind === 'added') return { ...changes, [key]: { ...change, value } }
  const entry = userOwned(entries).find((item) => item.key === key)
  if (!entry) return changes
  const sensitive = change?.kind === 'edited' ? change.sensitive : entry.sensitive
  if (!sensitive && !entry.sensitive && entry.value === value) return unstage(changes, key)
  return { ...changes, [key]: { kind: 'edited', value, sensitive } }
}

/** 削除: an unsaved addition simply disappears; a saved value is marked for removal. */
export function stageRemove(changes: EnvChanges, key: string): EnvChanges {
  if (changes[key]?.kind === 'added') return unstage(changes, key)
  return { ...changes, [key]: { kind: 'removed' } }
}

/** 戻す: drop one staged change. */
export function unstage(changes: EnvChanges, key: string): EnvChanges {
  return Object.fromEntries(Object.entries(changes).filter(([staged]) => staged !== key))
}
