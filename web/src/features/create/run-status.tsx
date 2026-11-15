// What the wizard shows while a create attempt runs and after it failed.
import { LoaderCircle, RotateCw } from 'lucide-react'
import { copy, relativeTime } from '../../copy'
import type { CreateEntry } from '../../model/create'
import { locale } from '../../shell/language'
import { Button, LinkButton, Notice } from '../../ui'
import { text } from './copy'
import { createdBeforeSent, type CreateCandidate, type CreateFailed, type SubmitPhase } from './submit'

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

/**
 * A re-read of the connection catalog failed: what was read before stays on
 * screen (same notice as ResourceBoundary's stale state), and create waits.
 */
export function StaleCatalogNotice({ readAt, retrying, onRetry }: { readAt: number; retrying: boolean; onRetry: () => void }) {
  return (
    <Notice tone="warning" actions={<Button size="sm" icon={<RotateCw />} loading={retrying} onClick={onRetry}>{copy.common.retry}</Button>}>
      {copy.common.refreshFailed(relativeTime(new Date(readAt).toISOString()) ?? '')}
    </Notice>
  )
}

/**
 * A create step answered 2xx with an answer this console cannot read: it may
 * have happened. The only action reads the latest state back (design §6: never
 * a generic retry, never a resend); create stays disabled until it has run.
 */
export function UnconfirmedCreateNotice({ confirming, stillUnknown, disabled, onConfirm }: { confirming: boolean; stillUnknown: boolean; disabled: boolean; onConfirm: () => void }) {
  return (
    <Notice tone="warning" title={text.unconfirmed.title} actions={<Button size="sm" loading={confirming} disabled={disabled} onClick={onConfirm}>{text.unconfirmed.confirm}</Button>}>
      <p>{text.unconfirmed.body}</p>
      {stillUnknown ? <p className="mt-1" role="status">{text.unconfirmed.stillUnknown}</p> : null}
    </Notice>
  )
}

/**
 * An earlier create's resend was refused (or it cannot be resent exactly): Platform's refusal does not prove the
 * earlier create failed, so nothing is sent. The actions read the latest state back (a hit is offered as a candidate)
 * and, only once a readback did not find it (or the user said its hit is not theirs), give the earlier create up with
 * its residual risk stated. After "not mine", `onReconsider` offers that hit again. `where` names where it went.
 */
export function UnsettledCreateNotice({ where, searched, confirming, stillUnknown, disabled, onConfirm, onGiveUp, onReconsider }: {
  where: string
  searched: boolean
  confirming: boolean
  stillUnknown: boolean
  disabled: boolean
  onConfirm: () => void
  onGiveUp: () => void
  /** Present while a hit the user said is not theirs can be looked at again (`reconsiderCandidate`). */
  onReconsider?: () => void
}) {
  const actions = <>
    <Button size="sm" loading={confirming} disabled={disabled} onClick={onConfirm}>{text.unconfirmed.confirm}</Button>
    {onReconsider ? <Button size="sm" tone="secondary" disabled={confirming} onClick={onReconsider}>{text.unsettled.reconsider}</Button> : null}
    {searched ? <Button size="sm" tone="secondary" disabled={confirming} onClick={onGiveUp}>{text.unsettled.startOver}</Button> : null}
    <LinkButton to="/" tone="ghost" size="sm">{text.abandon}</LinkButton>
  </>
  return (
    <Notice tone="warning" title={text.unsettled.title} actions={actions}>
      <p>{text.unsettled.body(where)}</p>
      {onReconsider ? <p className="mt-1" data-testid="create-unsettled-not-mine">{text.unsettled.notMine}</p> : null}
      {searched ? <p className="mt-1" role="status" data-testid="create-unsettled-not-found">{text.unsettled.notFound(where)}</p> : null}
      {stillUnknown ? <p className="mt-1" role="status">{text.unconfirmed.stillUnknown}</p> : null}
    </Notice>
  )
}

/**
 * A readback found a resource with the earlier attempt's name where it was sent; Platform's answer does not say which
 * request made it. Nothing is sent until the user chooses: use it (kept as found: the wizard never deletes it, but the
 * app is built on it, and deleting the app later removes its record too, which the notice says) or say it is not theirs
 * (the attempt stays held). A repository's creation time and the earlier request's send time are shown side by side as
 * information; a hint is added when it looks older by this device's clock (`createdBeforeSent`). Both choices always.
 */
export function CandidateNotice({ candidate, onUse, onNotMine }: { candidate: CreateCandidate; onUse: () => void; onNotMine: () => void }) {
  if (candidate.step === 'stack') {
    return (
      <Notice tone="warning" title={text.candidate.stackTitle} actions={<>
        <Button size="sm" onClick={onUse}>{text.candidate.useStack}</Button>
        <Button size="sm" tone="secondary" onClick={onNotMine}>{text.candidate.notMineStack}</Button>
      </>}>
        <p>{text.candidate.stackBody(candidate.appName)}</p>
      </Notice>
    )
  }
  const where = text.unsettled.repository(candidate.binding.repository, candidate.binding.image)
  const createdAt = candidate.createdAt ? text.candidate.createdAt(new Date(candidate.createdAt).toLocaleString(locale())) : text.candidate.createdAtUnknown
  const sentAt = candidate.sentAt ? text.candidate.sentAt(new Date(candidate.sentAt).toLocaleString(locale())) : text.candidate.sentAtUnknown
  return (
    <Notice tone="warning" title={text.candidate.title} actions={<>
      <Button size="sm" onClick={onUse}>{text.candidate.use}</Button>
      <Button size="sm" tone="secondary" onClick={onNotMine}>{text.candidate.notMine}</Button>
    </>}>
      <p>{text.candidate.body(where)}</p>
      <ul className="mt-1">
        <li data-testid="create-candidate-created-at">{createdAt}</li>
        <li data-testid="create-candidate-sent-at">{sentAt}</li>
      </ul>
      {createdBeforeSent(candidate) ? <p className="mt-1" data-testid="create-candidate-created-before">{text.candidate.createdBeforeSent}</p> : null}
      <p className="mt-1" data-testid="create-candidate-use-means">{text.candidate.useMeans}</p>
    </Notice>
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
 * other, with the server's validation detail verbatim) and what to do next.
 * The retry itself is the wizard's primary button; taken names and invalid
 * input fields return to their owning step instead.
 */
export function FailureNotice({ failure }: { failure: CreateFailed }) {
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
  // The repository destination's answers have fixed words: never the server's reason or message.
  if (failure.destination) {
    const [title, body] = failure.destination === 'changed'
      ? [text.destination.changedTitle, text.destination.changed]
      : failure.destination === 'mismatch'
        ? [text.destination.mismatchTitle, text.destination.mismatch]
        : [undefined, text.destination.blocked]
    return (
      <Notice tone={failure.destination === 'changed' ? 'warning' : 'error'} title={title} actions={abandon}>
        <p>{body}</p>
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
