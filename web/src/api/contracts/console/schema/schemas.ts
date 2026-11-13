import { z } from 'zod'
import { buildSchemas } from './build-sessions'

// The writer owns total collections. Readers may not turn missing grants into
// empty grants. Directory proxy shapes are pinned to appserver-go v0.5.0;
// unrelated upstream fields (e.g. profile talent) are not Console vocabulary.
const id = z.string().min(1)
const text = z.string()
const count = z.number().int().nonnegative()
const total = <T extends z.ZodType>(item: T) => z.array(item).meta({ presence: 'total' })
const observed = <T extends z.ZodType>(value: T) => value.optional().meta({ presence: 'optionalObservation' })

export const shareScopes = ['private', 'group', 'company', 'public'] as const
export const memberRoles = ['member', 'manager'] as const
export const requestStatuses = ['pending', 'approved', 'declined'] as const
export const requestStates = ['none', 'granted', 'pending', 'declined'] as const

export const person = z.object({ id, subject: text.nullable(), pending: z.boolean(), email: text, displayName: text, avatarVersion: text.nullable() })
export const unknownPerson = z.strictObject({ id, displayName: z.literal(''), unknown: z.literal(true) })
export const personRef = z.union([person.strict(), unknownPerson])
export const appGroup = z.object({ id, path: text, name: text })
export const screenshot = z.strictObject({ id, caption: text, width: count, height: count })
export const share = z.strictObject({ scope: z.enum(shareScopes), groupIds: total(id), extraPersonIds: total(id) })
export const app = z.strictObject({
  id, slug: text, displayName: text, description: text, icon: text, tags: total(text), guide: text,
  capabilities: total(text), screenshots: total(screenshot), group: appGroup.strict(), owners: total(personRef),
  stackId: text.nullable(), appName: text.nullable(), share, createdBy: personRef, createdAt: text, updatedAt: text,
})
export const directoryEntry = app.omit({ slug: true, guide: true, share: true, createdBy: true }).extend({ path: text, canOpen: z.boolean() })
export const group = z.object({
  id, parentId: id.nullable(), name: text, slug: text, path: text, description: text, about: text,
  aboutUpdatedBy: person.nullable(), aboutUpdatedAt: text.nullable(), subgroupCount: count, memberCount: count, createdAt: text, updatedAt: text,
})
export const membership = z.object({ groupId: id, person, role: z.enum(memberRoles), inheritedFrom: id.nullable() })
export const personProfile = z.object({ person, memberships: total(z.object({ group: appGroup, role: membership.shape.role, inheritedFrom: id.nullable() })) })
export const directoryUser = z.object({ id, email: text, displayName: text })
export const migrationCounts = z.strictObject({ people: count, groups: count, memberships: count })
export const migrationResult = z.object({
  imported: migrationCounts,
  conflicts: total(z.object({ entity: text, id, reason: text })),
  merged: total(z.object({ id, replaced: id })),
})
export const me = z.strictObject({
  person: person.strict().extend({ subject: id }), effectiveGroupIds: total(id), managedGroupIds: total(id),
  isConsoleAdmin: z.boolean(), canCreateApps: z.boolean(), projectId: id,
  platformUnavailable: observed(z.boolean()), notMember: observed(z.boolean()), teamSlug: observed(text),
  directoryPublicURL: text, migration: migrationCounts.extend({ pending: z.boolean() }),
})
export const config = z.strictObject({ projectId: text.max(63).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/), dashboardUrl: observed(text) })
export const comment = z.strictObject({ id, appId: id, author: personRef, body: text, createdAt: text })
export const accessRequest = z.strictObject({
  id, appId: id, requester: personRef, message: text, status: z.enum(requestStatuses),
  requestedAt: text, decidedAt: text.nullable(), decidedBy: personRef.nullable(),
})
export const myAccessRequest = z.union([
  z.strictObject({ appName: text, exists: z.literal(false) }),
  z.strictObject({ appName: text, exists: z.literal(true), state: z.enum(requestStates), requestedAt: observed(text), decidedAt: observed(text) }),
])
export const createAccessRequest = z.union([
  z.strictObject({ state: z.literal('granted') }),
  z.strictObject({ state: z.literal('pending'), requestedAt: text }),
])
export const tool = z.object({ slug: text, name: text, description: text, url: text, liveReleaseNumber: count })
export const tools = z.union([
  z.strictObject({ available: z.literal(false), pending: observed(z.boolean()) }),
  z.strictObject({ available: z.literal(true), tools: total(tool), editUrl: observed(text), error: observed(z.literal('tools_unavailable')) }),
])
export const resolved = z.strictObject({ kind: z.enum(['group', 'app', 'entry']), id, currentPath: text })
export const settings = z.strictObject({
  projectId: id, teamSlug: observed(text.nullable()), github: z.strictObject({ connected: z.boolean(), connectionId: text.nullable() }),
  registry: z.strictObject({ connected: z.boolean(), connectionId: text.nullable() }), defaultTemplateId: text,
})
// Details are JSON, not authority or diagnostics. Transport deliberately drops
// them from client errors; their keys must never become schema paths.
export const error = z.object({ error: text, message: text, details: observed(z.json()) })
const list = <T extends z.ZodType>(item: T) => z.object({ items: total(item) })
export const schemas = {
  ...buildSchemas,
  Person: person, UnknownPerson: unknownPerson, PersonRef: personRef, AppGroup: appGroup, SharePolicy: share, Screenshot: screenshot,
  App: app, AppList: list(app), DirectoryEntry: directoryEntry, DirectoryEntryList: list(directoryEntry),
  GroupList: list(group), PersonList: list(person), PersonProfile: personProfile,
  MembershipList: list(membership), DirectoryUserList: list(directoryUser), MigrationResult: migrationResult,
  Me: me, Config: config, Comment: comment, CommentList: total(comment), ScreenshotList: total(screenshot),
  AccessRequestList: total(accessRequest), MyAccessRequest: myAccessRequest, CreateAccessRequest: createAccessRequest,
  ApproveAccessRequest: z.strictObject({ request: accessRequest, app }), DeclineAccessRequest: z.strictObject({ request: accessRequest }),
  Tools: tools, Resolved: resolved, Settings: settings, Error: error,
}
export type SchemaName = keyof typeof schemas
