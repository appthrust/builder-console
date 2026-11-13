// Console domain values that arrive through the response boundary
// (api/contracts/console/*), and the pure operations on them. Feature code
// reads these types, never the wire.

/** A Directory person. `avatarVersion`: null without a profile picture, else when it last changed (the image URL's cache-buster). */
export type Person = { id: string; subject: string | null; pending: boolean; email: string; displayName: string; avatarVersion: string | null }

/**
 * A person the console server can no longer resolve (removed from the
 * Directory). Only the id is known: no name, email or contact is invented.
 */
export type UnknownPerson = { unknown: true; id: string }

/** A person reference from the console server: resolved, or explicitly unknown. */
export type PersonRef = Person | UnknownPerson

export function isUnknownPerson(person: PersonRef): person is UnknownPerson {
  return 'unknown' in person
}

/** A Directory group (`GET groups`). */
export type Group = {
  id: string
  parentId: string | null
  name: string
  slug: string
  /** Ancestor slugs joined by "/". */
  path: string
  description: string
  about: string
  aboutUpdatedBy: Person | null
  aboutUpdatedAt: string | null
  subgroupCount: number
  memberCount: number
  createdAt: string
  updatedAt: string
}
export interface AppComment {
  id: string
  appId: string
  author: PersonRef
  body: string
  createdAt: string
}
/** Counts of console-held people, groups and memberships still to push into the Directory (release N only). */
export type DirectoryMigration = { pending: boolean; people: number; groups: number; memberships: number }
export type Me = {
  person: Person & { subject: string }
  /** Groups the caller belongs to: direct memberships plus their descendants (Directory `/me`). */
  effectiveGroupIds: string[]
  /** Groups the caller manages, direct and inherited; their managers edit the group's apps. */
  managedGroupIds: string[]
  isConsoleAdmin: boolean
  canCreateApps: boolean
  projectId: string
  /** True when the Platform API role lookup failed; canCreateApps and isConsoleAdmin are then false. */
  platformUnavailable?: boolean
  /** The Project rejected this account; this is not a Platform outage. */
  notMember?: boolean
  /** Owning Team of the Project; absent since access is resolved from Project IAM. */
  teamSlug?: string
  /** Public origin of the Directory built-in app (profiles, group management, avatars); empty when not linked. */
  directoryPublicURL: string
  migration: DirectoryMigration
}

/** `GET /config` from cmd/server; `dashboardUrl` is the Dashboard's Team settings page (only an absolute http(s) URL is kept). */
export interface ConsoleConfig {
  projectId: string
  dashboardUrl?: string
}

/** Group tree built from the flat `GET /groups` list, siblings sorted by name. */
export type GroupNode = Group & { children: GroupNode[]; depth: number }

export function buildGroupTree(groups: Group[]): GroupNode[] {
  const nodes = new Map<string, GroupNode>()
  for (const group of groups) nodes.set(group.id, { ...group, children: [], depth: 0 })
  const roots: GroupNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (list: GroupNode[], depth: number) => {
    list.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    for (const node of list) {
      node.depth = depth
      sort(node.children, depth + 1)
    }
  }
  sort(roots, 0)
  return roots
}

/** Depth-first order of a group tree (select options, admin tree). */
export function flattenGroupTree(nodes: GroupNode[]): GroupNode[] {
  return nodes.flatMap((node) => [node, ...flattenGroupTree(node.children)])
}

/** Ids of `groupId` and every descendant. */
export function subtreeIds(groups: Group[], groupId: string): Set<string> {
  const ids = new Set([groupId])
  let grew = true
  while (grew) {
    grew = false
    for (const group of groups) {
      if (group.parentId && ids.has(group.parentId) && !ids.has(group.id)) {
        ids.add(group.id)
        grew = true
      }
    }
  }
  return ids
}

/** Ancestors of a group path, root first: "a/b/c" → ["a", "a/b", "a/b/c"]. */
export function pathPrefixes(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** Console admins and managers of the group (direct or inherited; `Me.managedGroupIds` already carries both). */
export function canManageGroup(me: Pick<Me, 'isConsoleAdmin' | 'managedGroupIds'>, groupId: string): boolean {
  return me.isConsoleAdmin || me.managedGroupIds.includes(groupId)
}

/**
 * The caller's membership roots: effective groups whose parent is not effective.
 * `effectiveGroupIds` is direct memberships plus descendants, so these are the
 * direct memberships (a direct membership below another one folds into it).
 */
export function membershipRoots(me: Pick<Me, 'effectiveGroupIds'>, groups: readonly Group[]): Group[] {
  const effective = new Set(me.effectiveGroupIds)
  return groups.filter((group) => effective.has(group.id) && !(group.parentId && effective.has(group.parentId)))
}

export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
export const RESERVED_SLUGS: Record<string, true> = { mine: true, company: true, new: true, help: true, logout: true, api: true, oauth2: true, '-': true }

export function isValidSlug(slug: string): boolean {
  return slug.length <= 63 && SLUG_PATTERN.test(slug) && !Object.hasOwn(RESERVED_SLUGS, slug)
}
