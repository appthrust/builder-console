import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { ExternalLink, FolderTree, LayoutGrid } from 'lucide-react'
import { directoryLinks } from '../../api/console'
import { pathPrefixes, type Group } from '../../model/contracts/console'
import { type Membership } from '../../model/contracts/console'
import { appsQuery, membersQuery } from '../../api/queries/console'
import { copy } from '../../copy'
import { paths, type GroupTab } from '../../routes/paths'
import { locale } from '../../shell/language'
import { useShell } from '../../shell/use-shell'
import { EmptyState, HrefLink, LinkButton, LinkTabs, LoadFailed, PageHeader, Skeleton, useDocumentTitle } from '../../ui'
import { useAppViews } from '../app/use-app-views'
import { StaleNotice } from '../app/notices'
import { AppListSkeleton, AppTable, StatusLoadNotice } from './app-list'
import { text } from './copy'
import { GroupFront } from './group-front'
import { GroupMembers, splitMembers } from './members'

const TABS: GroupTab[] = ['front', 'apps', 'members']

/**
 * A group's front page, with app and member sub-pages. Read-only: the group
 * itself (name, place in the tree, introduction, members) is managed in the Directory.
 */
export function GroupPage({ group, tab = 'front' }: { group: Group; tab?: GroupTab }) {
  useDocumentTitle(group.name)
  const { me, groups } = useShell()
  const crumbs = pathPrefixes(group.path)
    .slice(0, -1)
    .flatMap((prefix) => groups.filter((candidate) => candidate.path === prefix))
    .map((ancestor) => ({ label: ancestor.name, href: paths.group(ancestor.path) }))
  const children = groups
    .filter((candidate) => candidate.parentId === group.id)
    .sort((a, b) => a.name.localeCompare(b.name, locale()))
  // Same query as the front and member tabs, so the page loads the member list once.
  const members = useQuery({ ...membersQuery(group.id), enabled: !group.description })

  return (
    <div className="space-y-6">
      <PageHeader
        title={group.name}
        lead={group.description || memberCountLead(members)}
        breadcrumbs={crumbs}
        actions={me.directoryPublicURL ? (
          <LinkButton href={directoryLinks.group(me.directoryPublicURL, group.id)} external size="sm" icon={<ExternalLink />}>
            {copy.group.manageInDirectory}
          </LinkButton>
        ) : undefined}
      />
      <LinkTabs
        label={copy.group.tabsLabel}
        current={tab}
        tabs={TABS.map((id) => ({ id, label: copy.group.tabs[id], href: paths.group(group.path, id) }))}
      />
      {tab === 'front' ? (
        <GroupFront key={group.id} group={group} subgroups={children} />
      ) : tab === 'apps' ? (
        <GroupApps group={group} subgroups={children} />
      ) : (
        <GroupMembers key={group.id} group={group} />
      )}
    </div>
  )
}

/**
 * Headline count = the group's own members; people who only reach it through an upper
 * group follow as quieter text. The effective `memberCount` is never shown here, so
 * nothing is drawn until the member list says which members are direct.
 */
function memberCountLead(members: UseQueryResult<Membership[]>) {
  if (members.isPending) {
    return (
      <span role="status" aria-label={copy.common.loading} className="block">
        <Skeleton className="h-5 w-40" />
      </span>
    )
  }
  if (members.isLoadingError) return undefined
  const { direct, inherited } = splitMembers(members.data)
  return (
    <>
      {copy.group.memberCount(direct.length)}
      {inherited.length > 0 ? <span className="text-xs">{copy.group.inheritedCount(inherited.length)}</span> : null}
    </>
  )
}

function GroupApps({ group, subgroups }: { group: Group; subgroups: Group[] }) {
  const { me } = useShell()
  const apps = useQuery(appsQuery({ scope: 'all', groupId: group.id }))
  const lookup = useAppViews(me.projectId)
  // The list covers the whole subtree, so each subgroup's count is the apps at or below its path.
  const countIn = (child: Group) => apps.data?.filter((app) => app.group.path === child.path || app.group.path.startsWith(`${child.path}/`)).length
  return (
    <div className="space-y-6">
      {subgroups.length > 0 ? (
        <section aria-labelledby={`sub-${group.id}`}>
          <h2 id={`sub-${group.id}`} className="mb-2 text-sm font-medium text-stone-500">
            {copy.group.subgroups}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {subgroups.map((child) => (
              <li key={child.id}>
                <HrefLink
                  href={paths.group(child.path)}
                  className="inline-flex min-h-10 items-center gap-2 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-700 transition-colors hover:border-accent hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <FolderTree aria-hidden className="size-4 text-stone-400" />
                  {child.name}
                  {apps.data ? <span className="rounded-full bg-stone-100 px-1.5 text-xs text-stone-500">{countIn(child)}</span> : null}
                </HrefLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <StatusLoadNotice lookup={lookup} />
      {apps.isRefetchError ? <StaleNotice updatedAt={apps.dataUpdatedAt} refetching={apps.isFetching} onRetry={() => void apps.refetch()} /> : null}
      {apps.isPending ? (
        <AppListSkeleton />
      ) : apps.isLoadingError ? (
        <LoadFailed error={apps.error} onRetry={() => void apps.refetch()} />
      ) : (
        <AppTable
          apps={apps.data}
          lookup={lookup}
          showGroup={subgroups.length > 0}
          caption={group.name}
          emptyState={
            <EmptyState
              icon={<LayoutGrid aria-hidden />}
              title={copy.group.appsEmpty}
              body={me.canCreateApps ? text.group.emptyBody : undefined}
              action={
                me.canCreateApps ? (
                  <LinkButton tone="primary" href={paths.new({ group: group.path })}>
                    {text.group.createHere}
                  </LinkButton>
                ) : undefined
              }
            />
          }
        />
      )}
    </div>
  )
}
