import { useQuery } from '@tanstack/react-query'
import { AppWindow } from 'lucide-react'
import { Fragment } from 'react'
import type { PersonProfile } from '../../api/console'
import { directoryAppsQuery } from '../../api/queries'
import { copy } from '../../copy'
import { isFinished, storeOrder } from '../../model/directory'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { Avatar, EmptyState, HrefLink, LoadFailed, PageHeader, Section, Skeleton, useDocumentTitle } from '../../ui'
import { useAppViews } from '../app/use-app-views'
import { StatusLoadNotice } from './app-list'
import { AppStoreGrid, AppStoreGridSkeleton } from './app-store-card'
import { text } from './copy'

/**
 * Stand-in maker card for when no Directory is linked (the route otherwise
 * redirects to the Directory profile): name, direct groups and the finished
 * apps they own. No email on screen; the picture is changed in the Directory.
 */
export function PersonPage({ profile }: { profile: PersonProfile }) {
  const { person, memberships } = profile
  useDocumentTitle(person.displayName)
  const { me } = useShell()
  const apps = useQuery(directoryAppsQuery({ ownerId: person.id }))
  const lookup = useAppViews(me.projectId)
  const loading = apps.isPending || lookup.loading
  const finished = storeOrder((apps.data ?? []).filter((entry) => isFinished(lookup.viewFor(entry))))
  const ordered = memberships
    .filter((membership) => membership.inheritedFrom === null)
    .sort((a, b) =>
      (a.role === b.role ? 0 : a.role === 'manager' ? -1 : 1) || a.group.path.split('/').length - b.group.path.split('/').length || a.group.name.localeCompare(b.group.name, 'ja')
    )

  return (
    <div className="space-y-8">
      <PageHeader
        breadcrumbs={[{ label: copy.directory.title, href: paths.directory }]}
        media={<Avatar person={person} size="lg" />}
        title={<span className="break-words">{person.displayName}</span>}
      >
        {ordered.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-600">
            <span className="sr-only">{text.person.memberships}: </span>
            {ordered.map((membership, index) => (
              <Fragment key={membership.group.id}>
                {index > 0 ? <span aria-hidden>・</span> : null}
                <span className="inline-flex items-center gap-1.5">
                  <HrefLink href={paths.group(membership.group.path)} className="inline-flex min-h-10 items-center text-accent-strong hover:underline md:min-h-8">{membership.group.name}</HrefLink>
                  {membership.role === 'manager' ? <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">{copy.members.role.manager}</span> : null}
                </span>
              </Fragment>
            ))}
          </p>
        ) : null}
      </PageHeader>

      <Section title={apps.isError ? text.person.appsLoading : loading ? <span aria-label={copy.common.loading}><Skeleton className="h-5 w-48" /></span> : text.person.apps(finished.length)}>
        <div className="space-y-4">
          <StatusLoadNotice lookup={lookup} />
          {apps.isError ? (
            <LoadFailed error={apps.error} onRetry={() => void apps.refetch()} />
          ) : loading ? (
            <AppStoreGridSkeleton />
          ) : finished.length === 0 ? (
            <EmptyState icon={<AppWindow aria-hidden />} title={text.person.noApps} />
          ) : (
            <AppStoreGrid entries={finished} lookup={lookup} />
          )}
        </div>
      </Section>
    </div>
  )
}
