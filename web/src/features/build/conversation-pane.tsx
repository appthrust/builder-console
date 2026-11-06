import { ArrowRight, Check, Clock, Loader2, Sparkles } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { buildCopy } from '../../model/build/copy'
import { buildFailureReference } from '../../model/build/failure'
import { assistantParts } from '../../model/build/messages'
import { isFirstTurn, isPrepareTurn, prepareShareLabel, replyOptions } from '../../model/build/questions'
import type { BuildFailure, BuildMessage, BuildStage, ProgressCard } from '../../model/build/types'
import { paths } from '../../routes/paths'
import { Button, cn, CopyButton, HrefLink, Notice } from '../../ui'
import { Composer } from './composer'
import { ProposalBody } from './proposal'
import { NameChoice } from './name-choice'
import { text as uiText } from './copy'

type Assistant = Extract<BuildMessage, { role: 'assistant' }>

/** Pixels from the bottom that still count as "reading the newest message". */
const STICK = 96

export function ConversationPane({ messages, stage, answering, thinking: turnPending, waitingForAi, planning, proposalAction, queued, progress, prepareOpen, ownerGroupName, failure, onSend, onRetry, onUseName }: {
  messages: BuildMessage[]
  stage: BuildStage
  answering: boolean
  /** A conversation turn is in flight; `progress` then describes it. */
  thinking: boolean
  /** The AI gate is temporarily refusing (412) and the reply is retried automatically. */
  waitingForAi?: boolean
  /** The plan the proposal will show is being made (not as part of 用意する). */
  planning?: Pick<ProgressCard, 'title' | 'hint' | 'elapsedLabel'>
  /** The stage action that belongs to the AI's proposal (「この内容で開発する」). */
  proposalAction?: ReactNode
  queued: boolean
  /** The AI is still asking its 用意する questions (name, who sees the app), also after the app is made. */
  prepareOpen?: boolean
  ownerGroupName?: string
  progress?: ProgressCard
  /** The current failure; a name collision turns the notice's action into the name choice. */
  failure?: BuildFailure
  onSend(text: string): void
  onRetry(kind: NonNullable<Extract<BuildMessage, { role: 'notice' }>['retry']>): void
  onUseName(name: string): void
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const submit = (text: string) => {
    if (answering) return
    following.current = true
    onSend(text)
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

  // While 用意する runs, `progress` describes the preparation, not the AI's turn.
  const turnProgress = progress?.kind === 'turn' || progress?.kind === 'workspace' ? progress : buildCopy.progress.turn
  const thinking: Pick<ProgressCard, 'title' | 'hint' | 'elapsedLabel'> | undefined = turnPending ? turnProgress : waitingForAi ? buildCopy.failure.waitingForAi : planning
  // The AI's last reply the user can answer; the derived proposal does not replace its question or chips.
  const last = [...messages].reverse().find((message) => message.role !== 'notice' && !(message.role === 'assistant' && message.proposal))
  const latest = last?.role === 'assistant' ? last : undefined
  // 用意する keeps the conversation open: the AI asks the published name and who sees the app.
  const answerable = stage === 'ask' || stage === 'decide' || stage === 'build' || Boolean(prepareOpen)
  const suggestions = !turnPending && !planning && answerable ? replyOptions(messages) : []
  const chips = suggestions.map((option) => {
    const label = prepareOpen ? prepareShareLabel(option, ownerGroupName) : option
    return { label, value: label }
  })
  const placeholder = (stage === 'build' || stage === 'publish') && !prepareOpen ? uiText.conversation.changesPlaceholder : uiText.conversation.replyPlaceholder

  return <section className="flex min-h-0 flex-1 flex-col bg-white" aria-label={uiText.conversation.title}>
    <h2 className="sr-only">{uiText.conversation.title}</h2>
    <div ref={scroller} role="log" aria-label={uiText.conversation.log} aria-live="polite" tabIndex={0} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-offset-[-2px]">
      <div ref={content} className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 px-4 py-5 sm:px-6">
        <p className="mt-auto text-xs leading-relaxed text-stone-500">{uiText.conversation.reflected}</p>
        {messages.map((message, index) => {
          const key = `${message.at}-${index}`
          if (message.role === 'notice') {
            // Retrying a prepare with the same name can only fail again: the only way forward is a different name.
            const nameTaken = message.retry === 'prepare' && failure?.kind === 'name-taken' && message.title === failure.title
            const actions = nameTaken ? <NameChoice suggestion={failure.suggestedName} onUse={onUseName} /> : message.retry ? <Button size="sm" onClick={() => onRetry(message.retry!)}>{uiText.conversation.retry}</Button> : undefined
            const reference = message.reference ? buildFailureReference(message.reference) : undefined
            return <Notice key={key} tone={message.tone} title={message.title} actions={actions}>
              {message.detail}
              {reference ? <div className="mt-3 flex flex-wrap items-center gap-2"><span className="min-w-0 break-all text-xs">{reference}</span><CopyButton value={reference} label={buildCopy.failure.copyReference} /></div> : null}
            </Notice>
          }
          // The console's own requests (opening, 用意する) are not the user's words; the AI's question speaks for them.
          if (message.role === 'user') return isFirstTurn(message.text) || isPrepareTurn(message.text) ? null : <UserMessage key={key} text={message.text} />
          return <AssistantMessage key={key} message={message} active={message === latest && answerable} action={message.proposal ? proposalAction : undefined} />
        })}
        {thinking ? <AiTurn>
          <p className="flex items-center gap-2 text-stone-600"><Loader2 aria-hidden className="size-4 animate-spin text-accent" />{thinking.title}{thinking.elapsedLabel ? <span className="tabular-nums text-stone-400">{thinking.elapsedLabel}</span> : null}</p>
          {thinking.hint ? <p className="mt-1 text-xs text-stone-500">{thinking.hint}</p> : null}
        </AiTurn> : null}
        {queued && !thinking ? <p className="ml-auto flex max-w-[85%] items-start gap-1.5 text-right text-xs text-stone-500">
          <Clock aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>{progress ? uiText.conversation.queuedAfter(progress.title) : uiText.conversation.queuedSoon}{progress?.elapsedLabel ? uiText.conversation.elapsed(progress.elapsedLabel) : ''}</span>
        </p> : null}
      </div>
    </div>
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4 sm:px-6">
      <Composer ref={input} chips={chips} disabled={answering} placeholder={placeholder} onSubmit={submit} onChip={submit} />
    </div>
  </section>
}

export function UserMessage({ text }: { text: string }) {
  return <article className="ml-auto max-w-[min(85%,60ch)] rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words text-stone-900">
    <span className="sr-only">{uiText.conversation.you}</span>{text}
  </article>
}

export function AiTurn({ label, children }: { label?: string; children: ReactNode }) {
  return <article className="mr-4 max-w-[70ch] text-sm leading-relaxed text-stone-900">
    <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-stone-500"><Sparkles aria-hidden className="size-3.5 text-accent" />{uiText.conversation.ai}{label ? <span className="font-normal text-stone-400">{uiText.conversation.labelSeparator}{label}</span> : null}</p>
    {children}
  </article>
}

/** The thing the user must answer: emphasised only while it is the open question. */
function QuestionLine({ active, children }: { active: boolean; children: ReactNode }) {
  return <p className={cn('break-words', active ? 'rounded-md border-l-2 border-accent bg-accent-soft px-3 py-2 font-medium text-stone-900' : 'font-medium text-stone-700')}>{children}</p>
}

export function AssistantMessage({ message, active, action }: { message: Assistant; active: boolean; action?: ReactNode }) {
  if (message.proposal) return <AiTurn><ProposalBody proposal={message.proposal} action={action} /></AiTurn>
  const { summary, changed, question } = assistantParts(message)
  return <AiTurn>
    {summary ? <p className="whitespace-pre-line break-words">{summary}</p> : null}
    {changed.length ? <div className={cn(summary && 'mt-2')}>
      <p className="text-xs font-medium text-stone-500">{uiText.conversation.changed}</p>
      <ul className="mt-1 space-y-1">{changed.map((item, index) => <li key={`${index}-${item}`} className="flex gap-1.5 text-stone-700"><Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" /><span className="min-w-0 break-words">{item}</span></li>)}</ul>
    </div> : null}
    {question ? <div className={cn((summary || changed.length > 0) && 'mt-2.5')}><QuestionLine active={active}>{question}</QuestionLine></div> : null}
    {message.link ? <HrefLink href={paths.excel2app(message.link.draftId)} className="mt-1 inline-flex min-h-8 items-center gap-1 text-sm font-medium text-accent-strong underline underline-offset-2 hover:text-stone-900">{uiText.conversation.excelReview}<ArrowRight aria-hidden className="size-3.5" /></HrefLink> : null}
  </AiTurn>
}
