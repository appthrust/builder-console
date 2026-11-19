import { z } from 'zod'
import * as wire from './schema/schemas'
import { openEnum, openUnion, selectVariant } from '../../boundary'
import type { AccessRequest, AppPermissions, AppTools, BusinessApp, Contribution, CreatedAccessRequest, DirectoryEntry, DirectoryMigrationResult, InboxServerItem, Membership, MyAccessRequest, PersonProfile, PlatformSettings, Resolved, Screenshot } from '../../../model/contracts/console'
import { NO_APP_PERMISSIONS } from '../../../model/contracts/console'
import { personReader, personRefReader } from './person'

export const screenshotReader: z.ZodType<Screenshot> = wire.screenshot.strip()
const shareReader = wire.share.strip().extend({ scope: openEnum(wire.shareScopes) })
const appGroupReader = wire.appGroup
const contributionReader: z.ZodType<Contribution> = wire.contribution.strip().extend({ scope: openEnum(wire.contributionScopes) })
// The caller's grants fail closed without failing the app: a set that is absent,
// null, partial or not the five known booleans reads as no grant at all (never a
// partial one); unknown extra keys are dropped. The writer schema stays strict.
const permissionsReader: z.ZodType<AppPermissions> = z.unknown().optional().transform((value) => {
  const known = wire.permissions.strip().safeParse(value)
  return known.success ? known.data : { ...NO_APP_PERMISSIONS }
})
export const appReader: z.ZodType<BusinessApp> = wire.app.strip().extend({
  group: appGroupReader, screenshots: z.array(screenshotReader), owners: z.array(personRefReader), createdBy: personRefReader, share: shareReader,
  contribution: contributionReader, permissions: permissionsReader,
})
export const entryReader: z.ZodType<DirectoryEntry> = wire.directoryEntry.strip().extend({
  group: appGroupReader, screenshots: z.array(screenshotReader), owners: z.array(personRefReader), contribution: contributionReader, permissions: permissionsReader,
})
const inboxItem = wire.inbox.shape.items.element
// A kind this build cannot render is not work it can route to; drop it rather than miscount.
export const inboxReader: z.ZodType<InboxServerItem[]> = z.object({
  items: z.array(inboxItem.strip().extend({ kind: openEnum(wire.inboxKinds), app: inboxItem.shape.app.strip() })),
}).transform(({ items }) => items.flatMap(({ kind, ...item }) => kind.kind === 'known' ? [{ ...item, kind: kind.value }] : []))
const memberRole = openEnum(wire.memberRoles)
export const membershipReader: z.ZodType<Membership> = wire.membership.extend({ person: personReader, role: memberRole })
export const profileReader: z.ZodType<PersonProfile> = wire.personProfile.extend({
  person: personReader,
  memberships: z.array(wire.personProfile.shape.memberships.element.extend({ role: memberRole })),
})
export const migrationReader: z.ZodType<DirectoryMigrationResult> = wire.migrationResult.extend({ imported: wire.migrationCounts.strip() })
export const accessRequestReader: z.ZodType<AccessRequest> = wire.accessRequest.strip().extend({
  requester: personRefReader, decidedBy: personRefReader.nullable(), status: openEnum(wire.requestStatuses),
})
const absentRequest = wire.myAccessRequest.options[0].strip()
const existingRequest = wire.myAccessRequest.options[1].strip().extend({ state: openEnum(wire.requestStates) })
export const myAccessRequestReader: z.ZodType<MyAccessRequest> = selectVariant([absentRequest, existingRequest], (input) =>
  typeof input === 'object' && input !== null && 'exists' in input && input.exists === false ? absentRequest : existingRequest,
)
export const createdAccessRequestReader: z.ZodType<CreatedAccessRequest> = openUnion({
  discriminator: 'state', identity: z.object({}),
  variants: { granted: wire.createAccessRequest.options[0].strip(), pending: wire.createAccessRequest.options[1].strip() },
})
export const resolvedReader: z.ZodType<Resolved> = openUnion({
  discriminator: 'kind', identity: wire.resolved.pick({ id: true, currentPath: true }).strip(),
  variants: {
    group: wire.resolved.strip().extend({ kind: z.literal('group') }),
    app: wire.resolved.strip().extend({ kind: z.literal('app') }),
    entry: wire.resolved.strip().extend({ kind: z.literal('entry') }),
  },
})
const unavailableTools = wire.tools.options[0].strip()
const availableTools = wire.tools.options[1].strip().extend({ error: openEnum(['tools_unavailable']).optional() })
export const toolsReader: z.ZodType<AppTools> = selectVariant([unavailableTools, availableTools], (input) =>
  typeof input === 'object' && input !== null && 'available' in input && input.available === false ? unavailableTools : availableTools,
)
export const settingsReader: z.ZodType<PlatformSettings> = wire.settings.strip().extend({ github: wire.settings.shape.github.strip(), registry: wire.settings.shape.registry.strip() })
