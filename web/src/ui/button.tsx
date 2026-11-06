import { ArrowUpRight, Loader2 } from 'lucide-react'
import { Slot } from 'radix-ui'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { copy } from '../copy'
import { cn } from './cn'
import { HrefLink } from './link'

export type ButtonTone = 'primary' | 'secondary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md'

const TONE: Record<ButtonTone, string> = {
  primary: 'bg-accent text-white shadow-sm hover:bg-accent-strong disabled:bg-stone-300 disabled:shadow-none',
  secondary: 'border border-stone-300 bg-white text-stone-800 shadow-xs hover:bg-stone-50 hover:border-stone-400 disabled:text-stone-400 disabled:hover:bg-white',
  danger: 'bg-bad text-white shadow-sm hover:bg-bad-ink disabled:bg-stone-300 disabled:shadow-none',
  ghost: 'text-stone-700 hover:bg-stone-100 hover:text-stone-900 disabled:text-stone-400 disabled:hover:bg-transparent',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-10 gap-1.5 px-2.5 text-xs md:h-8',
  md: 'h-10 gap-2 px-3.5 text-sm md:h-9',
}

/** Shared by <Button> and <LinkButton> so buttons and button-styled links look and focus the same. */
export function buttonClasses(tone: ButtonTone = 'secondary', size: ButtonSize = 'md', className?: string): string {
  return cn(
    'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed [&_svg]:size-4 [&_svg]:shrink-0',
    TONE[tone],
    SIZE[size],
    className
  )
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone
  size?: ButtonSize
  /** Shows a spinner, disables the button and sets aria-busy; the label stays so the width does not jump. */
  loading?: boolean
  /** Leading 16px lucide icon; always paired with the visible label. */
  icon?: ReactNode
  /** Render the single child element (e.g. an anchor) with button styling instead of a <button>. */
  asChild?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function Button({ tone = 'secondary', size = 'md', loading = false, icon, asChild = false, className, type = 'button', disabled, children, ref, ...rest }: ButtonProps) {
  const classes = buttonClasses(tone, size, className)
  if (asChild) {
    return (
      <Slot.Root className={classes} {...rest}>
        {children}
      </Slot.Root>
    )
  }
  return (
    <button ref={ref} type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 aria-hidden className="animate-spin" /> : icon ? <span aria-hidden className="contents">{icon}</span> : null}
      {children}
    </button>
  )
}

/** Compact row action with an accessible name and a 40px mobile target. */
export function IconButton({ label, size = 'sm', tone = 'ghost', className, ...rest }: Omit<ButtonProps, 'children' | 'aria-label'> & { label: string }) {
  return <Button {...rest} aria-label={label} title={label} tone={tone} size={size} className={cn('w-10 px-0', size === 'sm' ? 'md:w-8' : 'md:w-9', className)} />
}

/** Published app URL: open a new tab without nesting interactive row actions. */
export function OpenLink({ href, label = copy.appList.open }: { href: string; label?: string }) {
  return <LinkButton href={href} external tone="ghost" size="sm" aria-label={label} title={label} icon={<ArrowUpRight />} className="w-10 px-0 md:w-8" />
}

export type LinkButtonProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  tone?: ButtonTone
  size?: ButtonSize
  icon?: ReactNode
  /** Console URL (group/app splats, `paths.*`) — navigates inside the SPA. */
  href?: string
  /** Static route path such as "/mine"; same as `href`. */
  to?: string
  /** Full-page navigation in a new tab (published app URLs). */
  external?: boolean
}

/** A link that looks like a button (TanStack <Link> for console URLs, plain <a> for external ones). */
export function LinkButton({ tone = 'secondary', size = 'md', icon, href, to, external = false, className, children, ...rest }: LinkButtonProps) {
  const classes = buttonClasses(tone, size, className)
  const target = href ?? to ?? '/'
  const content = (
    <>
      {icon ? <span aria-hidden className="contents">{icon}</span> : null}
      {children}
    </>
  )
  if (external) {
    return (
      <a href={target} target="_blank" rel="noreferrer noopener" className={classes} {...rest}>
        {content}
      </a>
    )
  }
  return (
    <HrefLink href={target} className={classes} {...rest}>
      {content}
    </HrefLink>
  )
}
