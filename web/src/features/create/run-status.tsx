// What the wizard shows while a create attempt runs and after it failed.
import { LoaderCircle } from 'lucide-react'
import { copy } from '../../copy'
import type { CreateEntry } from '../../model/create'
import { paths } from '../../routes/paths'
import { Button, LinkButton, Notice } from '../../ui'
import { text } from './copy'
import type { CreateFailed, SubmitPhase } from './submit'

/** The submitCreate phases each non-AI entry goes through, in order. */
const ENTRY_PHASES: Record<Exclude<CreateEntry, 'ai'>, readonly SubmitPhase[]> = {
  template: ['draft', 'source', 'checking', 'platform', 'bind'],
  existing: ['draft', 'source', 'checking', 'platform', 'bind'],
  image: ['draft', 'checking', 'platform', 'bind'],
}

/** ひな形 / 作ったコードから / イメージ: the current phase and how far along it is. */
export function CreatingPanel({ entry, phase }: { entry: Exclude<CreateEntry, 'ai'>; phase: SubmitPhase }) {
  const phases = ENTRY_PHASES[entry]
  const done = Math.max(0, phases.indexOf(phase))
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-4" data-testid="create-running">
      <p className="text-sm font-semibold text-stone-900">{copy.progress.title}</p>
      <p role="status" className="mt-2 flex items-center gap-2 text-sm text-stone-700">
        <LoaderCircle aria-hidden className="size-4 animate-spin text-accent" />
        {copy.create.phase[phase]}
      </p>
      <div
        role="progressbar"
        aria-label={copy.progress.title}
        aria-valuemin={0}
        aria-valuemax={phases.length}
        aria-valuenow={done}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-stone-200"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${((done + 0.5) / phases.length) * 100}%` }} />
      </div>
      <p className="mt-2 text-xs text-stone-500">{text.creatingHint}</p>
    </div>
  )
}

/** Input failures belong beside the owning step, rather than the generic retry notice. */
export function FieldFailureNotice({ failure, onFix }: { failure: CreateFailed; onFix: () => void }) {
  const path = failure.field?.path ?? ''
  const title = path.startsWith('template.') ? text.fieldError.template
    : path.startsWith('existing.') ? text.fieldError.existing : text.fieldError.destination
  return (
    <Notice tone="error" title={title} actions={<Button size="sm" onClick={onFix}>{text.fix}</Button>}>
      {failure.data ? <p className="break-words">{failure.data.message}</p> : null}
    </Notice>
  )
}

/**
 * A failed attempt: why (forbidden / console unreachable / platform updating /
 * destination moved or blocked / other, with the server's validation detail
 * verbatim) and what to do next. The retry itself is the wizard's primary
 * button; taken names and invalid input fields return to their owning step
 * instead. A destination failure says what the re-read destination changed
 * (`destinationNote`) and links to its setting.
 */
export function FailureNotice({ failure, destinationNote }: { failure: CreateFailed; destinationNote?: string }) {
  const abandon = (
    <LinkButton to="/" tone="ghost" size="sm">
      {text.abandon}
    </LinkButton>
  )
  if (failure.forbidden) {
    return (
      <Notice tone="error" actions={abandon}>
        {copy.create.forbidden}
      </Notice>
    )
  }
  if (failure.destination) {
    const { reason, message } = failure.destination
    const changed = reason === 'DestinationChanged' || reason === 'DestinationMismatch'
    return (
      <Notice
        tone="error"
        title={changed ? copy.create.destination.changedTitle : copy.create.destination.blockedTitle}
        actions={<>
          <LinkButton href={paths.repositoryDestinationSettings} size="sm">{copy.create.destination.openSetting}</LinkButton>
          {abandon}
        </>}
      >
        <p className="break-words" data-testid="create-destination-failure">{destinationNote ?? copy.create.destination.problem(reason, message)}</p>
        {failure.progress.draft ? <p className="mt-1 opacity-80">{copy.create.draftKept}</p> : null}
      </Notice>
    )
  }
  const title = failure.transient ? copy.errors.transient : failure.retryable ? copy.create.retryable : copy.create.failed
  return (
    <Notice tone="error" title={title} actions={abandon}>
      {failure.issues.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5" data-testid="create-issues">
          {failure.issues.map((issue) => (
            <li key={issue.section}>
              <span className="font-medium">{copy.create.issueSection[issue.section]}</span>: {issue.message}
            </li>
          ))}
        </ul>
      ) : failure.data ? (
        <p className="break-words">{failure.data.message}</p>
      ) : null}
      {failure.progress.draft ? <p className="mt-1 opacity-80">{copy.create.draftKept}</p> : null}
    </Notice>
  )
}
