import { ChevronRight, X } from 'lucide-react'
import { Collapsible as RCollapsible, Dialog as RDialog, DropdownMenu as RMenu, Tooltip as RTooltip } from 'radix-ui'
import { useId, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { copy } from '../copy'
import { Button, type ButtonTone } from './button'
import { cn } from './cn'
import { ActionError } from './feedback'
import { TextInput } from './form'
import { useReturnFocus } from './focus'

/** Modal dialog (Radix): focus trap, Escape closes, focus returns to the trigger. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  returnFocusRef,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const focus = useReturnFocus(open, returnFocusRef)
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-stone-900/40 animate-fade-in" />
        <RDialog.Content
          {...focus}
          {...(!description ? { 'aria-describedby': undefined } : {})}
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-y-auto rounded-t-xl bg-white shadow-xl animate-pop-in focus:outline-none',
            'sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[calc(100%-2rem)] sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
            className
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div className="min-w-0">
              <RDialog.Title className="text-base font-semibold text-stone-900">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-1 text-sm text-stone-500">{description}</RDialog.Description> : null}
            </div>
            <RDialog.Close
              aria-label={copy.common.close}
              className="-mt-1 -mr-1 flex size-10 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-800 md:size-8"
            >
              <X aria-hidden className="size-4" />
            </RDialog.Close>
          </div>
          {children ? <div className="px-5 pt-4 pb-5 text-sm text-stone-700">{children}</div> : <div className="pb-5" />}
          {footer ? (
            <div className="flex flex-col-reverse gap-2 border-t border-stone-100 bg-stone-50/60 px-5 py-3 sm:flex-row sm:justify-end">{footer}</div>
          ) : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

/**
 * Confirmation for irreversible or widening actions (ux-design §6-5). With
 * `confirmText` the user must type it (e.g. the app name) before confirming.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel = copy.common.cancel,
  tone = 'primary',
  confirmText,
  onConfirm,
  pending = false,
  error,
  disabled = false,
  returnFocusRef,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  body: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: Extract<ButtonTone, 'primary' | 'danger'>
  confirmText?: string
  onConfirm: () => void
  pending?: boolean
  error?: unknown
  disabled?: boolean
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const ready = !disabled && (!confirmText || typed.trim() === confirmText)
  const change = (next: boolean) => {
    if (pending) return
    if (!next) setTyped('')
    onOpenChange(next)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={title}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button onClick={() => change(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button tone={tone} onClick={onConfirm} disabled={!ready} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>{body}</div>
        {confirmText ? (
          <div>
            <label htmlFor={inputId} className="block text-sm text-stone-700">
              {copy.common.confirmTyping(confirmText)}
            </label>
            <TextInput
              id={inputId}
              className="mt-1.5"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && ready && !pending) onConfirm()
              }}
            />
          </div>
        ) : null}
        {error ? <ActionError error={error} /> : null}
      </div>
    </Dialog>
  )
}

// Dropdown menu: Radix pieces with the console look.
/**
 * Non-modal by default: a modal menu whose item opens a Dialog leaves
 * `pointer-events: none` on <body> after the dialog closes (Radix layering).
 */
export function DropdownMenu({ modal = false, ...rest }: ComponentProps<typeof RMenu.Root>) {
  return <RMenu.Root modal={modal} {...rest} />
}
export const DropdownMenuTrigger = RMenu.Trigger
export const DropdownMenuGroup = RMenu.Group

export function DropdownMenuContent({ className, align = 'end', sideOffset = 6, ...rest }: ComponentProps<typeof RMenu.Content>) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn('z-50 min-w-56 max-w-[calc(100vw-1rem)] rounded-lg border border-line bg-white p-1 shadow-lg animate-pop-in', className)}
        {...rest}
      />
    </RMenu.Portal>
  )
}

export const menuItemClasses =
  'flex min-h-10 w-full cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-stone-700 outline-none select-none md:min-h-0 data-disabled:text-stone-400 data-highlighted:bg-stone-100 data-highlighted:text-stone-900 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-stone-500'

export function DropdownMenuItem({ className, ...rest }: ComponentProps<typeof RMenu.Item>) {
  return <RMenu.Item className={cn(menuItemClasses, className)} {...rest} />
}

export function DropdownMenuLabel({ className, ...rest }: ComponentProps<typeof RMenu.Label>) {
  return <RMenu.Label className={cn('px-2.5 pt-2 pb-1 text-xs font-medium text-stone-500', className)} {...rest} />
}

export function DropdownMenuSeparator({ className, ...rest }: ComponentProps<typeof RMenu.Separator>) {
  return <RMenu.Separator className={cn('-mx-1 my-1 h-px bg-stone-100', className)} {...rest} />
}

/** Short hint on hover/focus. The trigger must already carry its own accessible text. */
export function Tooltip({ content, side = 'top', children }: { content: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={300}>
      <RTooltip.Root>
        <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-72 rounded-md bg-stone-900 px-2.5 py-1.5 text-xs text-white shadow-md animate-fade-in"
          >
            {content}
            <RTooltip.Arrow className="fill-stone-900" />
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  )
}

export const Collapsible = RCollapsible.Root
export const CollapsibleTrigger = RCollapsible.Trigger
export const CollapsibleContent = RCollapsible.Content

/** The single 「詳しい人向け」 fold (ux-design §6-2): technical words live only inside it. */
export function Disclosure({ title, defaultOpen = false, children }: { title: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <RCollapsible.Root defaultOpen={defaultOpen} className="group/disclosure rounded-lg border border-stone-200 bg-white">
      <RCollapsible.Trigger className="flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left text-sm font-medium text-stone-700 hover:bg-stone-50">
        <ChevronRight aria-hidden className="size-4 text-stone-400 transition-transform group-data-[state=open]/disclosure:rotate-90" />
        {title}
      </RCollapsible.Trigger>
      <RCollapsible.Content className="border-t border-stone-100 px-4 py-3 text-sm text-stone-700">{children}</RCollapsible.Content>
    </RCollapsible.Root>
  )
}
