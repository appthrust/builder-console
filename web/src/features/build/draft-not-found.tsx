import { notFound } from '@tanstack/react-router'
import { FileQuestion } from 'lucide-react'
import { isPlatformNotFound } from '../../api/platform-error'
import { useMe } from '../../api/queries'
import { paths } from '../../routes/paths'
import { EmptyState, LinkButton } from '../../ui'
import { text } from './copy'

/**
 * `.catch` handler for draft loaders: a 404 is an answer (deleted, or another
 * account's draft), rendered by the route's not-found page rather than its
 * error boundary, which would also report it as a caught render error.
 */
export function notFoundOnDraft404(error: unknown): never {
  if (isPlatformNotFound(error)) throw notFound()
  throw error
}

/** The build/improve route's not-found page for the signed-in person. */
export function DraftNotFoundPage() {
  const me = useMe().data
  return <div className="p-5"><DraftNotFound email={me.person.email} /></div>
}

/**
 * The Platform API shows a draft only to its owner and answers 404 otherwise,
 * so "not found" usually means "signed in as someone else" (appthrust.ink
 * 2026-10-16: a shared link opened under another account showed the
 * transient 「しばらくしてから再読み込み」 with a retry that could never work).
 */
export function DraftNotFound({ email }: { email: string }) {
  const copy = text.page.notFound
  return (
    <EmptyState
      icon={<FileQuestion />}
      heading="h1"
      title={copy.title}
      body={<>{copy.body}<br />{copy.signedInAs(email)}</>}
      action={<LinkButton href={paths.drafts()}>{copy.back}</LinkButton>}
    />
  )
}
