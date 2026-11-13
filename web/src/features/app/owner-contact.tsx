import { Mail } from 'lucide-react'
import { isUnknownPerson, type BusinessApp, type Person } from '../../model/contracts/console'
import { LinkButton } from '../../ui'
import { text } from './copy'

/** Only resolved owners with a usable address are contacted; an unknown person has no contact to invent. */
export function OwnerContact({ app }: { app: Pick<BusinessApp, 'owners' | 'displayName'> }) {
  const owners = app.owners.filter((owner): owner is Person => !isUnknownPerson(owner) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.email))
  return owners.length ? (
    <LinkButton external target="_self" href={`mailto:${owners.map((owner) => encodeURIComponent(owner.email)).join(',')}?subject=${encodeURIComponent(text.overview.emailSubject(app.displayName))}`} icon={<Mail />}>
      {text.overview.ask(owners.map((owner) => owner.displayName))}
    </LinkButton>
  ) : <p className="text-sm text-stone-500">{text.overview.noContact}</p>
}
