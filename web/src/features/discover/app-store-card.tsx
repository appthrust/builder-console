import { Check } from 'lucide-react'
import { screenshotUrl } from '../../api/console'
import { type DirectoryEntry } from '../../api/console-unverified'
import { copy } from '../../copy'
import type { AppView } from '../../model/app'
import { paths } from '../../routes/paths'
import { AppIcon, Avatar, Button, HrefLink, LinkButton, PersonLink, Skeleton, StatusPill } from '../../ui'
import type { AppViews } from '../app'
import { text } from './copy'

/** App page of a directory entry; its `path` ends with the slug. */
export const entryHref = (entry: Pick<DirectoryEntry, 'group' | 'path'>) =>
  paths.app(entry.group.path, entry.path.slice(entry.path.lastIndexOf('/') + 1))

type HeadingLevel = 'h3' | 'h4'

/**
 * App Store card (store-ux §3.1): first picture, icon, name, one-liner, two
 * capabilities, the first owner's face, and 開く ↗ / 使いたい. The name is the
 * card's link and stretches over it; the owner link and the button sit above it.
 * Status shows only when something is wrong (問題あり / 停止中).
 */
export function AppStoreCard({ entry, view, showGroup = true, heading = 'h3' }: {
  entry: DirectoryEntry
  view: AppView
  showGroup?: boolean
  heading?: HeadingLevel
}) {
  const Heading = heading
  const owner = entry.owners[0]
  const shot = entry.screenshots[0]
  const problem = view.status === 'failed' || view.status === 'unknown'
  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-lg border border-line bg-surface transition-[border-color,box-shadow] hover:border-stone-300 hover:shadow-md">
      {shot ? (
        <img
          src={screenshotUrl(entry.id, shot.id)}
          alt=""
          width={shot.width}
          height={shot.height}
          loading="lazy"
          decoding="async"
          className="aspect-[16/10] w-full border-b border-stone-100 bg-stone-100 object-cover object-top"
        />
      ) : null}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <AppIcon icon={entry.icon} name={entry.displayName} size="lg" />
          <div className="min-w-0 flex-1">
            <Heading className="text-base font-semibold text-stone-900">
              <HrefLink
                href={entryHref(entry)}
                className="break-words outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:text-accent-strong focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
              >
                {entry.displayName}
              </HrefLink>
            </Heading>
            {entry.description ? <p className="mt-0.5 line-clamp-2 break-words text-sm text-stone-600">{entry.description}</p> : null}
          </div>
          {problem ? <span className="shrink-0"><StatusPill status={view.status} label={view.label} /></span> : null}
        </div>
        {entry.capabilities.length > 0 ? (
          <ul className="space-y-1">
            {entry.capabilities.slice(0, 2).map((capability, index) => (
              <li key={index} className="flex min-w-0 items-start gap-2 text-sm text-stone-700">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
                <span className="min-w-0 truncate">{capability}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-stone-500">
            {owner ? (
              <PersonLink personId={owner.id} className="relative z-10 inline-flex min-h-10 min-w-0 items-center gap-1.5 rounded text-stone-700 hover:text-accent-strong hover:underline">
                <Avatar person={owner} size="sm" />
                <span className="truncate">{owner.displayName}</span>
              </PersonLink>
            ) : <span>{copy.appList.noOwner}</span>}
            {showGroup ? <><span aria-hidden>・</span><span className="truncate">{entry.group.name}</span></> : null}
          </p>
          {entry.canOpen ? (
            view.url ? (
              <LinkButton external href={view.url} size="sm" className="relative z-10" aria-label={text.store.open(entry.displayName)}>{copy.appList.open}</LinkButton>
            ) : null
          ) : entry.appName ? (
            <LinkButton href={paths.requestAccess(entry.appName, 'not_visible')} size="sm" className="relative z-10" aria-label={text.store.want(entry.displayName)}>{text.entry.wantToUse}</LinkButton>
          ) : (
            <Button size="sm" disabled title={text.entry.requestUnavailable} className="relative z-10">{text.entry.wantToUse}</Button>
          )}
        </div>
      </div>
    </article>
  )
}

/** 1 / 2 / 3 columns (≥768 / ≥1280). Entries keep the caller's order. */
export function AppStoreGrid({ entries, lookup, showGroup = true, heading, label }: {
  entries: DirectoryEntry[]
  lookup: AppViews
  showGroup?: boolean
  heading?: HeadingLevel
  label?: string
}) {
  return (
    <ul aria-label={label} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {entries.map((entry) => (
        <li key={entry.id} className="min-w-0">
          <AppStoreCard entry={entry} view={lookup.viewFor(entry)} showGroup={showGroup} heading={heading} />
        </li>
      ))}
    </ul>
  )
}

export function AppStoreGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div role="status" aria-label={copy.common.loading} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="space-y-4 rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex items-start gap-3">
            <Skeleton className="size-14 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
          <Skeleton className="h-3 w-3/4" />
          <div className="flex items-center justify-between">
            <Skeleton className="h-6 w-28 rounded-full" />
            <Skeleton className="h-8 w-16" />
          </div>
        </div>
      ))}
    </div>
  )
}
