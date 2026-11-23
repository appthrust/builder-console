import { z } from 'zod'

const id = z.string().min(1)
const personRef = z.object({ sourceUID: id, personID: id })
const binding = z.object({
  name: id, role: id, subjects: z.array(z.object({ kind: z.string(), name: z.string().optional(), issuer: z.string().optional(), subject: z.string().optional() })),
  organizationPersonRefs: z.array(personRef).optional(), organizationGroupSourceRef: z.object({ sourceUID: id }).optional(),
  managedFor: z.string().optional(), etag: z.string().optional(),
})
export const cutoverResource = z.object({ id: z.string(), applicationUID: z.string(), direction: z.string(), phase: id, reason: z.string(), previousDigest: z.string(), cookieIsolationVerified: z.boolean() })
export const shareManagement = z.object({
  bindings: z.array(binding), canManageBindings: z.boolean(), isOwner: z.boolean(), shareSync: z.string(),
  organizationGroups: z.object({ declared: z.boolean(), accepted: z.boolean(), roles: z.array(id) }),
  organizationSource: z.object({ sourceUID: id, ready: z.boolean(), initialSyncComplete: z.boolean(), appliedVersion: z.string(), consecutiveFailures: z.number().int().nonnegative() }).optional(),
  cutover: cutoverResource.optional(),
})
export const shareDiff = z.object({
  applicationUID: id, candidateDigest: z.string(), diffDigest: id, shareRevision: id, bindingETag: id,
  addedCount: z.number().int().nonnegative(), removedCount: z.number().int().nonnegative(), unresolvedCount: z.number().int().nonnegative(),
  added: z.array(z.object({ principal: id, displayName: z.string().optional() })).max(20),
  removed: z.array(z.object({ principal: id, displayName: z.string().optional() })).max(20),
  oldAuthenticated: z.boolean(), newAuthenticated: z.boolean(),
})
export const shareSchemas = { ShareManagement: shareManagement, ShareDiff: shareDiff, ShareCutover: z.object({ resource: cutoverResource }) }

export type ShareAccess = z.output<typeof shareManagement>
export type ShareDiff = z.output<typeof shareDiff>
