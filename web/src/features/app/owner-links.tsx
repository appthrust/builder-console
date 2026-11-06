import type { Person } from '../../api/console'
import { copy } from '../../copy'
import { Avatar, cn, PersonLink } from '../../ui'

/** 担当: each owner's face and name, linking to their maker page (store-ux §2). */
export function OwnerLinks({ owners, className }: { owners: Pick<Person, 'id' | 'displayName' | 'avatarVersion'>[]; className?: string }) {
  if (owners.length === 0) return <span className={className}>{copy.appList.noOwner}</span>
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-center gap-x-3', className)}>
      {owners.map((owner) => (
        <PersonLink
          key={owner.id}
          personId={owner.id}
          className="inline-flex min-h-10 min-w-0 items-center gap-1.5 rounded text-stone-700 hover:text-accent-strong hover:underline md:min-h-8"
        >
          <Avatar person={owner} size="sm" />
          <span className="break-words">{owner.displayName}</span>
        </PersonLink>
      ))}
    </span>
  )
}
