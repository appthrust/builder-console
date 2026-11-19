import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useSelector } from '@tanstack/react-store'
import { Search, X } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { subtreeIds, type BusinessApp, type DirectoryEntry, type Group } from '../../model/contracts/console'
import { isOneOf } from '../../model/contracts/build'
import { appsQuery, directoryAppsQuery } from '../../api/queries/console'
import { copy } from '../../copy'
import { paths } from '../../routes/paths'
import { locale } from '../../shell/language'
import { dismissLaunchHint, shellStore } from '../../shell/store'
import { useShell } from '../../shell/use-shell'
import { AppIcon, Button, cn, EmptyState, HrefLink, IconButton, LinkButton, LoadFailed, useDocumentTitle } from '../../ui'
import { useAppViews, type AppViews } from '../app/use-app-views'
import { StaleNotice } from '../app/notices'
import { InboxPanel, useConsoleView } from '../inbox'
import { AppListSkeleton, StatusLoadNotice } from './app-list'
import { AppLaunchGrid, AppLaunchGridSkeleton, entryHref } from './app-store-card'
import { text } from './copy'
import { matchesAppSearch } from './search'

/** Cards shown before 「もっと見る」, and how many more each press adds. */
export const PAGE_SIZE = 24

export type UsableFilter = { id: string; label: string; apps: BusinessApp[] }

/**
 * 「使えるアプリ」 chips (role-based-views ux-design §6.2): すべて, one per
 * membership root (its subtree), ほかの部署, 全社. Only apps bound to the
 * platform (no 作りかけ); a chip with no apps is not offered. すべて keeps the
 * chip order, each chip is name-ordered.
 */
export function usableFilters(apps: readonly BusinessApp[], homeGroups: readonly Group[], groups: readonly Group[]): UsableFilter[] {
  const byName = (a: BusinessApp, b: BusinessApp) => a.displayName.localeCompare(b.displayName, locale())
  const remaining = apps.filter((app) => app.stackId)
  const take = (keep: (app: BusinessApp) => boolean) => {
    const taken = remaining.filter(keep).sort(byName)
    for (const app of taken) remaining.splice(remaining.indexOf(app), 1)
    return taken
  }
  const memberships = homeGroups.map((group) => {
    const ids = subtreeIds([...groups], group.id)
    return { id: `group:${group.id}`, label: group.name, apps: take((app) => ids.has(app.group.id)) }
  })
  const company = { id: 'company', label: copy.home.filterCompany, apps: take((app) => isOneOf(app.share.scope, 'company', 'public')) }
  const other = { id: 'other', label: copy.home.filterOther, apps: take(() => true) }
  const chips = [...memberships, other, company].filter((chip) => chip.apps.length > 0)
  return [{ id: 'all', label: copy.home.filterAll, apps: chips.flatMap((chip) => chip.apps) }, ...chips]
}

/**
 * Home (role-based-views ux-design §6.2–6.3, WF-01/02): search, then for makers
 * 「あなたの対応待ち」, for users a one-time tip, then the same 「使えるアプリ」.
 */
export function HomePage({ q }: { q: string }) {
  useDocumentTitle(copy.home.title)
  const { me } = useShell()
  const view = useConsoleView()
  const lookup = useAppViews(me.projectId)
  return (
    <div className="space-y-8">
      <h1 className="sr-only">{copy.home.title}</h1>
      <div className="space-y-4">
        <SearchBox q={q} />
        {q ? null : view === 'maker' ? <InboxPanel seeAllHref={paths.mine()} /> : <LaunchHint />}
      </div>
      <StatusLoadNotice lookup={lookup} />
      {q ? <SearchResults q={q} lookup={lookup} /> : <UsableApps lookup={lookup} />}
      <p className="text-sm text-stone-500">
        {copy.home.directoryPrompt}{' '}
        <HrefLink href={paths.directory} className="inline-flex min-h-10 items-center font-medium text-accent-strong underline underline-offset-2 hover:text-accent md:min-h-0">
          {copy.home.directoryLink}
        </HrefLink>
      </p>
    </div>
  )
}

/** Only submitting changes history; typing preserves earlier search results for Back. */
function SearchBox({ q }: { q: string }) {
  const navigate = useNavigate({ from: '/' })
  const [value, setValue] = useState(q)
  const term = value.trim()

  // The URL changed from elsewhere (検索をやめる, back button): follow it.
  const [followedQ, setFollowedQ] = useState(q)
  if (followedQ !== q) {
    setFollowedQ(q)
    if (term !== q) setValue(q)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (term !== q) void navigate({ search: { q: term } })
  }

  return (
    <form role="search" onSubmit={submit} className="relative">
      <label htmlFor="home-search" className="sr-only">
        {copy.home.searchLabel}
      </label>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-stone-400" />
      <input
        id="home-search"
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={copy.home.searchPlaceholder}
        autoComplete="off"
        enterKeyHint="search"
        className="block h-12 w-full rounded-lg border border-stone-200 bg-white pr-24 pl-12 text-base text-stone-900 shadow-xs placeholder:text-stone-400 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent [&::-webkit-search-cancel-button]:hidden"
      />
      <div className="absolute top-1/2 right-2 -translate-y-1/2">
        <Button type="submit" tone="primary" size="sm">
          {copy.home.searchSubmit}
        </Button>
      </div>
    </form>
  )
}

/** Shown until closed once in this browser (ux-design §6.2 初回の案内). */
function LaunchHint() {
  const dismissed = useSelector(shellStore, (state) => state.launchHintDismissed)
  if (dismissed) return null
  return (
    <div className="flex items-center gap-2 rounded-lg bg-accent-soft py-1 pr-1 pl-4 text-sm text-accent-strong">
      <p className="min-w-0 flex-1 py-1.5">{copy.home.hint}</p>
      <IconButton label={copy.home.hintClose} icon={<X />} onClick={dismissLaunchHint} className="text-accent-strong hover:bg-white/60" />
    </div>
  )
}

function DirectoryButton() {
  return <LinkButton tone="primary" href={paths.directory}>{copy.home.emptyAction}</LinkButton>
}

function UsableApps({ lookup }: { lookup: AppViews }) {
  const { groups, homeGroups } = useShell()
  // The server already hid what the caller cannot see.
  const visible = useQuery(appsQuery({ scope: 'all' }))
  const filters = useMemo(() => usableFilters(visible.data ?? [], homeGroups, groups), [visible.data, homeGroups, groups])
  const [filterId, setFilterId] = useState('all')
  const [shown, setShown] = useState(PAGE_SIZE)
  const current = filters.find((filter) => filter.id === filterId) ?? filters[0]
  const noGroup = homeGroups.length === 0

  if (visible.isLoadingError) return <LoadFailed error={visible.error} onRetry={() => void visible.refetch()} />
  if (visible.isSuccess && filters[0].apps.length === 0) {
    return noGroup
      ? <EmptyState heading="h2" title={copy.home.noGroupTitle} body={copy.home.noGroupBody} action={<DirectoryButton />} />
      : <EmptyState heading="h2" title={copy.home.emptyTitle} body={copy.home.emptyBody} action={<DirectoryButton />} />
  }

  const select = (id: string) => {
    setFilterId(id)
    setShown(PAGE_SIZE)
  }
  return (
    <div className="space-y-6">
      {visible.isRefetchError ? <StaleNotice updatedAt={visible.dataUpdatedAt} refetching={visible.isFetching} onRetry={() => void visible.refetch()} /> : null}
      {noGroup ? <EmptyState title={copy.home.noGroupTitle} body={copy.home.noGroupBody} /> : null}
      <section aria-labelledby="home-usable" aria-busy={visible.isPending}>
        <h2 id="home-usable" className="flex items-baseline gap-2 text-lg font-semibold text-stone-900">
          {copy.home.usable}
          {visible.isSuccess ? <span className="text-sm font-normal text-stone-500">{copy.home.count(current.apps.length)}</span> : null}
        </h2>
        {filters.length > 2 ? (
          <div role="group" aria-label={copy.home.filterLabel} className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
            {filters.map((filter) => {
              const selected = filter.id === current.id
              return (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => select(filter.id)}
                  className={cn(
                    'inline-flex h-10 shrink-0 items-center rounded-full border px-3.5 text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:h-8',
                    selected ? 'border-accent bg-accent font-medium text-white' : 'border-stone-300 bg-white text-stone-700 hover:border-stone-400 hover:bg-stone-50'
                  )}
                >
                  {filter.label}
                </button>
              )
            })}
          </div>
        ) : null}
        <div className="mt-4">
          {visible.isPending ? (
            <AppLaunchGridSkeleton />
          ) : (
            <AppLaunchGrid apps={current.apps.slice(0, shown)} lookup={lookup} label={current.id === 'all' ? copy.home.usable : `${copy.home.usable}: ${current.label}`} />
          )}
        </div>
        {visible.isSuccess && current.apps.length > shown ? (
          <div className="mt-4 flex justify-center">
            <Button onClick={() => setShown((count) => count + PAGE_SIZE)}>{copy.home.more}</Button>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function SearchResults({ q, lookup }: { q: string; lookup: AppViews }) {
  // The API has no owner filter. Match the authorized, fully loaded list so
  // searching a person's name never loses apps to the server's narrower `q`.
  const results = useQuery(appsQuery({ scope: 'all' }))
  const matches = (results.data ?? [])
    .filter((app) => app.stackId && matchesAppSearch(app, q))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, locale()))
  // Nothing usable matched: offer what the directory knows, with 「使いたい」 (WF-07 C).
  const directory = useQuery({ ...directoryAppsQuery({ q }), enabled: results.isSuccess && matches.length === 0 })
  const others = (directory.data ?? []).filter((entry) => !entry.canOpen)
  return (
    <section aria-labelledby="home-results" aria-busy={results.isFetching}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h2 id="home-results" className="flex items-baseline gap-2 text-lg font-semibold text-stone-900">
          {copy.home.resultsTitle(q)}
          <span aria-live="polite" aria-atomic="true" className="text-sm font-normal text-stone-500">
            {results.isFetching ? text.home.searching : results.data ? text.home.resultsCount(matches.length) : ''}
          </span>
        </h2>
        <HrefLink href={paths.home} className="inline-flex min-h-10 shrink-0 items-center gap-1 text-sm text-stone-500 hover:text-stone-800 hover:underline">
          <X aria-hidden className="size-4" />
          {copy.home.searchClear}
        </HrefLink>
      </div>
      {results.isRefetchError ? <StaleNotice updatedAt={results.dataUpdatedAt} refetching={results.isFetching} onRetry={() => void results.refetch()} /> : null}
      {results.isPending ? (
        <AppLaunchGridSkeleton count={3} />
      ) : results.isLoadingError ? (
        <LoadFailed error={results.error} onRetry={() => void results.refetch()} />
      ) : matches.length > 0 ? (
        <AppLaunchGrid apps={matches} lookup={lookup} label={copy.home.resultsTitle(q)} />
      ) : directory.isPending ? (
        <AppListSkeleton rows={1} />
      ) : others.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-stone-600">{copy.home.noUsableMatch}</p>
          <p className="text-sm font-medium text-stone-800">{copy.home.otherMatches(others.length)}</p>
          <ul aria-label={copy.home.otherMatchesLabel} className="divide-y divide-stone-100 overflow-hidden rounded-lg border border-line bg-white">
            {others.map((entry) => <WantRow key={entry.id} entry={entry} />)}
          </ul>
        </div>
      ) : (
        <EmptyState icon={<Search aria-hidden />} title={copy.home.noResults} />
      )}
    </section>
  )
}

/** An app the caller cannot open yet: its intro page and 「使いたい」. */
function WantRow({ entry }: { entry: DirectoryEntry }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <AppIcon icon={entry.icon} name={entry.displayName} />
      <HrefLink href={entryHref(entry)} className="min-w-0 flex-1 rounded hover:text-accent-strong">
        <span className="block truncate text-sm font-medium text-stone-900">{entry.displayName}</span>
        <span className="block truncate text-xs text-stone-500">{entry.group.name}</span>
      </HrefLink>
      {entry.appName ? (
        <LinkButton href={paths.requestAccess(entry.appName, 'not_visible')} size="sm" aria-label={text.store.want(entry.displayName)}>{text.entry.wantToUse}</LinkButton>
      ) : (
        <Button size="sm" disabled title={text.entry.requestUnavailable}>{text.entry.wantToUse}</Button>
      )}
    </li>
  )
}
