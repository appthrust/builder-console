import { useEffect, useRef, useState, type JSX } from 'react'
import { buildProgress } from '../../../model/build/progress'
import { buildCopy } from '../../../model/build/copy'
import { buildFailureReference } from '../../../model/build/failure'
import type { ProgressCard } from '../../../model/build/types'
import { Button, Card, CardBody, CardHeader, CopyButton, Notice } from '../../../ui'
import { implementationCopy as copy } from './copy'
import { PreviewDatabaseLine, type PreviewDatabaseControl } from './preview-database'
import { implemented, type ImplementationState } from './state'
import { text } from '../copy'


export function ImplementPanel({ state, preparation, released, previewNotice, previewDatabase, onOpenPreview, onRetry, onSkipTask }: {
  state: ImplementationState
  preparation?: ProgressCard
  released: boolean
  /** The 「データベースなし」 notice, for workspaces without their own preview database. */
  previewNotice?: string
  previewDatabase?: PreviewDatabaseControl
  onOpenPreview(): void
  onRetry?(): void
  onSkipTask?(id: string): void
}): JSX.Element {
  const preview = useRef<HTMLIFrameElement>(null)
  const [previewRevision, setPreviewRevision] = useState(0)
  const [now, setNow] = useState(Date.now)
  const ticking = state.startedAt !== undefined && state.tasks.some((task) => task.status === 'running')
  // The elapsed time on the running task is the user's only proof that something is happening.
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [ticking])
  const failedTask = state.tasks.find((task) => task.id === state.currentTaskId && task.status === 'failed')
  const reference = state.failure?.reference ? buildFailureReference(state.failure.reference) : undefined
  const nothingImplemented = state.phase === 'done' && !implemented(state)
  const progress = buildProgress(preparation, state, now, released)
  const previewReady = Boolean(state.previewUrl) && state.previewStatus === 'ready'
  const taskStarted = state.tasks.some((task) => task.status === 'running' || task.status === 'done' || task.status === 'failed')
  // The preview first appears with the first task. A new run (retry, skip, change)
  // starts with every task pending; a preview already shown stays mounted then,
  // instead of tearing down the iframe and reloading the app when a task starts.
  const [previewShown, setPreviewShown] = useState(false)
  if (previewReady && taskStarted && !previewShown) setPreviewShown(true)
  const previewStarted = taskStarted || (previewShown && previewReady)
  const newTabAvailable = Boolean(state.previewUrl) && (previewReady || state.previewStatus === 'error' || state.previewStatus === 'timed-out')
  const previewMessage = state.previewStatus === 'error' ? copy.previewError : state.previewStatus === 'timed-out' ? copy.previewTimedOut : copy.preparing
  const openPreview = () => {
    if (!previewReady) return
    setPreviewRevision((value) => value + 1)
    preview.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    preview.current?.focus()
    onOpenPreview()
  }
  return (
    <div className="space-y-4">
      {previewStarted ? <Card>
        <CardHeader title={copy.title} actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!previewReady} onClick={openPreview}>{copy.open}</Button>
            {newTabAvailable ? <Button asChild tone="ghost" size="sm">
              <a href={state.previewUrl} target="_blank" rel="noopener noreferrer">{copy.newTab}</a>
            </Button> : <Button tone="ghost" size="sm" disabled>{copy.newTab}</Button>}
          </div>
        )} />
        {previewNotice ? <p role="note" className="border-t border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">{previewNotice}</p> : null}
        {previewDatabase ? <PreviewDatabaseLine control={previewDatabase} /> : null}
        {previewReady ? (
          <iframe
            key={`${state.previewUrl}:${previewRevision}`}
            ref={preview}
            title={copy.preview}
            src={state.previewUrl}
            sandbox="allow-same-origin allow-scripts allow-forms"
            className="h-48 w-full rounded-b-lg border-0 bg-white sm:h-56"
          />
        ) : (
          <CardBody><p role="status" className="py-16 text-center text-sm text-stone-500">{previewMessage}</p></CardBody>
        )}
      </Card> : null}
      <section aria-label={text.artifact.progress} aria-live="polite"><Card><CardBody>
        <h3 className="font-semibold text-stone-900">{progress.title}</h3>
        {progress.hint ? <p className="mt-2 text-sm text-stone-600">{progress.hint}</p> : null}
        <ol aria-label={text.implement.steps} className="mt-4 space-y-3 text-sm">
          {progress.steps?.map((step, index) => {
            const unmet = state.tasks.find((task) => task.id === step.taskId)?.verification?.criteria.filter((criterion) => !criterion.met) ?? []
            return <li key={step.taskId ?? index} aria-current={step.state === 'doing' ? 'step' : undefined} className="flex gap-3">
            <span aria-label={text.artifact.states[step.state]} className={step.state === 'failed' ? 'text-bad-ink' : step.state === 'doing' ? 'text-accent' : 'text-stone-400'}>{{ todo: '○', doing: '●', done: '✔', failed: '✖' }[step.state]}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap justify-between gap-2"><span className={step.state === 'doing' ? 'font-semibold' : undefined}>{step.label}</span>{step.elapsedLabel ? <span aria-label={text.implement.elapsed} className="tabular-nums text-stone-500">{step.elapsedLabel}</span> : null}</div>
              {step.status ? <span className="block text-xs text-stone-500">{step.status}</span> : null}
              {step.expectation ? <span className="block text-xs text-stone-500">{step.expectation}</span> : null}
              {step.activity ? <span aria-label={buildCopy.progress.observe.activity} className="block text-xs text-stone-600">{step.activity}</span> : null}
              {step.detail ? <span className="block text-xs text-bad-ink">{step.detail}</span> : null}
              {unmet.length ? <details className="mt-1 text-xs text-amber-800" open>
                <summary className="cursor-pointer">{copy.unmetCriteria(unmet.length)}</summary>
                <ul className="mt-1 list-disc space-y-1 pl-4">{unmet.map((item, criterionIndex) => <li key={criterionIndex}>{item.criterion}{item.note ? <span className="block text-stone-500">{item.note}</span> : null}</li>)}</ul>
              </details> : null}
            </div>
          </li>})}
        </ol>
        {progress.buildUrl && !progress.buildFailed ? <a href={progress.buildUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block text-xs text-accent-strong underline">{text.implement.buildLink}</a> : null}
        {progress.delayHint ? <p role="status" className="mt-3 text-sm text-bad-ink">{progress.delayHint}</p> : null}
      </CardBody></Card></section>
      {state.failure ? (
        <Notice tone="error" title={state.failure.title} actions={(
          <>
            {onRetry && state.failure.kind !== 'policy' ? <Button size="sm" loading={state.retryPending} disabled={state.retryPending} onClick={onRetry}>{state.retryPending ? copy.retryPending : copy.retry}</Button> : null}
            {state.failure.kind !== 'policy' && state.failure.kind !== 'quota' && failedTask && onSkipTask ? <Button size="sm" tone="ghost" disabled={state.retryPending} onClick={() => onSkipTask(failedTask.id)}>{copy.skip}</Button> : null}
          </>
        )}>
          <p>{state.failure.reason}</p>
          {reference ? <div className="mt-3 flex flex-wrap items-center gap-2"><span className="min-w-0 break-all text-xs">{reference}</span><CopyButton value={reference} label={buildCopy.failure.copyReference} /></div> : null}
        </Notice>
      ) : nothingImplemented && onRetry ? (
        <Notice tone="warning" title={copy.nothingImplemented} actions={<Button size="sm" loading={state.retryPending} disabled={state.retryPending} onClick={onRetry}>{state.retryPending ? copy.retryPending : copy.retry}</Button>} />
      ) : null}
    </div>
  )
}
