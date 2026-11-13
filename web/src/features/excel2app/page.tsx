// Collect a workbook set, review its integrated business design, then hand the
// same draft and screen decisions to the build flow.
import type { ApplicationDraftCreationToolRegistryResponse, ApplicationDraftWorkbookEntry, ApplicationDraftWorkbookSummary, ExcelAnalysis, UiDesign } from '@appthrust/api-schema/platform-api'
import { isOneOf, type BuildTurn } from '../../model/contracts/build'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, Calculator, CalendarClock, Check, ClipboardList, Database, Download, Eye, FileSpreadsheet, GitBranch, ListChecks, Loader2, Pencil, PieChart, RotateCcw, Search, Sparkles, Table2, Upload } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { aiPolicyCopy, aiPolicyExplanation } from '../../copy/ai-policy'
import { shareScopeLabel, type DraftShareScope } from '../../model/access'
import { buildCopy } from '../../model/build/copy'
import { classifyBuildFailure, isAIQuotaExhausted } from '../../model/build/failure'
import type { BuildFailure } from '../../model/build/types'
import { activityLines } from '../../model/build/progress'
import { importedRowCount } from '../../model/build/questions'
import { parseSpec } from '../../model/build/spec'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { Button, Card, CardBody, cn, CopyButton, Field, focusHeading, LinkButton, Markdown, Notice, PageHeader, RadioCards, Stepper, TextArea, TextInput, useDocumentTitle, useUnsavedChangesGuard } from '../../ui'
import { resolveBuildGroup } from '../build/entry'
import { filesFromDrop, filesFromList, type CollectedWorkbook } from './collect'
import { text } from './copy'
import { readWorkbook, type AppPlan, type Capability, type ColumnKind, type SheetReading, type WorkbookGrid } from './model'
import { SAMPLE_SETS } from './samples'
import { screenId } from './ui-design'
import { UiDecisions } from './ui-decisions'
import { UiPreviewStep } from './ui-preview-step'
import { latestSaver, resumeStep, specParts, useExcel2AppDraft, WorkbookStoreError, type AnalysisProblem, type Excel2AppStep } from './use-excel2app-draft'

const CAPABILITY_ICON: Record<Capability, ReactNode> = {
  entry: <ClipboardList aria-hidden className="size-4" />,
  choices: <ListChecks aria-hidden className="size-4" />,
  calculation: <Calculator aria-hidden className="size-4" />,
  lookup: <Search aria-hidden className="size-4" />,
  aggregate: <PieChart aria-hidden className="size-4" />,
  workflow: <GitBranch aria-hidden className="size-4" />,
  deadlines: <CalendarClock aria-hidden className="size-4" />,
}

const ROLE_PILL: Record<SheetReading['role'], string> = {
  records: 'bg-accent-soft text-accent-strong',
  master: 'bg-stone-100 text-stone-700',
  summary: 'bg-amber-50 text-amber-800',
  empty: 'bg-stone-100 text-stone-500',
}

/** Kinds the app derives rather than stores as typed text stand out in the column table. */
const KIND_PILL: Partial<Record<ColumnKind, string>> = {
  formula: 'bg-accent-soft text-accent-strong',
  reference: 'bg-accent-soft text-accent-strong',
}

/** Step indexes in `text.steps` order. */
const ANALYSIS_STEP = 1
const SPEC_STEP = 2
const PREVIEW_STEP = 3
const IMPLEMENT_STEP = 4

/** 見せる相手 on the 実装 step: the scopes the build page's 用意する question offers, in its order. */
const SHARE_CHOICES: DraftShareScope[] = ['private', 'group', 'company']
const PUBLISH_NAME_ID = 'excel2app-publish-name'

/** Rows each sample card advertises: the rows the app imports, so the card agrees with the spec. */
const SAMPLE_IMPORT_ROWS = new Map(SAMPLE_SETS.map((sample) => [sample.id, sample.workbooks.reduce((sum, workbook) => sum + readWorkbook(workbook).sheets.filter((sheet) => sheet.role === 'records' || sheet.role === 'master').reduce((rows, sheet) => rows + sheet.dataRows, 0), 0)]))

export function Excel2AppPage({ draftId }: { draftId?: string }) {
  const createdDraftId = useRef<string>(undefined)
  const [route, setRoute] = useState({ draftId, flowKey: 0 })
  if (route.draftId !== draftId) {
    const bindingCreatedDraft = route.draftId === undefined && draftId !== undefined && draftId === createdDraftId.current
    createdDraftId.current = undefined
    setRoute({ draftId, flowKey: route.flowKey + (bindingCreatedDraft ? 0 : 1) })
  }
  return <Excel2AppFlow key={route.flowKey} draftId={draftId} onCreatedDraft={(id) => { createdDraftId.current = id }} />
}

/** Binding this flow's new draft to the URL must not discard upload or admission errors. */
function Excel2AppFlow({ draftId, onCreatedDraft }: { draftId?: string; onCreatedDraft: (id: string) => void }) {
  const navigate = useNavigate()
  const { me, groups, currentGroup } = useShell()
  const flow = useExcel2AppDraft(me.projectId, draftId)
  const { draft, reading, plan, grids, readOnly } = flow
  const ownerGroupName = groups.find((group) => group.id === resolveBuildGroup(me, groups, currentGroup))?.name
  const [step, setStep] = useState<Excel2AppStep | undefined>(draftId ? undefined : 0)
  const [pickError, setPickError] = useState<string>()
  const [specEdit, setSpecEdit] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [advancing, setAdvancing] = useState(false)
  const [publishName, setPublishName] = useState<string>()
  const [shareChoice, setShareChoice] = useState<DraftShareScope>()
  const [nameMissing, setNameMissing] = useState(false)
  const [startError, setStartError] = useState(false)

  // A reload resumes at the step the draft's state implies, once the state is known
  // (the 「AI なしで続ける」 reading also needs the stored grid).
  const known = Boolean(draft) && (Boolean(reading) || !flow.offline || flow.gridsReady || flow.gridsFailed)
  if (step === undefined && draft && known) setStep(resumeStep(draft, Boolean(reading)))

  const savedBody = draft ? specParts(draft.specMarkdown).body : ''
  const specDirty = !readOnly && specEdit !== undefined && specEdit !== savedBody
  useDocumentTitle(text.pageTitle((step ?? 0) + 1))
  useUnsavedChangesGuard(specDirty, text.unsavedChanges)

  useEffect(() => {
    if (step !== undefined && step > 0) focusHeading('excel2app-step-title')
  }, [step])

  // The preview asks for the default design when it is first shown.
  const initDesign = flow.design.init
  const hasPlan = Boolean(plan)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on entering the preview (and once the fallback plan exists), not on every render.
  useEffect(() => {
    if (step === PREVIEW_STEP && draft) { flow.loadGrids(); initDesign() }
  }, [step, draft?.id, hasPlan])

  const collected = async (inputs: readonly File[] | readonly WorkbookGrid[], sample = false) => {
    setPickError(undefined)
    try {
      const result = sample ? await flow.addSample(inputs as readonly WorkbookGrid[]) : await flow.addFiles(inputs as readonly File[])
      if (!result) return
      editSpec(undefined)
      setEditing(false)
      setStep(result.analysisRequested ? ANALYSIS_STEP : 0)
      if (result.id !== draftId) {
        onCreatedDraft(result.id)
        await navigate({ to: '/-/excel2app', search: { draft: result.id }, replace: true })
      }
    } catch { setPickError(text.pick.saveFailed) }
  }

  const remove = async (file: CollectedWorkbook) => {
    setPickError(undefined)
    try { await flow.removeWorkbook(file.key, file.workbookId) }
    catch (error) {
      const problem = error instanceof WorkbookStoreError ? error.problem : 'failed'
      setPickError(problem === 'busy' ? text.pick.busy : problem === 'created' ? text.pick.created : text.pick.saveFailed)
    }
  }

  // Blur, 表示 and 次へ share one save queue: a later request waits for the running PATCH,
  // then saves the newest text (typed while the first was saving) instead of dropping it.
  const specEditRef = useRef<string>(undefined)
  const editSpec = (value: string | undefined) => {
    specEditRef.current = value
    setSpecEdit(value)
  }
  const saveRef = useRef(flow.spec.save)
  saveRef.current = flow.spec.save
  const [saveSpec] = useState(() => latestSaver(
    (body) => saveRef.current(body),
    () => specEditRef.current,
    (body) => {
      if (specEditRef.current !== body) return
      specEditRef.current = undefined
      setSpecEdit((current) => (current === body ? undefined : current))
    },
  ))

  // A set change invalidates unsaved edits to the previous integrated design.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only membership changes discard editor state.
  useEffect(() => {
    specEditRef.current = undefined
    setSpecEdit(undefined)
    setEditing(false)
  }, [draft?.source?.revision])

  const next = async () => {
    if (step === SPEC_STEP && !readOnly) {
      setAdvancing(true)
      const saved = await saveSpec()
      setAdvancing(false)
      if (!saved) return
    }
    setStep((current) => (current === undefined ? current : ((current + 1) as Excel2AppStep)))
  }

  const design = flow.design.current
  // The name the preview settled; the specification's name and the title stand in until a design exists.
  const chosenName = publishName ?? draft?.publishPreferences?.name ?? (design?.appName || (draft ? parseSpec(draft.specMarkdown).spec.name || draft.title : ''))
  const chosenScope = shareChoice ?? draft?.publishPreferences?.shareScope ?? 'group'

  const startBuild = async () => {
    if (!draft || readOnly) return
    setStartError(false)
    const name = chosenName.trim()
    if (!name) {
      setNameMissing(true)
      document.getElementById(PUBLISH_NAME_ID)?.focus()
      return
    }
    setAdvancing(true)
    const ready = await flow.handOff({ name, shareScope: chosenScope })
    setAdvancing(false)
    if (!ready) return setStartError(true)
    void navigate({ href: paths.build(draft.id) })
  }

  if (draftId && flow.draftQuery.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={text.title} lead={text.lead} />
        <Notice tone="error" className="mt-6" title={text.loadFailed} actions={<Button type="button" tone="secondary" size="sm" onClick={() => void flow.draftQuery.refetch()} icon={<RotateCcw className="size-4" />}>{text.retryLoad}</Button>} />
      </div>
    )
  }
  if (step === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={text.title} lead={text.lead} />
        <p role="status" className="mt-6 flex items-center gap-2 text-sm text-stone-500"><Loader2 aria-hidden className="size-4 animate-spin" />{text.loading}</p>
      </div>
    )
  }

  const stepTitle = [
    text.pick.title,
    reading ? text.analysis.setTitle : readOnly || flow.analysis.problem || (!flow.codexAvailable && !flow.analysis.turn) ? text.steps[ANALYSIS_STEP] : text.analysis.running,
    text.spec.title,
    text.preview.title,
    text.implement.title,
  ][step]
  const nextDisabled = advancing || (step === ANALYSIS_STEP && !reading) || (step === SPEC_STEP && !draft?.specMarkdown.trim())

  return (
    <div className={cn('mx-auto', step === PREVIEW_STEP ? 'max-w-6xl' : 'max-w-3xl')}>
      <PageHeader title={text.title} lead={text.lead} />
      {readOnly && draft ? (
        <div className="mt-6" data-testid="excel2app-created">
          <Notice tone="info" title={text.created.title} actions={<LinkButton href={paths.build(draft.id)} tone="secondary" size="sm">{text.created.openBuild}</LinkButton>}>
            {text.created.body}
          </Notice>
        </div>
      ) : null}
      <div className="mt-6">
        <Stepper step={step} labels={text.steps} />
      </div>
      <Card className="mt-6">
        <CardBody className="px-4 py-6 sm:px-8 sm:py-8">
          <h2 id="excel2app-step-title" tabIndex={-1} className="mb-5 text-lg font-semibold break-words text-stone-900 focus:outline-none">{stepTitle}</h2>

          {step === 0 && !readOnly ? <PickStep busy={flow.collecting || flow.starting || flow.turnRunning} error={pickError} files={flow.files} budget={flow.budget} hint={flow.hint} onHint={flow.setHint} onFiles={(files) => void collected(files)} onSample={(grids) => void collected(grids, true)} onRemove={(file) => void remove(file)} onRetry={(file) => void flow.retryFile(file.key)} onStart={() => { setStep(ANALYSIS_STEP); void flow.startAnalysis() }} /> : null}
          {step === ANALYSIS_STEP && draft ? (
            reading ? (
              <AnalysisStep reading={reading} workbooks={draft.source?.workbooks ?? []} entries={flow.entries} offline={flow.offline} />
            ) : !readOnly ? (
              <AnalysingStep
                workbooks={draft.source?.workbooks ?? []}
                turn={flow.analysis.turn}
                problem={flow.analysis.problem}
                error={flow.analysis.error}
                failure={flow.analysis.failure}
                codexAvailable={flow.codexAvailable}
                codexUnavailableReason={flow.codexUnavailableReason}
                codexPolicy={flow.codexPolicy}
                canContinueOffline={!flow.codexAvailable && flow.gridsReady}
                onRetry={flow.analysis.retry}
                onOffline={() => void flow.analysis.continueOffline()}
              />
            ) : null
          ) : null}
          {step === ANALYSIS_STEP && reading && !flow.offline && flow.workbooksQuery.isError ? <Notice tone="error" title={text.loadFailed} actions={<Button type="button" onClick={() => void flow.workbooksQuery.refetch()}>{text.retryLoad}</Button>} /> : null}
          {step === SPEC_STEP && draft ? (
            <SpecStep
              body={readOnly ? savedBody : specEdit ?? savedBody}
              specMarkdown={draft.specMarkdown}
              editing={editing && !readOnly}
              readOnly={readOnly}
              status={flow.spec.status}
              fileName={plan?.name ?? draft.title}
              onEditing={setEditing}
              onChange={editSpec}
              onBlur={() => void saveSpec()}
              onRetry={() => void saveSpec()}
            />
          ) : null}
          {step === PREVIEW_STEP && flow.gridsReady && reading && plan ? (
            <UiPreviewStep
              plan={plan}
              design={design}
              grids={grids}
              messages={flow.design.messages}
              busy={flow.design.busy}
              readOnly={readOnly}
              activityTail={flow.design.activityTail}
              onSend={flow.design.send}
              onUndo={flow.design.undo}
              canUndo={flow.design.canUndo}
              suggestions={flow.design.suggestions}
              onRetry={flow.design.retry}
            />
          ) : null}
          {step === PREVIEW_STEP && flow.offline ? <Notice tone="info" className="mt-4">{text.preview.offlineNote}</Notice> : null}
          {(step === PREVIEW_STEP || (step === ANALYSIS_STEP && !flow.codexAvailable)) && flow.gridsFailed ? <Notice tone="error" className="mt-4" title={text.loadFailed} actions={<Button type="button" onClick={flow.retryGrids}>{text.retryLoad}</Button>} /> : null}
          {step === PREVIEW_STEP && !flow.gridsReady && !flow.gridsFailed ? <p role="status">{text.loading}</p> : null}
          {step === IMPLEMENT_STEP && !readOnly && reading && plan && design ? (
            <ImplementStep
              reading={reading}
              plan={plan}
              design={design}
              name={chosenName}
              shareChoice={chosenScope}
              ownerGroupName={ownerGroupName}
              nameMissing={nameMissing}
              onName={setPublishName}
              onShareChoice={setShareChoice}
            />
          ) : null}
          {step === IMPLEMENT_STEP && !readOnly && startError ? <Notice tone="error" className="mt-4">{text.implement.startFailed}</Notice> : null}

          {step > 0 ? (
            <div className="mt-8 flex flex-col-reverse gap-3 border-t border-stone-100 pt-5 sm:flex-row sm:items-center">
              <Button type="button" tone="secondary" disabled={advancing || (readOnly && step === ANALYSIS_STEP)} onClick={() => setStep((current) => (current ? ((current - 1) as Excel2AppStep) : current))}>{text.back}</Button>
              <div className="flex flex-col sm:ml-auto">
                {readOnly && step >= PREVIEW_STEP ? (
                  <LinkButton href={paths.build(draft!.id)}>{text.created.openBuild}</LinkButton>
                ) : step < PREVIEW_STEP ? (
                  <Button type="button" tone="primary" data-testid="excel2app-next" disabled={nextDisabled} loading={advancing} onClick={() => void next()} icon={<ArrowRight className="size-4" />}>{text.next}</Button>
                ) : step === PREVIEW_STEP ? (
                  <Button type="button" tone="primary" data-testid="excel2app-to-implement" disabled={flow.design.busy || !design} onClick={() => setStep(IMPLEMENT_STEP)} icon={<ArrowRight className="size-4" />}>{text.preview.toImplement}</Button>
                ) : (
                  <Button type="button" tone="primary" data-testid="excel2app-start-build" loading={advancing} disabled={advancing || !design} onClick={() => void startBuild()} icon={<Sparkles className="size-4" />}>{text.implement.start}</Button>
                )}
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </div>
  )
}

interface PickStepProps {
  busy: boolean
  error?: string
  files: CollectedWorkbook[]
  budget: { files: number; maxFiles: number; bytes: number; maxBytes: number; sheets: number; maxSheets: number }
  hint: string
  onHint: (hint: string) => void
  onFiles: (files: File[]) => void
  onSample: (grids: WorkbookGrid[]) => void
  onRemove: (file: CollectedWorkbook) => void
  onRetry: (file: CollectedWorkbook) => void
  onStart: () => void
}

function fileStateText(file: CollectedWorkbook): string {
  if (file.problem) return text.pick[file.problem]
  switch (file.state) {
    case 'reading': return text.pick.reading
    case 'storing': return text.pick.saving
    case 'failed': return text.pick.saveFailed
    case 'invalid': return text.pick.invalid(file.location)
    default: return text.pick[file.state]
  }
}

function PickStep({ busy, error, files, budget, hint, onHint, onFiles, onSample, onRemove, onRetry, onStart }: PickStepProps) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [dropError, setDropError] = useState(false)
  const [walking, setWalking] = useState(false)
  const blocked = busy || walking
  const drop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setOver(false)
    if (blocked) return
    setWalking(true)
    setDropError(false)
    try { onFiles(await filesFromDrop(event.dataTransfer)) }
    catch { setDropError(true) }
    finally { setWalking(false) }
  }
  return (
    <div className="space-y-6">
      <div data-testid="excel2app-drop" onDragOver={(event) => { event.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={(event) => void drop(event)} className={cn('flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-5 py-8 text-center', over ? 'border-accent bg-accent-soft' : 'border-stone-300 bg-stone-50/60')}>
        {blocked ? <Loader2 aria-hidden className="size-6 animate-spin text-accent-strong" /> : <Upload aria-hidden className="size-6 text-stone-500" />}
        <p className="text-sm font-semibold text-stone-900">{text.pick.drop}</p>
        <p className="text-xs text-stone-500">{text.pick.dropHint}</p>
        <input ref={input} type="file" multiple accept=".xlsx,.xlsm" className="sr-only" data-testid="excel2app-files-input" onChange={(event) => { onFiles(filesFromList(event.target.files)); event.target.value = '' }} />
        <Button type="button" tone="secondary" disabled={blocked} onClick={() => input.current?.click()} icon={<FileSpreadsheet className="size-4" />}>{text.pick.choose}</Button>
      </div>
      {error || dropError ? <p role="alert" className="text-sm text-bad-ink">{error ?? text.pick.unreadable}</p> : null}
      <section aria-label={text.pick.files}>
        <p data-testid="excel2app-budget" className="text-sm tabular-nums text-stone-600">{text.pick.budget(budget.files, budget.maxFiles, (budget.bytes / 1048576).toFixed(1), String(budget.maxBytes / 1048576), budget.sheets, budget.maxSheets)}</p>
        <ul data-testid="excel2app-files" className="mt-3 divide-y divide-stone-100">
          {files.map((file) => (
            <li key={file.key} data-testid="excel2app-file" data-state={file.state} className="flex flex-wrap items-center gap-2 py-3 text-sm">
              <span className="min-w-0 flex-1 break-words font-medium">{file.fileName}</span>
              <span role="status" className={file.state === 'stored' ? 'text-accent-strong' : 'text-stone-600'}>{fileStateText(file)}</span>
              {file.state === 'failed' && !file.problem ? <Button type="button" tone="ghost" size="sm" disabled={blocked} onClick={() => onRetry(file)}>{text.pick.retry}</Button> : null}
              <Button type="button" tone="ghost" size="sm" disabled={blocked} onClick={() => onRemove(file)}>{text.pick.remove}</Button>
            </li>
          ))}
        </ul>
      </section>
      <Field id="excel2app-hint" label={text.pick.hint}>
        <TextArea id="excel2app-hint" value={hint} maxLength={4000} rows={2} disabled={blocked} placeholder={text.pick.hintPlaceholder} onChange={(event) => onHint(event.target.value)} />
      </Field>
      <Button type="button" tone="primary" data-testid="excel2app-analyse" disabled={blocked || budget.files === 0} onClick={onStart} icon={<Sparkles className="size-4" />}>{text.pick.start(budget.files)}</Button>
      <section aria-labelledby="excel2app-samples-title">
        <h3 id="excel2app-samples-title" className="text-sm font-semibold">{text.pick.samples}</h3>
        <p className="mt-1 text-sm text-stone-500">{text.pick.samplesLead}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {SAMPLE_SETS.map((sample) => (
            <button key={sample.id} type="button" disabled={blocked} onClick={() => onSample(sample.workbooks)} data-testid={`excel2app-sample-${sample.id}`} className="rounded-lg border border-stone-200 p-4 text-left hover:border-accent-line disabled:opacity-50">
              <span className="block font-semibold">{sample.title}</span>
              <span className="mt-2 block text-sm text-stone-600">{sample.usage}</span>
              <span className="mt-3 block text-xs text-stone-500">{text.pick.sheets(sample.workbooks.reduce((count, workbook) => count + workbook.sheets.length, 0))} ・ {text.pick.rows(SAMPLE_IMPORT_ROWS.get(sample.id) ?? 0)}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

/** Progress is persisted by the staged turn, never inferred from elapsed time. */
export function AnalysingStep({ workbooks = [], turn, problem, error, failure, codexAvailable, codexUnavailableReason, codexPolicy, canContinueOffline, onRetry, onOffline }: {
  workbooks?: ApplicationDraftWorkbookSummary[]
  turn?: BuildTurn
  problem?: AnalysisProblem
  error?: string
  failure?: BuildFailure
  codexAvailable: boolean
  codexUnavailableReason?: ApplicationDraftCreationToolRegistryResponse['codexUnavailableReason']
  codexPolicy?: string
  canContinueOffline: boolean
  onRetry: () => void
  onOffline: () => void
}) {
  const running = isOneOf(turn?.status, 'pending', 'running')
  const progress = turn?.excelProgress
  const log = activityLines(turn?.activityTail).at(-1)
  const offline = canContinueOffline && !codexAvailable ? <Button type="button" tone="secondary" size="sm" data-testid="excel2app-offline" onClick={onOffline}>{text.analysis.offline}</Button> : null
  const retry = <Button type="button" tone="primary" size="sm" data-testid="excel2app-analysis-retry" onClick={onRetry} icon={<RotateCcw className="size-4" />}>{text.analysis.retry}</Button>
  const quota = problem === 'quota' || (problem === 'failed' && isAIQuotaExhausted(error ?? ''))
  const classified = failure ?? (error ? classifyBuildFailure(error, undefined, 'turn') : undefined)
  const policy = classified?.kind === 'policy' ? classified.reason : aiPolicyExplanation(codexUnavailableReason, codexPolicy)
  return (
    <div className="space-y-5" aria-busy={running}>
      <ul data-testid="excel2app-progress" className="space-y-3">
        {workbooks.map((workbook) => {
          const state = progress?.workbooks.find((item) => item.workbookId === workbook.id)?.state ?? 'pending'
          return <li key={workbook.id} data-testid="excel2app-progress-file" data-state={state} className="flex flex-wrap items-center gap-2 text-sm"><FileSpreadsheet aria-hidden className="size-4" /><span className="min-w-0 flex-1 break-words">{workbook.fileName}</span><span>{text.analysis.progress[state]}</span></li>
        })}
      </ul>
      {progress ? <p data-testid="excel2app-progress-stage" data-stage={progress.stage} className="text-sm font-medium">{text.analysis.stagesByName[progress.stage]}</p> : null}
      {policy ? (
        <div data-testid="excel2app-analysis-policy"><Notice tone="warning" title={aiPolicyCopy.title} actions={offline}>{policy}</Notice></div>
      ) : quota ? (
        <div data-testid="excel2app-analysis-quota"><Notice tone="error" title={buildCopy.failure.quota.title} actions={retry}>{buildCopy.failure.quota.reason}</Notice></div>
      ) : problem === 'unavailable' || (!turn && !codexAvailable) ? (
        <div data-testid="excel2app-analysis-unavailable"><Notice tone="warning" title={text.analysis.unavailableTitle} actions={<>{retry}{offline}</>}>{codexAvailable ? text.analysis.unavailableBody : text.analysis.noRuntimeBody}</Notice></div>
      ) : problem === 'failed' ? (
        <div data-testid="excel2app-analysis-failed"><Notice tone="error" title={text.analysis.failedTitle} actions={<>{retry}{offline}</>}>{error ? <span className="block break-words">{error}</span> : null}<span className="block">{text.analysis.failedBody}</span></Notice></div>
      ) : (
        <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
          <p className="text-xs font-medium text-stone-500">{text.analysis.log}</p>
          <p data-testid="excel2app-analysis-log" className="mt-0.5 truncate font-mono text-xs text-stone-700">{log ?? (running ? text.analysis.running : text.analysis.waiting)}</p>
        </div>
      )}
    </div>
  )
}

function AnalysisStep({ reading, workbooks, entries, offline }: { reading: ExcelAnalysis; workbooks: ApplicationDraftWorkbookSummary[]; entries: ApplicationDraftWorkbookEntry[]; offline: boolean }) {
  const names = new Map(workbooks.map((workbook) => [workbook.id, workbook.fileName]))
  return (
    <div className="space-y-8">
      <p className="text-sm text-stone-600">{text.analysis.lead}</p>
      {offline ? <Notice tone="info">{text.analysis.offlineNote}</Notice> : null}
      <section data-testid="excel2app-summary" className="rounded-lg border border-accent-line bg-accent-soft/50 p-4">
        <h3 className="text-xs font-semibold text-accent-strong">{text.analysis.summaryLabel}</h3>
        <p className="mt-2 font-medium">{reading.summary}</p>
        <ul className="mt-2 space-y-1">{reading.bullets.map((point) => <li key={point} className="text-sm">{point}</li>)}</ul>
      </section>
      {reading.flows.length > 0 ? <section><h3 className="mb-2 font-semibold">{text.analysis.flows}</h3><ul>{reading.flows.map((flow) => <li key={flow.name} data-testid="excel2app-flow" className="text-sm">{flow.name}: {flow.steps.join(' → ')}</li>)}</ul></section> : null}
      <section className="space-y-3">
        <h3 className="font-semibold">{text.analysis.entities}</h3>
        {reading.entities.map((entity) => (
          <article key={entity.name} data-testid="excel2app-entity" data-entity={entity.name} className="rounded-lg border border-stone-200 p-4">
            <h4 className="font-semibold">{entity.name} <span className="text-xs font-normal text-stone-500">{text.role[entity.kind]} ・ {text.analysis.rows(entity.importRows)}</span></h4>
            <ul className="mt-3 flex flex-wrap gap-2">{entity.fields.map((field) => <li key={field.name} className="rounded bg-stone-100 px-2 py-1 text-xs">{field.name} · {text.kind[field.kind]}{field.referenceEntity ? ` → ${field.referenceEntity}` : ''}</li>)}</ul>
            <p className="mt-3 text-xs font-medium text-stone-500">{text.analysis.sources}</p>
            <ul className="mt-1 space-y-1">{entity.sources.map((source, index) => <li key={`${source.workbookId}:${source.sheet}:${index}`} data-testid="excel2app-entity-source" className="text-sm">{names.get(source.workbookId)} ・ {source.sheet} ・ {text.analysis.rows(source.dataRows)}</li>)}</ul>
          </article>
        ))}
      </section>
      {reading.findings.length > 0 ? <section data-testid="excel2app-findings"><h3 className="font-semibold">{text.analysis.findings}</h3><ul className="mt-2 list-disc space-y-2 pl-5">{reading.findings.map((finding, index) => <li key={`${finding.kind}:${index}`} className="text-sm">{finding.message}</li>)}</ul></section> : null}
      <section aria-labelledby="excel2app-capabilities">
        <h3 id="excel2app-capabilities" className="mb-3 font-semibold">{text.analysis.capabilities}</h3>
        <ul className="grid gap-3 sm:grid-cols-2">{reading.capabilities.map((capability) => <li key={capability} className="flex gap-3 text-sm"><span className="text-accent-strong">{CAPABILITY_ICON[capability]}</span><span>{text.capability[capability].title}</span></li>)}</ul>
      </section>
      <section className="space-y-4">
        <h3 className="font-semibold">{text.analysis.readings}</h3>
        {entries.filter((entry) => entry.reading).map((entry) => <details key={entry.workbook.id} data-testid="excel2app-reading" className="space-y-3"><summary className="cursor-pointer text-sm font-medium">{entry.workbook.fileName}</summary><p className="text-sm text-stone-600">{entry.reading!.summary}</p>{entry.reading!.sheets.map((sheet) => <SheetCard key={sheet.name} sheet={sheet} />)}</details>)}
      </section>
    </div>
  )
}

function SheetCard({ sheet }: { sheet: SheetReading }) {
  return (
    <div data-testid="excel2app-sheet" data-sheet={sheet.name} className="overflow-hidden rounded-lg border border-stone-200">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-stone-200 bg-stone-50 px-4 py-3">
        <Table2 aria-hidden className="size-4 shrink-0 text-stone-500" />
        <span className="font-semibold break-words text-stone-900">{sheet.name}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', ROLE_PILL[sheet.role])}>{text.role[sheet.role]}</span>
        <span className="text-xs text-stone-500">{text.analysis.rows(sheet.dataRows)}</span>
        {sheet.role === 'summary' ? <span className="basis-full text-xs text-amber-800 sm:ml-auto sm:basis-auto">{text.analysis.skipped}</span> : null}
      </div>
      {sheet.columns.length === 0 ? <p className="px-4 py-3 text-sm text-stone-500">{text.analysis.noColumns}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-stone-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium whitespace-nowrap">{text.analysis.columns}</th>
                <th scope="col" className="px-2 py-2 font-medium whitespace-nowrap">{text.analysis.kind}</th>
                <th scope="col" className="hidden px-2 py-2 font-medium sm:table-cell">{text.analysis.samples}</th>
                <th scope="col" className="px-4 py-2 text-right font-medium whitespace-nowrap">{text.analysis.fill}</th>
              </tr>
            </thead>
            <tbody>
              {sheet.columns.map((column) => {
                const rules = column.kind === 'formula' ? sheet.rules.filter((item) => item.column === column.header) : []
                const samples = column.samples.join(' / ')
                return (
                  <tr key={column.index} className="border-t border-stone-100 align-top">
                    <td className="px-4 py-2.5 font-medium whitespace-nowrap text-stone-900">{column.header}</td>
                    <td className="min-w-28 px-2 py-2.5 text-stone-700">
                      <span className={cn('inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', KIND_PILL[column.kind] ?? 'bg-stone-100 text-stone-700')}>{text.kind[column.kind]}</span>
                      {column.kind === 'choice' && column.options ? <span className="mt-1 block text-xs leading-relaxed text-stone-500">{column.options.join(' / ')}</span> : null}
                      {column.kind === 'reference' && column.referenceSheet ? <span className="mt-1 block text-xs text-stone-500">→ {column.referenceSheet}</span> : null}
                      {rules.map((rule) => <span key={rule.expression} className="mt-1 block font-mono text-xs break-words text-stone-500 sm:hidden">= {rule.expression}</span>)}
                    </td>
                    <td className="hidden px-2 py-2.5 text-xs leading-relaxed sm:table-cell">
                      {rules.length > 0 ? (
                        <ul className="space-y-1">
                          {rules.map((rule) => (
                            <li key={rule.expression} className="flex items-baseline gap-2">
                              <code className="min-w-0 font-mono break-words text-stone-700">= {rule.expression}</code>
                              <span className="shrink-0 rounded-full bg-white px-1.5 text-[11px] whitespace-nowrap text-stone-500 ring-1 ring-stone-200">{text.ruleCategory[rule.category]}</span>
                            </li>
                          ))}
                        </ul>
                      ) : <span title={samples} className="line-clamp-2 break-words text-stone-500">{samples}</span>}
                    </td>
                    <td className={cn('px-4 py-2.5 text-right tabular-nums whitespace-nowrap', column.kind === 'formula' ? 'text-xs text-accent-strong' : column.fill < 0.5 ? 'text-stone-400' : 'text-stone-700')}>{column.kind === 'formula' ? text.analysis.auto : `${Math.round(column.fill * 100)}%`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {sheet.workflow || sheet.mergedRanges > 0 ? (
        <div className="space-y-4 border-t border-stone-200 px-4 py-4">
          {sheet.workflow ? (
            <div>
              <p className="text-xs font-medium text-stone-500">{text.analysis.workflow(sheet.workflow.column)}</p>
              <ol data-testid="excel2app-workflow" className="mt-2 flex flex-wrap items-center gap-1.5">
                {sheet.workflow.stages.map((stageName, index) => (
                  <li key={stageName} className="flex items-center gap-1.5">
                    {index > 0 ? <ArrowRight aria-hidden className="size-3 text-stone-400" /> : null}
                    <span className="rounded-full border border-accent-line bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">{stageName}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {sheet.mergedRanges > 0 ? <p className="text-xs text-amber-800">{text.analysis.merged(sheet.mergedRanges)}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

type SpecStatus = { state: 'idle' | 'saving' | 'saved' } | { state: 'failed'; body: string }

/** The specification body (front-matter hidden); edits are saved to the draft on blur, on 表示 and on 次へ. */
function SpecStep({ body, specMarkdown, editing, readOnly, status, fileName, onEditing, onChange, onBlur, onRetry }: {
  body: string
  specMarkdown: string
  editing: boolean
  readOnly: boolean
  status: SpecStatus
  fileName: string
  onEditing: (editing: boolean) => void
  onChange: (value: string) => void
  onBlur: () => void
  onRetry: () => void
}) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([specMarkdown], { type: 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${fileName}-spec.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const modes = [
    { editing: false, label: text.spec.preview, icon: <Eye aria-hidden className="size-4" /> },
    { editing: true, label: text.spec.edit, icon: <Pencil aria-hidden className="size-4" /> },
  ]
  return (
    <div className="space-y-4">
      {!readOnly ? <p className="text-sm text-stone-600">{text.spec.lead}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={text.spec.mode} className="inline-flex rounded-md border border-stone-200 bg-stone-100 p-0.5">
          {modes.map((mode) => {
            const active = mode.editing === editing
            return (
              <button key={mode.label} type="button" aria-pressed={active} disabled={readOnly && mode.editing} onClick={() => onEditing(mode.editing)} className={cn('inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50', active ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800')}>
                {mode.icon}{mode.label}
              </button>
            )
          })}
        </div>
        <span role="status" data-testid="excel2app-spec-status" className="text-xs text-stone-500">
          {status.state === 'saving' ? <span className="inline-flex items-center gap-1"><Loader2 aria-hidden className="size-3 animate-spin" />{text.spec.saving}</span> : status.state === 'saved' ? <span className="inline-flex items-center gap-1 text-accent-strong"><Check aria-hidden className="size-3" />{text.spec.saved}</span> : null}
        </span>
        <span className="flex gap-1 sm:ml-auto">
          <CopyButton value={specMarkdown} tone="ghost" />
          <Button type="button" tone="ghost" size="sm" onClick={download} icon={<Download className="size-4" />}>{text.spec.download}</Button>
        </span>
      </div>
      {status.state === 'failed' && !readOnly ? (
        <Notice tone="error" title={text.spec.saveFailed} actions={<Button type="button" tone="secondary" size="sm" onClick={onRetry} icon={<RotateCcw className="size-4" />}>{text.spec.retrySave}</Button>} />
      ) : null}
      {!body.trim() && !editing ? <Notice tone="warning">{text.spec.empty}</Notice> : null}
      {editing ? (
        <TextArea aria-label={text.spec.title} data-testid="excel2app-spec-input" value={body} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} rows={24} className="font-mono text-xs leading-relaxed" />
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
        <div role="region" aria-label={text.spec.title} tabIndex={0} className="max-h-[32rem] overflow-y-auto rounded-lg border border-stone-200 bg-white px-4 py-5 focus-visible:outline-2 focus-visible:outline-accent sm:px-6"><Markdown source={body} /></div>
      )}
    </div>
  )
}

function ImplementStep({ reading, plan, design, name, shareChoice, ownerGroupName, nameMissing, onName, onShareChoice }: {
  reading: ExcelAnalysis
  plan: AppPlan
  design: UiDesign
  name: string
  shareChoice: DraftShareScope
  ownerGroupName?: string
  nameMissing: boolean
  onName: (name: string) => void
  onShareChoice: (choice: DraftShareScope) => void
}) {
  const rules = reading.entities.reduce((sum, entity) => sum + entity.rules.length, 0) + plan.entities.filter((entity) => entity.workflow).length
  // Screens hidden in the UI preview are not built, so they leave the summary too.
  const hidden = new Set(design.screens.filter((screen) => screen.hidden).map((screen) => screen.id))
  const screens = plan.screens.filter((screen) => !hidden.has(screenId(screen.kind, screen.entity)))
  const stats: [string, number][] = [
    [text.implement.stats.entities, plan.entities.length],
    [text.implement.stats.screens, screens.length],
    [text.implement.stats.rules, rules],
    [text.implement.stats.rows, importedRowCount(reading) ?? 0],
  ]
  return (
    <div className="space-y-8">
      <p className="text-sm text-stone-600">{text.implement.lead}</p>
      <section aria-labelledby="excel2app-summary">
        <h3 id="excel2app-summary" className="mb-3 text-sm font-semibold text-stone-900">{text.implement.summary}</h3>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-stone-200 px-4 py-3">
              <dt className="text-xs text-stone-500">{label}</dt>
              <dd className="mt-0.5 text-2xl font-semibold tabular-nums text-stone-900">{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        <ul className="mt-4 divide-y divide-stone-100 rounded-lg border border-stone-200">
          {plan.entities.map((entity) => (
            <li key={entity.name} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Database aria-hidden className="size-4 shrink-0 text-stone-500" />
                <span className="font-medium break-words text-stone-900">{entity.name}</span>
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', ROLE_PILL[entity.kind])}>{text.role[entity.kind]}</span>
                <span className="text-xs text-stone-500">{text.implement.fields(entity.fields.length)} ・ {text.implement.rows(entity.importRows)}</span>
              </div>
              <ul className="mt-2 flex flex-wrap gap-1.5 pl-6">
                {screens.filter((screen) => screen.entity === entity.name).map((screen) => (
                  <li key={screen.kind} className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs text-stone-700">{text.screen[screen.kind]}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="excel2app-ui-decisions" data-testid="excel2app-ui-decisions">
        <h3 id="excel2app-ui-decisions" className="mb-3 text-sm font-semibold text-stone-900">{text.implement.uiDecisions}</h3>
        <UiDecisions design={design} />
        <p className="mt-2 text-xs text-stone-500">{text.implement.uiDecisionsHint}</p>
      </section>
      <section aria-labelledby="excel2app-plan">
        <h3 id="excel2app-plan" className="mb-3 text-sm font-semibold text-stone-900">{text.implement.steps}</h3>
        <ol className="space-y-2.5">
          {text.implement.plan.map((item, index) => (
            <li key={item} className="flex items-start gap-3 text-sm text-stone-700"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-strong">{index + 1}</span>{item}</li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="excel2app-publish" data-testid="excel2app-publish" className="space-y-5 border-t border-stone-100 pt-6">
        <div>
          <h3 id="excel2app-publish" className="text-sm font-semibold text-stone-900">{text.implement.publish}</h3>
          <p className="mt-1 text-xs text-stone-500">{text.implement.publishLead}</p>
        </div>
        <Field id={PUBLISH_NAME_ID} label={text.implement.name} hint={text.implement.nameHint} error={nameMissing && !name.trim() ? text.implement.nameRequired : undefined} required>
          <TextInput id={PUBLISH_NAME_ID} data-testid="excel2app-publish-name" value={name} maxLength={200} autoComplete="off" invalid={nameMissing && !name.trim()} onChange={(event) => onName(event.target.value)} />
        </Field>
        <RadioCards<DraftShareScope>
          name="excel2app-audience"
          legend={text.implement.audience}
          columns={3}
          value={shareChoice}
          onChange={onShareChoice}
          options={SHARE_CHOICES.map((choice) => ({ value: choice, title: shareScopeLabel(choice, ownerGroupName), description: text.implement.audienceHint[choice] }))}
        />
      </section>
      <p className="flex items-center gap-1.5 text-xs text-stone-500"><Sparkles aria-hidden className="size-3.5 shrink-0 text-accent" />{text.implement.startHint}</p>
    </div>
  )
}
