// SharePolicy wording: who can open an app, as the group names the company uses.
import type { AppGroup, ConsoleValue, Group } from './contracts/console'
import { copy } from '../copy'
import { text } from '../features/app/copy'

export type ShareScope = 'private' | 'group' | 'company' | 'public'

/**
 * A share scope: a local choice (a form, always known) or the server's open
 * value. A scope this console does not know is never read as any audience and
 * is never sent back.
 */
export type ShareScopeValue = ShareScope | ConsoleValue<ShareScope>

/** A share policy from either source; `scope` may be unknown when it came from the server. */
export interface ShareInput {
  scope: ShareScopeValue
  groupIds: readonly string[]
  extraPersonIds: readonly string[]
}

/** A share policy whose scope is known: the only kind that may be written. */
export interface KnownShare {
  scope: ShareScope
  groupIds: string[]
  extraPersonIds: string[]
}

/** The scope when it is known; undefined for a scope this console does not know. */
export function knownScope(scope: ShareScopeValue): ShareScope | undefined {
  if (typeof scope === 'string') return scope
  return scope.kind === 'known' ? scope.value : undefined
}

/** The policy as a write may send it, or undefined when its scope is unknown (no write is offered then). */
export function knownShare(share: ShareInput): KnownShare | undefined {
  const scope = knownScope(share.scope)
  return scope ? { scope, groupIds: [...share.groupIds], extraPersonIds: [...share.extraPersonIds] } : undefined
}

/**
 * "営業1課・営業2課 に公開" / "自分だけに公開" / "全社に公開" / "社外にも公開".
 * Group ids that are not in `groups` (not loaded yet, or deleted) fall back to
 * the app's owner group name when it matches, and are otherwise skipped.
 */
export function shareSentence(
  share: ShareInput,
  groups: readonly Pick<Group, 'id' | 'name'>[],
  ownerGroup?: AppGroup
): string {
  const scope = knownScope(share.scope)
  if (!scope) return text.unsupported.share
  if (scope === 'private') return copy.share.private
  if (scope === 'company') return copy.share.company
  if (scope === 'public') return copy.share.public
  const names = share.groupIds.flatMap((id) => {
    const name = groups.find((group) => group.id === id)?.name ?? (ownerGroup?.id === id ? ownerGroup.name : undefined)
    return name ? [name] : []
  })
  if (names.length > 0) return copy.share.group(text.names.groups(names))
  return ownerGroup ? copy.share.group(ownerGroup.name) : copy.share.company
}

const SCOPE_RANK: Record<ShareScope, number> = { private: 0, group: 1, company: 2, public: 3 }

/**
 * Widening needs the typed-name confirmation (ux-design §6.5): a broader scope,
 * or more groups within the group scope. Leaving a scope this console does not
 * know always counts as widening.
 */
export function widensShare(before: ShareInput, after: KnownShare): boolean {
  const from = knownScope(before.scope)
  if (!from) return true
  if (SCOPE_RANK[after.scope] !== SCOPE_RANK[from]) {
    return SCOPE_RANK[after.scope] > SCOPE_RANK[from]
  }
  return after.scope === 'group' && after.groupIds.some((id) => !before.groupIds.includes(id))
}
