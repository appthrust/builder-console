import { AlertTriangle, CheckCircle2, Info, Loader2, RotateCw, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { isAccessDenied } from '../api/platform-error'
import { isConsoleError } from '../api/console'
import { isResponseContractError } from '../api/boundary'
import { AccessForbiddenError } from '../api/access'
import { platformErrorEnvelope } from '../api/platform-error'
import { isPublishPreparationPending } from '../api/publish-retry'
import { copy, type ConsoleStatus } from '../copy'
import { Button } from './button'
import { cn } from './cn'

const PILL: Record<ConsoleStatus, { pill: string; dot: string }> = {
  live: { pill: 'bg-ok-soft text-accent-strong ring-accent-line', dot: 'bg-ok' },
  deploying: { pill: 'bg-busy-soft text-busy-ink ring-amber-200', dot: 'bg-busy animate-pulse' },
  failed: { pill: 'bg-bad-soft text-bad-ink ring-red-200', dot: 'bg-bad' },
  unfinished: { pill: 'bg-white text-stone-600 ring-stone-300', dot: 'border border-stone-400' },
  unknown: { pill: 'bg-stone-100 text-stone-600 ring-stone-200', dot: 'bg-stone-400' },
}

/** The status words (ux-design §10). Color is never the only signal: the word is always shown. */
export function StatusPill({ status, label, second }: { status: ConsoleStatus; label?: string; second?: string }) {
  const style = PILL[status]
  const pill = (
    <span
      data-status={status}
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', style.pill)}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', style.dot)} />
      {label ?? copy.status[status]}
    </span>
  )
  return second ? (
    <span className="inline-flex min-w-0 flex-col items-start gap-1.5">
      {pill}
      <span className="text-xs leading-relaxed text-stone-500">{second}</span>
    </span>
  ) : pill
}

export type NoticeTone = 'info' | 'success' | 'warning' | 'error'

const NOTICE: Record<NoticeTone, { box: string; icon: ReactNode }> = {
  info: { box: 'border-stone-200 bg-white text-stone-700', icon: <Info className="text-accent" /> },
  success: { box: 'border-accent-line bg-accent-soft text-accent-strong', icon: <CheckCircle2 /> },
  warning: { box: 'border-amber-200 bg-busy-soft text-busy-ink', icon: <AlertTriangle /> },
  error: { box: 'border-red-200 bg-bad-soft text-bad-ink', icon: <XCircle /> },
}

export function Notice({
  tone = 'info',
  title,
  children,
  actions,
  className,
}: {
  tone?: NoticeTone
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const style = NOTICE[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0', style.box, className)}
    >
      {style.icon}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title ? 'mt-0.5 opacity-90' : undefined)}>{children}</div> : null}
        {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

export function EmptyState({ icon, title, body, action, heading = 'p' }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; heading?: 'p' | 'h1' | 'h2' }) {
  const Heading = heading
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-stone-300 bg-white px-6 py-12 text-center">
      {icon ? (
        <span aria-hidden className="mb-3 flex size-10 items-center justify-center rounded-full bg-stone-100 text-stone-500 [&_svg]:size-5">
          {icon}
        </span>
      ) : null}
      <Heading className={cn('font-medium text-stone-800', heading === 'h1' ? 'text-xl' : 'text-sm')}>{title}</Heading>
      {body ? <p className="mt-1 max-w-sm text-sm text-stone-500">{body}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function Loading({ label = copy.common.loading, className }: { label?: string; className?: string }) {
  return (
    <p role="status" className={cn('flex items-center gap-2 py-6 text-sm text-stone-500', className)}>
      <Loader2 aria-hidden className="size-4 animate-spin text-accent" />
      {label}
    </p>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block animate-pulse rounded-md bg-stone-200/70', className)} />
}

/** 401 / access denied: retrying cannot help, the caller has to sign in again or ask an admin. */
export const isSignInError = (error: unknown) => isAccessDenied(error) || (isConsoleError(error) && error.status === 401)

/** A 401 cannot be fixed by retrying, so it gets the access-denied text and no retry button. */
export function LoadFailed({ error, onRetry }: { error?: unknown; onRetry: () => void }) {
  if (isSignInError(error)) return <Notice tone="error">{copy.common.accessDenied}</Notice>
  return (
    <Notice
      tone="error"
      title={copy.common.loadFailed}
      actions={
        <Button size="sm" icon={<RotateCw />} onClick={onRetry}>
          {copy.common.retry}
        </Button>
      }
    />
  )
}

/** Japanese text for a known console error code; undefined for anything else. */
function consoleErrorText(error: unknown): string | undefined {
  if (!isConsoleError(error)) return undefined
  if (error.status === 403) return copy.errors.forbidden
  if (error.code === 'slug_taken') return copy.errors.slugTaken
  if (error.code === 'directory_unavailable') return copy.errors.directoryUnavailable
  if (error.status === 409) return copy.errors.conflict
  if (error.status === 400) return copy.errors.invalid
  if (error.status === 502) return copy.errors.upstream
  return undefined
}

/** Failed mutation: Japanese summary first; server detail (not localized) only as a secondary hint. */
export function ActionError({ error }: { error: unknown }) {
  if (error instanceof AccessForbiddenError) return <Notice tone="error">{error.message}</Notice>
  if (isAccessDenied(error)) return <Notice tone="error">{copy.common.accessDenied}</Notice>
  if (isPublishPreparationPending(error)) return <Notice tone="warning">{copy.errors.publishPreparationPending}</Notice>
  // The write was sent; only its answer is unreadable. Never imply it failed or invite a blind resend.
  if (isResponseContractError(error)) return <Notice tone="warning">{error.outcome === 'write_unconfirmed' ? copy.common.resultUnconfirmed : copy.common.loadFailed}</Notice>
  if (isConsoleError(error) && error.transient) return <Notice tone="error" title={copy.errors.transient} />
  const known = consoleErrorText(error)
  if (known) return <Notice tone="error">{known}</Notice>
  const detail = isConsoleError(error) ? error.message : platformErrorEnvelope(error)?.message
  return (
    <Notice tone="error" title={copy.common.actionFailed}>
      {detail ? <span className="block text-xs">{detail}</span> : null}
    </Notice>
  )
}
