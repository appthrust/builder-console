// Console operations that have no response contract yet (W1/W5 move each one
// to api/contracts/console/* and the gateway, then delete it here; the file
// goes away with the last one). Every body below passes through the single
// unchecked cast `unverified()`: nothing here is validated, so feature code
// importing this module is a tracked boundary violation
// (api/testing/response-boundary-allowlist.json) that may only shrink.
import { consoleTransport, type ConsoleBody, type ConsoleTransport } from './console'
import type { Person } from '../model/contracts/console'

/** Owner-uploaded app screen; the bytes are served at `screenshotUrl(appId, id)`. */
export interface Screenshot { id: string; caption: string; width: number; height: number }
/** Directory profile (`GET people/{id}`): direct memberships only. */
export interface PersonProfile {
  person: Person
  memberships: { group: { id: string; path: string; name: string }; role: MemberRole; inheritedFrom: string | null }[]
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
/** `POST /admin/directory-migrate`: the Directory import result, replayed on repeat calls. */
export type DirectoryMigrationResult = {
  imported: { people: number; groups: number; memberships: number }
  conflicts: Array<{ entity: string; id: string; reason: string }>
}
export type Resolved = { kind: 'group' | 'app' | 'entry'; id: string; currentPath: string }
/** A realm account from the Directory's `directory-users` search; not a Person until registered. */
export type DirectoryUser = { id: string; email: string; displayName: string }
export type PlatformSettings = {
  projectId: string
  teamSlug?: string | null
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

export type AppListParams = { scope?: AppScope; groupId?: string; q?: string }
export interface DirectoryAppsParams { groupId?: string; q?: string; ownerId?: string }

export interface ConsoleApi {
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

/** The one unchecked cast of a Console success body; no contract exists yet for these operations. */
function unverified<T>(body: ConsoleBody): T {
  if (body.kind === 'invalid') throw new Error('Console response is not JSON')
  return (body.kind === 'json' ? body.value : undefined) as T
}

export function createConsoleApi(transport: ConsoleTransport = consoleTransport): ConsoleApi {
  // A FormData body goes out as multipart; the browser sets the boundary itself.
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
    unverified<T>((await transport.send({ method, path: `/api/console${path}`, body })).body)
  const q = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
    const text = search.toString()
    return text ? `?${text}` : ''
  }
  const id = encodeURIComponent
  const list = async <T>(path: string) => (await call<{ items: T[] }>('GET', path)).items


  return {
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
      members: (groupId: string) => list<Membership>(`/directory/groups/${id(groupId)}/members`),
      users: (query: string) => list<DirectoryUser>(`/directory/directory-users${q({ q: query })}`),
    },
    screenshots: {
      upload: (appId: string, file: File, caption?: string) => {
        const form = new FormData()
        form.set('file', file)
        if (caption) form.set('caption', caption)
        return call<Screenshot>('POST', `/apps/${id(appId)}/screenshots`, form)
      },
      remove: (appId: string, screenshotId: string) => call<void>('DELETE', `/apps/${id(appId)}/screenshots/${id(screenshotId)}`),
      reorder: (appId: string, order: string[]) => call<Screenshot[]>('PATCH', `/apps/${id(appId)}/screenshots`, { order }),
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
