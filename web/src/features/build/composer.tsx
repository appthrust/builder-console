import { SendHorizontal } from 'lucide-react'
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '../../ui'
import { cn } from '../../ui/cn'
import { text as uiText } from './copy'

/** One quiet object under the transcript: optional reply chips, then a growing
 * textarea with the send button inside its frame. The keyboard contract (Enter
 * sends, Shift+Enter breaks a line, IME composition never sends) lives on the
 * send button's accessible description instead of as visible helper text, so
 * the area stays calm. Stage actions (用意する / 公開する) are not here: they
 * belong to the proposal message or the page header. */
export interface ComposerProps {
  /** Reply suggestions from the AI, or the options of an opening question. */
  chips?: { label: string; value: string }[]
  /** The opening question's title; undefined for plain suggestions. */
  chipsTitle?: string
  disabled: boolean
  placeholder: string
  /** Trimmed, non-empty, at most `MAX_LENGTH` characters. */
  onSubmit(text: string): void
  onChip(value: string, label: string): void
}

export const MAX_LENGTH = 4000
const MIN_ROWS = 3
const MAX_ROWS = 8

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer({ chips, chipsTitle, disabled, placeholder, onSubmit, onChip }, ref) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => textarea.current as HTMLTextAreaElement)
  const [text, setText] = useState('')
  const trimmed = text.trim()
  const canSend = !disabled && trimmed.length > 0 && trimmed.length <= MAX_LENGTH

  // Grow with the content between MIN_ROWS and MAX_ROWS; beyond that the textarea scrolls.
  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20
    const padding = element.offsetHeight - element.clientHeight + 16
    element.style.height = 'auto'
    const wanted = Math.min(Math.max(element.scrollHeight, lineHeight * MIN_ROWS + padding), lineHeight * MAX_ROWS + padding)
    element.style.height = `${wanted}px`
    element.style.overflowY = element.scrollHeight > wanted ? 'auto' : 'hidden'
  }, [text])

  const submit = useCallback(() => {
    if (!canSend) return
    onSubmit(trimmed)
    setText('')
    textarea.current?.focus()
  }, [canSend, onSubmit, trimmed])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // keyCode 229 covers browsers that do not expose isComposing during IME input.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    submit()
  }

  return <div className="shrink-0 border-t border-stone-200 pt-3">
    {chips?.length ? <div className="mb-2" role="group" aria-label={chipsTitle ?? uiText.composer.suggestions}>
      {chipsTitle ? <p className="mb-1.5 text-sm font-medium text-stone-800">{chipsTitle}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => <Button key={chip.value} size="sm" tone={chipsTitle ? 'secondary' : 'ghost'} className={cn(!chipsTitle && 'border border-stone-200')} disabled={disabled} onClick={() => { onChip(chip.value, chip.label); textarea.current?.focus() }}>{chip.label}</Button>)}
      </div>
    </div> : null}
    <form onSubmit={(event) => { event.preventDefault(); submit() }} className={cn('relative rounded-lg border bg-white shadow-xs transition-colors focus-within:border-accent focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-accent', disabled ? 'border-stone-200 bg-stone-50' : 'border-stone-300')}>
      <label htmlFor="build-reply" className="sr-only">{uiText.composer.label}</label>
      <textarea
        id="build-reply"
        ref={textarea}
        value={text}
        rows={MIN_ROWS}
        maxLength={MAX_LENGTH}
        disabled={disabled}
        placeholder={placeholder}
        aria-describedby="build-reply-keys"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="block w-full resize-none rounded-lg bg-transparent py-3 pr-14 pl-4 text-sm leading-6 text-stone-900 placeholder:text-stone-400 focus:outline-none disabled:cursor-not-allowed disabled:text-stone-500"
      />
      <p id="build-reply-keys" className="sr-only">{uiText.composer.keyHint}</p>
      <Button type="submit" tone="primary" size="sm" aria-label={uiText.composer.send} title={uiText.composer.keyHint} className="absolute right-2 bottom-2 w-9 rounded-md px-0" disabled={!canSend}><SendHorizontal aria-hidden /></Button>
    </form>
  </div>
})
