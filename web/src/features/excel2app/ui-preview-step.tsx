// Step 4 of Excel → app: the planned app in a live preview next to the chat
// with the AI that changes it. Presentational: the page owns the draft, sends
// each instruction as a ui-design conversation turn and passes back the
// server's `UiDesign`, the conversation, and whether a turn is running.
// Side by side the frame and the chat share one height and scroll on their
// own, so a reply and its effect on the screens stay visible together; narrow
// screens stack them.
import type { UiDesign } from '@appthrust/api-schema/platform-api'
import { AlertCircle, Loader2, RotateCcw, SendHorizontal, Sparkles, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { buildCopy } from '../../model/build/copy'
import { classifyBuildFailure, isAIQuotaExhausted } from '../../model/build/failure'
import { Button, cn, TextInput } from '../../ui'
import { text } from './assistant-copy'
import type { AppPlan, WorkbookGrid } from './model'
import { previewText } from './preview-copy'
import { UiPreview } from './ui-preview'
import type { UiPreviewChatMessage } from './use-excel2app-draft'

export interface UiPreviewStepProps {
  plan: AppPlan
  /** The server's design; `null` until the first ui-design turn has produced one. */
  design: UiDesign | null
  grids: ReadonlyMap<string, WorkbookGrid>
  messages: UiPreviewChatMessage[]
  /** A ui-design turn is running. */
  busy: boolean
  /** Created drafts keep their preview and history, but cannot change the design. */
  readOnly?: boolean
  /** The running turn's latest activity, shown muted under the typing indicator. */
  activityTail?: string
  onSend: (instruction: string) => void
  onUndo: () => void
  canUndo: boolean
  suggestions: string[]
  /** Re-sends the failed turn; the retry button shows on a trailing failed message only when given. */
  onRetry?: () => void
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The first shown screen a design change touched, so the preview jumps to
 * where the AI just worked; `undefined` when only app-wide settings changed.
 */
export function changedScreenId(before: UiDesign, after: UiDesign): string | undefined {
  const visible = after.screens.filter((screen) => !screen.hidden)
  const previous = before.screens.filter((screen) => !screen.hidden)
  for (const [index, screen] of visible.entries()) {
    const old = previous[index]
    if (!old || old.id !== screen.id || old.title !== screen.title) return screen.id
  }
  const screenOf = (kind: string, entity?: string) => visible.find((screen) => screen.kind === kind && (entity === undefined || screen.entity === entity))?.id
  for (const entity of Object.keys(after.lists)) {
    if (!sameJson(before.lists[entity], after.lists[entity])) {
      const id = screenOf('list', entity)
      if (id) return id
    }
  }
  for (const entity of Object.keys(after.forms)) {
    if (!sameJson(before.forms[entity], after.forms[entity])) {
      const id = screenOf('form', entity)
      if (id) return id
    }
  }
  if (!sameJson(before.dashboard, after.dashboard)) return screenOf('dashboard')
  return undefined
}

export function UiPreviewStep({ plan, design, grids, messages, busy, readOnly = false, activityTail, onSend, onUndo, canUndo, suggestions, onRetry }: UiPreviewStepProps) {
  const visible = design?.screens.filter((screen) => !screen.hidden) ?? []
  const [screenId, setScreenId] = useState(visible[0]?.id ?? '')
  const [shownDesign, setShownDesign] = useState(design)
  // A new design from the AI moves the preview to the screen it changed.
  if (design !== shownDesign) {
    setShownDesign(design)
    const focus = shownDesign && design ? changedScreenId(shownDesign, design) : undefined
    if (focus) setScreenId(focus)
  }
  // A screen the AI just hid falls back to the first one still shown.
  const selected = visible.some((screen) => screen.id === screenId) ? screenId : (visible[0]?.id ?? '')
  // The newest non-empty line of the running turn's activity log.
  const activity = activityTail
    ?.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)

  return (
    <div className="@container space-y-4">
      {!readOnly ? <p className="text-sm text-stone-600">{text.chat.lead}</p> : null}
      <div className="grid gap-5 @2xl:h-[clamp(34rem,calc(100dvh-7rem),44rem)] @2xl:grid-cols-[minmax(0,1fr)_17rem] @2xl:grid-rows-[minmax(0,1fr)] @5xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div data-testid="excel2app-preview" className="min-w-0 @2xl:min-h-0">
          {design ? (
            <UiPreview plan={plan} design={design} grids={grids} screenId={selected} onScreenChange={setScreenId} />
          ) : (
            <PreviewSkeleton busy={busy} activity={activity} />
          )}
        </div>
        <ChatPanel
          messages={messages}
          busy={busy}
          readOnly={readOnly}
          activity={design ? activity : undefined}
          ready={design !== null}
          onSend={onSend}
          onUndo={onUndo}
          canUndo={canUndo}
          suggestions={suggestions}
          onRetry={onRetry}
        />
      </div>
    </div>
  )
}

/** The frame before the first design exists: its outline, and what the AI is doing. */
function PreviewSkeleton({ busy, activity }: { busy: boolean; activity?: string }) {
  const bar = cn('rounded bg-stone-200', busy && 'motion-safe:animate-pulse')
  return (
    <section data-testid="excel2app-ui-preview-skeleton" aria-busy={busy} className="flex h-full min-h-[32rem] flex-col overflow-hidden rounded-xl border border-stone-300/80 bg-white shadow-sm">
      <div aria-hidden className="flex shrink-0 items-center gap-3 border-b border-stone-200 bg-stone-100 px-3 py-2">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-stone-300" />
          <span className="size-2.5 rounded-full bg-stone-300" />
          <span className="size-2.5 rounded-full bg-stone-300" />
        </span>
        <span className="h-6 flex-1 rounded-md bg-white ring-1 ring-stone-200" />
      </div>
      <div className="relative flex flex-1 flex-col @xl:flex-row">
        <div aria-hidden className="flex shrink-0 gap-2 border-b border-stone-200 bg-stone-50 p-3 @xl:w-44 @xl:flex-col @xl:border-r @xl:border-b-0">
          {[0, 1, 2, 3].map((item) => (
            <span key={item} className={cn('h-5 w-20 @xl:w-full', bar)} />
          ))}
        </div>
        <div aria-hidden className="flex flex-1 flex-col gap-3 p-5">
          <span className={cn('h-6 w-40', bar)} />
          <span className={cn('h-8 w-full', bar)} />
          {[0, 1, 2, 3, 4].map((item) => (
            <span key={item} className={cn('h-5 w-full', bar)} />
          ))}
        </div>
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div role="status" className="flex max-w-sm flex-col items-center gap-1.5 rounded-lg bg-white/90 px-5 py-4 text-center shadow-sm ring-1 ring-stone-200">
            <p className="flex items-center gap-2 text-sm font-medium text-stone-800">
              {busy ? <Loader2 aria-hidden className="size-4 animate-spin text-accent" /> : null}
              {busy ? previewText.preparing : previewText.notReady}
            </p>
            {busy && activity ? (
              <p aria-hidden data-testid="excel2app-ui-preview-activity" className="w-full truncate font-mono text-xs text-stone-500">{activity}</p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}

interface ChatPanelProps {
  messages: UiPreviewChatMessage[]
  busy: boolean
  readOnly: boolean
  activity?: string
  /** A design exists to change; before that only もう一度 can move on. */
  ready: boolean
  onSend: (instruction: string) => void
  onUndo: () => void
  canUndo: boolean
  suggestions: string[]
  onRetry?: () => void
}

function ChatPanel({ messages, busy, readOnly, activity, ready, onSend, onUndo, canUndo, suggestions, onRetry }: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const log = useRef<HTMLOListElement>(null)
  const blocked = busy || !ready || readOnly

  // Keep the newest message (or the typing indicator) in view. When the chat
  // sits under the preview (phones), a reply that reshapes the preview would push
  // the chat off screen; keep the input the user is typing in where it was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the conversation grows or settles, not on every render.
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
    if (document.activeElement === input.current) input.current?.scrollIntoView({ block: 'nearest' })
  }, [messages.length, busy])

  const submit = (instruction: string) => {
    const trimmed = instruction.trim()
    if (!trimmed || blocked) return
    onSend(trimmed)
    setDraft('')
    input.current?.focus()
  }

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    // Enter that confirms an IME conversion (keyCode 229 in Safari) must not send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    submit(draft)
  }

  return (
    <section aria-labelledby="excel2app-chat-title" className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-stone-50 @2xl:h-full @2xl:min-h-0">
      <header className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-4 py-2.5">
        <Sparkles aria-hidden className="size-4 shrink-0 text-accent" />
        <h3 id="excel2app-chat-title" className="min-w-0 truncate text-sm font-semibold text-stone-900">{text.chat.title}</h3>
        <Button
          type="button"
          tone="ghost"
          size="sm"
          className="ml-auto"
          disabled={!canUndo || blocked}
          onClick={() => {
            onUndo()
            input.current?.focus()
          }}
          icon={<Undo2 />}
          data-testid="excel2app-chat-undo"
        >
          {text.chat.undo}
        </Button>
      </header>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard. */}
      <ol ref={log} aria-label={text.chat.messages} aria-live="polite" aria-busy={busy} tabIndex={0} className="max-h-80 min-h-40 flex-1 space-y-3 overflow-y-auto px-4 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent @2xl:max-h-none @2xl:min-h-0">
        {messages.map((message, index) => {
          const state = message.failed ? 'failed' : message.pending ? 'pending' : undefined
          const quota = message.failed && isAIQuotaExhausted(message.text)
          const failure = message.failed ? message.failure ?? classifyBuildFailure(message.text, undefined, 'turn') : undefined
          const policy = failure?.kind === 'policy' ? failure : undefined
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the conversation only grows; an index is its identity.
            <li key={index} data-testid="excel2app-chat-message" data-role={message.role} data-state={state} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
              {message.failed ? (
                <div className="max-w-[85%] space-y-2 rounded-2xl rounded-bl-sm border border-red-200 bg-bad-soft px-3.5 py-2.5 text-sm text-bad-ink">
                  <p className="flex items-center gap-1.5 font-medium">
                    <AlertCircle aria-hidden className="size-4 shrink-0" />
                    {policy ? policy.title : quota ? buildCopy.failure.quota.title : text.chat.failed}
                  </p>
                  {policy ? <p className="leading-relaxed">{policy.reason}</p> : quota ? <p className="leading-relaxed">{buildCopy.failure.quota.reason}</p> : message.text ? <p className="leading-relaxed break-words whitespace-pre-line">{message.text}</p> : null}
                  {!policy && onRetry && index === messages.length - 1 && !busy && !readOnly ? (
                    <Button type="button" tone="secondary" size="sm" icon={<RotateCcw />} onClick={onRetry} data-testid="excel2app-chat-retry">
                      {text.chat.retry}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-line transition-opacity',
                    message.role === 'user' ? 'rounded-br-sm bg-accent text-white' : 'rounded-bl-sm border border-stone-200 bg-white text-stone-800 shadow-xs',
                    message.pending && 'opacity-60',
                  )}
                >
                  <span className="sr-only">{message.role === 'user' ? text.chat.you : text.chat.assistant}: </span>
                  {message.text}
                  {message.pending ? <span className="sr-only"> ({text.chat.pending})</span> : null}
                </p>
              )}
            </li>
          )
        })}
        {busy ? (
          <li data-testid="excel2app-chat-thinking" className="flex justify-start">
            <div className="max-w-[85%] min-w-0 rounded-2xl rounded-bl-sm border border-stone-200 bg-white px-3.5 py-2 text-sm text-stone-500 shadow-xs">
              <p className="inline-flex items-center gap-2">
                <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-accent" />
                {text.chat.thinking}
              </p>
              {/* The activity log changes every few seconds; announcing each line would drown the conversation. */}
              {activity ? <p aria-hidden data-testid="excel2app-chat-activity" className="mt-1 truncate font-mono text-xs text-stone-400">{activity}</p> : null}
            </div>
          </li>
        ) : null}
      </ol>
      <div className="shrink-0 space-y-3 border-t border-stone-200 bg-white px-4 py-3">
        {suggestions.length > 0 ? (
          <div>
            <p id="excel2app-chat-suggestions" className="text-xs text-stone-500">{text.chat.suggestions}</p>
            <ul aria-labelledby="excel2app-chat-suggestions" className="mt-1.5 flex flex-wrap gap-1.5">
              {suggestions.map((suggestion) => (
                <li key={suggestion}>
                  <button type="button" data-testid="excel2app-chat-suggestion" disabled={blocked} onClick={() => submit(suggestion)} className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs text-stone-700 transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent-strong focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-stone-200 disabled:hover:bg-white disabled:hover:text-stone-700">
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            submit(draft)
          }}
        >
          <TextInput ref={input} data-testid="excel2app-chat-input" aria-label={text.chat.input} aria-describedby="excel2app-chat-hint" placeholder={text.chat.placeholder} disabled={readOnly} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} autoComplete="off" enterKeyHint="send" />
          <Button type="submit" tone="primary" data-testid="excel2app-chat-send" disabled={!draft.trim() || blocked} icon={<SendHorizontal />}>{text.chat.send}</Button>
        </form>
        <p id="excel2app-chat-hint" className="sr-only">{text.chat.sendHint}</p>
      </div>
    </section>
  )
}
