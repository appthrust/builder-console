import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Building2, Search, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { directoryLinks } from '../../api/console'
import { type DirectoryEntry } from '../../api/console-unverified'
import { type Group } from '../../model/contracts/console'
import { directoryAppsQuery } from '../../api/queries/console'
import { copy } from '../../copy'
import { groupDirectory, isFinished, storeOrder, type DirectoryGroupCard } from '../../model/directory'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { AppIcon, Button, Card, CardBody, EmptyState, HrefLink, LinkButton, LoadFailed, PageHeader, useDocumentTitle } from '../../ui'
import { useAppViews, type AppViews } from '../app/use-app-views'
import { AppListSkeleton, StatusLoadNotice } from './app-list'
import { AppStoreGrid, entryHref } from './app-store-card'
import { text } from './copy'
import { matchesDirectoryEntrySearch } from './search'

export function DirectoryPage({ q }: { q: string }) {
  useDocumentTitle(copy.directory.title)
  const { me, groups } = useShell()
  const entries = useQuery(directoryAppsQuery({ q }))
  const lookup = useAppViews(me.projectId)

  return (
    <div className="space-y-6">
      <PageHeader title={copy.directory.title} lead={copy.directory.lead} />
      <DirectorySearchBox q={q} />
      <StatusLoadNotice lookup={lookup} />
      {entries.isError ? (
        <LoadFailed error={entries.error} onRetry={() => void entries.refetch()} />
      ) : entries.isPending || lookup.loading ? (
        <AppListSkeleton rows={4} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<Building2 aria-hidden />}
          title={copy.directory.noGroups}
          action={me.directoryPublicURL ? <LinkButton href={directoryLinks.groups(me.directoryPublicURL)} external>{copy.nav.people}</LinkButton> : undefined}
        />
      ) : q ? (
        <DirectorySearchResults entries={entries.data} q={q} lookup={lookup} />
      ) : (
        <DirectoryGroups groups={groups} entries={entries.data} lookup={lookup} personId={me.person.id} />
      )}
    </div>
  )
}

/** Like home search, only submitting pushes history; Back restores the submitted query. */
function DirectorySearchBox({ q }: { q: string }) {
  const navigate = useNavigate()
  const [value, setValue] = useState(q)
  const term = value.trim()
  const [followedQ, setFollowedQ] = useState(q)
  if (followedQ !== q) {
    setFollowedQ(q)
    if (term !== q) setValue(q)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (term !== q) void navigate({ href: paths.directorySearch(term) })
  }

  return (
    <form role="search" onSubmit={submit} className="relative">
      <label htmlFor="directory-search" className="sr-only">{copy.directory.search}</label>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-stone-400" />
      <input
        id="directory-search"
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={copy.directory.search}
        autoComplete="off"
        enterKeyHint="search"
        className="block h-12 w-full rounded-lg border border-stone-200 bg-white pr-24 pl-12 text-base text-stone-900 shadow-xs placeholder:text-stone-400 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent [&::-webkit-search-cancel-button]:hidden"
      />
      <div className="absolute top-1/2 right-2 -translate-y-1/2">
        <Button type="submit" tone="primary" size="sm">{copy.home.searchSubmit}</Button>
      </div>
    </form>
  )
}

function DirectoryGroups({ groups, entries, lookup, personId }: {
  groups: Group[]
  entries: DirectoryEntry[]
  lookup: AppViews
  personId: string
}) {
  const cards = groupDirectory(groups, entries, (entry) => isFinished(lookup.viewFor(entry)))
  const ownedUnfinished = entries.filter((entry) =>
    entry.owners.some((owner) => owner.id === personId) && !isFinished(lookup.viewFor(entry))
  )

  return (
    <div className="space-y-6">
      {cards.every((card) => card.appCount === 0) ? <EmptyState title={copy.directory.empty} /> : null}
      <ul className="grid gap-4 md:grid-cols-2">
        {cards.map((card) => {
          const myDrafts = ownedUnfinished.filter((entry) =>
            entry.group.path === card.group.path || entry.group.path.startsWith(`${card.group.path}/`)
          ).length
          return <li key={card.group.id} className="min-w-0"><GroupCard card={{ ...card, myDrafts }} /></li>
        })}
      </ul>
    </div>
  )
}

function GroupCard({ card }: { card: DirectoryGroupCard }) {
  return (
    <Card className="h-full">
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="min-w-0 break-words text-base font-semibold text-stone-900">
            <HrefLink href={paths.group(card.group.path)} className="inline-flex min-h-10 items-center hover:text-accent-strong hover:underline">
              {card.group.name}
            </HrefLink>
          </h2>
          <span className="shrink-0 text-xs text-stone-500">{copy.directory.count(card.appCount)}</span>
        </div>
        {card.children.length > 0 ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-stone-600">
            {card.children.map((child) => (
              <li key={child.id} className="min-w-0">
                <HrefLink href={paths.group(child.path)} className="inline-flex min-h-10 items-center break-words hover:text-accent-strong hover:underline">{child.name}</HrefLink>
              </li>
            ))}
            {card.moreChildren > 0 ? (
              <li><HrefLink href={paths.group(card.group.path)} className="inline-flex min-h-10 items-center text-stone-500 hover:underline">{copy.directory.moreChildren(card.moreChildren)}</HrefLink></li>
            ) : null}
          </ul>
        ) : null}
        {card.apps.length > 0 ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-2">
            {card.apps.map((entry) => (
              <li key={entry.id} className="min-w-0 max-w-full">
                <HrefLink href={entryHref(entry)} className="flex min-h-10 min-w-0 items-center gap-2 text-sm hover:text-accent-strong hover:underline">
                  <AppIcon icon={entry.icon} name={entry.displayName} size="sm" />
                  <span className="truncate">{entry.displayName}</span>
                </HrefLink>
              </li>
            ))}
          </ul>
        ) : null}
        {card.myDrafts > 0 ? (
          <HrefLink href={paths.drafts()} className="inline-flex min-h-10 items-center text-xs text-stone-500 hover:text-stone-800 hover:underline">{copy.directory.drafts(card.myDrafts)}</HrefLink>
        ) : null}
      </CardBody>
    </Card>
  )
}

function DirectorySearchResults({ entries, q, lookup }: { entries: DirectoryEntry[]; q: string; lookup: AppViews }) {
  const matches = storeOrder(entries.filter((entry) => isFinished(lookup.viewFor(entry)) && matchesDirectoryEntrySearch(entry, q)))
  const byGroup = new Map<string, { group: DirectoryEntry['group']; entries: DirectoryEntry[] }>()
  for (const entry of matches) {
    const section = byGroup.get(entry.group.id) ?? { group: entry.group, entries: [] }
    section.entries.push(entry)
    byGroup.set(entry.group.id, section)
  }
  const sections = [...byGroup.values()].sort((a, b) => a.group.name.localeCompare(b.group.name, 'ja') || a.group.path.localeCompare(b.group.path))

  return (
    <section aria-labelledby="directory-results" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="directory-results" className="text-lg font-semibold text-stone-900">{copy.home.resultsTitle(q)}</h2>
          <p aria-live="polite" aria-atomic="true" className="mt-1 text-sm text-stone-500">{text.home.resultsCount(matches.length)}</p>
        </div>
        <HrefLink href={paths.directory} className="inline-flex min-h-10 items-center gap-1 text-sm text-stone-500 hover:text-stone-800 hover:underline">
          <X aria-hidden className="size-4" />{copy.home.searchClear}
        </HrefLink>
      </div>
      {sections.length === 0 ? <EmptyState icon={<Search aria-hidden />} title={copy.home.noResults} /> : sections.map((section) => (
        <section key={section.group.id} aria-labelledby={`directory-${section.group.id}`}>
          <h3 id={`directory-${section.group.id}`} className="mb-2 text-base font-semibold text-stone-900">
            <HrefLink href={paths.group(section.group.path)} className="inline-flex min-h-10 items-center hover:text-accent-strong hover:underline">{section.group.name}</HrefLink>
          </h3>
          <AppStoreGrid entries={section.entries} lookup={lookup} heading="h4" />
        </section>
      ))}
    </section>
  )
}
