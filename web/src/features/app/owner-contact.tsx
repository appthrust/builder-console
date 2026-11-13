import { Mail } from 'lucide-react'
import type { BusinessApp } from '../../api/console-unverified'
import { LinkButton } from '../../ui'
import { text } from './copy'

export function OwnerContact({ app }: { app: BusinessApp }) {
  const owners = app.owners.filter((owner) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.email))
  return owners.length ? (
    <LinkButton external target="_self" href={`mailto:${owners.map((owner) => encodeURIComponent(owner.email)).join(',')}?subject=${encodeURIComponent(text.overview.emailSubject(app.displayName))}`} icon={<Mail />}>
      {text.overview.ask(owners.map((owner) => owner.displayName))}
    </LinkButton>
  ) : <p className="text-sm text-stone-500">{text.overview.noContact}</p>
}
