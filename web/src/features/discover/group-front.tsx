import { useQuery } from '@tanstack/react-query'
import { FolderTree } from 'lucide-react'
import type { Group } from '../../model/contracts/console'
import { directoryAppsQuery, membersQuery } from '../../api/queries/console'
import { copy, relativeTime } from '../../copy'
import { isFinished, makersOf, storeOrder, storeScore, type Maker } from '../../model/directory'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { Avatar, Disclosure, EmptyState, HrefLink, LoadFailed, Markdown, PersonLink, Section, Skeleton } from '../../ui'
import { useAppViews } from '../app/use-app-views'
import { StatusLoadNotice } from './app-list'
import { AppStoreGrid, AppStoreGridSkeleton } from './app-store-card'
import { text } from './copy'

/** The group's introduction (written in the Directory), its contacts, makers and finished apps. */
export function GroupFront({ group, subgroups }: { group: Group; subgroups: Group[] }) {
  const { me } = useShell()
  const members = useQuery(membersQuery(group.id))
  const apps = useQuery(directoryAppsQuery({ groupId: group.id }))
  const lookup = useAppViews(me.projectId)
  const contacts = members.data?.filter((member) => member.inheritedFrom == null && member.role === 'manager') ?? []
  const finished = storeOrder((apps.data ?? []).filter((entry) => isFinished(lookup.viewFor(entry))))
  const introduced = finished.filter((entry) => storeScore(entry) > 0)
  const trial = finished.filter((entry) => storeScore(entry) === 0)
  const makers = makersOf(finished)
  const updated = relativeTime(group.aboutUpdatedAt ?? undefined)
  const loadingApps = apps.isPending || lookup.loading

  return (
    <div className="space-y-8">
      <section aria-label={copy.group.about} className="space-y-4">
        {group.about.trim() ? <Markdown source={group.about} /> : <EmptyState title={copy.group.aboutEmpty} />}
        {members.isPending ? (
          <div role="status" aria-label={copy.common.loading}><Skeleton className="h-4 w-48" /></div>
        ) : members.isError ? (
          <LoadFailed error={members.error} onRetry={() => void members.refetch()} />
        ) : contacts.length > 0 ? (
          <p className="text-sm text-stone-600">{copy.group.contacts}: {contacts.map((member) => member.person.displayName).join('、')}</p>
        ) : null}
        {group.aboutUpdatedBy || updated ? (
          <p className="text-xs text-stone-500">
            {copy.group.lastUpdated}: {group.aboutUpdatedBy?.displayName}
            {group.aboutUpdatedBy && updated ? ' · ' : null}
            {group.aboutUpdatedAt && updated ? <time dateTime={group.aboutUpdatedAt}>{updated}</time> : null}
          </p>
        ) : null}
      </section>

      {!loadingApps && !apps.isError && makers.length > 0 ? <MakerRow makers={makers} /> : null}

      <Section
        title={apps.isError ? copy.group.apps : loadingApps ? <span aria-label={copy.common.loading}><Skeleton className="h-5 w-64" /></span> : copy.group.finishedApps(finished.length)}
        actions={<HrefLink href={paths.group(group.path, 'apps')} className="inline-flex min-h-10 items-center text-sm font-medium text-accent-strong hover:underline">{copy.group.all}</HrefLink>}
      >
        <div className="space-y-4">
          <StatusLoadNotice lookup={lookup} />
          {apps.isError ? (
            <LoadFailed error={apps.error} onRetry={() => void apps.refetch()} />
          ) : loadingApps ? (
            <AppStoreGridSkeleton />
          ) : finished.length === 0 ? (
            <EmptyState title={copy.directory.empty} />
          ) : (
            <>
              {introduced.length > 0 ? <AppStoreGrid entries={introduced} lookup={lookup} showGroup={false} /> : null}
              {trial.length > 0 ? (
                <Disclosure title={text.store.trial(trial.length)} defaultOpen={introduced.length === 0}>
                  <p className="mb-3 text-xs text-stone-500">{text.store.trialLead}</p>
                  <AppStoreGrid entries={trial} lookup={lookup} showGroup={false} />
                </Disclosure>
              ) : null}
            </>
          )}
        </div>
      </Section>

      {subgroups.length > 0 ? (
        <Section title={copy.group.children}>
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {subgroups.map((child) => (
              <li key={child.id} className="min-w-0">
                <HrefLink href={paths.group(child.path)} className="inline-flex min-h-10 items-center gap-2 text-sm text-accent-strong hover:underline">
                  <FolderTree aria-hidden className="size-4 shrink-0" />
                  <span className="break-words">{child.name}</span>
                </HrefLink>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}

/** 「この部署で作っている人」: everyone who owns a finished app in the subtree, linking to their page. */
function MakerRow({ makers }: { makers: Maker[] }) {
  return (
    <Section title={text.store.makers}>
      <ul className="flex flex-wrap gap-2">
        {makers.map(({ person, appCount }) => (
          <li key={person.id} className="min-w-0">
            <PersonLink
              personId={person.id}
              className="inline-flex min-h-10 min-w-0 items-center gap-2 rounded-full border border-stone-200 bg-white py-1 pr-3 pl-1 text-sm text-stone-800 hover:border-stone-300 hover:bg-stone-50 hover:text-accent-strong"
            >
              <Avatar person={person} />
              <span className="truncate">{person.displayName}</span>
              <span className="shrink-0 text-xs text-stone-500">{text.store.makerApps(appCount)}</span>
            </PersonLink>
          </li>
        ))}
      </ul>
    </Section>
  )
}
