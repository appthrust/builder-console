import { copy } from '../copy'
import { isUnknownPerson, type DirectoryEntry, type Group, type Person, type PersonRef } from './contracts/console'
import type { AppView } from './app'

/** Directory candidates reuse the existing view's draft and initial-publication gates. */
export function isFinished(view: AppView): boolean {
  return !view.draft && view.build === undefined && view.status !== 'deploying'
}

type StoreFields = Pick<DirectoryEntry, 'screenshots' | 'capabilities'> & { guide?: string }

/**
 * How well an app introduces itself: screenshots weigh most, then
 * capabilities, then a guide. Directory entries carry no guide, so for them
 * the guide term is always 0; a BusinessApp counts it.
 */
export function storeScore(entry: StoreFields): number {
  return (entry.screenshots.length > 0 ? 4 : 0) + (entry.capabilities.length > 0 ? 2 : 0) + (entry.guide ? 1 : 0)
}

/** Store order: best-introduced first, then by Japanese name. Returns a new array. */
export function storeOrder<T extends StoreFields & { displayName: string }>(entries: readonly T[]): T[] {
  return entries
    .map((entry) => ({ entry, score: storeScore(entry) }))
    .sort((a, b) => b.score - a.score || a.entry.displayName.localeCompare(b.entry.displayName, 'ja'))
    .map(({ entry }) => entry)
}

/** A person's name; a person the server can no longer resolve is named as unknown (never with invented details). */
export function personName(person: PersonRef): string {
  return isUnknownPerson(person) ? copy.common.unknownPerson : person.displayName
}

/** The resolved people among `refs`: the only ones with a name, address or page. */
export function resolvedPeople(refs: readonly PersonRef[]): Person[] {
  return refs.filter((person): person is Person => !isUnknownPerson(person))
}

export interface Maker {
  person: Person
  appCount: number
}

/** Everyone (resolved) who owns at least one of `entries`, most apps first, then by Japanese name. */
export function makersOf(entries: readonly Pick<DirectoryEntry, 'owners'>[]): Maker[] {
  const byId = new Map<string, Maker>()
  for (const entry of entries) {
    for (const person of resolvedPeople(entry.owners)) {
      const maker = byId.get(person.id)
      if (maker) maker.appCount += 1
      else byId.set(person.id, { person, appCount: 1 })
    }
  }
  return [...byId.values()].sort((a, b) => b.appCount - a.appCount || a.person.displayName.localeCompare(b.person.displayName, 'ja'))
}

export interface DirectoryGroupCard {
  group: Group
  children: Group[]
  moreChildren: number
  apps: DirectoryEntry[]
  appCount: number
  /** The caller enriches this from its own unfinished apps, which directory entries do not include. */
  myDrafts: number
}

/** Top-level departments, with finished apps counted across each department's subtree; representatives in store order. */
export function groupDirectory(
  groups: readonly Group[],
  entries: readonly DirectoryEntry[],
  finished: (entry: DirectoryEntry) => boolean,
  opts: { maxChildren?: number; maxApps?: number } = {},
): DirectoryGroupCard[] {
  const { maxChildren = 5, maxApps = 3 } = opts
  const finishedEntries = storeOrder(entries.filter(finished))
  return groups
    .filter((group) => group.parentId === null)
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    .map((group) => {
      const children = groups.filter((child) => child.parentId === group.id).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
      const prefix = `${group.path}/`
      const apps = finishedEntries.filter((entry) => entry.group.path === group.path || entry.group.path.startsWith(prefix))
      const shownChildren = children.slice(0, maxChildren)
      return {
        group,
        children: shownChildren,
        moreChildren: children.length - shownChildren.length,
        apps: apps.slice(0, maxApps),
        appCount: apps.length,
        myDrafts: 0,
      }
    })
}
