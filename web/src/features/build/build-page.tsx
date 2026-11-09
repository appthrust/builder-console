// AI build session IA (ai-build-session-ux §3):
// - Frame: the shell gives this route a viewport-height frame below the TopBar
//   (shell.tsx `workspace`). The page itself never scrolls.
// - Scroll ownership: exactly one scroller per visible pane. From md the
//   conversation (main column, ≥55% at 1280; messages capped near 70ch) and
//   「いま作っているもの」 (side column) scroll independently; below md the two
//   are tabs and only the selected one scrolls.
// - Header: one compact row (back · name · state · 4-step rail · stage action).
//   Below lg the rail and the action wrap to a second row, action right-aligned.
// - Actions: 「この内容で作る」 is attached to the AI's proposal message in
//   the conversation (the user reads what will be made, then commits there).
//   公開する / 続けて直す are page-level and sit at the header's right end; during
//   preparation the header shows the progress instead of a button.
// - Composer is pinned under the transcript as one calm object: answer options /
//   reply suggestions as one quiet chip row above a framed, auto-growing input
//   with the send button inside it. No footer; the keyboard hint is a description.
// - From md the side pane folds to a strip (toggle in its heading; the strip keeps
//   the ◔ progress mark and reopens it). The choice persists (shell store).
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { useQueryClient } from '@tanstack/react-query'
import { useSelector } from '@tanstack/react-store'
import { PanelRightOpen, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cleanupCreation, updateDraft } from '../../api/build'
import { buildKeys, useBuildDraft } from '../../api/build-queries'
import { useGroups } from '../../api/queries'
import { deriveAccess, shareScopeLabel } from '../../model/access'
import { useCreatedAppAccess } from '../create/access'
import { AccessForbiddenError } from '../../api/access'
import { renameCreationPlan } from '../../model/build/plan'
import { buildCopy } from '../../model/build/copy'
import { implementedReleaseReady } from '../../model/app'
import { isBuildPending } from '../../model/build/progress'
import { paths } from '../../routes/paths'
import { setArtifactCollapsed, shellStore } from '../../shell/store'
import { useShell } from '../../shell/use-shell'
import { ActionError, Button, cn, EmptyState, focusHeading, LinkButton, Loading, LoadFailed, useDocumentTitle } from '../../ui'
import { DatabaseChanges } from '../app/database-changes'
import { canEditApp } from '../app/permissions'
import { useAppViews } from '../app/use-app-views'
import { ArtifactPane } from './artifact-pane'
import { ConversationPane } from './conversation-pane'
import { PublishStep } from './publish-step'
import { SessionHeader, StageAction } from './session-header'
import { useBuildSession } from './use-build-session'
import { useNameSuggestion } from './use-name-suggestion'
import { text } from './copy'
import { resolveBuildGroup } from './entry'
import { BuildFailureNotice } from './build-failure-notice'

export function BuildPage({ draftId }: { draftId: string }) {
  const { me, groups, currentGroup } = useShell()
  const groupId = resolveBuildGroup(me, groups, currentGroup)
  const query = useBuildDraft(me.projectId, draftId, Boolean(groupId))
  if (!groupId) return <EmptyState icon={<Users />} heading="h1" title={text.page.noGroup.title} body={text.page.noGroup.body} action={<LinkButton href={paths.directory}>{text.page.noGroup.directory}</LinkButton>} />
  if (query.isPending) return <Loading className="px-5" />
  if (query.isLoadingError) return <div className="p-5"><LoadFailed onRetry={() => void query.refetch()} error={query.error} /></div>
  return <Session key={draftId} draft={query.data} groupId={groupId} />
}

function Session({ draft, groupId }: { draft: ApplicationDraft; groupId: string }) {
  const { me } = useShell()
  const groups = useGroups().data
  const ownerGroupName = groups.find((group) => group.id === groupId)?.name
  const build = useBuildSession(draft, me, groupId, ownerGroupName)
  const suggestion = useNameSuggestion(draft, build.failure, groups.find((group) => group.id === groupId)?.path)
  const failure = build.failure?.reasonCode === 'PublishURLConflict' ? { ...build.failure, suggestedName: suggestion } : build.failure
  const [tab, setTab] = useState<'conversation' | 'artifact'>('conversation')
  const artifactCollapsed = useSelector(shellStore, (state) => state.artifactCollapsed)
  const [sharing, setSharing] = useState(false)
  const lookup = useAppViews(me.projectId)
  const { stage, progress } = build.result
  const name = draft.publishPreferences?.name ?? build.spec.name ?? draft.title
  useDocumentTitle(text.page.title(name))
  useEffect(() => { focusHeading('build-title') }, [draft.id])
  // The 作りかけ list (nav count, /-/drafts) gains this draft on arrival and changes its stage word as it moves.
  const queryClient = useQueryClient()
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(me.projectId) }) }, [queryClient, me.projectId, stage])
  const appView = build.app ? lookup.viewFor(build.app) : undefined
  const creationAccess = useCreatedAppAccess(me.projectId, build.app, appView?.platform?.publish)
  const releases = lookup.input.releasesByApplication[draft.createdApplicationId ?? '']?.components.flatMap((component) => component.releases) ?? []
  const released = implementedReleaseReady(appView?.platform, releases, {
    draftId: draft.id, initialReleaseId: build.session.initialReleaseId,
    taskCount: build.implementation.state.tasks.length, tasks: build.implementation.state.tasks,
  })
  const url = released ? appView?.platform?.publish?.publicUrl ?? appView?.platform?.publish?.tailnetUrl : undefined
  const shareText = build.app ? deriveAccess(appView?.platform?.publish?.access, build.app, groups, creationAccess.error instanceof AccessForbiddenError ? 'forbidden' : creationAccess.error ? 'failed' : undefined).label : shareScopeLabel('private')
  const planPending = isBuildPending(draft.creationPlanGenerations?.at(-1))
  const updatingPlan = build.session.prepareRequested && planPending
  const primary = { ...build.result.primary, enabled: build.result.primary.enabled && !build.busy && !sharing && !updatingPlan }
  // 決める: the prepare action is attached to the AI's proposal, labelled by what pressing it will do.
  const preparing = stage === 'decide' && build.proposal && (primary.action === 'prepare' || primary.action === 'prepare-after-plan')
  const proposalAction = preparing ? <Button tone="primary" loading={Boolean(updatingPlan)} disabled={!primary.enabled} onClick={() => build.prepare()}>
    {updatingPlan ? text.page.updatingPlan(progress?.elapsedLabel ?? '0:00') : build.proposal!.stale ? buildCopy.primary.refresh : buildCopy.primary.prepare}
  </Button> : undefined
  // The first plan (or a retried one) is being written: the AI says so where the proposal will appear.
  const planning = (stage === 'ask' || stage === 'decide') && planPending && !updatingPlan ? { ...buildCopy.proposal.pending, ...(progress?.kind === 'plan' && progress.elapsedLabel ? { elapsedLabel: progress.elapsedLabel } : {}) } : undefined
  const openPreview = () => {
    setTab('artifact')
    document.getElementById('build-artifact')?.scrollIntoView({ block: 'nearest' })
  }
  const onPrimary = () => {
    if (primary.action === 'publish') { setSharing(true); setTab('artifact') }
    else if (primary.action === 'plan') build.requestPlan()
    else if (primary.action === 'continue') { build.patch({ continuedAfterPublishAt: draft.publishedAt }); setTab('conversation') }
  }
  const useName = (next: string) => {
    if (!draft.creationPlan) return
    void build.perform('prepare', async () => {
      const publishConflict = build.failure?.reasonCode === 'PublishURLConflict'
      // URL recovery changes the stored plan, never a schema-defaulted client copy.
      if (!publishConflict) await cleanupCreation(me.projectId, draft.id)
      const updated = await updateDraft(me.projectId, draft.id, publishConflict
        ? { renameApplication: { name: next } }
        : { creationPlan: renameCreationPlan(draft.creationPlan!, next, { domain: build.domain }) })
      build.receive(updated)
      // The collision is resolved by the new name: its notice must not linger as a stale retry.
      build.patch((current) => ({ ...current, lastPlannedIntent: updated.intent, reusePlan: true, executionRequestId: undefined, messages: current.messages.filter((message) => message.role !== 'notice' || message.retry !== 'prepare') }))
      build.prepare()
    })
  }
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="build-session" data-stage={stage}>
    <SessionHeader name={name} stage={stage} released={released} action={<StageAction stage={stage} primary={primary} progress={progress} onPrimary={onPrimary} />} />
    <BuildFailureNotice failure={draft.buildFailure} projectId={me.projectId} stackId={draft.createdApplicationStackId} title={name} canEdit={build.app ? canEditApp(build.app, me) : draft.ownerUserId === me.person.subject} />
    {creationAccess.error ? <ActionError error={creationAccess.error} /> : null}
    {build.waitingForPublish || creationAccess.waitingForPublish ? <p role="status" className="px-5 py-2 text-xs text-stone-500">{text.page.waitingForPublish}</p> : null}
    <div role="tablist" aria-label={text.page.tabs} className="flex shrink-0 border-b border-line bg-white md:hidden">
      {(['conversation', 'artifact'] as const).map((value) => <button key={value} id={`build-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`build-${value}`} tabIndex={tab === value ? 0 : -1} className={cn('min-h-11 flex-1 border-b-2 px-3 text-sm', tab === value ? 'border-accent font-semibold text-stone-900' : 'border-transparent text-stone-500')} onClick={() => setTab(value)} onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = value === 'conversation' ? 'artifact' : 'conversation'; setTab(next); document.getElementById(`build-tab-${next}`)?.focus() }
      }}>{value === 'conversation' ? text.conversation.title : text.page.artifactTab}{value === 'artifact' && progress ? <span aria-label={text.artifact.states.doing} className="ml-2">◔</span> : null}</button>)}
    </div>
    <div className={cn('flex min-h-0 flex-1 md:grid md:grid-rows-[minmax(0,1fr)]', artifactCollapsed ? 'md:grid-cols-[minmax(0,1fr)_2.75rem]' : 'md:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_28rem]')}>
      <div id="build-conversation" role="tabpanel" aria-labelledby="build-tab-conversation" className={cn('min-h-0 min-w-0 flex-1 flex-col md:flex md:border-r md:border-line', tab === 'conversation' ? 'flex' : 'hidden')}>
        <ConversationPane messages={build.messages} stage={stage} answering={build.busy} thinking={isBuildPending(draft.conversationTurns?.at(-1))} waitingForAi={build.waitingForAi} planning={planning} proposalAction={proposalAction} queued={build.queued} progress={progress} prepareOpen={build.prepareOpen} ownerGroupName={ownerGroupName} failure={failure} onSend={build.send} onRetry={build.retry} onUseName={useName} />
      </div>
      <div id="build-artifact" role="tabpanel" aria-labelledby="build-tab-artifact" className={cn('relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain', tab === 'artifact' ? 'block' : 'hidden', artifactCollapsed ? 'md:hidden' : 'md:block')}>
        <ArtifactPane draft={draft} spec={build.spec} proposal={build.proposal} stage={stage} progress={progress} implementation={build.implementation.state} failure={build.failure} url={url} shareText={shareText} previewDatabaseReset={build.implementation.previewDatabaseReset} onOpenPreview={openPreview} onRetry={build.implementation.retry} onSkipTask={build.implementation.skipTask} onCollapse={() => setArtifactCollapsed(true)} databaseChanges={<DatabaseChanges projectId={me.projectId} databaseId={build.app && canEditApp(build.app, me) ? appView?.stack?.databaseComponentId : undefined} />} shareStep={sharing && build.app ? <PublishStep app={build.app} publishId={appView?.platform?.publish?.id} publishPreferences={draft.publishPreferences} onPublished={(updated) => { build.published(updated); setSharing(false) }} onCancel={() => setSharing(false)} /> : undefined} />
      </div>
      {artifactCollapsed ? (
        <div className="hidden min-h-0 flex-col items-center gap-2 bg-white py-2 md:flex">
          <button type="button" aria-label={buildCopy.artifact.expand} aria-expanded={false} aria-controls="build-artifact" title={buildCopy.artifact.expand} onClick={() => setArtifactCollapsed(false)} className="flex size-9 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900">
            <PanelRightOpen aria-hidden className="size-5" />
          </button>
          {progress ? <span aria-label={text.artifact.states.doing} title={progress.title} className="text-accent">◔</span> : null}
          <span aria-hidden className="text-xs font-medium text-stone-500 [writing-mode:vertical-rl]">{buildCopy.artifact.title}</span>
        </div>
      ) : null}
    </div>
  </div>
}
