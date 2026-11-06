import { FileQuestion } from 'lucide-react'
import { paths } from '../../routes/paths'
import { EmptyState, LinkButton } from '../../ui'
import { text } from './copy'

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
