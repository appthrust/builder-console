// SharePolicy wording: who can open an app, as the group names the company uses.
import type { BusinessApp, SharePolicy } from '../api/console-unverified'
import type { Group } from './contracts/console'
import { copy } from '../copy'
import { text } from '../features/app/copy'

/**
 * "営業1課・営業2課 に公開" / "自分だけに公開" / "全社に公開" / "社外にも公開".
 * Group ids that are not in `groups` (not loaded yet, or deleted) fall back to
 * the app's owner group name when it matches, and are otherwise skipped.
 */
export function shareSentence(
  share: SharePolicy,
  groups: readonly Pick<Group, 'id' | 'name'>[],
  ownerGroup?: BusinessApp['group']
): string {
  if (share.scope === 'private') return copy.share.private
  if (share.scope === 'company') return copy.share.company
  if (share.scope === 'public') return copy.share.public
  const names = share.groupIds.flatMap((id) => {
    const name = groups.find((group) => group.id === id)?.name ?? (ownerGroup?.id === id ? ownerGroup.name : undefined)
    return name ? [name] : []
  })
  if (names.length > 0) return copy.share.group(text.names.groups(names))
  return ownerGroup ? copy.share.group(ownerGroup.name) : copy.share.company
}

const SCOPE_RANK: Record<SharePolicy['scope'], number> = { private: 0, group: 1, company: 2, public: 3 }

/**
 * Widening needs the typed-name confirmation (ux-design §6.5): a broader scope,
 * or more groups within the group scope.
 */
export function widensShare(before: SharePolicy, after: SharePolicy): boolean {
  if (SCOPE_RANK[after.scope] !== SCOPE_RANK[before.scope]) {
    return SCOPE_RANK[after.scope] > SCOPE_RANK[before.scope]
  }
  return after.scope === 'group' && after.groupIds.some((id) => !before.groupIds.includes(id))
}
