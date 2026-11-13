import { copy } from '../copy'
import { sharingCopy } from '../copy/sharing'
import { text } from '../features/app/copy'
import { isOneOf } from './contracts/build'
import type { PublishAccess, PublishAccessChange } from './contracts/app'
import { knownScope, type KnownShare, type ShareInput, type ShareScope, type ShareScopeValue } from './share'

export type { ShareScope }

type SharedApp = { share: ShareInput; owners: readonly { id: string }[] }
export type AccessDisplay = { label: string; applied: boolean; state: 'applied' | 'pending' | 'unapplied' | 'failed' }

export type DraftShareScope = Extract<ShareScope, 'private' | 'group' | 'company'>

/** One audience vocabulary for preparation, Excel hand-off and publication. */
export function shareScopeLabel(scope: ShareScope, ownerGroupName?: string): string {
  return scope === 'group' && ownerGroupName ? ownerGroupName : copy.create.share[scope].title
}

export function accessRequest(scope: ShareScope): PublishAccessChange {
  if (scope === 'public') return { mode: 'Public' }
  return { mode: 'Authenticated', ...(scope === 'private' || scope === 'group' ? { externalAuthorization: { appInstallation: 'builder-console' } } : {}) }
}

/**
 * The observed policy is authoritative; desired metadata alone is never proof.
 * An access mode or share scope this console does not know never matches.
 */
export function matchesAccess(access: PublishAccess | undefined, scope: ShareScopeValue): boolean {
  const known = knownScope(scope)
  if (!known || !access?.mode || access.pending) return false
  const external = access.authorization?.external
  if (known === 'public') return isOneOf(access.mode, 'Public') && !external
  if (!isOneOf(access.mode, 'Authenticated')) return false
  return known === 'company' ? !external : external?.appInstallation === 'builder-console' && external.path === '/authz'
}

export function deriveAccess(access: PublishAccess | undefined, app: SharedApp, groups: readonly { id: string; name: string }[] = [], failure?: 'forbidden' | 'failed'): AccessDisplay {
  const isPublic = isOneOf(access?.mode, 'Public')
  if (failure === 'forbidden') return { state: 'unapplied', applied: false, label: sharingCopy.status.unapplied }
  if (failure === 'failed') return { state: 'failed', applied: false, label: isPublic ? sharingCopy.status.failedPublic : sharingCopy.status.failed }
  if (access?.pending) return { state: 'pending', applied: false, label: sharingCopy.status.pending }
  const scope = knownScope(app.share.scope)
  const applied = matchesAccess(access, app.share.scope)
  const state = applied ? 'applied' : 'unapplied'
  // Explicitly show an exposed URL even if the intended share is narrower.
  if (isPublic) return { state, applied, label: sharingCopy.status.public }
  if (!scope) return { state, applied, label: text.unsupported.share }
  if (!applied) return { state, applied, label: sharingCopy.status.unapplied }
  if (scope === 'company') return { state, applied, label: sharingCopy.status.company }
  const count = new Set([...app.owners.map((owner) => owner.id), ...app.share.extraPersonIds]).size
  const names = scope === 'group' ? text.names.people(app.share.groupIds.map((id) => groups.find((group) => group.id === id)?.name ?? id)) : ''
  return { state, applied, label: sharingCopy.status.limited(count, names) }
}

/** Both roles are persisted in the same PATCH; no intermediate missing/duplicate access. Only a known share can be written. */
export function movePerson(app: { owners: readonly { id: string }[]; share: KnownShare }, id: string, role: 'editor' | 'viewer' | 'remove') {
  const ownerIds = app.owners.map((owner) => owner.id).filter((owner) => owner !== id)
  const extraPersonIds = app.share.extraPersonIds.filter((person) => person !== id)
  if (role === 'editor') ownerIds.push(id)
  if (role === 'viewer') extraPersonIds.push(id)
  if (ownerIds.length === 0) throw new Error(sharingCopy.lastOwner)
  return { ownerIds, share: { ...app.share, extraPersonIds } }
}
