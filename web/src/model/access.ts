import type { PublishAccess, PublishAccessRequest } from '@appthrust/api-schema/platform-api'
import type { SharePolicy, ShareScope } from '../api/console-unverified'
import { copy } from '../copy'
import { sharingCopy } from '../copy/sharing'
import { text } from '../features/app/copy'

type SharedApp = { share: SharePolicy; owners: readonly { id: string }[] }
export type AccessDisplay = { label: string; applied: boolean; state: 'applied' | 'pending' | 'unapplied' | 'failed' }

export type DraftShareScope = Extract<ShareScope, 'private' | 'group' | 'company'>

/** One audience vocabulary for preparation, Excel hand-off and publication. */
export function shareScopeLabel(scope: ShareScope, ownerGroupName?: string): string {
  return scope === 'group' && ownerGroupName ? ownerGroupName : copy.create.share[scope].title
}

export function accessRequest(scope: ShareScope): PublishAccessRequest {
  if (scope === 'public') return { mode: 'Public' }
  return { mode: 'Authenticated', ...(scope === 'private' || scope === 'group' ? { externalAuthorization: { appInstallation: 'builder-console' } } : {}) }
}

/** The observed policy is authoritative; desired metadata alone is never proof. */
export function matchesAccess(access: PublishAccess | undefined, scope: ShareScope): boolean {
  if (!access?.mode || access.pending) return false
  const external = access.authorization?.external
  if (scope === 'public') return access.mode === 'Public' && !external
  if (access.mode !== 'Authenticated') return false
  return scope === 'company' ? !external : external?.appInstallation === 'builder-console' && external.path === '/authz'
}

export function deriveAccess(access: PublishAccess | undefined, app: SharedApp, groups: readonly { id: string; name: string }[] = [], failure?: 'forbidden' | 'failed'): AccessDisplay {
  if (failure === 'forbidden') return { state: 'unapplied', applied: false, label: sharingCopy.status.unapplied }
  if (failure === 'failed') return { state: 'failed', applied: false, label: access?.mode === 'Public' ? sharingCopy.status.failedPublic : sharingCopy.status.failed }
  if (access?.pending) return { state: 'pending', applied: false, label: sharingCopy.status.pending }
  const applied = matchesAccess(access, app.share.scope)
  const state = applied ? 'applied' : 'unapplied'
  // Explicitly show an exposed URL even if the intended share is narrower.
  if (access?.mode === 'Public') return { state, applied, label: sharingCopy.status.public }
  if (!applied) return { state, applied, label: sharingCopy.status.unapplied }
  if (app.share.scope === 'company') return { state, applied, label: sharingCopy.status.company }
  const count = new Set([...app.owners.map((owner) => owner.id), ...app.share.extraPersonIds]).size
  const names = app.share.scope === 'group' ? text.names.people(app.share.groupIds.map((id) => groups.find((group) => group.id === id)?.name ?? id)) : ''
  return { state, applied, label: sharingCopy.status.limited(count, names) }
}

/** Both roles are persisted in the same PATCH; no intermediate missing/duplicate access. */
export function movePerson(app: SharedApp, id: string, role: 'editor' | 'viewer' | 'remove') {
  const ownerIds = app.owners.map((owner) => owner.id).filter((owner) => owner !== id)
  const extraPersonIds = app.share.extraPersonIds.filter((person) => person !== id)
  if (role === 'editor') ownerIds.push(id)
  if (role === 'viewer') extraPersonIds.push(id)
  if (ownerIds.length === 0) throw new Error(sharingCopy.lastOwner)
  return { ownerIds, share: { ...app.share, extraPersonIds } }
}
