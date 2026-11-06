import type { ReactNode } from 'react'

/** Label / value rows of the confirm and plan steps; stacked on narrow screens. */
export function SummaryList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-stone-100 rounded-lg border border-stone-200">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[10rem_1fr] sm:gap-4">
          <dt className="text-stone-500">{label}</dt>
          <dd className="min-w-0 break-words text-stone-900">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
