import { CheckCircle2, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { buildCopy } from '../../model/build/copy'
import type { BuildOutcome } from '../../model/build/types'
import { Button } from '../../ui'
import { AiTurn } from './conversation-pane'
import { text } from './copy'
import { implementationCopy } from './implement/copy'

/**
 * The implementation run in the conversation, for both engines (APT-1124): while it runs, the tasks done, the current
 * task and the 経過 with what to expect; once built, that the app is made and 「公開する」 as the primary action; a run
 * that skipped everything says the app did not change and offers the run's retry. A stopped run has its own failure UI.
 */
export function BuildOutcomeTurn({ outcome, audience, hint, notice, publish, retry }: {
  outcome?: BuildOutcome
  /** Who the app is published to, in words (`shareScopeLabel`), once chosen. */
  audience?: string
  /** What to do first when 公開する cannot be pressed yet (engine-specific); replaces the audience sentence. */
  hint?: string
  /** Read before publishing, right above 公開する (the running app's recorded build failure, APT-1136). */
  notice?: ReactNode
  /** The page's own 公開する: the same action, label and enabled state as the header's. */
  publish: { label: string; enabled: boolean; onClick(): void }
  /** The run's retry (an all-skipped retry reopens every task); absent where the page offers none. */
  retry?: { pending: boolean; onClick(): void }
}) {
  if (!outcome || outcome.kind === 'stopped') return null
  const copy = text.outcome
  if (outcome.kind === 'implementing') {
    if (outcome.interrupted) return <AiTurn><div data-testid="build-outcome" data-outcome="interrupted">
      <p className="font-medium text-stone-900">{buildCopy.progress.interrupted.title}</p>
      <p className="mt-1 text-xs text-stone-500">{buildCopy.progress.interrupted.hint}</p>
    </div></AiTurn>
    return <AiTurn><div data-testid="build-outcome" data-outcome="implementing">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-stone-700">
        <Loader2 aria-hidden className="size-4 animate-spin text-accent" />
        {outcome.total > 0 ? <span className="font-medium tabular-nums">{copy.tasks(outcome.finished, outcome.total)}</span> : null}
        {outcome.current ? <span className="min-w-0 break-words">{copy.current(outcome.current)}</span> : null}
        {outcome.elapsedLabel ? <span className="text-xs tabular-nums text-stone-500">{copy.elapsed(outcome.elapsedLabel)}</span> : null}
      </p>
      <p className="mt-1 text-xs text-stone-500">{copy.expectation}</p>
    </div></AiTurn>
  }
  if (outcome.kind === 'built') return <AiTurn><div data-testid="build-outcome" data-outcome="built">
    <p className="flex items-center gap-1.5 font-medium text-stone-900"><CheckCircle2 aria-hidden className="size-4 text-accent" />{copy.built}</p>
    <p className="mt-1">{hint ?? (audience ? copy.publishTo(audience) : copy.publish)}</p>
    {notice}
    <div className="mt-3"><Button tone="primary" disabled={!publish.enabled} onClick={publish.onClick}>{publish.label}</Button></div>
  </div></AiTurn>
  return <AiTurn><div data-testid="build-outcome" data-outcome="unchanged">
    <p>{copy.unchanged}</p>
    {retry ? <>
      <p className="mt-1 text-xs text-stone-500">{copy.unchangedRetry}</p>
      <div className="mt-3"><Button loading={retry.pending} disabled={retry.pending} onClick={retry.onClick}>{retry.pending ? implementationCopy.retryPending : implementationCopy.retry}</Button></div>
    </> : null}
  </div></AiTurn>
}
