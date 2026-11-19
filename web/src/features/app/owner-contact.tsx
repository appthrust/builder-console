import { Mail } from 'lucide-react'
import { isUnknownPerson, type BusinessApp, type Person } from '../../model/contracts/console'
import { LinkButton } from '../../ui'
import { text } from './copy'

/**
 * Only resolved owners with a usable address are contacted; an unknown person has no contact to invent.
 * `compact` is the small 「メールで連絡する」 beside a heading: without an address it shows nothing.
 */
export function OwnerContact({ app, compact = false }: { app: Pick<BusinessApp, 'owners' | 'displayName'>; compact?: boolean }) {
  const owners = app.owners.filter((owner): owner is Person => !isUnknownPerson(owner) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.email))
  if (!owners.length) return compact ? null : <p className="text-sm text-stone-500">{text.overview.noContact}</p>
  return (
    <LinkButton external target="_self" size={compact ? 'sm' : 'md'} href={`mailto:${owners.map((owner) => encodeURIComponent(owner.email)).join(',')}?subject=${encodeURIComponent(text.overview.emailSubject(app.displayName))}`} icon={<Mail />}>
      {compact ? text.feedback.mail : text.overview.ask(owners.map((owner) => owner.displayName))}
    </LinkButton>
  )
}
