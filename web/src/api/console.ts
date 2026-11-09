// Console API (`/api/console/*`, served by cmd/server): business-app
// metadata, share policy, access requests and comments. People, groups and
// memberships belong to the Directory built-in app; the console server proxies its API
// same-origin under `/api/console/directory/*` (→ `/api/directory/v1/*`). Same-origin
// JSON; the OIDC edge attaches Authorization, the SPA never sees a token.
import { copy } from '../copy'
import { assertSessionActive, checkSessionResponse } from './session-expiry'

/** A Directory person. `avatarVersion`: null without a profile picture, else when it last changed (the image URL's cache-buster). */
export type Person = { id: string; subject: string | null; pending: boolean; email: string; displayName: string; avatarVersion: string | null }
/** Owner-uploaded app screen; the bytes are served at `screenshotUrl(appId, id)`. */
export interface Screenshot { id: string; caption: string; width: number; height: number }
/** Directory profile (`GET people/{id}`): direct memberships only. */
export interface PersonProfile {
  person: Person
  memberships: { group: { id: string; path: string; name: string }; role: MemberRole; inheritedFrom: string | null }[]
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
export type MemberRole = 'member' | 'manager'
/** `inheritedFrom` = group id when inherited. */
export type Membership = { groupId: string; person: Person; role: MemberRole; inheritedFrom: string | null }
export type ShareScope = 'private' | 'group' | 'company' | 'public'
export type SharePolicy = { scope: ShareScope; groupIds: string[]; extraPersonIds: string[] }
export type BusinessApp = {
  id: string
  slug: string
  displayName: string
  description: string
  icon: string
  tags: string[]
  guide: string
  capabilities: string[]
  /** Ordered by position; never null. */
  screenshots: Screenshot[]
  group: { id: string; path: string; name: string }
  owners: Person[]
  /** Platform binding; null while draft. */
  stackId: string | null
  appName: string | null
  share: SharePolicy
  createdBy: Person
  createdAt: string
  updatedAt: string
}
export interface DirectoryEntry {
  id: string
  path: string
  displayName: string
  description: string
  icon: string
  tags: string[]
  capabilities: string[]
  screenshots: Screenshot[]
  group: BusinessApp['group']
  owners: Person[]
  appName: string | null
  stackId: string | null
  createdAt: string
  updatedAt: string
  canOpen: boolean
}
export interface AppComment {
  id: string
  appId: string
  author: Person
  body: string
  createdAt: string
}
export type AccessRequestStatus = 'pending' | 'approved' | 'declined'
export type AccessRequest = {
  id: string
  appId: string
  requester: Person
  message: string
  status: AccessRequestStatus
  requestedAt: string
  decidedAt: string | null
  decidedBy: Person | null
}
export type MyAccessRequest = {
  appName: string
  exists: boolean
  state?: 'none' | 'granted' | 'pending' | 'declined'
  requestedAt?: string | null
  decidedAt?: string | null
}
/** Counts of console-held people, groups and memberships still to push into the Directory (release N only). */
export type DirectoryMigration = { pending: boolean; people: number; groups: number; memberships: number }
/** `POST /admin/directory-migrate`: the Directory import result, replayed on repeat calls. */
export type DirectoryMigrationResult = {
  imported: { people: number; groups: number; memberships: number }
  conflicts: Array<{ entity: string; id: string; reason: string }>
}
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
  /** Owning Team from the latest successful Project read; empty until one succeeds. */
  teamSlug: string
  /** Public origin of the Directory built-in app (profiles, group management, avatars); empty when not linked. */
  directoryPublicURL: string
  migration: DirectoryMigration
}
/** `error` is a stable snake_case code. */
export type ApiError = { error: string; message: string; details?: unknown }
export type Resolved = { kind: 'group' | 'app' | 'entry'; id: string; currentPath: string }
/** A realm account from the Directory's `directory-users` search; not a Person until registered. */
export type DirectoryUser = { id: string; email: string; displayName: string }
export type PlatformSettings = {
  projectId: string
  teamSlug: string | null
  github: { connected: boolean; connectionId: string | null }
  registry: { connected: boolean; connectionId: string | null }
  defaultTemplateId: string
}
export type AppScope = 'mine' | 'company' | 'all'
/** A tool published by the Tools built-in app whose data comes from this app; `url` opens it on the Tools origin. */
export type AppTool = { slug: string; name: string; description: string; url: string; liveReleaseNumber: number }
/**
 * `GET /apps/{id}/tools` (Built-in app Connect, console-tools.md §3): `available` false when the Tools built-in app is not
 * installed (`pending` while it installs); `error: 'tools_unavailable'` when it is installed but did not answer.
 * `editUrl` (where a tool is made) is present only for people who may create tools.
 */
export type AppTools =
  | { available: false; pending?: boolean }
  | { available: true; tools: AppTool[]; editUrl?: string; error?: 'tools_unavailable' }

export type CreateAppInput = {
  displayName: string
  description?: string
  icon?: string
  tags?: string[]
  groupId: string
  slug?: string
  share?: SharePolicy
}
export type UpdateAppInput = {
  displayName?: string
  description?: string
  icon?: string
  tags?: string[]
  guide?: string
  capabilities?: string[]
  groupId?: string
  slug?: string
  share?: SharePolicy
  ownerIds?: string[]
}

/**
 * Non-2xx console response. `code` is the contract's stable snake_case error.
 * `transient` = no contract envelope came back: a 5xx from a proxy or gateway
 * in front of the console server (e.g. during a rollout), or no response at
 * all. Retrying shortly is the fix, so the message says exactly that.
 */
export class ConsoleApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  readonly transient: boolean

  constructor(status: number, body: Partial<ApiError> | undefined) {
    const code = typeof body?.error === 'string' ? body.error : undefined
    const transient = code === undefined && (status === 0 || status >= 500)
    super(transient ? copy.errors.transient : body?.message || `console api ${status}`)
    this.name = 'ConsoleApiError'
    this.status = status
    this.code = code ?? (status === 404 ? 'not_found' : 'unknown')
    this.details = body?.details
    this.transient = transient
  }
}

export function isConsoleError(error: unknown, code?: string): error is ConsoleApiError {
  return error instanceof ConsoleApiError && (code === undefined || error.code === code)
}

const READ_TIMEOUT_MS = 8_000

type Fetcher = (input: string, init: RequestInit) => Promise<Response>
export type AppListParams = { scope?: AppScope; groupId?: string; q?: string }
export interface DirectoryAppsParams { groupId?: string; q?: string; ownerId?: string }

export interface ConsoleApi {
  me(): Promise<Me>
  /** Follows the redirect table; bound apps resolve as entries when they cannot be opened. */
  resolve(path: string): Promise<Resolved>
  apps: {
    list(params?: AppListParams): Promise<BusinessApp[]>
    get(appId: string): Promise<BusinessApp>
    byPath(groupPath: string, slug: string): Promise<BusinessApp>
    create(input: CreateAppInput): Promise<BusinessApp>
    update(appId: string, input: UpdateAppInput): Promise<BusinessApp>
    /** 409 `already_bound`. */
    bind(appId: string, input: { stackId: string; appName: string }): Promise<BusinessApp>
    remove(appId: string): Promise<void>
    /** The app catalog: every bound app, with `canOpen` for the caller. */
    directory(params?: DirectoryAppsParams): Promise<DirectoryEntry[]>
    directoryEntry(appId: string): Promise<DirectoryEntry>
    /** Tools published by the Tools built-in app, built on this app, that the caller may use. */
    tools(appId: string): Promise<AppTools>
  }
  /** The Directory built-in app through the console's same-origin proxy (`/api/console/directory/*`). */
  directory: {
    /** Registered people matching a name or email. */
    searchPeople(query: string): Promise<Person[]>
    /** Exact subject lookup, including people who do not own a visible app. */
    personBySubject(subject: string): Promise<Person | undefined>
    /** Batch lookup (no call for an empty list); unknown ids are absent from the answer. */
    people(ids: string[]): Promise<Person[]>
    /** 404 for an unknown person. */
    person(personId: string): Promise<PersonProfile>
    /** Pre-registers a person by email; 409 when the email is known. */
    createPerson(input: { email: string; displayName: string }): Promise<Person>
    groups(): Promise<Group[]>
    /** Direct + inherited members (read-only here; management lives in the Directory). */
    members(groupId: string): Promise<Membership[]>
    /** Realm accounts matching a name or email. */
    users(query: string): Promise<DirectoryUser[]>
  }
  screenshots: {
    /** 400 `invalid_request` (type, size, decode, caption); 409 `conflict` at 5 screenshots. */
    upload(appId: string, file: File, caption?: string): Promise<Screenshot>
    remove(appId: string, screenshotId: string): Promise<void>
    /** `order` must be a permutation of the current ids. */
    reorder(appId: string, order: string[]): Promise<Screenshot[]>
  }
  comments: {
    list(appId: string): Promise<AppComment[]>
    post(appId: string, body: string): Promise<AppComment>
    remove(appId: string, commentId: string): Promise<void>
  }
  accessRequests: {
    mine(appName: string): Promise<MyAccessRequest>
    create(input: { appName: string; message: string }): Promise<{ state: 'granted' | 'pending'; requestedAt?: string }>
    pending(): Promise<AccessRequest[]>
    ofApp(appId: string): Promise<AccessRequest[]>
    approve(appId: string, requestId: string): Promise<{ request: AccessRequest; app: BusinessApp }>
    decline(appId: string, requestId: string): Promise<{ request: AccessRequest }>
  }
  admin: {
    platform(): Promise<PlatformSettings>
    /** Console admin only; pushes the console's people, groups and memberships into the Directory (release N only). */
    directoryMigrate(): Promise<DirectoryMigrationResult>
  }
}

export function createConsoleApi(fetcher: Fetcher = (input, init) => fetch(input, init)): ConsoleApi {
  async function send<T>(method: string, path: string, body: BodyInit | undefined, contentType: string | undefined): Promise<T> {
    assertSessionActive()
    const read = method === 'GET'
    let response: Response
    try {
      response = await fetcher(`/api/console${path}`, {
        method,
        headers: contentType === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': contentType },
        body,
        credentials: 'same-origin',
        redirect: 'manual',
        signal: read ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined,
      })
    } catch {
      // Network failure or read timeout: nothing answered (status 0).
      throw new ConsoleApiError(0, undefined)
    }
    checkSessionResponse(response)
    if (!response.ok) {
      let parsed: Partial<ApiError> | undefined
      try {
        parsed = (await response.json()) as Partial<ApiError>
      } catch {
        parsed = undefined
      }
      throw new ConsoleApiError(response.status, parsed)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
  const call = <T>(method: string, path: string, body?: unknown) =>
    send<T>(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json')
  // The browser sets the multipart boundary itself, so no Content-Type here.
  const callForm = <T>(method: string, path: string, form: FormData) => send<T>(method, path, form, undefined)
  const q = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
    const text = search.toString()
    return text ? `?${text}` : ''
  }
  const id = encodeURIComponent
  const list = async <T>(path: string) => (await call<{ items: T[] }>('GET', path)).items

  return {
    me: () => call<Me>('GET', '/me'),
    resolve: (path: string) => call<Resolved>('GET', `/resolve${q({ path })}`),
    apps: {
      list: (params: AppListParams = {}) =>
        list<BusinessApp>(`/apps${q({ scope: params.scope, group: params.groupId, q: params.q })}`),
      get: (appId: string) => call<BusinessApp>('GET', `/apps/${id(appId)}`),
      byPath: (groupPath: string, slug: string) =>
        call<BusinessApp>('GET', `/apps/by-path/${groupPath.split('/').filter(Boolean).map(id).join('/')}/${id(slug)}`),
      create: (input: CreateAppInput) => call<BusinessApp>('POST', '/apps', input),
      update: (appId: string, input: UpdateAppInput) => call<BusinessApp>('PATCH', `/apps/${id(appId)}`, input),
      bind: (appId: string, input: { stackId: string; appName: string }) =>
        call<BusinessApp>('POST', `/apps/${id(appId)}/bind`, input),
      remove: (appId: string) => call<void>('DELETE', `/apps/${id(appId)}`),
      directory: (params: DirectoryAppsParams = {}) =>
        list<DirectoryEntry>(`/apps${q({ scope: 'directory', group: params.groupId, q: params.q, ownerId: params.ownerId })}`),
      directoryEntry: (appId: string) => call<DirectoryEntry>('GET', `/apps/${id(appId)}/directory-entry`),
      tools: (appId: string) => call<AppTools>('GET', `/apps/${id(appId)}/tools`),
    },
    directory: {
      searchPeople: (query: string) => list<Person>(`/directory/people${q({ q: query })}`),
      personBySubject: async (subject: string) => (await list<Person>(`/directory/people${q({ subject })}`))[0],
      people: async (ids: string[]) => {
        // The Directory answers at most 100 ids per call.
        const batches: string[][] = []
        for (let start = 0; start < ids.length; start += 100) batches.push(ids.slice(start, start + 100))
        const pages = await Promise.all(batches.map((batch) => list<Person>(`/directory/people${q({ ids: batch.join(',') })}`)))
        return pages.flat()
      },
      person: (personId: string) => call<PersonProfile>('GET', `/directory/people/${id(personId)}`),
      createPerson: (input: { email: string; displayName: string }) => call<Person>('POST', '/directory/people', input),
      groups: () => list<Group>('/directory/groups'),
      members: (groupId: string) => list<Membership>(`/directory/groups/${id(groupId)}/members`),
      users: (query: string) => list<DirectoryUser>(`/directory/directory-users${q({ q: query })}`),
    },
    screenshots: {
      upload: (appId: string, file: File, caption?: string) => {
        const form = new FormData()
        form.set('file', file)
        if (caption) form.set('caption', caption)
        return callForm<Screenshot>('POST', `/apps/${id(appId)}/screenshots`, form)
      },
      remove: (appId: string, screenshotId: string) => call<void>('DELETE', `/apps/${id(appId)}/screenshots/${id(screenshotId)}`),
      reorder: (appId: string, order: string[]) => call<Screenshot[]>('PATCH', `/apps/${id(appId)}/screenshots`, { order }),
    },
    comments: {
      list: (appId: string) => call<AppComment[]>('GET', `/apps/${id(appId)}/comments`),
      post: (appId: string, body: string) => call<AppComment>('POST', `/apps/${id(appId)}/comments`, { body }),
      remove: (appId: string, commentId: string) => call<void>('DELETE', `/apps/${id(appId)}/comments/${id(commentId)}`),
    },
    accessRequests: {
      mine: (appName: string) => call<MyAccessRequest>('GET', `/access-requests/mine${q({ appName })}`),
      create: (input: { appName: string; message: string }) =>
        call<{ state: 'granted' | 'pending'; requestedAt?: string }>('POST', '/access-requests', input),
      pending: () => call<AccessRequest[]>('GET', '/access-requests?status=pending'),
      ofApp: (appId: string) => call<AccessRequest[]>('GET', `/apps/${id(appId)}/access-requests`),
      approve: (appId: string, requestId: string) =>
        call<{ request: AccessRequest; app: BusinessApp }>('POST', `/apps/${id(appId)}/access-requests/${id(requestId)}/approve`),
      decline: (appId: string, requestId: string) =>
        call<{ request: AccessRequest }>('POST', `/apps/${id(appId)}/access-requests/${id(requestId)}/decline`),
    },
    admin: {
      platform: () => call<PlatformSettings>('GET', '/admin/platform'),
      directoryMigrate: () => call<DirectoryMigrationResult>('POST', '/admin/directory-migrate'),
    },
  }
}

export const consoleApi = createConsoleApi()

export const screenshotUrl = (appId: string, screenshotId: string) =>
  `/api/console/apps/${encodeURIComponent(appId)}/screenshots/${encodeURIComponent(screenshotId)}`

/** Directory public URLs; `base` is `Me.directoryPublicURL` (no trailing slash needed). */
const directoryBase = (base: string) => base.replace(/\/+$/, '')

/** A person's profile picture, served by the Directory; `version` is `Person.avatarVersion`, so a new picture gets a new URL. */
export const avatarUrl = (base: string, personId: string, version: string) =>
  `${directoryBase(base)}/api/directory/v1/people/${encodeURIComponent(personId)}/avatar?v=${encodeURIComponent(version)}`

export const directoryLinks = {
  person: (base: string, personId: string) => `${directoryBase(base)}/people/${encodeURIComponent(personId)}`,
  /** The signed-in person's own page (name, picture). */
  you: (base: string) => `${directoryBase(base)}/people/me`,
  groups: (base: string) => `${directoryBase(base)}/groups`,
  group: (base: string, groupId: string) => `${directoryBase(base)}/groups/${encodeURIComponent(groupId)}`,
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

export const consoleKeys = {
  me: ['console', 'me'] as const,
  groups: ['console', 'directory', 'groups'] as const,
  members: (groupId: string) => ['console', 'directory', 'groups', groupId, 'members'] as const,
  apps: (params: AppListParams) => ['console', 'apps', params] as const,
  app: (appId: string) => ['console', 'app', appId] as const,
  directoryApps: (params: DirectoryAppsParams) => ['console', 'directory-apps', params] as const,
  directoryEntry: (appId: string) => ['console', 'directory-entry', appId] as const,
  appTools: (appId: string) => ['console', 'app-tools', appId] as const,
  comments: (appId: string) => ['console', 'comments', appId] as const,
  person: (personId: string) => ['console', 'directory', 'people', personId] as const,
  people: (ids: readonly string[]) => ['console', 'directory', 'people', 'ids', ids] as const,
  peopleSearch: (query: string) => ['console', 'directory', 'people', 'search', query] as const,
  accessRequestMine: (appName: string) => ['console', 'access-requests', 'mine', appName] as const,
  accessRequestsPending: ['console', 'access-requests', 'pending'] as const,
  accessRequestsOfApp: (appId: string) => ['console', 'access-requests', 'app', appId] as const,
  resolve: (path: string) => ['console', 'resolve', path] as const,
  directoryUsers: (query: string) => ['console', 'directory', 'users', query] as const,
  platform: ['console', 'admin', 'platform'] as const,
}
