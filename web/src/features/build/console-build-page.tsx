// The build screen for a console-v1 session (APT-753 S4-U1/U2). The session is
// read through `useConsoleBuildSession`; this page lays it out like the legacy
// build screen (header, conversation, what is being built) and owns the page
// notices: an unreadable write offers only 「最新の状態を確認する」, an
// interrupted one resends the same intent, a 412 shows the newer state and
// can put the rejected message back, a refused write gets its typed copy, and
// a state this console does not know stops only what depends on it. The legacy
// platform-v1 page (`build-page.tsx`) shares presentational parts only.
import { useSelector } from '@tanstack/react-store'
import { Loader2, PanelRightOpen } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { useBuildDraft } from '../../api/queries/build'
import { copy } from '../../copy'
import { buildCopy } from '../../model/build/copy'
import { failureKind, failureNext, planPhase, type FailureKind } from '../../model/build/replies'
import { parseSpec } from '../../model/build/spec'
import type { BuildStage } from '../../model/build/types'
import type { BuildDraft } from '../../model/contracts/build'
import type { Group, Me } from '../../model/contracts/console'
import { setArtifactCollapsed, shellStore } from '../../shell/store'
import { useShell } from '../../shell/use-shell'
import { ActionError, Button, cn, Loading, Notice, ResourceBoundary, focusHeading, useDocumentTitle } from '../../ui'
import { ConsoleConversation, FailureNotice } from './console-conversation'
import { useConsoleDraftStages, type ConsoleStages } from './console-draft-stages'
import { ConsoleSpecPane } from './console-spec-pane'
import type { ConsoleBuildView } from './console-view'
import { text } from './copy'
import { SessionHeader } from './session-header'
import { UnconfirmedNotice } from './unconfirmed-notice'
import { useConsoleBuildSession, type ConsoleBuildActions } from './use-console-build-session'

export function ConsoleBuildPage({ sessionId }: { sessionId: string }) {
  const build = useConsoleBuildSession(sessionId)
  return <ResourceBoundary query={build.query} resetKey={sessionId} loading={<Loading className="px-5" />}>
    {(_session, stale) => build.view ? <ConsoleSession view={build.view} actions={build.actions} stale={stale} /> : null}
  </ResourceBoundary>
}

/** The legacy rail's step for a lifecycle: talking, deciding (plan), building. Unknown marks no step. */
const STAGE_BY_LIFECYCLE: Record<string, BuildStage> = { initializing: 'ask', specifying: 'ask', planning: 'decide', planned: 'decide', created: 'build', archived: 'decide' }

function ConsoleSession({ view, actions, stale }: { view: ConsoleBuildView; actions: ConsoleBuildActions; stale: ReactNode }) {
  const { session } = view
  // From the plan onward the Platform draft carries the plan, the creation and publishing (design §9).
  const needsDraft = Boolean(session.draftId && (session.plan || (session.lifecycle.kind === 'known' && session.lifecycle.value === 'created')))
  return needsDraft ? <ConsoleWithDraft view={view} actions={actions} stale={stale} draftId={session.draftId!} /> : <ConsoleLayout view={view} actions={actions} stale={stale} />
}

function ConsoleWithDraft({ view, actions, stale, draftId }: { view: ConsoleBuildView; actions: ConsoleBuildActions; stale: ReactNode; draftId: string }) {
  const { me, groups } = useShell()
  const query = useBuildDraft(me.projectId, draftId)
  // Until the draft is read the conversation stays usable; a failed first read is one notice, retried by the query.
  if (!query.data) return <ConsoleLayout view={view} actions={actions} stale={stale} draftError={query.error} />
  return <ConsoleDraftView view={view} actions={actions} stale={stale} draft={query.data} me={me} groups={groups} />
}

function ConsoleDraftView({ view, actions, stale, draft, me, groups }: { view: ConsoleBuildView; actions: ConsoleBuildActions; stale: ReactNode; draft: BuildDraft; me: Me; groups: Group[] }) {
  const [openArtifact, setOpenArtifact] = useState(0)
  const stages = useConsoleDraftStages({ view, actions, draft, me, groups, onOpenArtifact: () => setOpenArtifact((count) => count + 1) })
  return <ConsoleLayout view={view} actions={actions} stale={stale} stages={stages} openArtifact={openArtifact} />
}

function ConsoleLayout({ view, actions, stale, stages, draftError, openArtifact = 0 }: { view: ConsoleBuildView; actions: ConsoleBuildActions; stale: ReactNode; stages?: ConsoleStages; draftError?: unknown; openArtifact?: number }) {
  const { session } = view
  const name = parseSpec(session.specification.markdown).spec.name || text.session.newApp
  useDocumentTitle(text.page.title(name))
  useEffect(() => { focusHeading('build-title') }, [session.id])
  const [tab, setTab] = useState<'conversation' | 'artifact'>('conversation')
  const [restore, setRestore] = useState<{ text: string; nonce: number }>()
  const artifactCollapsed = useSelector(shellStore, (state) => state.artifactCollapsed)
  useEffect(() => {
    if (!openArtifact) return
    setTab('artifact')
    setArtifactCollapsed(false)
  }, [openArtifact])
  const lifecycle = session.lifecycle.kind === 'known' ? session.lifecycle.value : undefined
  const archived = lifecycle === 'archived'
  const planTurn = view.activeTurn?.kind === 'request_plan' ? view.activeTurn : undefined
  const planWaiting = planTurn ? planPhase(planTurn) : undefined
  const stalePlan = session.plan?.stale === true
  // While a plan request runs the header says so; once building started it is the draft's stage action;
  // otherwise the typed plan action (never message text), while there is no current plan to build from. A stale
  // plan's re-plan sits on the plan's proposal with its reason once the draft is read, so it is not repeated here.
  const action = planWaiting
    ? <p role="status" className="flex h-9 items-center gap-2 text-sm whitespace-nowrap text-stone-600 max-sm:text-xs"><Loader2 aria-hidden className="size-4 animate-spin text-accent" />{text.console.progress.waiting[planWaiting.kind === 'working' ? planWaiting.waiting : 'planning']}</p>
    : stages?.headerAction ?? ((lifecycle === 'specifying' || (lifecycle === 'planned' && stalePlan && !stages) || view.unsupported)
      ? <Button tone="primary" className="max-sm:px-2.5 max-sm:text-xs" disabled={!view.canRequestPlan} onClick={() => actions.requestPlan()}>{stalePlan ? text.console.plan.replan : buildCopy.questions.kickoffReply}</Button>
      : undefined)
  const busy = Boolean(planWaiting) || stages?.stage === 'build'
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="build-session" data-engine="console-v1" data-stage={stages?.stage ?? (lifecycle ? STAGE_BY_LIFECYCLE[lifecycle] : undefined)}>
    <SessionHeader name={name} stage={stages?.stage ?? (lifecycle ? STAGE_BY_LIFECYCLE[lifecycle]! : 'ask')} released={stages?.released ?? false} unsupported={!lifecycle} action={action} />
    <PageNotices view={view} actions={actions} stale={stale} archived={archived} extra={[
      ...(draftError !== undefined && draftError !== null ? [<ActionError key="draft-error" error={draftError} />] : []),
      ...(stages?.notices ?? []),
    ]} onRestore={(message) => {
      setRestore((current) => ({ text: message, nonce: (current?.nonce ?? 0) + 1 }))
      setTab('conversation')
    }} />
    <div role="tablist" aria-label={text.page.tabs} className="flex shrink-0 border-b border-line bg-white md:hidden">
      {(['conversation', 'artifact'] as const).map((value) => <button key={value} id={`build-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`build-${value}`} tabIndex={tab === value ? 0 : -1} className={cn('min-h-11 flex-1 border-b-2 px-3 text-sm', tab === value ? 'border-accent font-semibold text-stone-900' : 'border-transparent text-stone-500')} onClick={() => setTab(value)} onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = value === 'conversation' ? 'artifact' : 'conversation'; setTab(next); document.getElementById(`build-tab-${next}`)?.focus() }
      }}>{value === 'conversation' ? text.conversation.title : text.page.artifactTab}{value === 'artifact' && (view.confirmation || busy) ? <span aria-label={view.confirmation ? text.console.proposal.title : text.artifact.states.doing} className="ml-2 inline-block size-1.5 rounded-full bg-accent align-middle" /> : null}</button>)}
    </div>
    <div className={cn('flex min-h-0 flex-1 md:grid md:grid-rows-[minmax(0,1fr)]', stages?.artifact && artifactCollapsed ? 'md:grid-cols-[minmax(0,1fr)_2.75rem]' : 'md:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_28rem]')}>
      <div id="build-conversation" role="tabpanel" aria-labelledby="build-tab-conversation" className={cn('min-h-0 min-w-0 flex-1 flex-col md:flex md:border-r md:border-line', tab === 'conversation' ? 'flex' : 'hidden')}>
        <ConsoleConversation view={view} actions={actions} restore={restore} end={stages?.conversationEnd} closedReason={stages?.closed ? text.console.created : undefined} />
      </div>
      <div id="build-artifact" role="tabpanel" aria-labelledby="build-tab-artifact" className={cn('relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain', tab === 'artifact' ? 'block' : 'hidden', stages?.artifact && artifactCollapsed ? 'md:hidden' : 'md:block')}>
        {stages?.artifact ?? <ConsoleSpecPane view={view} />}
      </div>
      {stages?.artifact && artifactCollapsed ? <div className="hidden min-h-0 flex-col items-center gap-2 bg-white py-2 md:flex">
        <button type="button" aria-label={buildCopy.artifact.expand} aria-expanded={false} aria-controls="build-artifact" title={buildCopy.artifact.expand} onClick={() => setArtifactCollapsed(false)} className="flex size-9 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900">
          <PanelRightOpen aria-hidden className="size-5" />
        </button>
        <span aria-hidden className="text-xs font-medium text-stone-500 [writing-mode:vertical-rl]">{buildCopy.artifact.title}</span>
      </div> : null}
    </div>
  </div>
}

/**
 * One inset place under the header for page-level notices. An unreadable write answer suppresses the others:
 * its only action is the re-read, and nothing else can be sent until it is done.
 */
function PageNotices({ view, actions, stale, archived, extra, onRestore }: { view: ConsoleBuildView; actions: ConsoleBuildActions; stale: ReactNode; archived: boolean; extra: ReactNode[]; onRestore(message: string): void }) {
  const { write, failure, conflict, session } = view
  const unconfirmed = write?.status === 'unconfirmed'
  const interrupted = write?.status === 'interrupted'
  // A network failure carries no code; it may not have arrived and is retried as the same request.
  const failed: FailureKind | undefined = failure ? (failure.code === 'unknown' && failure.retryable ? 'unavailable' : failureKind(failure.code)) : undefined
  // The active turn shows its own failure in the conversation; the session's is shown here once.
  const sessionFailure = session.failure && !(view.activeTurn?.failure) ? failureKind(session.failure.error, session.failure.details) : undefined
  const rejected = conflict?.rejected.family === 'turn' && conflict.rejected.body.kind === 'conversation' ? conflict.rejected.body.message : undefined
  const notices = [
    stale ? <Fragment key="stale">{stale}</Fragment> : null,
    view.unsupported ? <Notice key="unsupported" tone="warning" title={buildCopy.unsupported.title}>{buildCopy.unsupported.detail}</Notice> : null,
    archived ? <Notice key="archived">{text.console.archived}</Notice> : null,
    sessionFailure ? <FailureNotice key="session-failure" kind={sessionFailure} /> : null,
    unconfirmed ? <UnconfirmedNotice key="unconfirmed" onConfirm={() => void actions.confirm()} /> : null,
    !unconfirmed && conflict ? <Notice key="conflict" title={text.console.conflict.title} actions={<>
      {rejected ? <Button size="sm" onClick={() => { onRestore(rejected); actions.dismissConflict() }}>{text.console.conflict.restore}</Button> : null}
      <Button size="sm" tone="ghost" onClick={actions.dismissConflict}>{copy.common.close}</Button>
    </>}>{text.console.conflict.reason}</Notice> : null,
    !unconfirmed && failed ? <FailureNotice key="failure" kind={failed} tone={failure?.retryable ? 'warning' : 'error'} actions={
      failure?.retryable && interrupted ? <Button size="sm" onClick={actions.retry}>{text.conversation.retry}</Button>
        : failureNext[failed] === 'confirm' ? <Button size="sm" onClick={() => void actions.confirm()}>{buildCopy.failure.confirm}</Button>
          : <Button size="sm" tone="ghost" onClick={actions.dismissFailure}>{copy.common.close}</Button>
    } /> : null,
    !unconfirmed && !failure && interrupted ? <Notice key="interrupted" tone="warning" title={text.console.interrupted.title} actions={<Button size="sm" onClick={actions.retry}>{text.conversation.retry}</Button>}>{text.console.interrupted.reason}</Notice> : null,
    view.needsResume ? <Notice key="resume" tone="warning" title={text.console.resume.title} actions={<Button size="sm" onClick={() => void actions.resume()}>{text.console.resume.action}</Button>} /> : null,
    ...extra,
  ].filter(Boolean)
  return notices.length ? <div className="mx-3 mt-3 space-y-3 sm:mx-5">{notices}</div> : null
}
