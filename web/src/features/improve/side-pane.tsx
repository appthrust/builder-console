import { Circle, ExternalLink, PanelRightClose } from 'lucide-react'
import { relativeTime } from '../../copy'
import { buildCopy } from '../../model/build/copy'
import { activityLines, formatElapsed } from '../../model/build/progress'
import { isProductLanguage } from '../../model/build/wording'
import type { ImproveState, ImproveVersion } from '../../model/improve'
import { Card, CardBody, LinkButton } from '../../ui'
import { text as buildText } from '../build/copy'
import type { ImplementationState } from '../build/implement'
import { text } from './copy'
import { useClock } from './use-clock'
import { text as proposalText } from '../proposals/copy'

const MARK = { todo: '○', doing: '●', done: '✔', failed: '✖' } as const

/**
 * 「いま直しているもの」: the proposal before it is made, the run's tasks while
 * they are made (from the server's run projection), then every version made
 * in this session and the app's address.
 */
export function ImproveSidePane({ state, implementation, versions, appUrl, proposalPending, onCollapse }: {
  state: ImproveState
  implementation: ImplementationState
  versions: ImproveVersion[]
  appUrl?: string
  proposalPending?: boolean
  onCollapse(): void
}) {
  const showRun = state.phase === 'running' || state.phase === 'failed' || state.phase === 'done'
  return <section aria-label={text.pane.title} className="mx-auto w-full max-w-4xl min-w-0 space-y-4 p-4 sm:p-5">
    <div className="hidden items-center justify-between md:flex">
      <h2 className="text-sm font-semibold text-stone-500">{text.pane.title}</h2>
      <button type="button" aria-label={text.pane.collapse} aria-expanded aria-controls="build-artifact" title={text.pane.collapse} onClick={onCollapse} className="-mr-1.5 flex size-8 items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-900">
        <PanelRightClose aria-hidden className="size-4" />
      </button>
    </div>
    {state.phase === 'proposed' ? <ProposalTasks state={state} />
      : showRun && state.run ? <RunProgress state={state} implementation={implementation} appUrl={appUrl} proposalPending={proposalPending} />
        : <p className="text-sm text-stone-500">{text.pane.empty}</p>}
    {versions.length ? <section aria-label={text.pane.versions}><Card><CardBody>
      <h3 className="text-sm font-semibold text-stone-900">{text.pane.versions}</h3>
      <ol className="mt-3 space-y-3 text-sm">{[...versions].reverse().map((version) => <li key={version.runId}>
        <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-medium text-stone-900">{text.updated(version.version)}</span><span className="text-xs text-stone-500">{relativeTime(version.at)}</span></div>
        {version.tasks.filter(isProductLanguage).map((title) => <span key={title} className="block text-xs text-stone-600">{title}</span>)}
      </li>)}</ol>
      {appUrl ? <div className="mt-4 border-t border-stone-100 pt-3">
        <p className="text-xs text-stone-500">{text.pane.appUrl}</p>
        <a href={appUrl} target="_blank" rel="noreferrer noopener" className="mt-0.5 block font-mono text-sm break-all text-accent-strong underline-offset-2 hover:underline">{appUrl}</a>
      </div> : null}
    </CardBody></Card></section> : null}
  </section>
}

function ProposalTasks({ state }: { state: ImproveState }) {
  const tasks = state.proposal.filter((task) => isProductLanguage(task.title))
  return <section aria-label={text.pane.proposal}><Card><CardBody>
    <h3 className="text-sm font-semibold text-stone-900">{text.pane.proposal}</h3>
    <ul className="mt-3 space-y-2 text-sm">{tasks.map((task) => <li key={task.id} className="flex gap-2"><Circle aria-hidden className="mt-1.5 size-2.5 shrink-0 text-stone-400" /><span className="min-w-0 break-words">{task.title}{task.detail ? <span className="block text-xs text-stone-500">{task.detail}</span> : null}</span></li>)}</ul>
  </CardBody></Card></section>
}

function RunProgress({ state, implementation, appUrl, proposalPending }: { state: ImproveState; implementation: ImplementationState; appUrl?: string; proposalPending?: boolean }) {
  const run = state.run!
  const running = state.phase === 'running'
  const now = useClock(running)
  const copy = buildCopy.progress.task
  const tasks = implementation.tasks.filter((task) => run.taskIds.includes(task.id))
  // The tail belongs to the task in progress; between tasks it would describe the finished one.
  const activity = running && tasks.some((task) => task.status === 'running') ? activityLines(implementation.activityTail).filter(isProductLanguage).slice(-3) : []
  const step = implementation.step === 'working' ? copy.working(Boolean(implementation.activityTail?.trim())) : implementation.step ? copy[implementation.step] : undefined
  const previewReady = Boolean(implementation.previewUrl) && implementation.previewStatus === 'ready'
  const title = state.phase === 'done' ? proposalPending ? proposalText.sent : text.updated(state.version) : running ? text.run.running : implementation.failure?.title ?? text.run.running
  return <section aria-label={text.pane.progress} aria-live="polite"><Card><CardBody>
    <h3 className="font-semibold text-stone-900">{title}</h3>
    <ol aria-label={text.pane.progress} className="mt-4 space-y-3 text-sm">
      {tasks.map((task) => {
        const mark = task.status === 'running' ? 'doing' : task.status === 'failed' ? 'failed' : task.status === 'pending' ? 'todo' : 'done'
        const active = task.status === 'running' && task.id === implementation.currentTaskId
        const since = Date.parse(implementation.startedAt ?? '')
        return <li key={task.id} aria-current={active ? 'step' : undefined} className="flex gap-3">
          <span aria-label={buildText.artifact.states[mark]} className={mark === 'failed' ? 'text-bad-ink' : mark === 'doing' ? 'text-accent' : 'text-stone-400'}>{MARK[mark]}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap justify-between gap-2"><span className={active ? 'font-semibold' : undefined}>{isProductLanguage(task.title) ? task.title : copy.fallback}</span>{active && Number.isFinite(since) ? <span aria-label={buildText.implement.elapsed} className="tabular-nums text-stone-500">{formatElapsed(now - since)}</span> : null}</div>
            <span className="block text-xs text-stone-500">{copy.status[task.status]}{task.versionLabel && isProductLanguage(task.versionLabel) ? ` · ${task.versionLabel}` : ''}</span>
            {active && step ? <span className="block text-xs text-stone-600">{step}</span> : null}
          </div>
        </li>
      })}
    </ol>
    {activity.length ? <pre aria-label={buildCopy.progress.observe.activity} className="mt-3 max-h-24 overflow-hidden whitespace-pre-wrap break-words rounded bg-stone-50 p-2.5 font-mono text-xs leading-relaxed text-stone-600">{activity.join('\n')}</pre> : null}
    {(running || proposalPending) && implementation.previewUrl ? previewReady
      ? <LinkButton external href={implementation.previewUrl} size="sm" icon={<ExternalLink />} className="mt-3">{text.run.preview}</LinkButton>
      : <p role="status" className="mt-3 text-xs text-stone-500">{text.run.previewPreparing}</p> : null}
    {state.phase === 'done' && appUrl ? <LinkButton external href={appUrl} tone="primary" size="sm" icon={<ExternalLink />} className="mt-4">{text.run.openApp}</LinkButton> : null}
  </CardBody></Card></section>
}
