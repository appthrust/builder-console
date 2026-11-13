// Improvement runs produce owner-reviewed proposals; only Applied is a live update.
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSelector } from '@tanstack/react-store'
import { ChevronLeft, Loader2, PanelRightOpen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { buildKeys, useBuildDraft } from '../../api/queries/build'
import { appsQuery } from '../../api/queries/console'
import { improveStages, improveVersions, type ImprovePhase } from '../../model/improve'
import { paths } from '../../routes/paths'
import { setArtifactCollapsed, shellStore } from '../../shell/store'
import { useShell } from '../../shell/use-shell'
import { Button, cn, focusHeading, HrefLink, Loading, LoadFailed, StatusPill, Stepper, useDocumentTitle } from '../../ui'
import type { ConsoleStatus } from '../../copy'
import { useAppViews } from '../app/use-app-views'
import { text as buildText } from '../build/copy'
import { ImproveConversation } from './conversation'
import { improveStateWord, text } from './copy'
import { ImproveSidePane } from './side-pane'
import { useImproveSession } from './use-improve-session'
import { text as proposalText } from '../proposals/copy'
import { ProposalOutcome, ProposalStatus } from '../proposals/proposal-ui'
import { proposalWaiting } from '../proposals/model'

const PILL: Record<ImprovePhase, ConsoleStatus> = { asking: 'unfinished', proposed: 'unfinished', running: 'deploying', failed: 'failed', done: 'live' }

export function ImprovePage({ draftId }: { draftId: string }) {
  const { me } = useShell()
  const query = useBuildDraft(me.projectId, draftId)
  if (query.isPending) return <Loading className="px-5" />
  if (query.isLoadingError) return <div className="p-5"><LoadFailed onRetry={() => void query.refetch()} error={query.error} /></div>
  return <Session key={draftId} draft={query.data} />
}

function Session({ draft }: { draft: ApplicationDraft }) {
  const { me } = useShell()
  const session = useImproveSession(me.projectId, draft)
  const { state, implementation } = session
  const [tab, setTab] = useState<'conversation' | 'artifact'>('conversation')
  const collapsed = useSelector(shellStore, (store) => store.artifactCollapsed)
  const composer = useRef<HTMLTextAreaElement>(null)
  // The app this session changes, joined by stack like every other app view.
  const apps = useQuery(appsQuery({ scope: 'all' }))
  const app = apps.data?.find((item) => item.stackId === draft.createdApplicationStackId)
  const lookup = useAppViews(me.projectId)
  const view = draft.createdApplicationStackId ? lookup.viewFor(app ?? { id: draft.id, stackId: draft.createdApplicationStackId, createdAt: draft.createdAt }) : undefined
  const appUrl = view?.url
  const name = app?.displayName ?? draft.title
  useDocumentTitle(text.page.title(name))
  useEffect(() => { focusHeading('build-title') }, [draft.id])
  // The 作りかけ list (nav count, /-/drafts) follows this session's state word.
  const queryClient = useQueryClient()
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(me.projectId) }) }, [queryClient, me.projectId, state.phase])
  const back = app ? { href: paths.app(app.group.path, app.slug), label: text.page.back(app.displayName) } : { href: paths.drafts(), label: buildText.header.back(text.page.drafts) }
  const continueFixing = () => {
    setTab('conversation')
    requestAnimationFrame(() => composer.current?.focus())
  }
  const currentTask = state.phase === 'running' ? implementation.state.tasks.find((task) => task.id === implementation.state.currentTaskId) : undefined
  const action = state.phase === 'running'
    ? <p role="status" className="flex h-9 items-center gap-2 text-sm whitespace-nowrap text-stone-600 max-sm:text-xs"><Loader2 aria-hidden className="size-4 animate-spin text-accent" />{currentTask ? text.run.running : text.run.starting}</p>
    : state.phase === 'done' && !session.reviewLocked ? <Button tone="primary" className="max-sm:px-2.5 max-sm:text-xs" onClick={continueFixing}>{text.run.continue}</Button>
      : null

  return <div className="flex min-h-0 flex-1 flex-col" data-testid="improve-session" data-stage={state.stage} data-phase={state.phase}>
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-white px-3 py-2 sm:px-5">
      <div className="flex min-w-0 flex-[1_1_14rem] items-center gap-1">
        <HrefLink href={back.href} aria-label={back.label} title={back.label} className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900"><ChevronLeft aria-hidden className="size-5" /></HrefLink>
        <h1 id="build-title" tabIndex={-1} className="min-w-0 truncate text-base font-semibold text-stone-900 focus:outline-none" title={name}>{name}</h1>
        <span className="ml-2 shrink-0">{session.proposal.data ? <ProposalStatus proposal={session.proposal.data} /> : <StatusPill status={PILL[state.phase]} label={draft.proposalId ? proposalText.phase.Drafting : improveStateWord(state.phase, state.version)} />}</span>
      </div>
      <div className="flex flex-[1_1_auto] flex-wrap items-center justify-between gap-x-3 gap-y-1.5 sm:gap-x-4 lg:flex-none">
        <Stepper compact step={improveStages.indexOf(state.stage)} labels={improveStages.map((stage) => text.stageLabels[stage])} />
        {action ? <div className="ml-auto shrink-0">{action}</div> : null}
      </div>
    </header>
    <div role="tablist" aria-label={text.page.tabs} className="flex shrink-0 border-b border-line bg-white md:hidden">
      {(['conversation', 'artifact'] as const).map((value) => <button key={value} id={`build-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`build-${value}`} tabIndex={tab === value ? 0 : -1} className={cn('min-h-11 flex-1 border-b-2 px-3 text-sm', tab === value ? 'border-accent font-semibold text-stone-900' : 'border-transparent text-stone-500')} onClick={() => setTab(value)} onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = value === 'conversation' ? 'artifact' : 'conversation'; setTab(next); document.getElementById(`build-tab-${next}`)?.focus() }
      }}>{value === 'conversation' ? buildText.conversation.title : text.page.sideTab}{value === 'artifact' && state.phase === 'running' ? <span aria-label={buildText.artifact.states.doing} className="ml-2">◔</span> : null}</button>)}
    </div>
    <div className={cn('flex min-h-0 flex-1 md:grid md:grid-rows-[minmax(0,1fr)]', collapsed ? 'md:grid-cols-[minmax(0,1fr)_2.75rem]' : 'md:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_28rem]')}>
      <div id="build-conversation" role="tabpanel" aria-labelledby="build-tab-conversation" className={cn('min-h-0 min-w-0 flex-1 flex-col md:flex md:border-r md:border-line', tab === 'conversation' ? 'flex' : 'hidden')}>
        <ImproveConversation ref={composer} draft={draft} state={state} appUrl={appUrl} locked={session.locked} waitingForReview={!!session.proposal.data && proposalWaiting(session.proposal.data.phase)} outcome={session.proposal.data && session.proposal.data.phase !== 'Drafting' ? <ProposalOutcome proposal={session.proposal.data} version={state.version} /> : undefined} starting={implementation.pending} sendFailure={session.sendFailure} startFailure={implementation.requestFailure} onSend={session.send} onRetrySend={session.retrySend} onStart={implementation.startPending} />
        {session.proposal.error ? <LoadFailed error={session.proposal.error} onRetry={() => void session.proposal.refetch()} /> : null}
      </div>
      <div id="build-artifact" role="tabpanel" aria-labelledby="build-tab-artifact" className={cn('relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain', tab === 'artifact' ? 'block' : 'hidden', collapsed ? 'md:hidden' : 'md:block')}>
        <ImproveSidePane state={state} implementation={implementation.state} versions={improveVersions(draft).filter((version) => !draft.proposalId || !!version.version)} appUrl={session.proposal.data?.phase === 'Applied' || !draft.proposalId ? appUrl : undefined} proposalPending={!!draft.proposalId && session.proposal.data?.phase !== 'Applied'} onCollapse={() => setArtifactCollapsed(true)} />
      </div>
      {collapsed ? (
        <div className="hidden min-h-0 flex-col items-center gap-2 bg-white py-2 md:flex">
          <button type="button" aria-label={text.pane.expand} aria-expanded={false} aria-controls="build-artifact" title={text.pane.expand} onClick={() => setArtifactCollapsed(false)} className="flex size-9 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900">
            <PanelRightOpen aria-hidden className="size-5" />
          </button>
          {state.phase === 'running' ? <span aria-label={buildText.artifact.states.doing} className="text-accent">◔</span> : null}
          <span aria-hidden className="text-xs font-medium text-stone-500 [writing-mode:vertical-rl]">{text.pane.title}</span>
        </div>
      ) : null}
    </div>
  </div>
}
