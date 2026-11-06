import { AlertCircle, Check, Circle, LoaderCircle } from 'lucide-react'
import { copy } from '../../copy'
import type { ProgressStep, StepState } from '../../model/progress'
import { Button } from '../../ui'

const MARK: Record<StepState, { icon: typeof Check; className: string }> = {
  done: { icon: Check, className: 'bg-accent text-white' },
  active: { icon: LoaderCircle, className: 'bg-accent-soft text-accent-strong [&>svg]:animate-spin motion-reduce:[&>svg]:animate-none' },
  pending: { icon: Circle, className: 'bg-stone-100 text-stone-400' },
  failed: { icon: AlertCircle, className: 'bg-red-600 text-white' },
}

const TITLE: Record<StepState, string> = {
  done: 'text-stone-900',
  active: 'font-medium text-stone-900',
  pending: 'text-stone-400',
  failed: 'font-medium text-red-800',
}

/** The creating view's step list; shared by the app page and the AI entry of the wizard. */
export function ProgressList({
  steps,
  onRecheck,
  rechecking,
}: {
  steps: ProgressStep[]
  /** Reads the repository again (steps with `action: 'recheck'`). */
  onRecheck?: () => void
  rechecking?: boolean
}) {
  return (
    <ol className="relative" data-testid="create-progress">
      {steps.map((step, index) => {
        const mark = MARK[step.state]
        const Icon = mark.icon
        const last = index === steps.length - 1
        return (
          <li key={step.key} data-state={step.state} data-step={step.key} className="relative flex gap-3 pb-5 last:pb-0">
            {last ? null : <span aria-hidden className="absolute top-7 bottom-1 left-3 w-px -translate-x-1/2 bg-stone-200" />}
            <span aria-hidden className={`relative inline-flex size-6 shrink-0 items-center justify-center rounded-full ${mark.className}`}>
              <Icon className="size-3.5" strokeWidth={2.5} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className={`text-sm ${TITLE[step.state]}`}>
                <span className="sr-only">{copy.progress.stateLabel[step.state]}: </span>
                {step.title}
              </p>
              {step.detail ? (
                <p className={`mt-0.5 text-xs text-stone-500 ${step.action || step.state === 'failed' ? 'break-words' : 'truncate'}`}>
                  {step.href ? (
                    <a href={step.href} target="_blank" rel="noreferrer" className="text-accent-strong underline-offset-2 hover:underline">
                      {step.detail}
                      <span aria-hidden> ↗</span>
                    </a>
                  ) : (
                    step.detail
                  )}
                </p>
              ) : null}
              {step.action === 'recheck' && onRecheck ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Button size="sm" onClick={onRecheck} loading={rechecking} disabled={rechecking}>
                    {rechecking ? copy.progress.check.rechecking : copy.progress.check.recheck}
                  </Button>
                  <span className="text-xs text-stone-500">{copy.progress.check.recheckHint}</span>
                </div>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
