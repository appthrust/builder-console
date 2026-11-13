import { isOneOf, type BuildDraft, type BuildTurn, type ImplementationRun } from '../../model/contracts/build'
import { Check, Circle, ExternalLink, Loader2 } from 'lucide-react'
import { forwardRef, useLayoutEffect, useRef, type ReactNode } from 'react'
import { buildCopy } from '../../model/build/copy'
import { buildFailureReference, classifyBuildFailure } from '../../model/build/failure'
import { assistantMessage } from '../../model/build/messages'
import { activityLines, formatElapsed } from '../../model/build/progress'
import type { BuildFailure } from '../../model/build/types'
import { isProductLanguage } from '../../model/build/wording'
import { improveTimeline, runVersion, sortedTurns, type ImproveState, type ImproveTask } from '../../model/improve'
import { ActivityLog, Button, CopyButton, LinkButton, Notice } from '../../ui'
import { Composer } from '../build/composer'
import { AiTurn, AssistantMessage, UserMessage } from '../build/conversation-pane'
import { text as buildText } from '../build/copy'
import { text } from './copy'
import { useClock } from './use-clock'
import { text as proposalText } from '../proposals/copy'

/** Pixels from the bottom that still count as "reading the newest message". */
const STICK = 96

export interface ImproveConversationProps {
  draft: BuildDraft
  state: ImproveState
  /** The published app, linked from a finished run. */
  appUrl?: string
  locked: boolean
  starting: boolean
  waitingForReview?: boolean
  outcome?: ReactNode
  sendFailure?: BuildFailure
  startFailure?: BuildFailure
  onSend(text: string): void
  onRetrySend(): void
  onStart(): void
  /** Reads the draft back after a send or start whose answer could not be read (the only action then offered). */
  onConfirmSend(): void
  onConfirmStart(): void
}

/** Product-language lines of the AI's live output; file paths and platform words stay hidden. */
function readableActivity(tail: string | undefined): string[] {
  return activityLines(tail).filter(isProductLanguage)
}

export const ImproveConversation = forwardRef<HTMLTextAreaElement, ImproveConversationProps>(function ImproveConversation({ draft, state, appUrl, locked, waitingForReview, outcome, starting, sendFailure, startFailure, onSend, onRetrySend, onStart, onConfirmSend, onConfirmStart }, input) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const now = useClock(state.turnActive)
  const submit = (value: string) => {
    if (locked) return
    following.current = true
    onSend(value)
  }

  // Newest at the bottom: follow new content unless the reader scrolled up to look back.
  useLayoutEffect(() => {
    const box = scroller.current
    const inner = content.current
    if (!box || !inner) return
    const toBottom = () => { if (following.current) box.scrollTop = box.scrollHeight }
    const onScroll = () => { following.current = box.scrollHeight - box.scrollTop - box.clientHeight < STICK }
    toBottom()
    const observer = new ResizeObserver(toBottom)
    observer.observe(inner)
    observer.observe(box)
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => { observer.disconnect(); box.removeEventListener('scroll', onScroll) }
  }, [])

  const turns = sortedTurns(draft)
  const lastTurn = turns.at(-1)
  const lastAnswer = [...turns].reverse().find((turn) => isOneOf(turn.status, 'succeeded'))
  const latestRun = draft.implementationRuns.at(-1)
  const answerable = state.phase === 'asking' || state.phase === 'proposed'
  const chips = answerable && !locked ? (lastAnswer?.suggestedReplies ?? []).map((reply) => ({ label: reply, value: reply })) : []

  const turnItem = (turn: BuildTurn): ReactNode => {
    const answer = isOneOf(turn.status, 'succeeded') ? assistantMessage(turn, draft.id) : undefined
    return <div key={turn.id} className="flex flex-col gap-5">
      <UserMessage text={turn.userMessage} />
      {answer?.role === 'assistant' ? <AssistantMessage message={answer} active={answerable && turn === lastAnswer} /> : null}
      {turn.id === state.proposalTurnId ? <ProposalCard tasks={state.proposal} starting={starting} disabled={locked} failure={startFailure} onStart={onStart} onConfirm={onConfirmStart} /> : null}
      {isOneOf(turn.status, 'failed') ? <FailureNotice failure={classifyBuildFailure(turn.error ?? '', undefined, 'turn', { draftId: draft.id, at: turn.finishedAt ?? turn.startedAt })} onRetry={turn === lastTurn && !locked ? () => submit(turn.userMessage) : undefined} /> : null}
      {turn.status.kind === 'unknown' ? <UnsupportedNotice /> : null}
      {isOneOf(turn.status, 'pending', 'running') ? <AiTurn>
        <p role="status" className="flex items-center gap-2 text-stone-600"><Loader2 aria-hidden className="size-4 animate-spin text-accent" />{text.conversation.thinking}<span className="tabular-nums text-stone-400">{formatElapsed(now - Date.parse(turn.startedAt))}</span></p>
        <p className="mt-1 text-xs text-stone-500">{buildCopy.progress.turn.hint}</p>
        <Activity lines={readableActivity(turn.activityTail)} />
      </AiTurn> : null}
    </div>
  }

  const runItem = (run: ImplementationRun): ReactNode => {
    const latest = run === latestRun
    // A run in a state this console does not know is shown as that: never as running, made or stopped.
    if (run.status.kind === 'unknown') return <UnsupportedNotice key={run.id} />
    if (isOneOf(run.status, 'pending', 'running')) {
      const task = run.tasks.find((item) => item.id === run.currentTaskId)
      return <AiTurn key={run.id}>
        <p role="status" className="flex items-center gap-2 text-stone-600"><Loader2 aria-hidden className="size-4 animate-spin text-accent" />{task ? text.run.running : text.run.starting}</p>
        {task && isProductLanguage(task.title) ? <p className="mt-1 text-xs text-stone-500">{task.title}</p> : null}
      </AiTurn>
    }
    if (isOneOf(run.status, 'succeeded')) {
      const changed = run.tasks.filter((task) => run.taskIds.includes(task.id) && isOneOf(task.status, 'done') && isProductLanguage(task.title))
      return <AiTurn key={run.id}>
        <div data-testid="improve-result">
          {latest && outcome ? outcome : <p className="font-semibold text-stone-900">{draft.proposalId && !runVersion(run) ? proposalText.sent : text.updated(runVersion(run))}</p>}
          {changed.length ? <div className="mt-2">
            <p className="text-xs font-medium text-stone-500">{text.run.changed}</p>
            <ul className="mt-1 space-y-1">{changed.map((task) => <li key={task.id} className="flex gap-1.5 text-stone-700"><Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" /><span className="min-w-0 break-words">{task.title}</span></li>)}</ul>
          </div> : null}
          {latest && appUrl && (!draft.proposalId || runVersion(run)) ? <LinkButton external href={appUrl} size="sm" icon={<ExternalLink />} className="mt-3">{text.run.openApp}</LinkButton> : null}
        </div>
      </AiTurn>
    }
    const task = run.tasks.find((item) => item.id === run.currentTaskId)
    const failure = classifyBuildFailure(run.error || task?.error || (isOneOf(run.status, 'cancelled') ? buildText.implement.cancelled : buildText.implement.failed), undefined, 'implement', { draftId: draft.id, executionId: run.id, at: run.finishedAt ?? draft.updatedAt }, undefined, undefined, run.failureReason ?? task?.failureReason)
    return <FailureNotice key={run.id} failure={failure} onRetry={latest && state.phase === 'failed' && !locked ? onStart : undefined} />
  }

  return <section className="flex min-h-0 flex-1 flex-col bg-white" aria-label={buildText.conversation.title}>
    <h2 className="sr-only">{buildText.conversation.title}</h2>
    <div ref={scroller} role="log" aria-label={buildText.conversation.log} aria-live="polite" tabIndex={0} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-offset-[-2px]">
      <div ref={content} className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 px-4 py-5 sm:px-6">
        <p className="mt-auto text-xs leading-relaxed text-stone-500">{text.conversation.intro}</p>
        {improveTimeline(draft).map((item) => item.kind === 'turn' ? turnItem(item.turn) : runItem(item.run))}
        {outcome && !isOneOf(latestRun?.status, 'succeeded') ? <AiTurn>{outcome}</AiTurn> : null}
        {sendFailure ? <FailureNotice failure={sendFailure} onRetry={locked ? undefined : onRetrySend} onConfirm={onConfirmSend} /> : null}
      </div>
    </div>
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4 sm:px-6">
      <Composer ref={input} chips={chips} disabled={locked} placeholder={waitingForReview ? proposalText.waiting : text.conversation.placeholder} onSubmit={submit} onChip={submit} />
    </div>
  </section>
})

function Activity({ lines }: { lines: string[] }) {
  return <ActivityLog lines={lines} label={buildCopy.progress.observe.activity} className="mt-2 max-h-40 p-2.5" />
}

function UnsupportedNotice() {
  return <Notice tone="warning" title={buildCopy.unsupported.title}>{buildCopy.unsupported.detail}</Notice>
}

function FailureNotice({ failure, onRetry, onConfirm }: { failure: BuildFailure; onRetry?(): void; onConfirm?(): void }) {
  const reference = failure.reference ? buildFailureReference(failure.reference) : undefined
  // An unconfirmed send or start may have happened: it is read back, never offered again from here.
  const action = failure.kind === 'unconfirmed'
    ? onConfirm ? <Button size="sm" onClick={onConfirm}>{buildCopy.failure.confirm}</Button> : undefined
    : onRetry && failure.kind !== 'policy' ? <Button size="sm" onClick={onRetry}>{buildText.conversation.retry}</Button> : undefined
  return <Notice tone={failure.kind === 'unconfirmed' ? 'warning' : 'error'} title={failure.title} actions={action}>
    {failure.reason}
    {reference ? <div className="mt-3 flex flex-wrap items-center gap-2"><span className="min-w-0 break-all text-xs">{reference}</span><CopyButton value={reference} label={buildCopy.failure.copyReference} /></div> : null}
  </Notice>
}

/** The change the next run will make, with 「この内容で直す」 attached where it is read. */
function ProposalCard({ tasks, starting, disabled, failure, onStart, onConfirm }: { tasks: ImproveTask[]; starting: boolean; disabled: boolean; failure?: BuildFailure; onStart(): void; onConfirm(): void }) {
  const readable = tasks.filter((task) => isProductLanguage(task.title))
  return <section aria-label={text.proposal.label} data-testid="improve-proposal" className="mr-4 max-w-[70ch] rounded-lg border border-line bg-white px-4 py-3 text-sm leading-relaxed text-stone-900">
    <p className="text-xs font-medium text-stone-500">{text.proposal.label}</p>
    <p className="mt-1 break-words">{text.proposal.lead}</p>
    {readable.length ? <ul className="mt-2 space-y-1.5">{readable.map((task) => <li key={task.id} className="flex gap-2"><Circle aria-hidden className="mt-1.5 size-2.5 shrink-0 text-stone-400" /><span className="min-w-0 break-words">{task.title}{task.detail ? <span className="block text-xs text-stone-500">{task.detail}</span> : null}</span></li>)}</ul> : null}
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button tone="primary" loading={starting} disabled={disabled || failure?.kind === 'policy' || failure?.kind === 'unconfirmed'} onClick={onStart}>{text.proposal.apply}</Button>
    </div>
    {failure ? <div className="mt-3"><FailureNotice failure={failure} onRetry={disabled ? undefined : onStart} onConfirm={onConfirm} /></div> : null}
  </section>
}
