// App detail (ux-design §7.3): header with the app URL as the hero, then tabs
// 概要 / つかいかた / データ / 更新履歴 / 設定 / ログ. The route resolves `/<group-path>/<slug>` to the
// BusinessApp; the platform side is joined by `stackId` (src/model/app.ts).
import { ExternalLink, Lock, MoreHorizontal, Pencil, Trash2, Users } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { appAccessRequestsQuery, useGroups, useMe } from '../../api/queries/console'
import { databaseTablesQuery, isDataForbidden, isDataMembershipUnbound } from '../../api/queries/data'
import { isLogsForbidden, useComponentLogs } from '../../api/queries/app'
import { useSourceRepositories } from '../../api/queries/catalog'
import { copy, relativeTime } from '../../copy'
import type { AppView } from '../../model/app'
import { isOneOf } from '../../model/contracts/build'
import type { BusinessApp } from '../../model/contracts/console'
import { shareSentence } from '../../model/share'
import { deriveAccess } from '../../model/access'
import { AccessForbiddenError } from '../../api/access'
import { sharingCopy } from '../../copy/sharing'
import { useCreatedAppAccess } from '../create/access'
import { ShareDialog } from './share-dialog'
import { PendingBadge } from './pending-badge'
import { paths, type AppTab } from '../../routes/paths'
import {
  AppIcon,
  Button,
  CopyButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  HrefLink,
  LinkButton,
  LinkTabs,
  LoadFailed,
  Loading,
  StatusPill,
  useDocumentTitle,
} from '../../ui'
import { text } from './copy'
import { DataTab } from './data/data-tab'
import { dataText } from './data/copy'
import { DeleteAppDialog } from './delete-dialog'
import { GuideTab } from './guide-tab'
import { LogsTab } from './logs-tab'
import { OverviewTab } from './overview-tab'
import { canEditApp } from './permissions'
import { lastUpdate, sourceRepositoryFor } from './platform'
import { ReleasesTab } from './releases-tab'
import { SettingsTab } from './settings-tab'
import { readCreateSession } from '../create/persistence'
import { useAppViews } from './use-app-views'
import { StaleNotice } from './notices'
import { OwnerLinks } from './owner-links'
import { ImproveButton } from '../improve/entry'
import { BuildFailureNotice } from '../build/build-failure-notice'
import { proposalsOptions } from '../../api/queries/proposal'
import { text as proposalText } from '../proposals/copy'

const TABS: readonly AppTab[] = ['overview', 'guide', 'data', 'releases', 'settings', 'logs']

/** `app` comes from the route's live `appQuery`, so edits made here flow back in. */
export function AppPage({ app, tab }: { app: BusinessApp; tab: AppTab }) {
  useDocumentTitle(app.displayName)
  const me = useMe().data
  const projectId = me.projectId
  const groups = useGroups().data
  const views = useAppViews(projectId)
  const repositories = useSourceRepositories(projectId)
  const view = views.viewFor(app)
  const creationAccess = useCreatedAppAccess(projectId, app, view.platform?.publish)
  const [manualAccessError, setManualAccessError] = useState<unknown>(null)
  const accessError = manualAccessError ?? creationAccess.error
  const access = deriveAccess(view.platform?.publish?.access, app, groups, accessError instanceof AccessForbiddenError ? 'forbidden' : accessError ? 'failed' : undefined)
  const logs = useComponentLogs(projectId, view.platform?.webComponentId, view.platform?.branchId, tab === 'logs')
  const logsForbidden = isLogsForbidden(logs.error)
  const sharing = shareSentence(app.share, groups, app.group)
  const canEdit = canEditApp(app, me)
  const requests = useQuery({ ...appAccessRequestsQuery(app.id), enabled: canEdit })
  const pendingCount = canEdit ? requests.data?.filter((request) => isOneOf(request.status, 'pending')).length ?? 0 : 0
  // Phase 1: the データ tab exposes every row, so only people who may edit the app see it (design "Authorization and privacy").
  const databaseId = canEdit ? view.stack?.databaseComponentId : undefined
  // A data URL for an app without the tab shows the overview once the stacks are known.
  const current: AppTab = tab === 'data' && !databaseId && !views.loading ? 'overview' : tab
  const dataTables = useQuery({ ...databaseTablesQuery(projectId, databaseId), enabled: current === 'data' })
  const dataLockedTitle = isDataForbidden(dataTables.error)
    ? dataText.forbiddenTitle
    : isDataMembershipUnbound(dataTables.error) ? dataText.membershipUnboundTitle : undefined
  const session = view.draft ? readCreateSession(app.id) : undefined
  const sourceRepository = view.draft
    ? repositories.data?.data.find((repository) => repository.id === session?.progress.sourceRepositoryId)
    : sourceRepositoryFor(view, repositories.data?.data)
  const [deleting, setDeleting] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  const tabs = TABS.filter((id) => id !== 'data' || databaseId).map((id) => {
    const lockedTitle = id === 'logs' && logsForbidden ? text.logs.forbiddenTitle : id === 'data' ? dataLockedTitle : undefined
    return {
      id,
      label: lockedTitle ? <span className="inline-flex items-center gap-1.5"><Lock aria-label={lockedTitle} className="size-3.5" />{copy.app.tabs[id]}</span> : copy.app.tabs[id],
      href: paths.app(app.group.path, app.slug, id),
    }
  })

  return (
    <div className="mx-auto w-full max-w-5xl">
      <AppHeader app={app} view={view} projectId={projectId} sharing={access.label} canEdit={canEdit} pendingCount={pendingCount} onShare={() => setShareOpen(true)} onDelete={() => setDeleting(true)} />
      <BuildFailureNotice failure={view.stack?.buildFailure} projectId={projectId} stackId={app.stackId ?? undefined} title={app.displayName} canEdit={canEdit} />

      <div className="mt-8">
        <LinkTabs label={text.header.tabsLabel} tabs={tabs} current={current} />
      </div>

      <div>
        {views.stale && !views.failed ? <div className="mt-4"><StaleNotice updatedAt={views.updatedAt} refetching={views.refetching} onRetry={views.refetch} /></div> : null}
        {views.failed ? (
          <LoadFailed onRetry={views.refetch} error={views.error} />
        ) : current === 'overview' ? (
          <OverviewTab
            projectId={projectId}
            app={app}
            view={view}
            sharing={sharing}
            access={access}
            accessError={accessError}
            sourceRepository={sourceRepository}
            canEdit={canEdit}
            onDelete={() => setDeleting(true)}
          />
        ) : current === 'guide' ? (
          <GuideTab key={app.id} app={app} view={view} canEdit={canEdit} />
        ) : current === 'data' ? (
          views.loading ? <Loading /> : <DataTab projectId={projectId} app={app} view={view} canEdit={canEdit} isAdmin={me.isConsoleAdmin} />
        ) : current === 'releases' ? (
          <ReleasesTab projectId={projectId} view={view} />
        ) : current === 'settings' ? (
          <SettingsTab projectId={projectId} app={app} view={view} access={access} onShare={() => setShareOpen(true)} sourceRepository={sourceRepository} canEdit={canEdit} onDelete={() => setDeleting(true)} />
        ) : (
          <LogsTab app={app} view={view} logs={logs} isAdmin={me.isConsoleAdmin} />
        )}
      </div>

      {canEdit ? <DeleteAppDialog projectId={projectId} app={app} view={view} sourceRepository={sourceRepository} open={deleting} onOpenChange={setDeleting} /> : null}
      {shareOpen ? <ShareDialog app={app} me={me} canEdit={canEdit} publishId={view.platform?.publish?.id} url={view.url} access={access} open={shareOpen} onOpenChange={setShareOpen} onAccessError={setManualAccessError} /> : null}
    </div>
  )
}

function AppHeader({
  app,
  view,
  projectId,
  sharing,
  canEdit,
  pendingCount,
  onShare,
  onDelete,
}: {
  app: BusinessApp
  view: AppView
  projectId: string
  sharing: string
  canEdit: boolean
  pendingCount: number
  onShare: () => void
  onDelete: () => void
}) {

  const updatedAt = relativeTime(lastUpdate(app, view))
  const settingsHref = paths.app(app.group.path, app.slug, 'settings')
  // AI improvement needs a live binding and never competes with an unfinished build session.
  const improvable = canEdit && !(view.build && view.build.phase !== 'done')
  const proposals = useQuery({ ...proposalsOptions(projectId, { applicationId: view.stack?.applicationId, phase: 'Proposed' }), enabled: canEdit && !!view.stack?.applicationId })

  return (
    <header>
      {/* The actions wrap under the name when the row cannot keep the name readable (phones). */}
      <div className="flex flex-wrap items-start gap-4">
        <AppIcon icon={app.icon} name={app.displayName} size="lg" />
        <div className="min-w-0 flex-[1_1_10rem]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-xl font-semibold break-words text-stone-900">{app.displayName}</h1>
            <StatusPill status={view.status} label={view.label} />
          </div>
          <p className="mt-1.5 text-sm text-stone-700" data-testid="status-text">
            {view.second}
          </p>
          {view.build && view.build.phase !== 'done' ? (
            <HrefLink href={paths.build(view.build.draftId)} className="mt-2 inline-flex min-h-8 items-center text-sm font-medium text-accent-strong underline">{text.overview.resume}</HrefLink>
          ) : null}
          <ul className="mt-2 flex flex-col gap-0.5 text-xs text-stone-500 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2" data-testid="app-meta">
            <li className="inline-flex items-center gap-1">
              <HrefLink href={paths.group(app.group.path)} className="inline-flex min-h-8 items-center text-stone-600 hover:text-accent-strong hover:underline">{app.group.name}</HrefLink>
            </li>
            <li className="inline-flex items-center gap-1 sm:before:mr-1 sm:before:content-['・']">
              <span data-testid="header-access-status">{sharing}</span>
            </li>
            <li className="inline-flex min-w-0 items-center gap-1.5 sm:before:mr-0.5 sm:before:content-['・']">
              {copy.app.owners} <OwnerLinks owners={app.owners} className="text-xs" />
            </li>
            {updatedAt ? <li className="sm:before:mr-2 sm:before:content-['・']">{copy.app.updated(updatedAt)}</li> : null}
          </ul>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-4">
          {canEdit && view.stack?.applicationId ? <LinkButton href={paths.proposals(view.stack.applicationId)} size="sm">{proposalText.title}<PendingBadge count={proposals.data?.data.length ?? 0} /></LinkButton> : null}
          {improvable && app.stackId ? <ImproveButton app={app} stackId={app.stackId} projectId={projectId} /> : null}
          <Button onClick={onShare} icon={<Users />} aria-label={sharingCopy.title}>{sharingCopy.title}<PendingBadge count={pendingCount} /></Button>
          {canEdit ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button tone="secondary" aria-label={text.header.menu} className="w-9 px-0" icon={<MoreHorizontal />} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <HrefLink href={settingsHref}>
                    <Pencil aria-hidden />
                    {text.header.edit}
                  </HrefLink>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onShare}>
                  <Users aria-hidden />
                  {text.header.share}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={onDelete}
                  className="text-bad-ink data-highlighted:bg-bad-soft data-highlighted:text-bad-ink [&_svg]:text-bad"
                >
                  <Trash2 aria-hidden />
                  {text.header.delete}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      {canEdit && proposals.error ? <LoadFailed error={proposals.error} onRetry={() => void proposals.refetch()} /> : null}

      <div className="mt-5 flex flex-col gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-stone-500">{text.header.urlLabel}</p>
          {view.url ? (
            <a
              href={view.url}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 block font-mono text-[15px] break-all text-accent-strong underline-offset-2 hover:underline"
              data-testid="app-url"
            >
              {view.url}
            </a>
          ) : (
            <p className="mt-0.5 text-sm text-stone-500">{copy.app.noUrl}</p>
          )}
        </div>
        {view.url ? (
          <div className="flex shrink-0 items-center gap-2">
            <CopyButton value={view.url} label={copy.app.copyUrl} />
            <LinkButton external href={view.url} tone="primary" icon={<ExternalLink />}>
              {copy.app.open}
            </LinkButton>
          </div>
        ) : null}
      </div>
    </header>
  )
}
