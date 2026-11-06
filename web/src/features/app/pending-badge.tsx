import { accessRequestCopy } from '../../copy/access-request'

export function PendingBadge({ count }: { count: number }) {
  if (count < 1) return null
  return (
    <span
      role="status"
      aria-label={`${accessRequestCopy.section}: ${count}`}
      data-testid="access-request-pending-badge"
      className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-busy-soft px-1.5 text-xs font-medium tabular-nums text-busy-ink"
    >
      {count}
    </span>
  )
}
