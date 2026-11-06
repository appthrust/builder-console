// Dev-only in-memory implementation of the console contract (`/api/console/*`)
// and of the slice of the Directory API the console uses: the same-origin proxy
// `/api/console/directory/*` and the public `/api/directory/v1/*` origin (avatars).
// `me.directoryPublicURL` is the request origin, so avatars load through Vite's
// `/api` proxy. Fixtures: a 3-level org, 4 people (+2 realm-only users), 6 apps
// bound to the platform mock's seeded stacks, and one redirect for a moved group
// (`sales/tokyo` → `sales/east`). Authorization mirrors the contract closely
// enough to exercise the UI; the real rules live in cmd/server.
// `POST /api/console/__mock/bare-500 {times?}` makes the next writes answer a
// bare gateway 500 (no JSON envelope), as during a console rollout.
// `POST /api/console/__mock/not-member {notMember?, teamSlug?}` denies Project
// access (default true); /me still answers with the non-member notice metadata.
// `POST /api/console/__mock/caller {personId, role?}` switches signed-in people
// (default role Viewer) for requester/approver stories; reset restores Yamada.
// `POST /api/console/__mock/role {role}` switches role and caller: Viewer uses
// Tanaka (who cannot open the private keihi app); Admin/Editor use Yamada.
// `POST /api/console/__mock/comments {state: 'empty' | 'many' | 'quota'}` replaces
// all comments: empty clears them, many seeds 120 on a-mitsumori (100 returned),
// quota seeds 200 there by the current caller so their next POST returns 429.
// `POST /api/console/__mock/reset` returns {reset: true} and reseeds all state,
// including environment-driven role, platform availability and project defaults.
// Screenshots live in memory: 見積作成 (3), 勤怠申請 (2) and 会議室予約 (1) start
// with generated 640×400 PNGs; uploads sniff PNG/JPEG/WebP like the server.
// Profile pictures too: 山田, 佐藤 and 田中 start with generated 96×96 PNGs (鈴木 has none).
// `POST /api/console/__mock/migration {pending?}` sets the release-N Directory
// migration banner state (default pending); `POST /admin/directory-migrate` clears it.
// `GET /apps/{id}/tools` (Built-in app Connect) answers per app: 見積作成 lists two tools,
// 日報 has none yet, 勤怠申請 waits for Tools to install, 会議室予約 cannot reach it,
// the rest have no Tools built-in app (panel hidden), and drafts answer as unbound apps. `POST
// /api/console/__mock/tools {appId, state: 'list' | 'empty' | 'pending' | 'unavailable' | 'absent'}` switches one app.
import type {
  AccessRequest,
  ApiError,
  AppComment,
  AppTool,
  AppTools,
  BusinessApp,
  DirectoryEntry,
  DirectoryMigration,
  DirectoryMigrationResult,
  DirectoryUser,
  Group,
  Me,
  MemberRole,
  Membership,
  Person,
  PersonProfile,
  PlatformSettings,
  Resolved,
  Screenshot,
  SharePolicy,
} from '../api/console'
import { isValidSlug } from '../api/console'
import { imageInfo, mockAvatarPng, mockScreenPng, type Rgb, type ScreenshotType } from './mock-images'

type Role = 'Admin' | 'Editor' | 'Viewer'
type StoredGroup = Omit<Group, 'path' | 'subgroupCount' | 'memberCount'>
type StoredApp = Omit<BusinessApp, 'group' | 'owners' | 'createdBy'> & { groupId: string; ownerIds: string[]; createdById: string }
type StoredComment = { comment: AppComment; deletedAt: string | null; deletedBy: string | null }
type StoredScreenshotFile = { appId: string; contentType: ScreenshotType; bytes: Uint8Array<ArrayBuffer> }
type StoredAvatar = { contentType: ScreenshotType; bytes: Uint8Array<ArrayBuffer> }
type ToolsState = 'list' | 'empty' | 'pending' | 'unavailable' | 'absent'
const TOOLS_STATES: readonly ToolsState[] = ['list', 'empty', 'pending', 'unavailable', 'absent']

const MAX_SCREENSHOTS = 5
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024

const T0 = Date.parse('2026-09-01T09:00:00Z')
const at = (days: number) => new Date(T0 + days * 86_400_000).toISOString()

const group = (id: string, parentId: string | null, name: string, slug: string, description = ''): StoredGroup => ({
  id,
  parentId,
  name,
  slug,
  description,
  about: '',
  aboutUpdatedBy: null,
  aboutUpdatedAt: null,
  createdAt: at(0),
  updatedAt: at(0),
})

const share = (scope: SharePolicy['scope'], groupIds: string[] = []): SharePolicy => ({ scope, groupIds, extraPersonIds: [] })
const app = (
  slug: string,
  displayName: string,
  groupId: string,
  owner: string,
  policy: SharePolicy,
  days: number,
  description: string,
  icon: string,
  tags: string[],
): StoredApp => ({
  id: `a-${slug}`,
  slug,
  displayName,
  description,
  icon,
  tags,
  guide: '',
  capabilities: [],
  screenshots: [],
  groupId,
  ownerIds: [owner],
  stackId: slug,
  appName: slug,
  share: policy,
  createdById: owner,
  createdAt: at(days),
  updatedAt: at(days + 1),
})

function seedConsole() {
  const people: Person[] = [
    { id: 'p-yamada', subject: 'sub-yamada', pending: false, email: 'yamada@example.com', displayName: '山田 太郎', avatarVersion: null },
    { id: 'p-sato', subject: 'sub-sato', pending: false, email: 'sato@example.com', displayName: '佐藤 花子', avatarVersion: null },
    { id: 'p-suzuki', subject: 'sub-suzuki', pending: false, email: 'suzuki@example.com', displayName: '鈴木 一郎', avatarVersion: null },
    { id: 'p-tanaka', subject: 'sub-tanaka', pending: false, email: 'tanaka@example.com', displayName: '田中 美咲', avatarVersion: null },
  ]
  const avatarFiles = new Map<string, StoredAvatar>()
  const seedAvatars: Record<string, Rgb> = { 'p-yamada': [13, 148, 136], 'p-sato': [219, 39, 119], 'p-tanaka': [79, 70, 229] }
  for (const entry of people) {
    const color = seedAvatars[entry.id]
    if (!color) continue
    avatarFiles.set(entry.id, { contentType: 'image/png', bytes: mockAvatarPng(color) })
    entry.avatarVersion = at(2)
  }
  const directoryOnly: DirectoryUser[] = [
    { id: 'd-takahashi', email: 'takahashi@example.com', displayName: '高橋 健' },
    { id: 'd-ito', email: 'ito@example.com', displayName: '伊藤 さくら' },
  ]
  const groups: StoredGroup[] = [
    group('g-sales', null, '営業本部', 'sales', '営業部門全体です。'),
    group('g-sales-east', 'g-sales', '営業1部', 'east'),
    {
      ...group('g-team-a', 'g-sales-east', '営業1課', 'team-a', '法人営業を担当しています。'),
      about: '# 営業1課について\n\n法人のお客さまへの提案を担当しています。\n\n- 見積書の作成\n- 商談の相談\n\n[窓口に連絡する](mailto:yamada@example.com)',
      aboutUpdatedBy: people[0],
      aboutUpdatedAt: at(35),
      updatedAt: at(35),
    },
    group('g-team-b', 'g-sales-east', '営業2課', 'team-b'),
    group('g-planning', 'g-sales', '営業企画部', 'planning'),
    group('g-soumu', null, '総務部', 'soumu'),
  ]
  /** Direct memberships: group id → person id → role. */
  const memberships = new Map<string, Map<string, MemberRole>>([
    ['g-sales', new Map([['p-sato', 'manager']])],
    ['g-team-a', new Map<string, MemberRole>([['p-yamada', 'member'], ['p-suzuki', 'member']])],
    ['g-planning', new Map([['p-sato', 'member']])],
    ['g-soumu', new Map([['p-tanaka', 'manager']])],
  ])
  const apps: StoredApp[] = [
    {
      ...app('mitsumori', '見積作成', 'g-team-a', 'p-yamada', share('group', ['g-team-a']), 3, '見積書を PDF で出します。', '📄', ['営業', '書類']),
      guide: '# 見積書を作る\n\n1. 「新しい見積」を押します。\n2. お客さまと品目を入力します。\n3. 内容を確認して PDF で保存します。\n\n## 困ったとき\n\n[担当者に相談する](mailto:yamada@example.com)',
      capabilities: ['見積書を PDF で出せる', '過去の見積を検索できる'],
    },
    app('nippo', '日報', 'g-team-a', 'p-suzuki', share('group', ['g-sales-east']), 5, '毎日の営業報告をまとめます。', '📝', ['営業']),
    app('keihi', '経費精算', 'g-team-a', 'p-yamada', share('private'), 20, '交通費と経費を申請します。', '💴', ['経理']),
    app('hikkoshi', '引っ越し見積', 'g-planning', 'p-sato', share('group', ['g-sales']), 30, '引っ越し案件の概算を出します。', '🚚', ['企画']),
    { ...app('kintai', '勤怠申請', 'g-soumu', 'p-tanaka', share('company'), 10, '休暇と残業を申請します。', '🕘', ['総務']), capabilities: ['休暇を申請できる', '残業の時間を記録できる', '上長が承認できる'] },
    app('kaigishitsu', '会議室予約', 'g-soumu', 'p-tanaka', share('public'), 25, '会議室の空きを確認して予約します。', '🏢', ['総務']),
  ]
  const screenshotFiles = new Map<string, StoredScreenshotFile>()
  const seedShots: Record<string, { accent: Rgb; captions: string[] }> = {
    'a-mitsumori': { accent: [13, 148, 136], captions: ['見積の一覧', '品目の入力', 'PDF の確認'] },
    'a-kintai': { accent: [79, 70, 229], captions: ['今月の勤怠', ''] },
    'a-kaigishitsu': { accent: [217, 119, 6], captions: ['空いている会議室'] },
  }
  for (const stored of apps) {
    const seed = seedShots[stored.id]
    if (!seed) continue
    stored.screenshots = seed.captions.map((caption, index): Screenshot => {
      const id = `shot-${stored.slug}-${index + 1}`
      screenshotFiles.set(id, { appId: stored.id, contentType: 'image/png', bytes: mockScreenPng(seed.accent, index) })
      return { id, caption, width: 640, height: 400 }
    })
  }
  const accessRequests: AccessRequest[] = [{
    id: 'aar-keihi-suzuki',
    appId: 'a-keihi',
    requester: people[2],
    message: '経費の確認で使います',
    status: 'pending',
    requestedAt: at(39),
    decidedAt: null,
    decidedBy: null,
  }]
  const comments: StoredComment[] = [
    {
      comment: { id: 'cmt-mitsumori-suzuki', appId: 'a-mitsumori', author: people[2], body: '前の見積を探せて助かりました。', createdAt: at(37) },
      deletedAt: null, deletedBy: null,
    },
    {
      comment: { id: 'cmt-mitsumori-yamada', appId: 'a-mitsumori', author: people[0], body: '分からないことがあれば、ここで聞いてください。', createdAt: at(38) },
      deletedAt: null, deletedBy: null,
    },
    {
      comment: { id: 'cmt-keihi-tanaka', appId: 'a-keihi', author: people[3], body: '総務でも使いたいです。相談できますか？', createdAt: at(39) },
      deletedAt: null, deletedBy: null,
    },
  ]
  return {
    callerId: 'p-yamada',
    role: (process.env.MOCK_ROLE as Role | undefined) ?? 'Admin',
    platformUnavailable: process.env.MOCK_PLATFORM_UNAVAILABLE === '1',
    notMember: false,
    teamSlug: 'commerce-team',
    projectId: process.env.MOCK_PROJECT_ID ?? 'commerce',
    people,
    directoryOnly,
    groups,
    memberships,
    /** Old path → id; consulted only when no current group/app owns the path. */
    groupRedirects: new Map<string, string>([['sales/tokyo', 'g-sales-east']]),
    appRedirects: new Map<string, string>(),
    /** The next writes answer a bare gateway 500 (no JSON). */
    bare500Writes: 0,
    apps,
    accessRequests,
    comments,
    /** App id → what `GET /apps/{id}/tools` answers; missing ids have no Tools built-in app. */
    tools: new Map<string, ToolsState>([['a-mitsumori', 'list'], ['a-nippo', 'empty'], ['a-kintai', 'pending'], ['a-kaigishitsu', 'unavailable']]),
    screenshotFiles,
    avatarFiles,
    migration: { pending: false, people: 0, groups: 0, memberships: 0 } as DirectoryMigration,
    /** Replayed on repeat calls, like the server. */
    migrationResult: undefined as DirectoryMigrationResult | undefined,
  }
}

let state = seedConsole()

// ---------- derived views ----------

function pathOf(groupId: string): string {
  const parts: string[] = []
  for (let current = state.groups.find((g) => g.id === groupId); current; current = state.groups.find((g) => g.id === current?.parentId)) {
    parts.unshift(current.slug)
  }
  return parts.join('/')
}

function subtree(groupId: string): Set<string> {
  const ids = new Set([groupId])
  for (let grew = true; grew; ) {
    grew = false
    for (const g of state.groups) {
      if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
        ids.add(g.id)
        grew = true
      }
    }
  }
  return ids
}

function ancestors(groupId: string): string[] {
  const ids: string[] = []
  for (let current = state.groups.find((g) => g.id === groupId)?.parentId; current; current = state.groups.find((g) => g.id === current)?.parentId) {
    ids.push(current)
  }
  return ids
}

function toGroup(stored: StoredGroup): Group {
  return {
    ...stored,
    path: pathOf(stored.id),
    subgroupCount: state.groups.filter((g) => g.parentId === stored.id).length,
    memberCount: membersOf(stored.id).length,
  }
}

const person = (id: string) => state.people.find((p) => p.id === id) as Person

/** Shared identity and owner data for the mock Platform API proxy. */
export const mockSubject = () => person(state.callerId).subject!
export const mockOwnerSubjects = (stackId: string): string[] =>
  (state.apps.find((app) => app.stackId === stackId)?.ownerIds ?? [])
    .flatMap((id) => person(id)?.subject ? [person(id).subject!] : [])

/** Direct rows plus rows inherited from ancestors: the strongest role wins, then the nearest source (Directory rule). */
function membersOf(groupId: string): Membership[] {
  const rows = new Map<string, Membership>()
  for (const [personId, memberRole] of state.memberships.get(groupId) ?? []) {
    rows.set(personId, { groupId, person: person(personId), role: memberRole, inheritedFrom: null })
  }
  for (const ancestorId of ancestors(groupId)) {
    for (const [personId, memberRole] of state.memberships.get(ancestorId) ?? []) {
      const existing = rows.get(personId)
      if (!existing || (existing.role === 'member' && memberRole === 'manager')) {
        rows.set(personId, { groupId, person: person(personId), role: memberRole, inheritedFrom: ancestorId })
      }
    }
  }
  return [...rows.values()]
}

/** Every group the person is a member of (direct + descendants), with the effective role. */
function personGroups(personId: string): Map<string, { role: MemberRole; inherited: boolean }> {
  const result = new Map<string, { role: MemberRole; inherited: boolean }>()
  for (const g of state.groups) {
    const row = membersOf(g.id).find((m) => m.person.id === personId)
    if (row) result.set(g.id, { role: row.role, inherited: row.inheritedFrom !== null })
  }
  return result
}

const isAdmin = () => state.role === 'Admin' && !state.platformUnavailable && !state.notMember
const canManage = (groupId: string) => isAdmin() || personGroups(state.callerId).get(groupId)?.role === 'manager'
const canEditApp = (stored: StoredApp) => stored.ownerIds.includes(state.callerId) || canManage(stored.groupId)

function visible(stored: StoredApp, personId = state.callerId): boolean {
  if ((personId === state.callerId && isAdmin()) || stored.ownerIds.includes(personId) || stored.share.extraPersonIds.includes(personId)) return true
  if (stored.share.scope === 'company' || stored.share.scope === 'public') return true
  if (stored.share.scope === 'private') return false
  const mine = personGroups(personId)
  return stored.share.groupIds.some((groupId) => [...subtree(groupId)].some((id) => mine.has(id)))
}

function toApp(stored: StoredApp): BusinessApp {
  const owner = state.groups.find((g) => g.id === stored.groupId) as StoredGroup
  const { groupId: _groupId, ownerIds, createdById, ...rest } = stored
  return {
    ...rest,
    group: { id: owner.id, path: pathOf(owner.id), name: owner.name },
    owners: ownerIds.map(person),
    createdBy: person(createdById),
  }
}

function toEntry(stored: StoredApp): DirectoryEntry {
  const app = toApp(stored)
  return {
    id: app.id,
    path: `${app.group.path}/${app.slug}`,
    displayName: app.displayName,
    description: app.description,
    icon: app.icon,
    tags: app.tags,
    capabilities: app.capabilities,
    screenshots: app.screenshots,
    group: app.group,
    owners: app.owners,
    appName: app.appName,
    stackId: app.stackId,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    canOpen: visible(stored),
  }
}

/** Origin of the request being served: the mock's Directory public URL (avatars load through Vite's `/api` proxy). */
let requestOrigin = ''

function me(): Me {
  const mine = personGroups(state.callerId)
  const caller = person(state.callerId)
  if (caller.subject === null) throw new Error('Mock caller must be signed in')
  return {
    person: { ...caller, subject: caller.subject },
    effectiveGroupIds: [...mine.keys()],
    managedGroupIds: [...mine].filter(([, row]) => row.role === 'manager').map(([groupId]) => groupId),
    isConsoleAdmin: isAdmin(),
    canCreateApps: !state.notMember && !state.platformUnavailable && (state.role === 'Admin' || state.role === 'Editor'),
    projectId: state.projectId,
    teamSlug: state.teamSlug,
    directoryPublicURL: requestOrigin,
    migration: state.migration,
    ...(state.notMember ? { notMember: true } : {}),
    ...(state.platformUnavailable ? { platformUnavailable: true } : {}),
  }
}

/** The Tools built-in app's public origin as the console server would read it from its link. */
const toolsOrigin = () => `https://tools.${state.projectId}.appthrust.test`

function mockTools(stored: StoredApp): AppTool[] {
  const tool = (slug: string, name: string, description: string, liveReleaseNumber: number): AppTool =>
    ({ slug, name, description, url: `${toolsOrigin()}/t/${slug}`, liveReleaseNumber })
  return [
    tool(`${stored.slug}-approvals`, `${stored.displayName}の承認`, '承認待ちの行を一覧して、承認・差し戻しをまとめて行います。', 3),
    tool(`${stored.slug}-search`, `${stored.displayName}の検索`, '', 1),
  ]
}

/** Mirrors the console server's mapping of the `tool-builder` link (console-tools.md §3). */
function appTools(stored: StoredApp): AppTools {
  // Unbound (a draft; the mock keeps its suggested appName until /bind): answered before the link is resolved.
  if (stored.stackId === null) return { available: true, tools: [] }
  const toolsState = state.tools.get(stored.id) ?? 'absent'
  if (toolsState === 'absent') return { available: false }
  if (toolsState === 'pending') return { available: false, pending: true }
  if (toolsState === 'unavailable') return { available: true, error: 'tools_unavailable', tools: [] }
  const tools = toolsState === 'list' ? mockTools(stored) : []
  return me().canCreateApps || isAdmin() ? { available: true, tools, editUrl: `${toolsOrigin()}/edit` } : { available: true, tools }
}

// ---------- resolve ----------

function findByPath(path: string): Resolved | undefined {
  const groupMatch = state.groups.find((g) => pathOf(g.id) === path)
  if (groupMatch) return { kind: 'group', id: groupMatch.id, currentPath: path }
  const slash = path.lastIndexOf('/')
  if (slash === -1) return undefined
  const parent = state.groups.find((g) => pathOf(g.id) === path.slice(0, slash))
  const appMatch = parent && state.apps.find((a) => a.groupId === parent.id && a.slug === path.slice(slash + 1))
  if (appMatch) return resolveApp(appMatch)
  return undefined
}

function resolveApp(stored: StoredApp): Resolved | undefined {
  const kind = visible(stored) ? 'app' : stored.stackId !== null ? 'entry' : undefined
  if (!kind) return undefined
  return { kind, id: stored.id, currentPath: `${pathOf(stored.groupId)}/${stored.slug}` }
}

function resolve(raw: string): Resolved | undefined {
  const path = raw.replace(/^\/+|\/+$/g, '')
  const direct = findByPath(path)
  if (direct) return direct
  const movedApp = state.appRedirects.get(path)
  const appHit = movedApp ? state.apps.find((a) => a.id === movedApp) : undefined
  if (appHit) return resolveApp(appHit)
  // Longest redirected group prefix, rewritten to the group's current path.
  const parts = path.split('/')
  for (let length = parts.length; length > 0; length--) {
    const target = state.groupRedirects.get(parts.slice(0, length).join('/'))
    if (!target || !state.groups.some((g) => g.id === target)) continue
    return findByPath([pathOf(target), ...parts.slice(length)].join('/'))
  }
  return undefined
}

// ---------- HTTP ----------

const json = (body: unknown, status = 200) => Response.json(body, { status })
const fail = (status: number, error: string, message: string) => json({ error, message } satisfies ApiError, status)
const notFound = () => fail(404, 'not_found', 'not found')
const forbidden = () => fail(403, 'forbidden', 'forbidden')

function slugify(displayName: string): string {
  const ascii = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
  return isValidSlug(ascii) ? ascii : `app-${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`
}

async function body<T>(request: Request): Promise<T> {
  return (await request.json()) as T
}

/**
 * The Directory API slice the console uses (`/api/directory/v1/<segments>`), reached
 * through the console proxy or the public origin. Groups and memberships are
 * read-only here: the Directory's own SPA manages them.
 */
async function directoryRoutes(request: Request, url: URL, segments: string[]): Promise<Response | undefined> {
  const method = request.method
  const [head, id, sub] = segments
  const q = (url.searchParams.get('q') ?? '').toLowerCase()
  const matches = (p: { email: string; displayName: string }) =>
    !q || p.email.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q)
  if (head === 'people' && !id && method === 'GET') {
    const ids = url.searchParams.has('ids') ? (url.searchParams.get('ids') ?? '').split(',') : undefined
    if (ids && (ids.length > 100 || ids.some((entry) => !entry.trim()))) return fail(400, 'invalid_request', 'ids must list 1 to 100 person IDs')
    const subject = url.searchParams.get('subject')
    return json({ items: state.people.filter((p) => matches(p) && (!ids || ids.includes(p.id)) && (!subject || p.subject === subject)) })
  }
  if (head === 'people' && !id && method === 'POST') {
    const input = await body<{ email: string; displayName: string }>(request)
    const email = input.email?.trim().toLowerCase() ?? ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !input.displayName?.trim()) return fail(400, 'invalid_request', 'A valid email and displayName are required')
    if (state.people.some((p) => p.email === email)) return fail(409, 'conflict', 'A person with this email already exists')
    const created: Person = { id: `p-${crypto.randomUUID().slice(0, 8)}`, subject: null, pending: true, email, displayName: input.displayName.trim(), avatarVersion: null }
    state.people.push(created)
    return json(created, 201)
  }
  if (head === 'people' && id && !sub && method === 'GET') {
    const found = state.people.find((p) => p.id === id)
    if (!found) return notFound()
    const memberships: PersonProfile['memberships'] = state.groups
      .filter((g) => state.memberships.get(g.id)?.has(found.id))
      .map((g) => ({ group: { id: g.id, path: pathOf(g.id), name: g.name }, role: state.memberships.get(g.id)?.get(found.id) ?? 'member', inheritedFrom: null }))
    return json({ person: found, memberships } satisfies PersonProfile)
  }
  if (head === 'people' && id && sub === 'avatar' && method === 'GET') {
    const file = state.avatarFiles.get(id)
    if (!file) return notFound()
    return new Response(file.bytes, {
      headers: { 'Content-Type': file.contentType, 'Content-Length': String(file.bytes.length), 'Cache-Control': 'private, max-age=86400' },
    })
  }
  if (head === 'directory-users' && !id && method === 'GET') {
    const known = state.people.map(({ id: personId, email, displayName }) => ({ id: personId, email, displayName }))
    const extra = state.directoryOnly.filter((d) => !state.people.some((p) => p.email === d.email))
    return json({ items: [...known, ...extra].filter(matches) })
  }
  if (head === 'groups' && !id && method === 'GET') return json({ items: state.groups.map(toGroup) })
  if (head === 'groups' && id && sub === 'members' && method === 'GET') {
    return state.groups.some((g) => g.id === id) ? json({ items: membersOf(id) }) : notFound()
  }
  return undefined
}

/** Handles `/api/console/*` and the public `/api/directory/v1/*`; returns undefined for anything else. */
export async function consoleRoutes(request: Request, url: URL): Promise<Response | undefined> {
  requestOrigin = url.origin
  if (url.pathname.startsWith('/api/directory/v1/')) {
    return directoryRoutes(request, url, url.pathname.slice('/api/directory/v1/'.length).split('/').filter(Boolean).map(decodeURIComponent))
  }
  if (!url.pathname.startsWith('/api/console/')) return undefined
  const segments = url.pathname.slice('/api/console/'.length).split('/').filter(Boolean).map(decodeURIComponent)
  const method = request.method
  const [head, id, sub, subId] = segments
  if (head === '__mock' && id === 'reset' && method === 'POST') {
    state = seedConsole()
    return json({ reset: true })
  }
  if (head === '__mock' && id === 'caller' && method === 'POST') {
    const input = await body<{ personId: string; role?: Role }>(request)
    if (!state.people.some((entry) => entry.id === input.personId && entry.subject)) return notFound()
    if (input.role && !['Admin', 'Editor', 'Viewer'].includes(input.role)) return fail(400, 'invalid_request', 'invalid role')
    state.callerId = input.personId
    state.role = input.role ?? 'Viewer'
    return json(me())
  }
  if (head === '__mock' && id === 'role' && method === 'POST') {
    const input = await body<{ role: Role }>(request)
    if (!['Admin', 'Editor', 'Viewer'].includes(input.role)) return fail(400, 'invalid_request', 'invalid role')
    state.role = input.role
    state.callerId = input.role === 'Viewer' ? 'p-tanaka' : 'p-yamada'
    return json(me())
  }
  if (head === '__mock' && id === 'comments' && method === 'POST') {
    const input = await body<{ state: 'empty' | 'many' | 'quota' }>(request)
    if (!['empty', 'many', 'quota'].includes(input.state)) return fail(400, 'invalid_request', 'invalid comments state')
    if (input.state !== 'empty' && !state.apps.some((app) => app.id === 'a-mitsumori' && app.stackId !== null)) return notFound()
    const count = input.state === 'quota' ? 200 : input.state === 'many' ? 120 : 0
    state.comments = Array.from({ length: count }, (_, index) => ({
      comment: {
        id: `cmt-${input.state}-${index + 1}`,
        appId: 'a-mitsumori',
        author: person(input.state === 'quota' ? state.callerId : index % 2 ? 'p-suzuki' : 'p-yamada'),
        body: `コメント ${index + 1}`,
        createdAt: new Date(T0 + 40 * 86_400_000 + index * 1000).toISOString(),
      },
      deletedAt: null,
      deletedBy: null,
    }))
    return json({ state: input.state, count })
  }
  if (head === '__mock' && id === 'tools' && method === 'POST') {
    const input = await body<{ appId: string; state: ToolsState }>(request)
    if (!TOOLS_STATES.includes(input.state)) return fail(400, 'invalid_request', 'invalid tools state')
    if (!state.apps.some((entry) => entry.id === input.appId)) return notFound()
    state.tools.set(input.appId, input.state)
    return json({ appId: input.appId, state: input.state })
  }
  if (head === '__mock' && id === 'not-member' && method === 'POST') {
    const input = await body<{ notMember?: boolean; teamSlug?: string }>(request)
    state.notMember = input.notMember ?? true
    state.teamSlug = input.teamSlug ?? state.teamSlug
    return json({ notMember: state.notMember, teamSlug: state.teamSlug })
  }
  // Old console drafts (stackId null): the abandoned 作りかけ row.
  if (head === '__mock' && id === 'app-draft' && method === 'POST') {
    const slug = 'draft-stopped'
    let draft = state.apps.find((item) => item.slug === slug)
    if (!draft) {
      draft = {
        ...app(slug, '備品予約', 'g-team-a', 'p-yamada', share('group', ['g-team-a']), 1, '備品の予約をまとめます。', '', ['予約']),
        stackId: null, appName: null, createdAt: new Date(Date.now() - 25 * 60_000).toISOString(),
      }
      state.apps.push(draft)
    }
    const record = toApp(draft)
    return json({ app: record, progress: { draft: record } })
  }

  if (head === '__mock' && id === 'bare-500' && method === 'POST') {
    const input = await body<{ times?: number }>(request).catch(() => ({ times: undefined }))
    state.bare500Writes = input.times ?? 1
    return json({ bare500Writes: state.bare500Writes })
  }
  if (head === '__mock' && id === 'migration' && method === 'POST') {
    const input = await body<{ pending?: boolean }>(request).catch(() => ({ pending: undefined }))
    const memberships = [...state.memberships.values()].reduce((total, rows) => total + rows.size, 0)
    state.migration = { pending: input.pending ?? true, people: state.people.length, groups: state.groups.length, memberships }
    state.migrationResult = undefined
    return json(state.migration)
  }
  if (method !== 'GET' && state.bare500Writes > 0) {
    // What the gateway answers while the console server rolls out: no contract envelope.
    state.bare500Writes--
    return new Response('upstream connect error or disconnect/reset before headers. reset reason: connection termination', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  if (head === 'me' && method === 'GET') return json(me())
  // The same-origin Directory proxy; the Directory does not gate reads on Project membership.
  if (head === 'directory') return directoryRoutes(request, url, segments.slice(1))
  const needsRoles = head === 'resolve' || head === 'apps' || head === 'admin' || (head === 'access-requests' && !id && method === 'GET')
  if (state.notMember && needsRoles) {
    return fail(403, 'not_project_member', state.teamSlug
      ? `This Project belongs to Team ${state.teamSlug}`
      : 'This Project belongs to a Team; ask its administrator to add you')
  }
  if (head === 'resolve' && method === 'GET') {
    const resolved = resolve(url.searchParams.get('path') ?? '')
    return resolved ? json(resolved) : notFound()
  }
  if (head === 'apps' && id && sub === 'directory-entry' && !subId && method === 'GET') {
    const stored = state.apps.find((app) => app.id === id)
    return stored && stored.stackId !== null ? json(toEntry(stored)) : notFound()
  }
  if (head === 'apps' && id && sub === 'tools' && !subId && method === 'GET') {
    const stored = state.apps.find((app) => app.id === id)
    return stored && visible(stored) ? json(appTools(stored)) : notFound()
  }
  if (head === 'admin' && id === 'directory-migrate' && method === 'POST') {
    if (!isAdmin()) return forbidden()
    const { people, groups, memberships } = state.migration
    state.migrationResult ??= { imported: { people, groups, memberships }, conflicts: [] }
    state.migration = { ...state.migration, pending: false }
    return json(state.migrationResult)
  }

  if (head === 'access-requests') {
    if (!id && method === 'GET') {
      if (url.searchParams.get('status') !== 'pending') return fail(400, 'invalid_request', 'status must be pending')
      const editable = new Set(state.apps.filter(canEditApp).map((entry) => entry.id))
      return json(state.accessRequests
        .filter((entry) => entry.status === 'pending' && editable.has(entry.appId))
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)))
    }
    if (id === 'mine' && method === 'GET') {
      const appName = url.searchParams.get('appName') ?? ''
      if (!isValidSlug(appName)) return fail(400, 'invalid_request', 'invalid appName')
      const stored = state.apps.find((entry) => entry.appName === appName)
      if (!stored) return json({ appName, exists: false })
      if (visible(stored)) return json({ appName, exists: true, state: 'granted' })
      let latest: AccessRequest | undefined
      for (let index = state.accessRequests.length - 1; index >= 0; index--) {
        const entry = state.accessRequests[index]
        if (entry.appId === stored.id && entry.requester.id === state.callerId) {
          latest = entry
          break
        }
      }
      if (latest && latest.status !== 'approved') {
        return json({ appName, exists: true, state: latest.status, requestedAt: latest.requestedAt, decidedAt: latest.decidedAt })
      }
      return json({ appName, exists: true, state: 'none' })
    }
    if (!id && method === 'POST') {
      const input = await body<{ appName: string; message: string }>(request)
      if (typeof input.appName !== 'string' || !isValidSlug(input.appName)) return fail(400, 'invalid_request', 'invalid appName')
      if (typeof input.message !== 'string' || [...input.message].length > 500) return fail(400, 'invalid_request', 'message must be at most 500 characters')
      const stored = state.apps.find((entry) => entry.appName === input.appName)
      if (!stored) return notFound()
      if (visible(stored)) return json({ state: 'granted' })
      const pending = state.accessRequests.filter((entry) => entry.requester.id === state.callerId && entry.status === 'pending')
      const existing = pending.find((entry) => entry.appId === stored.id)
      if (existing) return json({ state: 'pending', requestedAt: existing.requestedAt })
      if (pending.length >= 20) return fail(429, 'too_many_requests', 'Too many pending access requests')
      const created: AccessRequest = {
        id: `aar-${crypto.randomUUID()}`, appId: stored.id, requester: person(state.callerId),
        message: input.message, status: 'pending', requestedAt: new Date().toISOString(),
        decidedAt: null, decidedBy: null,
      }
      state.accessRequests.push(created)
      return json({ state: 'pending', requestedAt: created.requestedAt }, 201)
    }
    return undefined
  }

  if (head === 'apps') {
    if (!id) {
      if (method === 'GET') {
        const scope = url.searchParams.get('scope') ?? 'all'
        const groupId = url.searchParams.get('group')
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        const inGroup = groupId ? subtree(groupId) : undefined
        const ownerId = url.searchParams.get('ownerId')
        const rows = state.apps
          .filter((entry) => scope === 'directory' ? entry.stackId !== null : visible(entry))
          .filter((a) => scope !== 'mine' || a.ownerIds.includes(state.callerId))
          .filter((a) => scope !== 'company' || a.share.scope === 'company' || a.share.scope === 'public')
          .filter((a) => !inGroup || inGroup.has(a.groupId))
          .filter((a) => !ownerId || a.ownerIds.includes(ownerId))
          .filter(
            (a) =>
              !q ||
              [a.displayName, a.description, state.groups.find((group) => group.id === a.groupId)?.name ?? '', ...a.tags, ...a.capabilities].some((text) => text.toLowerCase().includes(q)),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        return json({ items: scope === 'directory' ? rows.map(toEntry) : rows.map(toApp) })
      }
      if (method === 'POST') {
        if (!me().canCreateApps) return forbidden()
        const input = await body<{
          displayName: string
          description?: string
          icon?: string
          tags?: string[]
          groupId: string
          slug?: string
          share?: SharePolicy
        }>(request)
        if (!input.displayName?.trim() || !state.groups.some((g) => g.id === input.groupId)) {
          return fail(400, 'invalid_request', 'displayName and an existing groupId are required')
        }
        const slug = input.slug ?? slugify(input.displayName)
        if (!isValidSlug(slug)) return fail(400, 'invalid_request', 'invalid slug')
        if (state.apps.some((a) => a.groupId === input.groupId && a.slug === slug)) return fail(409, 'slug_taken', `slug ${slug} is taken`)
        let appName = slug
        for (let n = 2; state.apps.some((a) => a.appName === appName); n++) appName = `${slug}-${n}`
        const now = new Date().toISOString()
        const created: StoredApp = {
          id: `a-${crypto.randomUUID().slice(0, 8)}`,
          slug,
          displayName: input.displayName.trim(),
          description: input.description ?? '',
          icon: input.icon ?? '',
          tags: input.tags ?? [],
          guide: '',
          capabilities: [],
          screenshots: [],
          groupId: input.groupId,
          ownerIds: [state.callerId],
          stackId: null,
          // The suggested label until /bind fixes it.
          appName,
          share: input.share ?? share('group', [input.groupId]),
          createdById: state.callerId,
          createdAt: now,
          updatedAt: now,
        }
        state.apps.push(created)
        return json(toApp(created), 201)
      }
      return undefined
    }
    if (id === 'by-path' && method === 'GET') {
      const rest = segments.slice(2)
      const parent = state.groups.find((g) => pathOf(g.id) === rest.slice(0, -1).join('/'))
      const hit = parent && state.apps.find((a) => a.groupId === parent.id && a.slug === rest.at(-1))
      return hit && visible(hit) ? json(toApp(hit)) : notFound()
    }
    const stored = state.apps.find((a) => a.id === id)
    if (sub === 'comments') {
      if (!stored || stored.stackId === null) return notFound()
      if (!subId && method === 'GET') {
        const comments = state.comments
          .filter((entry) => entry.comment.appId === stored.id && entry.deletedAt === null)
          .map((entry) => entry.comment)
          .reverse()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 100)
        return json(comments)
      }
      if (!subId && method === 'POST') {
        const input = await body<{ body: string }>(request)
        if (typeof input.body !== 'string') return fail(400, 'invalid_request', 'body must be between 1 and 1000 characters')
        const text = input.body.trim()
        if (!text || [...text].length > 1000) return fail(400, 'invalid_request', 'body must be between 1 and 1000 characters')
        const count = state.comments.filter((entry) => entry.comment.author.id === state.callerId && entry.deletedAt === null).length
        if (count >= 200) return fail(429, 'too_many_requests', 'Too many comments')
        const comment: AppComment = {
          id: `cmt-${crypto.randomUUID()}`, appId: stored.id, author: person(state.callerId),
          body: text, createdAt: new Date().toISOString(),
        }
        state.comments.push({ comment, deletedAt: null, deletedBy: null })
        return json(comment, 201)
      }
      if (subId && method === 'DELETE') {
        const entry = state.comments.find((entry) => entry.comment.id === subId && entry.comment.appId === stored.id && entry.deletedAt === null)
        if (!entry) return notFound()
        if (entry.comment.author.id !== state.callerId && !canEditApp(stored)) return forbidden()
        entry.deletedAt = new Date().toISOString()
        entry.deletedBy = state.callerId
        return new Response(null, { status: 204 })
      }
      return undefined
    }
    if (sub === 'screenshots') {
      if (!stored) return notFound()
      // Pictures are part of the directory face: any member may see them once the app is bound.
      if (subId && method === 'GET') {
        const file = state.screenshotFiles.get(subId)
        if (stored.stackId === null || !file || file.appId !== stored.id) return notFound()
        return new Response(file.bytes, {
          headers: { 'Content-Type': file.contentType, 'Content-Length': String(file.bytes.length), 'Cache-Control': 'private, max-age=86400' },
        })
      }
      if (!canEditApp(stored)) return visible(stored) ? forbidden() : notFound()
      if (!subId && method === 'POST') {
        const form = await request.formData().catch(() => undefined)
        const file = form?.get('file')
        if (!(file instanceof File)) return fail(400, 'invalid_request', 'file is required')
        if (file.size > MAX_SCREENSHOT_BYTES) return fail(400, 'invalid_request', 'file must be at most 2 MiB')
        const bytes = new Uint8Array(await file.arrayBuffer())
        const info = imageInfo(bytes)
        if (!info) return fail(400, 'invalid_request', 'file must be a PNG, JPEG or WebP image')
        const rawCaption = form?.get('caption') ?? ''
        const caption = typeof rawCaption === 'string' ? rawCaption.trim() : ''
        if ([...caption].length > 100) return fail(400, 'invalid_request', 'caption must be at most 100 characters')
        if (stored.screenshots.length >= MAX_SCREENSHOTS) return fail(409, 'conflict', 'At most 5 screenshots')
        const created: Screenshot = { id: `shot-${crypto.randomUUID()}`, caption, width: info.width, height: info.height }
        state.screenshotFiles.set(created.id, { appId: stored.id, contentType: info.contentType, bytes })
        stored.screenshots = [...stored.screenshots, created]
        return json(created, 201)
      }
      if (subId && method === 'DELETE') {
        if (!stored.screenshots.some((shot) => shot.id === subId)) return notFound()
        stored.screenshots = stored.screenshots.filter((shot) => shot.id !== subId)
        state.screenshotFiles.delete(subId)
        return new Response(null, { status: 204 })
      }
      if (!subId && method === 'PATCH') {
        const input = await body<{ order?: unknown }>(request)
        const current = new Map(stored.screenshots.map((shot) => [shot.id, shot]))
        const order: unknown[] = Array.isArray(input.order) ? input.order : []
        const picked = order.flatMap((sid) => (typeof sid === 'string' && current.has(sid) ? [current.get(sid)!] : []))
        if (!Array.isArray(input.order) || order.length !== current.size || picked.length !== order.length || new Set(picked).size !== picked.length) {
          return fail(400, 'invalid_request', 'order must be a permutation of the current screenshot ids')
        }
        stored.screenshots = picked
        return json(stored.screenshots)
      }
      return undefined
    }
    if (stored && sub === 'access-requests') {
      if (!canEditApp(stored)) return forbidden()
      if (!subId && method === 'GET') {
        const requests = state.accessRequests.filter((entry) => entry.appId === stored.id)
        const pending = requests.filter((entry) => entry.status === 'pending').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
        const previous = requests.filter((entry) => entry.status !== 'pending').reverse()
          .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')).slice(0, 20)
        return json([...pending, ...previous])
      }
      const decision = segments[4]
      if (subId && method === 'POST' && (decision === 'approve' || decision === 'decline')) {
        const entry = state.accessRequests.find((entry) => entry.id === subId && entry.appId === stored.id)
        if (!entry) return notFound()
        if (entry.status !== 'pending') return fail(409, 'conflict', 'Access request is already decided')
        const now = new Date().toISOString()
        // No await between the app write and the decision: both become visible together.
        if (decision === 'approve' && !visible(stored, entry.requester.id)) {
          stored.share.extraPersonIds.push(entry.requester.id)
          stored.updatedAt = now
        }
        entry.status = decision === 'approve' ? 'approved' : 'declined'
        entry.decidedAt = now
        entry.decidedBy = person(state.callerId)
        return json(decision === 'approve' ? { request: entry, app: toApp(stored) } : { request: entry })
      }
      return undefined
    }
    if (!stored || !visible(stored)) return notFound()
    const canEdit = canEditApp(stored)
    if (!sub && method === 'GET') return json(toApp(stored))
    if (!sub && method === 'PATCH') {
      if (!canEdit) return forbidden()
      const input = await body<Partial<Pick<StoredApp, 'displayName' | 'description' | 'icon' | 'tags' | 'groupId' | 'slug' | 'share' | 'guide' | 'capabilities'>> & { ownerIds?: string[] }>(request)
      if (input.guide !== undefined && (typeof input.guide !== 'string' || [...input.guide].length > 4000)) {
        return fail(400, 'invalid_request', 'guide must be at most 4000 characters')
      }
      if (input.capabilities !== undefined) {
        if (!Array.isArray(input.capabilities) || input.capabilities.length > 10 ||
          input.capabilities.some((value) => typeof value !== 'string' || !value.trim() || [...value.trim()].length > 60)) {
          return fail(400, 'invalid_request', 'capabilities must have at most 10 non-empty items of at most 60 characters')
        }
        input.capabilities = input.capabilities.map((value) => value.trim())
      }
      const oldPath = `${pathOf(stored.groupId)}/${stored.slug}`
      const nextGroup = input.groupId ?? stored.groupId
      const nextSlug = input.slug ?? stored.slug
      if (!state.groups.some((g) => g.id === nextGroup) || !isValidSlug(nextSlug)) return fail(400, 'invalid_request', 'invalid group or slug')
      if (state.apps.some((a) => a.id !== stored.id && a.groupId === nextGroup && a.slug === nextSlug)) return fail(409, 'slug_taken', 'slug taken')
      if (input.ownerIds && (input.ownerIds.length === 0 || input.ownerIds.some((ownerId) => !state.people.some((p) => p.id === ownerId)))) {
        return fail(400, 'invalid_request', 'owners must be known people')
      }
      if (input.share?.scope === 'public' && stored.share.scope !== 'public' && !me().isConsoleAdmin) return forbidden()
      const nextShare = input.share ?? stored.share
      if (nextShare.scope === 'group' && nextShare.groupIds.length === 0) return fail(400, 'invalid_request', 'share.groupIds must include at least one group')
      if (nextShare.extraPersonIds.some((id) => (input.ownerIds ?? stored.ownerIds).includes(id))) return fail(400, 'invalid_request', 'A person cannot be both an owner and an extra viewer')
      Object.assign(stored, {
        ...Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== undefined && key !== 'ownerIds')),
        ...(input.ownerIds ? { ownerIds: input.ownerIds } : {}),
        updatedAt: new Date().toISOString(),
      })
      const newPath = `${pathOf(stored.groupId)}/${stored.slug}`
      if (newPath !== oldPath) state.appRedirects.set(oldPath, stored.id)
      return json(toApp(stored))
    }
    if (!sub && method === 'DELETE') {
      if (!canEdit) return forbidden()
      state.apps.splice(state.apps.indexOf(stored), 1)
      state.accessRequests = state.accessRequests.filter((entry) => entry.appId !== stored.id)
      state.comments = state.comments.filter((entry) => entry.comment.appId !== stored.id)
      for (const shot of stored.screenshots) state.screenshotFiles.delete(shot.id)
      return new Response(null, { status: 204 })
    }
    if (sub === 'bind' && method === 'POST') {
      if (!canEdit) return forbidden()
      if (stored.stackId) return fail(409, 'already_bound', 'already bound')
      const input = await body<{ stackId: string; appName: string }>(request)
      Object.assign(stored, { stackId: input.stackId, appName: input.appName, updatedAt: new Date().toISOString() })
      return json(toApp(stored))
    }
    return undefined
  }

  if (head === 'admin' && id === 'platform' && method === 'GET') {
    return json({
      projectId: state.projectId,
      teamSlug: 'commerce-team',
      github: { connected: true, connectionId: 'github-source-207cb7ce' },
      registry: { connected: true, connectionId: 'registry-ghcr' },
      defaultTemplateId: 'nextjs-postgres',
    } satisfies PlatformSettings)
  }
  return undefined
}
