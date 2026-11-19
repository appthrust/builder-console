import { Check } from 'lucide-react'
import { screenshotUrl } from '../../api/console'
import { type BusinessApp, type DirectoryEntry } from '../../model/contracts/console'
import { copy } from '../../copy'
import type { AppView } from '../../model/app'
import { resolvedPeople } from '../../model/directory'
import { paths } from '../../routes/paths'
import { AppIcon, Avatar, Button, buttonClasses, cn, HrefLink, LinkButton, PersonLink, Skeleton, StatusPill } from '../../ui'
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
  // The first owner the server can still resolve; an unknown person has no page or picture.
  const owner = resolvedPeople(entry.owners)[0]
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
            ) : <span>{entry.owners.length > 0 ? copy.common.unknownPerson : copy.appList.noOwner}</span>}
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

/** How a home card opens its app (role-based-views ux-design §6.4). No `url` → the card cannot open it. */
export type CardLaunch = {
  url?: string
  tone: 'primary' | 'secondary'
  /** Shown only when something is not as usual; a healthy app says nothing. */
  note?: 'failed' | 'stopped' | 'notReady'
  /** Statuses are still loading: the list is shown first, the state lands later. */
  pending?: true
}

export function cardLaunch(view: AppView, lookup: Pick<AppViews, 'loading' | 'failed'>): CardLaunch {
  if (lookup.loading) return { tone: 'primary', pending: true }
  // An unreadable state claims nothing; the list carries one 「状態を確認できませんでした」 line instead.
  if (lookup.failed || view.unreadableStack || view.unreadableBuild) return { url: view.url, tone: 'primary' }
  if (view.status === 'failed') return { url: view.url, tone: 'secondary', note: 'failed' }
  if (view.status === 'unknown') return { url: view.url, tone: 'secondary', note: 'stopped' }
  if (!view.url) return { tone: 'primary', note: 'notReady' }
  return { url: view.url, tone: 'primary' }
}

const NOTE_TONE: Record<NonNullable<CardLaunch['note']>, string> = {
  failed: 'bg-busy-soft text-busy-ink ring-amber-200',
  stopped: 'bg-stone-100 text-stone-600 ring-stone-200',
  notReady: 'bg-stone-100 text-stone-600 ring-stone-200',
}

const cardLink = 'relative z-10 inline-flex min-h-10 items-center text-sm text-accent-strong underline underline-offset-2 hover:text-accent md:min-h-8'

/**
 * Home card (ux-design §6.4, WF-01): icon, name, group and the description's
 * first line. The whole card opens the app in a new tab; 「開く ↗」 marks that
 * target and is not a second tab stop. 「くわしく」 leads to the intro page,
 * 「管理」 (maintainers only) to the same page with tabs. No owner, no version.
 */
export function AppLaunchCard({ app, launch, heading = 'h3' }: { app: BusinessApp; launch: CardLaunch; heading?: HeadingLevel }) {
  const Heading = heading
  const line = app.description.split('\n')[0].trim() || app.capabilities[0] || ''
  const appPage = paths.app(app.group.path, app.slug)
  // Maintainers get tabs on the app page; 「くわしく」 shows them the intro page as users see it (app-page.tsx `?as=user`).
  const details = app.permissions.maintain ? `${appPage}?as=user` : appPage
  return (
    <article
      className={cn(
        'relative flex h-full flex-col gap-3 rounded-lg border bg-surface p-4 transition-[border-color,box-shadow]',
        launch.url ? 'border-line hover:border-stone-300 hover:shadow-md' : 'border-dashed border-stone-300'
      )}
    >
      <div className="flex items-start gap-3">
        <AppIcon icon={app.icon} name={app.displayName} />
        <div className="min-w-0 flex-1">
          <Heading className="text-base font-semibold text-stone-900">
            {launch.url ? (
              <a
                href={launch.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={text.card.openLabel(app.displayName)}
                className="break-words outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:text-accent-strong focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
              >
                {app.displayName}
              </a>
            ) : (
              <span className="break-words text-stone-600">{app.displayName}</span>
            )}
          </Heading>
          <p className="truncate text-xs text-stone-500">{app.group.name}</p>
        </div>
      </div>
      {line ? <p className="line-clamp-2 break-words text-sm text-stone-600">{line}</p> : null}
      {launch.note ? (
        <p>
          <span className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', NOTE_TONE[launch.note])}>{text.card[launch.note]}</span>
        </p>
      ) : null}
      <div className="mt-auto flex items-center gap-4 pt-1">
        <span
          aria-hidden
          className={cn(
            buttonClasses(launch.url || launch.pending ? launch.tone : 'secondary', 'md', 'flex-1 sm:flex-none sm:min-w-24'),
            launch.pending ? 'animate-pulse' : !launch.url && 'opacity-50 shadow-none'
          )}
        >
          {text.card.open}
        </span>
        <HrefLink href={details} aria-label={text.card.detailsLabel(app.displayName)} className={cardLink}>
          {text.card.details}
        </HrefLink>
        {app.permissions.maintain ? (
          <HrefLink href={appPage} aria-label={text.card.manageLabel(app.displayName)} className={cn(cardLink, 'ml-auto')}>
            {text.card.manage}
          </HrefLink>
        ) : null}
      </div>
    </article>
  )
}

/** One column on phones, two from 768px, three from 1280px; entries keep the caller's order. */
export function AppLaunchGrid({ apps, lookup, label }: { apps: BusinessApp[]; lookup: AppViews; label?: string }) {
  return (
    <ul aria-label={label} className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {apps.map((app) => (
        <li key={app.id} className="min-w-0">
          <AppLaunchCard app={app} launch={cardLaunch(lookup.viewFor(app), lookup)} />
        </li>
      ))}
    </ul>
  )
}

export function AppLaunchGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div role="status" aria-label={copy.common.loading} className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="space-y-4 rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-md" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-9 w-24" />
        </div>
      ))}
    </div>
  )
}
