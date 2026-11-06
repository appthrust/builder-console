import { useQuery } from '@tanstack/react-query'
import { LayoutGrid } from 'lucide-react'
import { appsQuery } from '../../api/queries'
import { copy } from '../../copy'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { EmptyState, LinkButton, LoadFailed, PageHeader, useDocumentTitle } from '../../ui'
import { useAppViews } from '../app/use-app-views'
import { AppListSkeleton, AppTable, StatusLoadNotice, usePendingAccessRequestCounts } from './app-list'
import { text } from './copy'

/**
 * Apps whose 担当者 includes the caller (ux-design §7.1 自分のアプリ); empty → the create path.
 * Only apps that exist (bound to the platform); anything half-made is under 作りかけ (drafts.tsx).
 */
export function MinePage({ status }: { status?: 'problem' }) {
  useDocumentTitle(copy.mine.title)
  const { me, currentGroup } = useShell()
  const apps = useQuery(appsQuery({ scope: 'mine' }))
  const lookup = useAppViews(me.projectId)
  const pendingCounts = usePendingAccessRequestCounts()
  const problemOnly = status === 'problem'
  const bound = (apps.data ?? []).filter((app) => app.stackId)
  const visible = problemOnly ? bound.filter((app) => lookup.viewFor(app).status === 'failed') : bound
  return (
    <div className="space-y-6">
      <PageHeader title={copy.mine.title} lead={problemOnly ? text.mine.problemLead : copy.mine.lead}
        actions={problemOnly ? <LinkButton href={paths.mine()}>{text.mine.seeAll}</LinkButton> : undefined} />
      <StatusLoadNotice lookup={lookup} />
      {apps.isPending || (problemOnly && lookup.loading) ? (
        <AppListSkeleton />
      ) : apps.isError ? (
        <LoadFailed error={apps.error} onRetry={() => void apps.refetch()} />
      ) : (
        <AppTable
          apps={visible}
          lookup={lookup}
          pendingCounts={pendingCounts}
          showGroup
          expandReason={problemOnly}
          caption={copy.mine.title}
          emptyState={problemOnly ? <EmptyState icon={<LayoutGrid aria-hidden />} title={lookup.failed ? text.mine.statusFailed : text.mine.noProblems} /> :
            <EmptyState
              icon={<LayoutGrid aria-hidden />}
              title={copy.mine.empty}
              body={me.canCreateApps ? text.mine.emptyBody : text.mine.cannotCreate}
              action={
                me.canCreateApps ? (
                  <LinkButton tone="primary" href={paths.new({ group: currentGroup?.path })}>
                    {copy.mine.emptyAction}
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
