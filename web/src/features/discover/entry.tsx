import type { DirectoryEntry } from '../../api/console'
import { copy, relativeTime } from '../../copy'
import { paths } from '../../routes/paths'
import { AppIcon, Button, HrefLink, LinkButton, Notice, PageHeader, useDocumentTitle } from '../../ui'
import { AppAbout, Comments, OwnerLinks, ScreenshotStrip } from '../app'
import { text } from './copy'

/**
 * The app page for people who cannot open the app (store-ux §3.4): the same
 * order as 概要 — pictures, what it does — but a directory projection only:
 * no app URL, guide, sharing policy or settings.
 */
export function EntryPage({ entry }: { entry: DirectoryEntry }) {
  useDocumentTitle(entry.displayName)
  const updated = relativeTime(entry.updatedAt)
  return (
    <div className="space-y-8">
      <PageHeader
        title={<span className="flex min-w-0 items-center gap-3"><AppIcon icon={entry.icon} name={entry.displayName} size="lg" /><span className="break-words">{entry.displayName}</span></span>}
        actions={entry.appName ? (
          <LinkButton tone="primary" href={paths.requestAccess(entry.appName, 'not_visible')}>{text.entry.wantToUse}</LinkButton>
        ) : <Button tone="primary" disabled title={text.entry.requestUnavailable}>{text.entry.wantToUse}</Button>}
      >
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-500">
          <HrefLink href={paths.group(entry.group.path)} className="inline-flex min-h-10 items-center text-accent-strong hover:underline">{text.entry.ofGroup(entry.group.name)}</HrefLink>
          <span aria-hidden>・</span>
          <span className="inline-flex min-w-0 items-center gap-1.5">{text.entry.owner} <OwnerLinks owners={entry.owners} /></span>
          {updated ? <><span aria-hidden>・</span><span>{copy.group.lastUpdated} <time dateTime={entry.updatedAt}>{updated}</time></span></> : null}
        </p>
      </PageHeader>

      <ScreenshotStrip appId={entry.id} screenshots={entry.screenshots} canEdit={false} />
      <AppAbout description={entry.description} capabilities={entry.capabilities} tags={entry.tags} />
      <Notice>{text.entry.restricted(entry.group.name)}</Notice>

      <Comments appId={entry.id} owners={entry.owners} canDeleteAny={false} />
    </div>
  )
}
