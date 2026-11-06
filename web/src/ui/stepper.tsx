import { Check } from 'lucide-react'
import { copy } from '../copy'
import { cn } from './cn'

/**
 * Numbered wizard steps; narrow screens show the current step name beneath the dots.
 * `compact` fits a header row: short connectors, smaller dots, and only the current
 * step's name below `lg` (the others stay available to screen readers).
 */
export function Stepper({ step, labels, compact = false }: { step: number; labels: readonly string[]; compact?: boolean }) {
  return (
    <nav aria-label={copy.common.creationSteps}>
      <ol className={cn('flex items-center', compact ? 'gap-1.5' : 'gap-2')}>
        {labels.map((label, index) => {
          const done = index < step
          const current = index === step
          const last = index === labels.length - 1
          return (
            <li key={label} aria-current={current ? 'step' : undefined} className={cn('flex min-w-0 items-center', compact ? 'gap-1.5' : 'gap-2', !last && !compact && 'flex-1')}>
              <span aria-hidden className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold', compact ? 'size-5 text-[11px]' : 'size-7 text-xs', current ? 'bg-accent text-white' : done ? 'bg-accent-soft text-accent-strong' : 'border border-stone-300 bg-white text-stone-500')}>
                {done ? <Check className={compact ? 'size-3' : 'size-4'} /> : index + 1}
              </span>
              <span className={cn(
                'truncate',
                compact ? 'text-xs' : 'text-sm',
                compact ? current ? 'whitespace-nowrap' : 'sr-only lg:not-sr-only' : 'sr-only md:not-sr-only',
                current ? 'font-semibold text-stone-900' : done ? 'text-stone-700' : 'text-stone-500'
              )}>
                {label}
                {done ? <span className="sr-only">（{copy.progress.stateLabel.done}）</span> : null}
              </span>
              {!last ? <span aria-hidden className={cn('h-px', compact ? 'w-3 shrink-0 max-sm:hidden lg:w-5' : 'min-w-4 flex-1', done ? 'bg-accent/50' : 'bg-stone-200')} /> : null}
            </li>
          )
        })}
      </ol>
      {compact ? null : <p aria-hidden className="mt-2 text-sm font-semibold text-stone-900 md:hidden">{labels[step]}</p>}
    </nav>
  )
}
