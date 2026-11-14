import { useEffect, useRef, useState, type JSX } from 'react'
import { buildProgress } from '../../../model/build/progress'
import { buildCopy } from '../../../model/build/copy'
import { buildFailureReference } from '../../../model/build/failure'
import { isOneOf } from '../../../model/contracts/build'
import type { ProgressCard } from '../../../model/build/types'
import { paths } from '../../../routes/paths'
import { Button, Card, CardBody, CardHeader, CopyButton, Notice } from '../../../ui'
import { implementationCopy as copy } from './copy'
import { LegacyPreviewCard, legacyPreviewReady } from './legacy-preview'
import { PreviewDatabaseLine, type PreviewDatabaseControl } from './preview-database'
import { PreviewViewer } from './preview-viewer'
import { implemented, type ImplementationState } from './state'
import { usePreviewSession } from './use-preview-session'
import { text } from '../copy'


export function ImplementPanel({ state, preparation, released, previewNotice, previewDatabase, onOpenPreview, onRetry, onSkipTask, onConfirm }: {
  state: ImplementationState
  preparation?: ProgressCard
  released: boolean
  /** The 「データベースなし」 notice, for workspaces without their own preview database. */
  previewNotice?: string
  previewDatabase?: PreviewDatabaseControl
  onOpenPreview(): void
  onRetry?(): void
  onSkipTask?(id: string): void
  /** Reads the draft back after a start whose answer could not be read (the only action then offered). */
  onConfirm?(): void
}): JSX.Element {
  const preview = useRef<HTMLIFrameElement>(null)
  const [previewRevision, setPreviewRevision] = useState(0)
  const [now, setNow] = useState(Date.now)
  const ticking = state.startedAt !== undefined && state.tasks.some((task) => isOneOf(task.status, 'running'))
  // The elapsed time on the running task is the user's only proof that something is happening.
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [ticking])
  const failedTask = state.tasks.find((task) => task.id === state.currentTaskId && isOneOf(task.status, 'failed'))
  const reference = state.failure?.reference ? buildFailureReference(state.failure.reference) : undefined
  const nothingImplemented = state.phase === 'done' && !implemented(state)
  const progress = buildProgress(preparation, state, now, released)
  const taskStarted = state.tasks.some((task) => isOneOf(task.status, 'running', 'done', 'failed'))
  // The preview first appears with the first task. A new run (retry, skip, change)
  // starts with every task pending; a preview already shown stays mounted then,
  // instead of tearing down the iframe and reloading the app when a task starts.
  const [previewShown, setPreviewShown] = useState(false)
  // Legacy same-origin preview (remove at migration stage 5; ./legacy-preview.tsx): a never-moved workspace's card.
  const legacy = state.legacyPreview
  // The session runs only while this card shows the preview; a hidden page renews nothing. A legacy workspace asks for none.
  const session = usePreviewSession(state.preview, { enabled: !legacy && (taskStarted || previewShown), onEndpointChanged: state.preview?.readBack })
  const previewReady = legacy ? legacyPreviewReady(legacy) : session.view.kind === 'ready'
  if (previewReady && taskStarted && !previewShown) setPreviewShown(true)
  const previewStarted = taskStarted || (previewShown && (!legacy || previewReady))
  const openPreview = () => {
    if (!previewReady) return
    setPreviewRevision((value) => value + 1)
    preview.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    preview.current?.focus()
    onOpenPreview()
  }
  return (
    <div className="space-y-4">
      {previewStarted && legacy ? <LegacyPreviewCard legacy={legacy} previewNotice={previewNotice} previewDatabase={previewDatabase} revision={previewRevision} frameRef={preview} onOpen={openPreview} /> : null}
      {previewStarted && !legacy ? <Card>
        <CardHeader title={copy.title} actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!previewReady} onClick={openPreview}>{copy.open}</Button>
            {/* The new tab is the Console's own viewer page; the raw preview origin is never opened top-level. */}
            {state.preview ? <Button asChild tone="ghost" size="sm">
              <a href={paths.workspacePreview(state.preview.workspaceId)} target="_blank" rel="noopener noreferrer">{copy.newTab}</a>
            </Button> : <Button tone="ghost" size="sm" disabled>{copy.newTab}</Button>}
          </div>
        )} />
        {previewNotice ? <p role="note" className="border-t border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">{previewNotice}</p> : null}
        {previewDatabase ? <PreviewDatabaseLine control={previewDatabase} /> : null}
        <PreviewViewer
          session={session}
          workspaceId={state.preview?.workspaceId ?? ''}
          title={copy.preview}
          revision={previewRevision}
          newTab={Boolean(state.preview)}
          onReadBack={state.preview?.readBack}
          frameRef={preview}
          frameClassName="h-48 w-full rounded-b-lg border-0 bg-white sm:h-56"
          statusClassName="border-t border-line py-12"
        />
      </Card> : null}
      <section aria-label={text.artifact.progress} aria-live="polite"><Card><CardBody>
        <h3 className="font-semibold text-stone-900">{progress.title}</h3>
        {progress.hint ? <p className="mt-2 text-sm text-stone-600">{progress.hint}</p> : null}
        <ol aria-label={text.implement.steps} className="mt-4 space-y-3 text-sm">
          {progress.steps?.map((step, index) => {
            const unmet = state.tasks.find((task) => task.id === step.taskId)?.verification?.criteria.filter((criterion) => !criterion.met) ?? []
            return <li key={step.taskId ?? index} aria-current={step.state === 'doing' ? 'step' : undefined} className="flex gap-3">
            <span aria-label={text.artifact.states[step.state]} className={step.state === 'failed' ? 'text-bad-ink' : step.state === 'doing' ? 'text-accent' : 'text-stone-400'}>{{ todo: '○', doing: '●', done: '✔', failed: '✖', unknown: '?' }[step.state]}</span>
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
      {state.phase === 'unsupported' ? (
        <Notice tone="warning" title={buildCopy.unsupported.title}><p>{buildCopy.unsupported.detail}</p></Notice>
      ) : null}
      {state.failure ? (
        // A write whose answer could not be read may have happened: the draft is read back instead of offering to send it again.
        <Notice tone={state.failure.kind === 'unconfirmed' ? 'warning' : 'error'} title={state.failure.title} actions={(
          <>
            {onRetry && state.failure.kind !== 'policy' && state.failure.kind !== 'unconfirmed' ? <Button size="sm" loading={state.retryPending} disabled={state.retryPending} onClick={onRetry}>{state.retryPending ? copy.retryPending : copy.retry}</Button> : null}
            {state.failure.kind !== 'policy' && state.failure.kind !== 'quota' && state.failure.kind !== 'unconfirmed' && failedTask && onSkipTask ? <Button size="sm" tone="ghost" disabled={state.retryPending} onClick={() => onSkipTask(failedTask.id)}>{copy.skip}</Button> : null}
            {state.failure.kind === 'unconfirmed' && onConfirm ? <Button size="sm" onClick={onConfirm}>{buildCopy.failure.confirm}</Button> : null}
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
