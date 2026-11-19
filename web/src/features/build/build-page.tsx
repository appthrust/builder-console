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
import type { BuildDraft } from '../../model/contracts/build'
import { useQueryClient } from '@tanstack/react-query'
import { useSelector } from '@tanstack/react-store'
import { PanelRightOpen, Users } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { buildKeys, useBuildDraft } from '../../api/queries/build'
import { useGroups } from '../../api/queries/console'
import { buildCopy } from '../../model/build/copy'
import { lastActionable } from '../../model/build/messages'
import { isBuildPending } from '../../model/build/progress'
import { paths } from '../../routes/paths'
import { setArtifactCollapsed, shellStore } from '../../shell/store'
import { useShell } from '../../shell/use-shell'
import { ActionError, Button, cn, EmptyState, focusHeading, LinkButton, Loading, Notice, ResourceBoundary, useDocumentTitle } from '../../ui'
import { DatabaseChanges } from '../app/database-changes'
import { ArtifactPane } from './artifact-pane'
import { ConversationPane, PlanRejectionActions } from './conversation-pane'
import { PublishStep } from './publish-step'
import { SessionHeader, StageAction } from './session-header'
import { useBuildSession } from './use-build-session'
import { useNameSuggestion } from './use-name-suggestion'
import { text } from './copy'
import { resolveBuildGroup } from './entry'
import { BuildFailureNotice } from './build-failure-notice'
import { useCreatedAppView } from './use-created-app-view'
import { BuildOutcomeTurn } from './build-outcome'
import { shareScopeLabel } from '../../model/access'

export function BuildPage({ draftId }: { draftId: string }) {
  const { me, groups, currentGroup } = useShell()
  const groupId = resolveBuildGroup(me, groups, currentGroup)
  const query = useBuildDraft(me.projectId, draftId, Boolean(groupId))
  if (!groupId) return <EmptyState icon={<Users />} heading="h1" title={text.page.noGroup.title} body={text.page.noGroup.body} action={<LinkButton href={paths.directory}>{text.page.noGroup.directory}</LinkButton>} />
  // The route loader read the draft once; a later unreadable poll keeps the last good draft (and the
  // composer, preview and progress built on it) under a fixed "could not update" notice among the page's notices.
  return <ResourceBoundary query={query} resetKey={draftId} loading={<Loading className="px-5" />}>
    {(draft, stale) => <Session key={draftId} draft={draft} groupId={groupId} stale={stale} />}
  </ResourceBoundary>
}

function Session({ draft, groupId, stale }: { draft: BuildDraft; groupId: string; stale: ReactNode }) {
  const { me } = useShell()
  const groups = useGroups().data
  const ownerGroupName = groups.find((group) => group.id === groupId)?.name
  const build = useBuildSession(draft, me, groupId, ownerGroupName)
  const suggestion = useNameSuggestion(draft, build.failure, groups.find((group) => group.id === groupId)?.path)
  const failure = build.failure?.reasonCode === 'PublishURLConflict' ? { ...build.failure, suggestedName: suggestion } : build.failure
  const [tab, setTab] = useState<'conversation' | 'artifact'>('conversation')
  const artifactCollapsed = useSelector(shellStore, (state) => state.artifactCollapsed)
  const [sharing, setSharing] = useState(false)
  const { stage, progress } = build.result
  const name = draft.publishPreferences?.name ?? build.spec.name ?? draft.title
  useDocumentTitle(text.page.title(name))
  useEffect(() => { focusHeading('build-title') }, [draft.id])
  // The 作りかけ list (nav count, /-/drafts) gains this draft on arrival and changes its stage word as it moves.
  const queryClient = useQueryClient()
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(me.projectId) }) }, [queryClient, me.projectId, stage])
  const { appView, creationAccess, released, url, shareText } = useCreatedAppView({ projectId: me.projectId, draft, app: build.app, groups, initialReleaseId: build.session.initialReleaseId, tasks: build.implementation.state.tasks })
  const appReadOnly = Boolean(appView?.unreadableStack || appView?.unreadableBuild)
  const planPending = isBuildPending(draft.creationPlanGenerations.at(-1))
  const updatingPlan = build.session.prepareRequested && planPending
  const primary = { ...build.result.primary, enabled: build.result.primary.enabled && !build.busy && !sharing && !updatingPlan && (build.result.primary.action !== 'publish' || !appReadOnly) }
  // 決める: the prepare action is attached to the AI's proposal, labelled by what pressing it will do. After the
  // destination moved, the notice right below the proposal carries the same action (once, beside its explanation).
  // A recreated-workspace notice is display only: what follows is decided on the newest message before it.
  const lastMessage = lastActionable(build.messages)
  const reapproveNotice = lastMessage?.role === 'notice' && lastMessage.retry === 'prepare' && lastMessage.title === buildCopy.failure.destination.changed.title
  // A plan Platform's validation rejected is never approved again. Its actions (「もう一度確かめる」 when the cause may lie
  // outside the plan, 「計画を作り直す」) are on the notice that explains the rejection, or on the proposal when that notice
  // is gone (and no new plan is being made yet). Once Platform refused a new plan for its generation limit, the proposal
  // does not offer another: only the check is left, where it applies.
  const rejectionNotice = lastMessage?.role === 'notice' && (lastMessage.retry === 'plan' || lastMessage.retry === 'recheck')
  const limitNotice = lastMessage?.role === 'notice' && lastMessage.title === buildCopy.failure.limit.title
  const offerRecheck = build.planRecheck
  const offerReplan = !limitNotice
  const preparing = stage === 'decide' && build.proposal && !reapproveNotice && !build.planRejected && (primary.action === 'prepare' || primary.action === 'prepare-after-plan')
  // Only a destination on screen can be approved (the approval binds its revision): none is set (the proposal says only
  // a Project administrator can set it), it is still read, or no read has shown it yet (read it again here). One still on
  // screen after a failed re-read stays approvable; the preparation checks Platform's current revision fresh against it.
  const shownDestination = typeof build.proposal?.newRepository !== 'string'
  const approve = <Button tone="primary" loading={Boolean(updatingPlan)} disabled={!primary.enabled || !shownDestination} onClick={() => build.prepare()}>
    {updatingPlan ? text.page.updatingPlan(progress?.elapsedLabel ?? '0:00') : build.proposal?.stale ? buildCopy.primary.refresh : buildCopy.primary.prepare}
  </Button>
  const proposalAction = build.planRejected
    ? (stage === 'decide' && !rejectionNotice && !planPending && (offerRecheck || offerReplan)
      ? <PlanRejectionActions recheck={offerRecheck ? { disabled: !build.canRecheck, onClick: build.recheck } : undefined} replan={offerReplan ? { disabled: build.busy, onClick: build.replan } : undefined} />
      : undefined)
    : !preparing ? undefined
      : build.proposal?.newRepository === 'failed' ? <><Button onClick={build.retryDestination}>{buildCopy.proposal.destinationRetry}</Button>{approve}</>
        : approve
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
  // The collision is resolved by the new name: its notice must not linger as a stale retry.
  const useName = (next: string) => build.rename(next, build.failure, (updated) => build.patch((current) => ({
    ...current, lastPlannedIntent: updated.intent, messages: current.messages.filter((message) => message.role !== 'notice' || message.retry !== 'prepare'),
  })))
  // What the run means, under the conversation: 公開する is offered there too once the app is built (APT-1124).
  const shareScope = draft.publishPreferences?.shareScope
  // A running app's recorded build failure is read where 公開する is pressed and in the publish step (APT-1136).
  const behind = appView?.latestBuildFailed ? <BuildFailureNotice failure={undefined} projectId={me.projectId} stackId={draft.createdApplicationStackId} title={name} canEdit={false} behind={{ runUrl: build.sourceRepository?.build?.runUrl }} /> : null
  // After an unreadable answer only the panel's re-read is offered (ImplementPanel), never another retry.
  const retryable = !appReadOnly && !build.implementation.state.failure
  const outcome = <BuildOutcomeTurn outcome={build.result.outcome} audience={shareScope ? shareScopeLabel(shareScope, ownerGroupName) : undefined} notice={behind}
    publish={{ label: buildCopy.primary.publish, enabled: primary.action === 'publish' && primary.enabled, onClick: onPrimary }}
    retry={retryable ? { pending: Boolean(build.implementation.state.retryPending), onClick: build.implementation.retry } : undefined} />
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="build-session" data-stage={stage}>
    <SessionHeader name={name} stage={stage} released={released} unsupported={build.result.unsupported} outcome={build.result.outcome} action={<StageAction stage={stage} primary={primary} progress={progress} onPrimary={onPrimary} />} />
    {/* Page-level notices share one inset place under the header, whatever raised them. */}
    {stale || build.result.unsupported || draft.buildFailure || creationAccess.error ? <div className="mx-5 mt-3 space-y-3">
      {stale}
      {build.result.unsupported ? <Notice tone="warning" title={buildCopy.unsupported.title}>{buildCopy.unsupported.detail}</Notice> : null}
      <BuildFailureNotice failure={draft.buildFailure} projectId={me.projectId} stackId={draft.createdApplicationStackId} title={name} canEdit={build.app ? build.app.permissions.maintain : draft.ownerUserId === me.person.subject} />
      {creationAccess.error ? <ActionError error={creationAccess.error} /> : null}
    </div> : null}
    {build.waitingForPublish || creationAccess.waitingForPublish ? <p role="status" className="px-5 py-2 text-xs text-stone-500">{text.page.waitingForPublish}</p> : null}
    <div role="tablist" aria-label={text.page.tabs} className="flex shrink-0 border-b border-line bg-white md:hidden">
      {(['conversation', 'artifact'] as const).map((value) => <button key={value} id={`build-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`build-${value}`} tabIndex={tab === value ? 0 : -1} className={cn('min-h-11 flex-1 border-b-2 px-3 text-sm', tab === value ? 'border-accent font-semibold text-stone-900' : 'border-transparent text-stone-500')} onClick={() => setTab(value)} onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = value === 'conversation' ? 'artifact' : 'conversation'; setTab(next); document.getElementById(`build-tab-${next}`)?.focus() }
      }}>{value === 'conversation' ? text.conversation.title : text.page.artifactTab}{value === 'artifact' && progress ? <span aria-label={text.artifact.states.doing} className="ml-2">◔</span> : null}</button>)}
    </div>
    <div className={cn('flex min-h-0 flex-1 md:grid md:grid-rows-[minmax(0,1fr)]', artifactCollapsed ? 'md:grid-cols-[minmax(0,1fr)_2.75rem]' : 'md:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_28rem]')}>
      <div id="build-conversation" role="tabpanel" aria-labelledby="build-tab-conversation" className={cn('min-h-0 min-w-0 flex-1 flex-col md:flex md:border-r md:border-line', tab === 'conversation' ? 'flex' : 'hidden')}>
        <ConversationPane messages={build.messages} stage={stage} answering={build.busy} unsupported={build.result.unsupported || build.planBlocksStart} thinking={isBuildPending(draft.conversationTurns.at(-1))} waitingForAi={build.waitingForAi} planning={planning} proposalAction={proposalAction} queued={build.queued} progress={progress} prepareOpen={build.prepareOpen} ownerGroupName={ownerGroupName} failure={failure} planRejected={build.planRejected ? (build.planRecheck ? 'recheck' : 'replan') : undefined} canRecheck={build.canRecheck} end={outcome} onSend={build.send} onRetry={build.retry} onUseName={useName} />
      </div>
      <div id="build-artifact" role="tabpanel" aria-labelledby="build-tab-artifact" className={cn('relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain', tab === 'artifact' ? 'block' : 'hidden', artifactCollapsed ? 'md:hidden' : 'md:block')}>
        <ArtifactPane draft={draft} spec={build.spec} proposal={build.proposal} stage={stage} progress={progress} implementation={build.implementation.state} changeByReply={build.changeByReply} failure={build.failure} url={url} shareText={shareText} previewDatabaseReset={build.implementation.previewDatabaseReset} onOpenPreview={openPreview} onRetry={build.implementation.retry} onSkipTask={build.implementation.skipTask} onConfirm={build.implementation.confirm} onCollapse={() => setArtifactCollapsed(true)} databaseChanges={<DatabaseChanges projectId={me.projectId} databaseId={!appReadOnly && build.app?.permissions.data ? appView?.stack?.databaseComponentId : undefined} />} shareStep={sharing && build.app && !appReadOnly ? <>{behind}<PublishStep app={build.app} publishId={appView?.platform?.publish?.id} publishPreferences={draft.publishPreferences} onPublished={() => { build.published(); setSharing(false) }} onCancel={() => setSharing(false)} /></> : undefined} />
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
