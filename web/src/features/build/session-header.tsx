import { ChevronLeft, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ConsoleStatus } from '../../copy'
import type { BuildOutcome, BuildPrimary, BuildStage, ProgressCard } from '../../model/build/types'
import { paths } from '../../routes/paths'
import { Button, HrefLink, StatusPill, Stepper } from '../../ui'
import { buildStages, stageLabels } from './session'
import { localized } from '../../shell/language'
import { text, textJa } from './copy'
import { textEn } from './copy.en'
import { WorkspaceLeaseHint } from '../workspaces'

/** `unsupported`: the draft is in a state this console does not know, so no step is marked as the current one. */
export function StageRail({ stage, unsupported = false }: { stage: BuildStage; unsupported?: boolean }) {
  return <Stepper compact step={unsupported ? -1 : buildStages.indexOf(stage)} labels={buildStages.map((item) => stageLabels[item])} />
}

export const stateWord: Record<BuildStage, string> = localized({ ja: textJa.header.stateWord, en: textEn.header.stateWord })

/**
 * The stage's page-level action: 提案して / 公開する / 続けて直す. 「この内容で作る」 belongs to the
 * AI's proposal in the conversation (it is read there first), so it is not repeated here.
 * During preparation there is nothing to press; the header says what is happening.
 */
export function StageAction({ stage, primary, progress, onPrimary }: { stage: BuildStage; primary: BuildPrimary; progress?: ProgressCard; onPrimary(): void }) {
  if (primary.action === 'plan' || primary.action === 'publish' || primary.action === 'continue') return <Button tone="primary" className="max-sm:px-2.5 max-sm:text-xs" disabled={!primary.enabled} onClick={onPrimary}>{primary.label}</Button>
  if (stage === 'build' && progress) return <p role="status" className="flex h-9 items-center gap-2 text-sm whitespace-nowrap text-stone-600 max-sm:text-xs"><Loader2 aria-hidden className="size-4 animate-spin text-accent" />{progress.title}{progress.elapsedLabel ? <span className="tabular-nums text-stone-400">{progress.elapsedLabel}</span> : null}</p>
  return null
}

/**
 * The state word and rail step while 作る runs (APT-1124): a finished build is できました with 公開 as the current step,
 * a stopped or empty run says so, and a run whose lease lapsed waits to resume. Without an outcome the stage decides.
 */
function outcomeState(stage: BuildStage, outcome: BuildOutcome | undefined): { status: ConsoleStatus; label: string; rail: BuildStage } | undefined {
  if (stage !== 'build' || !outcome) return undefined
  const word = text.outcome.word
  switch (outcome.kind) {
    case 'built': return { status: 'live', label: word.built, rail: 'publish' }
    case 'unchanged': return { status: 'unfinished', label: word.unchanged, rail: 'build' }
    case 'stopped': return { status: 'failed', label: word.stopped, rail: 'build' }
    case 'implementing': return outcome.interrupted ? { status: 'deploying', label: word.interrupted, rail: 'build' } : undefined
  }
}

/**
 * One row from lg: back · name · state · rail · stage action. When the width runs
 * out (390px) the rail and the action wrap to a second row, action right-aligned.
 * While the implementation runs, the state word is followed by its tasks done and the run's 経過.
 * `workspaceId`: the session's workspace; while it runs, its lease countdown follows (devworkspace builder-console.md §4).
 */
export function SessionHeader({ name, stage, action, released = false, unsupported = false, outcome, workspaceId }: { name: string; stage: BuildStage; action?: ReactNode; released?: boolean; unsupported?: boolean; outcome?: BuildOutcome; workspaceId?: string }) {
  const back = stage === 'publish' ? { href: paths.mine(), label: text.header.myApps } : { href: paths.drafts(), label: text.header.drafts }
  const state = outcomeState(stage, outcome)
  const running = stage === 'build' && outcome?.kind === 'implementing' ? outcome : undefined
  return <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-white px-3 py-2 sm:px-5">
    <div className="flex min-w-0 flex-[1_1_14rem] items-center gap-1">
      <HrefLink href={back.href} aria-label={text.header.back(back.label)} title={back.label} className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900"><ChevronLeft aria-hidden className="size-5" /></HrefLink>
      <h1 id="build-title" tabIndex={-1} className="min-w-0 truncate text-base font-semibold text-stone-900 focus:outline-none" title={name}>{name}</h1>
      <span className="ml-2 shrink-0" data-testid="build-state">{state
        ? <StatusPill status={state.status} label={state.label} />
        : <StatusPill status={stage === 'publish' && released ? 'live' : stage === 'build' || stage === 'publish' ? 'deploying' : 'unfinished'} label={stage === 'publish' && !released ? stateWord.build : stateWord[stage]} />}</span>
      {running && running.total > 0 ? <span data-testid="build-run-progress" className="ml-1 shrink-0 text-xs whitespace-nowrap text-stone-600 tabular-nums">
        {text.outcome.tasks(running.finished, running.total)}{running.elapsedLabel ? <span className="text-stone-400">{text.conversation.labelSeparator}{running.elapsedLabel}</span> : null}
      </span> : null}
    </div>
    <div className="flex flex-[1_1_auto] flex-wrap items-center justify-between gap-x-3 gap-y-1.5 sm:gap-x-4 lg:flex-none">
      <StageRail stage={state?.rail ?? stage} unsupported={unsupported} />
      {workspaceId || action ? <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
        {workspaceId ? <WorkspaceLeaseHint workspaceId={workspaceId} /> : null}
        {action}
      </div> : null}
    </div>
  </header>
}
