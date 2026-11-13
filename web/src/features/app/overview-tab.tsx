import type { ApplicationSourceRepository } from '@appthrust/api-schema/platform-api'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, History, ScrollText } from 'lucide-react'
import type { ReactNode } from 'react'
import type { BusinessApp } from '../../api/console-unverified'
import { keys } from '../../api/queries/shared'
import { copy } from '../../copy'
import type { AppView } from '../../model/app'
import type { AccessDisplay } from '../../model/access'
import { buildCopy } from '../../model/build/copy'
import { hasCreatedAppAccess } from '../create/access'
import { deriveCreateProgress, repositoryLabel, showsCreateProgress } from '../../model/progress'
import { paths } from '../../routes/paths'
import { ActionError, Button, Card, CardBody, CardHeader, Disclosure, HrefLink, LinkButton, StatusPill } from '../../ui'
import { AppAbout, GuideSummary } from './app-about'
import { text } from './copy'
import { DatabaseChanges } from './database-changes'
import { ProgressList } from './progress-list'
import { readCreateSession } from '../create/persistence'
import { OwnerContact } from './owner-contact'
import { OwnerLinks } from './owner-links'
import { ScreenshotStrip } from './screenshots'
import { ToolsPanel } from './tools-panel'

export function OverviewTab({
  projectId,
  app,
  view,
  sharing,
  access,
  accessError,
  sourceRepository,
  canEdit,
  onDelete,
}: {
  projectId: string
  app: BusinessApp
  view: AppView
  sharing: string
  access: AccessDisplay
  accessError?: unknown
  sourceRepository: ApplicationSourceRepository | undefined
  canEdit: boolean
  onDelete: () => void
}) {
  const queryClient = useQueryClient()
  // The creation marker outlives the URL step until the requested audience is
  // observed on the publish; once applied, the plain overview takes over.
  const finishingCreation = hasCreatedAppAccess(app.id) && !access.applied
  const creating = sourceRepository?.build?.state !== 'failed' && (view.draft || showsCreateProgress(view) || finishingCreation)
  const session = view.draft ? readCreateSession(app.id) : undefined
  const steps = creating ? deriveCreateProgress({ view, sourceRepository, shareSentence: sharing, access }) : []
  if (view.status === 'unfinished') {
    const failedIndex = steps.findIndex((step) => step.state === 'active')
    if (failedIndex >= 0) {
      const step = steps[failedIndex]!
      steps[failedIndex] = { ...step, state: 'failed', title: text.overview.draftStepStopped, detail: session?.failure?.message ?? view.draftReason }
    }
  }
  const failedStep = steps.find((step) => step.state === 'failed' && !step.action)
  const stack = view.stack
  const repositoriesKey = keys.sourceRepositories(stack?.projectId ?? sourceRepository?.projectId ?? projectId)
  const rechecking = useIsFetching({ queryKey: repositoriesKey }) > 0
  const port = view.platform?.webPort?.toString()
  const adopted = sourceRepository?.existing?.repository
  const repositoryUrl = sourceRepository?.repositoryUrl ?? (adopted ? `https://github.com/${adopted}` : undefined)


  // The store face (store-ux §3.4): pictures, what it does, how to use it. While the app is still being
  // made, its progress is what matters, so the face goes below it until then.
  const face = (
    <div className="space-y-8">
      {/* Pictures are served only for bound apps, so a draft has nowhere to show them yet. */}
      {app.stackId !== null ? <ScreenshotStrip appId={app.id} screenshots={app.screenshots} canEdit={canEdit} /> : null}
      <AppAbout description={app.description} capabilities={app.capabilities} tags={app.tags} />
      <GuideSummary guide={app.guide} href={paths.app(app.group.path, app.slug, 'guide')} canEdit={canEdit} />
      <ToolsPanel appId={app.id} />
    </div>
  )

  const details = (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader title={view.status === 'unfinished' ? copy.statusText.draftStale : creating ? copy.progress.title : copy.app.overview.status} />
          <CardBody>
            {creating ? (
              <>
                <ProgressList
                  steps={steps}
                  onRecheck={() => void queryClient.refetchQueries({ queryKey: repositoriesKey })}
                  rechecking={rechecking}
                />
                {failedStep && !view.draft ? (
                  <p className="mt-5 text-sm text-stone-600" data-testid="overview-status-help">
                    {failedStep.help ?? copy.progress.failedHelp}
                  </p>
                ) : null}
              </>
            ) : (
              <div className="flex items-start gap-3">
                <StatusPill status={view.status} label={view.label} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-stone-800" data-testid="overview-status-text">
                    {view.second}
                  </p>
                  {view.help ? (
                    <p className="mt-2 text-sm text-stone-600" data-testid="overview-status-help">
                      {view.help}
                    </p>
                  ) : null}
                </div>
              </div>
            )}

            {view.status === 'failed' ? (
              <div className="mt-5 border-t border-stone-100 pt-4">
                <p className="text-xs font-medium text-stone-500">{text.overview.next}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <LinkButton href={paths.app(app.group.path, app.slug, 'logs')} icon={<ScrollText />}>
                    {copy.app.overview.nextLogs}
                  </LinkButton>
                  <LinkButton href={paths.app(app.group.path, app.slug, 'releases')} icon={<History />}>
                    {copy.app.overview.nextReleases}
                  </LinkButton>
                </div>
              </div>
            ) : null}
            {view.status === 'unfinished' ? (
              <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-stone-100 pt-4">
                {canEdit ? <LinkButton tone="primary" href={paths.new({ resume: app.id })}>{text.overview.resume}</LinkButton> : null}
                <OwnerContact app={app} />
                {canEdit ? <Button tone="ghost" onClick={onDelete}>{text.overview.draftStaleAction}</Button> : null}
              </div>
            ) : null}

            {accessError ? <ActionError error={accessError} /> : null}
          </CardBody>
        </Card>

        {/* Same audience as the データ tab: only people who may edit the app see or approve its database changes. */}
        <DatabaseChanges projectId={projectId} databaseId={canEdit ? stack?.databaseComponentId : undefined} />

        <Card>
          <CardHeader title={text.overview.placement} />
          <CardBody>
            <dl className="divide-y divide-stone-100">
              <Row label={copy.app.overview.group}>
                <HrefLink href={paths.group(app.group.path)} className="text-accent-strong underline-offset-2 hover:underline">
                  {app.group.name}
                </HrefLink>
              </Row>
              <Row label={copy.app.owners}><OwnerLinks owners={app.owners} className="-my-2" /></Row>
              <Row label={copy.app.settings.share}><span data-testid="overview-access-status">{access.label}</span></Row>
              {repositoryUrl ? <Row label={copy.app.overview.source}>
                  <a
                    href={repositoryUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 break-all text-accent-strong underline-offset-2 hover:underline"
                    data-testid="source-link"
                  >
                    {repositoryLabel(repositoryUrl)}
                    <ExternalLink aria-hidden className="size-3.5 shrink-0" />
                  </a>
              </Row> : null}
            </dl>
          </CardBody>
        </Card>
      </div>

      <aside className="min-w-0">
        <Disclosure title={copy.app.overview.advanced.toggle}>
          <dl className="space-y-3 text-xs">
            {(
              [
                [copy.app.overview.advanced.image, stack?.imageRef],
                [copy.app.overview.advanced.port, port],
                [copy.app.overview.advanced.template, stack?.templateId],
                [copy.app.overview.advanced.appName, app.appName ?? undefined],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-stone-500">{label}</dt>
                <dd className="mt-0.5 font-mono break-all text-stone-800">{value ?? copy.app.overview.advanced.none}</dd>
              </div>
            ))}
            {sourceRepository?.build?.runUrl ? <div>
              <dt className="text-stone-500">{buildCopy.sourceBuild.run}</dt>
              <dd className="mt-0.5 break-all"><a href={sourceRepository.build.runUrl} target="_blank" rel="noopener noreferrer" className="text-accent-strong underline">{sourceRepository.build.runUrl}</a></dd>
            </div> : null}
          </dl>
        </Disclosure>
      </aside>
    </div>
  )

  return <div className="space-y-10">{creating ? <>{details}{face}</> : <>{face}{details}</>}</div>
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 text-sm first:pt-0 last:pb-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-stone-500">{label}</dt>
      <dd className="min-w-0 break-words text-stone-900">{children}</dd>
    </div>
  )
}
