import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Search, X } from 'lucide-react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { subtreeIds } from '../../model/contracts/console'
import { appsQuery } from '../../api/queries/console'
import { copy } from '../../copy'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { Button, EmptyState, HrefLink, LoadFailed, useDocumentTitle } from '../../ui'
import { useAppViews, type AppViews } from '../app/use-app-views'
import { AppCards, AppCardsSkeleton, AppLines, AppListSkeleton, AppTable, StatusLoadNotice, usePendingAccessRequestCounts } from './app-list'
import { text } from './copy'
import { matchesAppSearch } from './search'

const CARD_LIMIT = 8
const NEW_LIMIT = 5

/** Home is for finding apps (ux-design §6-7, §7.2): search, the 所属 group, shared-from-above, company news. */
export function HomePage({ q }: { q: string }) {
  useDocumentTitle(copy.home.title)
  const { me } = useShell()
  const lookup = useAppViews(me.projectId)
  const pendingCounts = usePendingAccessRequestCounts()
  return (
    <div className="space-y-10">
      <SearchBox q={q} />
      <StatusLoadNotice lookup={lookup} />
      {q ? <SearchResults q={q} lookup={lookup} pendingCounts={pendingCounts} /> : <Sections lookup={lookup} pendingCounts={pendingCounts} />}
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

function SectionHeading({ id, title, lead, more, level = 2 }: { id: string; title: string; lead?: string; more?: ReactNode; level?: 1 | 2 }) {
  const Heading = level === 1 ? 'h1' : 'h2'
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        <Heading id={id} className="text-lg font-semibold text-stone-900">
          {title}
        </Heading>
        {lead ? <p className="mt-1 text-sm text-stone-500">{lead}</p> : null}
      </div>
      {more}
    </div>
  )
}

function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <HrefLink href={href} className="inline-flex min-h-10 shrink-0 items-center text-sm font-medium text-accent-strong hover:underline">
      {children}
    </HrefLink>
  )
}

function SearchResults({ q, lookup, pendingCounts }: { q: string; lookup: AppViews; pendingCounts: ReadonlyMap<string, number> }) {
  // The API has no owner filter. Match the authorized, fully loaded list so
  // searching a person's name never loses apps to the server's narrower `q`.
  const results = useQuery(appsQuery({ scope: 'all' }))
  const matches = (results.data ?? []).filter((app) => matchesAppSearch(app, q))
  return (
    <section aria-labelledby="home-results" aria-busy={results.isFetching}>
      <SectionHeading
        id="home-results"
        level={1}
        title={copy.home.resultsTitle(q)}
        lead={undefined}
        more={
          <HrefLink
            href={paths.home}
            className="inline-flex min-h-10 shrink-0 items-center gap-1 text-sm text-stone-500 hover:text-stone-800 hover:underline"
          >
            <X aria-hidden className="size-4" />
            {copy.home.searchClear}
          </HrefLink>
        }
      />
      <p aria-live="polite" aria-atomic="true" className="mb-4 text-sm text-stone-500">
        {results.isFetching ? text.home.searching : results.data ? text.home.resultsCount(matches.length) : ''}
      </p>
      {results.isPending ? (
        <AppListSkeleton />
      ) : results.isError ? (
        <LoadFailed error={results.error} onRetry={() => void results.refetch()} />
      ) : (
        <AppTable
          apps={matches}
          lookup={lookup}
          pendingCounts={pendingCounts}
          showGroup
          caption={copy.home.resultsTitle(q)}
          emptyState={<EmptyState icon={<Search aria-hidden />} title={copy.home.noResults} />}
        />
      )}
    </section>
  )
}

function Sections({ lookup, pendingCounts }: { lookup: AppViews; pendingCounts: ReadonlyMap<string, number> }) {
  const { me, groups, currentGroup } = useShell()
  // One visible-apps load feeds every section; the server already hid what the caller cannot see.
  const visible = useQuery(appsQuery({ scope: 'all' }))
  const sections = useMemo(() => {
    const apps = visible.data ?? []
    const contextIds = currentGroup ? subtreeIds(groups, currentGroup.id) : new Set<string>()
    const myGroupIds = new Set(me.effectiveGroupIds)
    return {
      group: apps.filter((app) => contextIds.has(app.group.id)),
      // Visible through a `group` share although owned outside the caller's groups: shared from above.
      shared: apps.filter((app) => app.share.scope === 'group' && !myGroupIds.has(app.group.id)),
      company: apps
        .filter((app) => app.share.scope === 'company' || app.share.scope === 'public')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, NEW_LIMIT),
    }
  }, [visible.data, currentGroup, groups, me.effectiveGroupIds])

  if (visible.isError) return <LoadFailed error={visible.error} onRetry={() => void visible.refetch()} />
  const loading = visible.isPending

  return (
    <>
      <section aria-labelledby="home-group">
        <SectionHeading
          id="home-group"
          level={1}
          title={currentGroup ? copy.home.groupApps(currentGroup.name) : copy.home.title}
          lead={currentGroup ? text.home.groupLead(currentGroup.name) : undefined}
          more={currentGroup ? <MoreLink href={paths.group(currentGroup.path)}>{copy.home.seeAll}</MoreLink> : null}
        />
        {!currentGroup ? (
          <EmptyState title={copy.home.noMembership} />
        ) : loading ? (
          <AppCardsSkeleton />
        ) : sections.group.length === 0 ? (
          <EmptyState title={copy.home.groupEmpty} />
        ) : (
          <AppCards apps={sections.group.slice(0, CARD_LIMIT)} lookup={lookup} pendingCounts={pendingCounts} />
        )}
      </section>

      <section aria-labelledby="home-shared">
        <SectionHeading id="home-shared" title={copy.home.shared} lead={text.home.sharedLead} />
        {loading ? (
          <AppListSkeleton rows={2} />
        ) : sections.shared.length === 0 ? (
          <p className="text-sm text-stone-500">{copy.home.sharedEmpty}</p>
        ) : (
          <AppLines apps={sections.shared} lookup={lookup} pendingCounts={pendingCounts} />
        )}
      </section>

      <section aria-labelledby="home-company">
        <SectionHeading
          id="home-company"
          title={copy.home.companyNew}
          lead={text.home.companyLead}
          more={<MoreLink href={paths.directory}>{copy.home.seeAll}</MoreLink>}
        />
        {loading ? (
          <AppListSkeleton rows={2} />
        ) : sections.company.length === 0 ? (
          <p className="text-sm text-stone-500">{copy.home.companyEmpty}</p>
        ) : (
          <AppLines apps={sections.company} lookup={lookup} pendingCounts={pendingCounts} showTime />
        )}
      </section>
    </>
  )
}
