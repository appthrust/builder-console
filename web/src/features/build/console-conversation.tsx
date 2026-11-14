// The conversation pane of a console-v1 session (APT-753 S4-U2): every turn's
// typed Reply in its own places (§6), a changed specification as a proposal
// with 反映する／反映しない, what the server is waiting for and when it was last
// observed (§13), and honest failure states with the next step the user has.
// Reply text is rendered as React text only: no HTML, no links, no commands.
import { Check, Loader2 } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { buildCopy } from '../../model/build/copy'
import { formatElapsed } from '../../model/build/progress'
import {
  actionableTurnId, failureNext, planPhase, replyView, turnPhase, waitingFor,
  type ConversationTurn, type FailureKind, type PlanTurn, type ReplyView, type WaitingFor,
} from '../../model/build/replies'
import { locale } from '../../shell/language'
import { Button, cn, Notice } from '../../ui'
import { Composer } from './composer'
import type { ConsoleBuildView, ConsoleProgress } from './console-view'
import { AiTurn, UserMessage } from './conversation-pane'
import { text } from './copy'
import type { ConsoleBuildActions } from './use-console-build-session'

/** Pixels from the bottom that still count as "reading the newest message". */
const STICK = 96

export function ConsoleConversation({ view, actions, restore, end, closedReason }: {
  view: ConsoleBuildView
  actions: ConsoleBuildActions
  restore?: { text: string; nonce: number }
  /** The plan's proposal (with 「この内容で作る」 or re-plan), under the turns. */
  end?: ReactNode
  /** Why the composer is closed for good (building started). */
  closedReason?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
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

  const actionable = actionableTurnId(view.turns)
  const last = view.turns.at(-1)
  const lastReply = last?.kind === 'conversation' && last.id === actionable ? replyView(last) : undefined
  // Reply chips answer the newest question only, and only while something can be sent.
  const chips = view.canSend && lastReply?.nextQuestion ? lastReply.suggestedReplies.map((reply) => ({ label: reply.label, value: reply.message })) : []
  const send = (message: string) => {
    following.current = true
    actions.send(message)
  }

  return <section className="flex min-h-0 flex-1 flex-col bg-white" aria-label={text.conversation.title}>
    <h2 className="sr-only">{text.conversation.title}</h2>
    <div ref={scroller} role="log" aria-label={text.conversation.log} aria-live="polite" tabIndex={0} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-offset-[-2px]">
      <div ref={content} className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 px-4 py-5 sm:px-6">
        <div className="mt-auto" />
        {view.turns.map((turn) => turn.kind === 'conversation'
          ? <ConversationTurnItem key={turn.id} turn={turn} view={view} actions={actions} actionable={turn.id === actionable} last={turn.id === last?.id} onChoose={(label) => { following.current = true; actions.send(text.console.candidateMessage(label), 'change') }} />
          : <PlanTurnItem key={turn.id} turn={turn} view={view} />)}
        {end}
      </div>
    </div>
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4 sm:px-6">
      {/* Closed for good (building started): the reason alone, not an input that only looks usable. */}
      {closedReason ? <p className="border-t border-stone-200 pt-3 text-xs leading-relaxed text-stone-500">{closedReason}</p>
        : <Composer chips={chips} disabled={!view.canSend} placeholder={text.conversation.replyPlaceholder} restore={restore} onSubmit={send} onChip={send} />}
    </div>
  </section>
}

function ConversationTurnItem({ turn, view, actions, actionable, last, onChoose }: {
  turn: ConversationTurn
  view: ConsoleBuildView
  actions: ConsoleBuildActions
  /** The newest turn, answered or confirming: its candidates can be chosen. */
  actionable: boolean
  last: boolean
  onChoose(label: string): void
}) {
  const phase = turnPhase(turn)
  const reply = replyView(turn)
  const active = view.activeTurn?.id === turn.id
  return <div className="flex flex-col gap-3" data-testid="console-turn" data-turn-id={turn.id}>
    <UserMessage text={turn.request.message} />
    {reply ? <AiTurn>
      <ReplyBody reply={reply} turn={turn} view={view} actions={actions} actionable={actionable} confirming={phase.kind === 'confirming'} onChoose={onChoose} />
    </AiTurn> : null}
    {phase.kind === 'working' && active ? <AiTurn><Waiting waiting={waitingFor(turn)} progress={view.progress} /></AiTurn> : null}
    {phase.kind === 'failed' ? <FailureNotice kind={phase.failure} actions={
      failureNext[phase.failure] === 'resend' && last && view.canSend
        ? <Button size="sm" onClick={() => { actions.send(turn.request.message, turn.request.intent) }}>{text.console.resend}</Button>
        : failureNext[phase.failure] === 'confirm' ? <Button size="sm" onClick={() => void actions.confirm()}>{buildCopy.failure.confirm}</Button> : undefined
    } /> : null}
    {phase.kind === 'unknown' ? <p className="text-xs text-stone-500">{text.console.unknownTurn}</p> : null}
  </div>
}

function ReplyBody({ reply, turn, view, actions, actionable, confirming, onChoose }: {
  reply: ReplyView
  turn: ConversationTurn
  view: ConsoleBuildView
  actions: ConsoleBuildActions
  actionable: boolean
  confirming: boolean
  onChoose(label: string): void
}) {
  const writing = view.write?.status === 'sending'
  const canChoose = actionable && !confirming && view.canSend
  return <div className="flex flex-col gap-3">
    {/* The answer always stands on its own: the user's question is visibly answered (APT-752). */}
    <p data-testid="reply-answer" className="whitespace-pre-wrap break-words">{reply.answer}</p>
    {reply.candidates.length ? <section aria-label={text.console.candidates} data-testid="reply-candidates">
      <p className="text-xs font-medium text-stone-500">{text.console.candidates}</p>
      {actionable && !confirming ? <ul className="mt-1.5 grid gap-2 sm:grid-cols-2">
        {reply.candidates.map((candidate) => <li key={candidate.id} className="min-w-0">
          <button type="button" disabled={!canChoose} onClick={() => onChoose(candidate.label)} className="flex h-full w-full flex-col items-start gap-0.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-left transition-colors hover:border-accent hover:bg-accent-soft/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-50 disabled:text-stone-500 disabled:hover:border-stone-200 disabled:hover:bg-stone-50">
            <span className="break-words font-medium">{candidate.label}</span>
            <span className="break-words text-xs text-stone-500">{candidate.description}</span>
          </button>
        </li>)}
      </ul> : <ul className="mt-1 space-y-1">
        {reply.candidates.map((candidate) => <li key={candidate.id} className="break-words"><span className="font-medium">{candidate.label}</span><span className="text-stone-500">{text.conversation.labelSeparator}{candidate.description}</span></li>)}
      </ul>}
      {canChoose ? <p className="mt-1.5 text-xs text-stone-500">{text.console.candidatesHint}</p> : null}
    </section> : null}
    {reply.openDecisions.length ? <section aria-label={text.console.openDecisions} data-testid="reply-open-decisions">
      <p className="text-xs font-medium text-stone-500">{text.console.openDecisions}<span className="font-normal">{text.conversation.labelSeparator}{text.console.openDecisionsHint}</span></p>
      <ul className="mt-1 space-y-1">
        {reply.openDecisions.map((decision, index) => <li key={`${index}-${decision.topic}`} className="break-words"><span className="font-medium">{decision.topic}</span><span className="text-stone-600">{text.conversation.labelSeparator}{decision.wish}</span></li>)}
      </ul>
    </section> : null}
    {reply.proposal ? <section aria-label={text.console.proposal.title} data-testid="reply-proposal" className={cn('rounded-lg border px-3.5 py-3', confirming ? 'border-accent-line bg-accent-soft/40' : 'border-stone-200')}>
      <p className="text-xs font-medium text-stone-500">{text.console.proposal.title}</p>
      <p className="mt-1 break-words font-medium">{reply.proposal.summary}</p>
      <ul className="mt-1.5 space-y-1">{reply.proposal.changes.map((change, index) => <li key={`${index}-${change}`} className="flex gap-1.5 text-stone-700"><Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" /><span className="min-w-0 break-words">{change}</span></li>)}</ul>
      {reply.proposal.decision === 'accept_spec' ? <p className="mt-2 text-xs text-accent-strong">{text.console.proposal.accepted}</p>
        : reply.proposal.decision === 'keep_spec' ? <p className="mt-2 text-xs text-stone-500">{text.console.proposal.kept}</p>
          : confirming ? <>
            <p className="mt-2 text-xs text-stone-600">{text.console.proposal.waiting}</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" tone="primary" disabled={Boolean(view.write) || view.unsupported} loading={writing && view.write?.family === 'resolution'} onClick={() => actions.resolve(turn.id, 'accept_spec')}>{text.console.proposal.accept}</Button>
              <Button size="sm" disabled={Boolean(view.write) || view.unsupported} onClick={() => actions.resolve(turn.id, 'keep_spec')}>{text.console.proposal.keep}</Button>
            </div>
          </> : null}
    </section> : null}
    {reply.nextQuestion ? <p className={cn('break-words', actionable ? 'rounded-md border-l-2 border-accent bg-accent-soft px-3 py-2 font-medium text-stone-900' : 'font-medium text-stone-700')}>{reply.nextQuestion}</p> : null}
  </div>
}

function PlanTurnItem({ turn, view }: { turn: PlanTurn; view: ConsoleBuildView }) {
  const phase = planPhase(turn)
  const active = view.activeTurn?.id === turn.id
  return <div className="flex flex-col gap-3" data-testid="console-plan-turn">
    <UserMessage text={buildCopy.questions.kickoffReply} />
    {phase.kind === 'failed' ? <FailureNotice kind={phase.failure} /> : <AiTurn>
      {phase.kind === 'working' ? active ? <Waiting waiting={phase.waiting} progress={view.progress} /> : null
        : phase.kind === 'handed_off' ? <>
          <p>{text.console.plan.handedOff(turn.specRevision)}</p>
          {active ? <div className="mt-2"><Waiting waiting="planning" progress={view.progress} /></div> : null}
        </>
          : phase.kind === 'planned' ? <p className="flex items-center gap-1.5"><Check aria-hidden className="size-4 text-accent" />{text.console.plan.planned(turn.specRevision)}</p>
            : <p className="text-xs text-stone-500">{text.console.plan.unknown}</p>}
    </AiTurn>}
  </div>
}

/** What the server is waiting for, when it last observed it, and only the server's own (≤3) activity lines. */
export function Waiting({ waiting, progress }: { waiting: WaitingFor; progress?: ConsoleProgress }) {
  const copy = text.console.progress
  const hint = waiting === 'preparing' ? copy.preparingHint : waiting === 'repairing' ? copy.repairingHint : undefined
  return <div role="status" data-testid="console-progress" data-waiting={waiting} data-slow={progress?.slow ? 'true' : undefined}>
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-stone-700">
      <Loader2 aria-hidden className="size-4 animate-spin text-accent" />
      <span>{copy.waiting[waiting]}</span>
      {progress && waiting === 'preparing' ? <span className="tabular-nums text-xs text-stone-500">{copy.elapsed(formatElapsed(progress.elapsedMs))}</span> : null}
      {progress ? <span className="tabular-nums text-xs text-stone-400">{copy.observed(new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(progress.observedAt)))}</span> : null}
    </p>
    {hint ? <p className="mt-1 text-xs text-stone-500">{hint}</p> : null}
    {progress?.activity.length ? <ul className="mt-1.5 space-y-0.5 text-xs text-stone-500">{progress.activity.map((line, index) => <li key={`${index}-${line}`} className="break-words">{line}</li>)}</ul> : null}
    {progress?.slow ? <p className="mt-1.5 text-xs text-busy-ink">{copy.slow}</p> : null}
  </div>
}

/** A typed failure in the product's words; the server's raw message is never shown in its place. */
export function FailureNotice({ kind, actions, tone = 'error' }: { kind: FailureKind; actions?: ReactNode; tone?: 'error' | 'warning' }) {
  const copy = text.console.failure[kind]
  return <Notice tone={tone} title={copy.title} actions={actions}>{copy.reason}</Notice>
}
