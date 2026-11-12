import type { ApplicationDraft, ApplicationDraftSourceSummary, UiDesign } from '@appthrust/api-schema/platform-api'
import { Circle, PanelRightClose } from 'lucide-react'
import type { ReactNode } from 'react'
import { buildCopy } from '../../model/build/copy'
import { buildFailureReference } from '../../model/build/failure'
import { importedRowCount } from '../../model/build/questions'
import type { BuildFailure, BuildProposal, BuildSpec, BuildStage, ProgressCard as Progress } from '../../model/build/types'
import { ActivityLog, Card, CardBody, CopyButton, Disclosure, LinkButton, Notice } from '../../ui'
import { ImplementPanel, type ImplementationState } from './implement'
import type { PreviewDatabaseReset } from './implement/use-implementation'
import { implementationCopy } from './implement/copy'
import { text } from './copy'
import { UiDecisions } from '../excel2app/ui-decisions'

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="space-y-2">{rows.map(([label, value]) => <div key={label} className="grid grid-cols-[5.5rem_1fr] gap-3 text-sm"><dt className="text-stone-500">{label}</dt><dd className="min-w-0 break-words text-stone-900">{value}</dd></div>)}</dl>
}

/**
 * The spec, then 「含まれるもの」 (screens with their purpose, records with their fields,
 * where it is published) and, for Excel → app drafts, 「画面の決定」 from the UI preview.
 * Only decided rows are shown; what is still open collapses into one 「これから決めること」 line.
 * An uploaded workbook answers 「元のデータ」 itself, whatever the front-matter says.
 */
export function SpecCard({ spec, title, proposal, source, uiDesign, excelAnalysis }: { spec: BuildSpec; title: string; proposal?: BuildProposal; source?: ApplicationDraftSourceSummary; uiDesign?: UiDesign; excelAnalysis?: ApplicationDraft['excelAnalysis'] }) {
  const about: [string, ReactNode][] = []
  const open: string[] = []
  const add = (label: string, value: ReactNode | undefined) => { if (value) about.push([label, value]); else open.push(label) }
  add(text.artifact.users, spec.users.join(text.artifact.listSeparator))
  add(text.artifact.rules, spec.rules.length ? <ul className="space-y-0.5">{spec.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul> : undefined)
  add(text.artifact.approval, spec.approval ? text.artifact.approvals[spec.approval] : undefined)
  const workbooks = source?.workbooks ?? []
  const first = workbooks[0]
  const imported = importedRowCount(excelAnalysis)
  add(text.artifact.importFrom, first ? workbooks.length === 1 ? text.artifact.workbook(first.fileName, first.sheetCount, imported) : text.artifact.workbookSet(first.fileName, workbooks.length - 1, workbooks.reduce((count, workbook) => count + workbook.sheetCount, 0), imported) : spec.importFrom ? text.artifact.imports[spec.importFrom] : undefined)
  const purpose = (screen: string) => proposal?.screens.find((item) => item.name === screen)?.purpose
  const contents: [string, ReactNode][] = []
  if (spec.screens.length) contents.push([text.artifact.screens, <ul className="space-y-1">{spec.screens.map((screen) => <li key={screen}>{screen}{purpose(screen) ? <span className="block text-xs text-stone-500">{purpose(screen)}</span> : null}</li>)}</ul>])
  else open.push(text.artifact.screens)
  if (spec.records.length) contents.push([text.artifact.records, <ul className="space-y-1">{spec.records.map((record) => <li key={record.name}>{record.name}{record.fields.length ? <span className="block text-xs text-stone-500">{record.fields.join(text.artifact.listSeparator)}</span> : null}</li>)}</ul>])
  else open.push(text.artifact.records)
  if (proposal) contents.push([buildCopy.proposal.url, proposal.url ? <span className="break-all">{proposal.url}</span> : <span className="text-stone-500">{buildCopy.proposal.urlLater}</span>])
  return <section aria-label={text.artifact.spec} data-testid="build-spec"><Card><CardBody className="space-y-4">
    <div><p className="text-xs text-stone-500">{text.artifact.spec}</p><h3 className="mt-0.5 text-lg font-semibold text-stone-900">{spec.name ?? title}</h3>{spec.oneLine ? <p className="mt-1 text-sm text-stone-600">{spec.oneLine}</p> : null}</div>
    {about.length ? <Rows rows={about} /> : null}
    {contents.length ? <div className="border-t border-stone-100 pt-3"><h4 className="mb-2 text-xs font-medium text-stone-500">{text.artifact.contents}</h4><Rows rows={contents} /></div> : null}
    {uiDesign ? <div className="border-t border-stone-100 pt-3" data-testid="build-ui-decisions"><h4 className="mb-2 text-xs font-medium text-stone-500">{text.artifact.uiDecisions}</h4><UiDecisions design={uiDesign} compact /></div> : null}
    {open.length ? <p className="text-xs text-stone-500">{text.artifact.undecided(open)}</p> : null}
  </CardBody></Card></section>
}

/** The planned tasks are replaced by the single live ladder once building starts. */
function TasksPreview({ proposal }: { proposal: BuildProposal }) {
  return <section aria-label={buildCopy.proposal.tasks}><Card><CardBody>
    <h3 className="text-sm font-semibold text-stone-900">{buildCopy.proposal.tasks}</h3>
    <ul className="mt-3 space-y-2 text-sm">{proposal.tasks.map((task, index) => <li key={`${index}-${task.title}`} className="flex gap-2"><Circle aria-hidden className="mt-1.5 size-2.5 shrink-0 text-stone-400" /><span className="min-w-0 break-words">{task.title}{task.detail ? <span className="block text-xs text-stone-500">{task.detail}</span> : null}</span></li>)}</ul>
    {proposal.moreTasks ? <p className="mt-2 text-xs text-stone-500">{buildCopy.proposal.moreTasks(proposal.moreTasks)}</p> : null}
  </CardBody></Card></section>
}

export function ProgressCard({ progress, failure }: { progress: Progress; failure?: BuildFailure }) {
  const reference = failure?.reference ? buildFailureReference(failure.reference) : undefined
  return <section role={failure ? 'alert' : undefined} aria-label={text.artifact.progress} aria-live={failure ? 'assertive' : 'polite'}><Card><CardBody>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-stone-900">{progress.title}</h3>{progress.elapsedLabel ? <span className="text-sm tabular-nums text-stone-500">{progress.elapsedLabel}</span> : null}</div>
    {progress.hint ? <p className="mt-2 text-sm text-stone-600">{progress.hint}</p> : null}
    {reference ? <p className="mt-3 break-all text-xs text-stone-600">{reference}</p> : null}
    {progress.activity ? <ActivityLog lines={progress.activity} label={buildCopy.progress.observe.activity} className="mt-3 max-h-48 p-3" /> : null}
    {progress.steps ? <ol aria-label={progress.staged ? text.artifact.preparation : undefined} className="mt-4 space-y-3">{progress.steps.map((step, index) => <li key={`${step.label}-${index}`} aria-current={step.state === 'doing' ? 'step' : undefined} className="flex gap-3 text-sm">
      <span aria-label={text.artifact.states[step.state]} className={step.state === 'failed' ? 'text-bad-ink' : step.state === 'todo' ? 'text-stone-400' : 'text-accent-strong'}>{progress.staged ? ({ todo: '○', doing: '●', done: '✔', failed: '!' })[step.state] : text.artifact.states[step.state]}</span>
      <div className="min-w-0 flex-1"><div className="flex flex-wrap justify-between gap-2"><span className={step.state === 'doing' ? 'font-semibold' : undefined}>{step.label}</span>{step.elapsedLabel ? <span className="tabular-nums text-stone-500">{step.elapsedLabel}</span> : null}</div>{step.expectation ? <span className="block text-xs text-stone-500">{step.expectation}</span> : null}{step.detail && step.detail !== progress.hint ? <span className="block text-xs text-stone-500">{step.detail}</span> : null}</div>
    </li>)}</ol> : null}
    {progress.currentActivity ? <p aria-label={buildCopy.progress.observe.activity} className="mt-4 text-sm text-stone-600"><span className="font-medium">{buildCopy.progress.observe.activity}: </span>{progress.currentActivity}{progress.buildUrl ? <a href={progress.buildUrl} target="_blank" rel="noopener noreferrer" className="mt-1 block text-accent-strong underline">{buildCopy.progress.observe.buildLink}</a> : null}</p> : null}
    {progress.delayHint ? <p role="status" className="mt-3 text-sm text-bad-ink">{progress.delayHint}</p> : null}
  </CardBody></Card></section>
}

export function PublishCard({ url, shareText, published = false }: { url: string; shareText: string; published?: boolean }) {
  return <section aria-label={text.artifact.publishedApp}><Card><CardBody>
    <h3 className="text-lg font-semibold text-stone-900">{published ? text.artifact.published : text.artifact.openResult}</h3>
    <p className="mt-2 text-sm text-stone-600">{shareText}</p>
    <p className="mt-4 break-all text-sm text-accent-strong">{url}</p><div className="mt-3 flex gap-2"><CopyButton value={url} label={text.artifact.copyUrl} /><LinkButton href={url} external>{text.artifact.open}</LinkButton></div>
    {published ? <p className="mt-5 text-sm text-stone-500">{text.artifact.nextRequests}</p> : null}
  </CardBody></Card></section>
}

export function ArtifactPane({ draft, spec, proposal, stage, progress, implementation, failure, url, shareText, shareStep, databaseChanges, previewDatabaseReset, onOpenPreview, onRetry, onSkipTask, onCollapse }: {
  draft: ApplicationDraft
  spec: BuildSpec
  proposal?: BuildProposal
  stage: BuildStage
  progress?: Progress
  implementation: ImplementationState
  failure?: BuildFailure
  url?: string
  shareText: string
  shareStep?: ReactNode
  /** The created app's 「データベースの変更」 (features/app/database-changes.tsx); shown once building starts. */
  databaseChanges?: ReactNode
  /** 「データベースを作り直す」 for the workspace's preview database (useImplementation().previewDatabaseReset). */
  previewDatabaseReset: PreviewDatabaseReset
  onOpenPreview(): void
  onRetry(): void
  onSkipTask(id: string): void
  /** From md the pane folds to a strip; the control lives in its heading so it leaves with the pane. */
  onCollapse(): void
}) {
  const raw = failure?.raw ?? implementation.failure?.raw
  const reference = failure?.reference ? buildFailureReference(failure.reference) : undefined
  const specCard = <SpecCard spec={spec} title={draft.title} proposal={proposal} source={draft.source} uiDesign={draft.uiDesign} excelAnalysis={draft.excelAnalysis} />
  // The preview starts with the first task; preparation and implementation remain one ladder.
  const built = stage === 'build' || stage === 'publish'
  // Once published, the working database no longer matters; until then a workspace either has its own or runs without one.
  const databaseStatus = stage === 'publish' ? undefined : implementation.previewDatabaseStatus
  const previewNotice = databaseStatus === 'none' && draft.creationPlan?.applicationStackRequest?.database
    ? implementationCopy.previewDatabase(Boolean(draft.source))
    : undefined
  const implementing = previewDatabaseReset.busy || implementation.phase === 'starting-workspace' || implementation.phase === 'running' || implementation.phase === 'pushing'
  const previewDatabase = databaseStatus && databaseStatus !== 'none'
    ? { status: databaseStatus, excel: Boolean(draft.source), busy: implementing, pending: previewDatabaseReset.pending, error: previewDatabaseReset.error, onReset: previewDatabaseReset.reset }
    : undefined
  const progressFailure = !built && failure && progress?.title === failure.title ? failure : undefined
  const showFailureNotice = failure && failure.kind !== 'name-taken' && (built ? !implementation.failure : !progressFailure)
  return <section aria-label={buildCopy.artifact.title} className="mx-auto w-full max-w-4xl min-w-0 space-y-4 p-4 sm:p-5">
    <div className="hidden items-center justify-between md:flex">
      <h2 className="text-sm font-semibold text-stone-500">{buildCopy.artifact.title}</h2>
      <button type="button" aria-label={buildCopy.artifact.collapse} aria-expanded aria-controls="build-artifact" title={buildCopy.artifact.collapse} onClick={onCollapse} className="-mr-1.5 flex size-8 items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-900">
        <PanelRightClose aria-hidden className="size-4" />
      </button>
    </div>
    {built ? null : specCard}
    {!built && progress ? <ProgressCard progress={progress} failure={progressFailure} /> : null}
    {!built && proposal?.tasks.length ? <TasksPreview proposal={proposal} /> : null}
    {showFailureNotice ? <Notice tone="error" title={failure.title}>
      <p>{failure.reason}</p>
      {reference ? <p className="mt-3 break-all text-xs">{reference}</p> : null}
    </Notice> : null}
    {shareStep}
    {stage === 'publish' && url ? <PublishCard url={url} shareText={shareText} published /> : null}
    {built ? <ImplementPanel state={implementation} preparation={progress} released={Boolean(url)} previewNotice={previewNotice} previewDatabase={previewDatabase} onOpenPreview={onOpenPreview} onRetry={onRetry} onSkipTask={onSkipTask} /> : null}
    {built ? databaseChanges : null}
    {stage === 'build' && url ? <PublishCard url={url} shareText={shareText} /> : null}
    {built && !url ? <p className="text-xs text-stone-500">{text.artifact.waitingForApp}</p> : null}
    {built ? specCard : null}
    <Disclosure title={text.artifact.advanced}>
      <div className="space-y-4 break-all text-xs text-stone-600">
        {progress?.buildUrl ? <a href={progress.buildUrl} target="_blank" rel="noopener noreferrer" className="block text-accent-strong underline">{buildCopy.sourceBuild.run}: {progress.buildUrl}</a> : null}
        {draft.creationPlan?.markdown ? <pre className="whitespace-pre-wrap break-words">{draft.creationPlan.markdown}</pre> : null}
        {raw ? <pre className="whitespace-pre-wrap break-words text-bad-ink">{raw}</pre> : null}
        {built ? <>
          {implementation.workspaceId ? <p>{text.artifact.workspace(implementation.workspaceId)}</p> : null}
          <p>{text.artifact.phase(implementation.phase)}</p>
          {implementation.activityTail ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{implementation.activityTail}</pre> : null}
          <pre className="whitespace-pre-wrap">{JSON.stringify(implementation.tasks, null, 2)}</pre>
        </> : null}
      </div>
    </Disclosure>
  </section>
}
