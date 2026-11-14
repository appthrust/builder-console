// The template / existing-work / image wizard. AI creation has its own build session.
import { useStore } from '@tanstack/react-form'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCreateStore, useSelector } from '@tanstack/react-store'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { buildGroupTree, flattenGroupTree, membershipRoots, type BusinessApp } from '../../model/contracts/console'
import type { ShareChoice } from '../../model/contracts/catalog'
import { createApi } from '../../api/create'
import { useCreateCatalog, useCreateConnections, useCreationTools } from '../../api/queries/catalog'
import { copy } from '../../copy'
import { aiPolicyExplanation } from '../../copy/ai-policy'
import {
  appUrl,
  isValidAppName,
  missingPrerequisites,
  pickCreateEnvironment,
  resolveCreateCatalog,
  pickSourceConnection,
  publishDomainPending,
  sourceConnectionsOf,
  templateSourceProblem,
  templateUsableFor,
  type CreateEntry,
} from '../../model/create'
import { shareSentence } from '../../model/share'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { Button, Card, CardBody, focusHeading, LoadFailed, Notice, PageHeader, Stepper, useDocumentTitle, useUnsavedChangesGuard } from '../../ui'
import { checkNameAvailability, suggestFreeUrlName, type AvailabilityRequest, type NameAvailability } from './availability'
import { text } from './copy'
import { effectiveShareGroupIds, stepFields, syncUrlName, useCreateForm, type CreateValues } from './form'
import { CreatingPanel, FailureNotice, FieldFailureNotice, StaleCatalogNotice, UnconfirmedCreateNotice } from './run-status'
import { beginBuild, resolveBuildGroup } from '../build/entry'
import { text as buildText } from '../build/copy'
import { newSessionEngine } from '../build/new-session-engine'
import { BuildStartFailure } from '../build/start-failure'
import { consoleConfigQuery } from '../../api/queries/console'
import { clearCreateSession, createSteps, readCreateSession, restoreCreateDraft, saveCreateSession, type Step } from './persistence'
import { businessTemplateById, joinBusinessTemplates } from './templates'
import { ConfirmStep } from './steps/confirm-step'
import { DetailsStep, type TakenUrlName } from './steps/details-step'
import { ShareStep } from './steps/share-step'
import { StartStep, type EntryBlocks } from './steps/start-step'
import {
  confirmCreate,
  CreateFailed,
  submitCreate,
  type CreatePath,
  type CreateProgress,
  type SubmitPhase,
} from './submit'

interface RunState {
  step: Step
  /** Set while an attempt runs. */
  phase?: SubmitPhase
  failure?: CreateFailed
  /** What earlier attempts made; a retry resumes from it. */
  resume: CreateProgress
  /** Step 1: a check of the URL name is running (blur or 次へ). */
  checkingName?: boolean
  /** Step 1: 次へ waits for validation and that check. */
  advancing?: boolean
  /** The URL name found taken, with a free variant once known. */
  nameTaken?: TakenUrlName
}

type CreateSearch = { group?: string; resume?: string; template?: string; intent?: string; step?: (typeof createSteps)[number] }


export function NewAppPage({ defaultGroupPath }: { defaultGroupPath?: string }) {
  const search: CreateSearch = useSearch({ from: '/new' })
  const draft = useQuery({
    // The wizard's own read of the draft it resumes (not the app page's cache).
    queryKey: ['create', 'resume', search.resume],
    queryFn: () => createApi.app(search.resume!),
    enabled: Boolean(search.resume),
  })
  if (search.resume && draft.isPending) return <Notice>{text.loadingDraft}</Notice>
  if (search.resume && draft.isError) return <LoadFailed onRetry={() => void draft.refetch()} error={draft.error} />
  return <CreateWizard key={JSON.stringify([search.resume, search.template, search.intent])} defaultGroupPath={defaultGroupPath} search={search} draft={search.resume ? draft.data : undefined} />
}

function CreateWizard({ defaultGroupPath, search, draft }: { defaultGroupPath?: string; search: CreateSearch; draft?: BusinessApp }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { me, groups: groupRows, currentGroup } = useShell()
  const aiGroupId = resolveBuildGroup(me, groupRows, currentGroup)
  const projectId = me.projectId
  const { templates, definitions } = useCreateCatalog(projectId)
  const connections = useCreateConnections(projectId)
  const tools = useCreationTools(projectId)

  const flatGroups = useMemo(() => flattenGroupTree(buildGroupTree(groupRows)), [groupRows])
  const defaultGroupId =
    groupRows.find((group) => group.path === defaultGroupPath)?.id ??
    membershipRoots(me, groupRows)[0]?.id ??
    me.effectiveGroupIds[0] ??
    flatGroups[0]?.id ??
    ''
  const [saved] = useState(() => {
    const stored = readCreateSession(search.resume)
    return draft ? restoreCreateDraft(draft, stored) : stored
  })
  const form = useCreateForm(defaultGroupId, saved?.values)
  // `?group=` can change while the wizard is open; follow it until the user picks a group.
  useEffect(() => {
    if (!saved && !form.getFieldMeta('groupId')?.isDirty) form.setFieldValue('groupId', defaultGroupId, { dontUpdateMeta: true })
  }, [form, defaultGroupId, saved])
  const values: CreateValues = useStore(form.store, (state) => state.values)

  const initialStep = createSteps.indexOf(search.step ?? saved?.step ?? 'start') as Step
  const run = useCreateStore<RunState>({ step: initialStep, resume: saved?.progress ?? {} })
  const { step, phase, failure, checkingName, advancing, nameTaken } = useSelector(run)
  const [startingBuild, setStartingBuild] = useState(false)
  const [buildError, setBuildError] = useState<{ error: unknown }>()
  const [completed, setCompleted] = useState(false)
  const completedRef = useRef(false)
  const persist = () => {
    if (completedRef.current) return
    const current = run.state
    saveCreateSession({
      version: 1, values: form.state.values, step: createSteps[current.step],
      seed: { template: search.template, intent: search.intent },
      progress: current.resume, phase: current.phase,
      failure: current.failure ? { message: current.failure.message } : undefined,
    })
  }
  const patch = (next: Partial<RunState>) => {
    run.setState((current) => ({ ...current, ...next }))
    persist()
    if (next.step !== undefined) void navigate({ to: '/new', search: { ...search, step: createSteps[next.step] } })
  }
  useEffect(() => {
    const next = createSteps.indexOf(search.step ?? saved?.step ?? 'start') as Step
    run.setState((current) => ({ ...current, step: next, advancing: false }))
    // A field failure already holds focus on its own notice.
    if (!run.state.failure?.field) focusHeading('create-step-title')
  }, [search.step, saved, run])
  useEffect(() => { persist() }, [values, step])
  useEffect(() => {
    if (!search.step) void navigate({ to: '/new', search: { ...search, step: createSteps[initialStep] }, replace: true })
  }, [])
  useDocumentTitle(text.pageTitle(Math.min(step + 1, 4)))
  useUnsavedChangesGuard(step > 0 && !completed, text.unsavedChanges)

  const formRef = useRef<HTMLFormElement>(null)
  // The running Step 1 name check (checkName).
  const nameCheck = useRef<{ key: string; controller: AbortController; result: Promise<NameAvailability | undefined> }>(undefined)
  useEffect(() => {
    // Cancel only the local name lookup; server-side creation keeps its own progress.
    return () => {
      nameCheck.current?.controller.abort()
    }
  }, [])

  const ownerGroup = groupRows.find((group) => group.id === values.groupId)
  const share: ShareChoice = {
    scope: values.scope,
    groupIds: values.scope === 'group' ? effectiveShareGroupIds(values) : [],
    extraPersonIds: draft?.share.extraPersonIds ?? saved?.progress.draft?.share.extraPersonIds ?? [],
  }
  const shareText = shareSentence(share, groupRows, ownerGroup ? { id: ownerGroup.id, path: ownerGroup.path, name: ownerGroup.name } : undefined)

  const templateRows = templates.data?.data ?? []
  const definitionRows = definitions.data?.data ?? []
  const selectedTemplate = templateRows.find((template) => template.id === values.templateId)
  const environment = connections.data
    ? pickCreateEnvironment(connections.data.sources, connections.data.registries, connections.data.domains)
    : {}
  const sourceConnections = sourceConnectionsOf(values.entry === 'template'
    ? { ...environment, source: pickSourceConnection(connections.data?.sources ?? [], selectedTemplate) }
    : environment)
  const domain = environment.domain
  const templateCatalog = resolveCreateCatalog(templateRows, definitionRows, 'github-template', values.entry === 'template' ? values.templateId : undefined)
  const defaultCatalog = resolveCreateCatalog(templateRows, definitionRows, 'github-template')
  const imageCatalog = resolveCreateCatalog(templateRows, definitionRows, 'sample-image')
  // Admins can set up what is missing themselves; everyone else asks an admin.
  const domainPending = publishDomainPending(connections.data?.domains ?? [])
  const missingSetupFor = (entry: CreateEntry) =>
    missingPrerequisites(environment, entry).filter((item) => item !== 'domain' || !domainPending)
  const missingFor = (entry: CreateEntry) => {
    const missing = missingSetupFor(entry)
    if (missing.length === 0) return domainPending ? text.domainPending : undefined
    return me.isConsoleAdmin
      ? text.missingAdmin(missing.map((item) => copy.create.prerequisite[item]).join(text.prerequisiteSeparator))
      : copy.create.missing(missing)
  }
  const imageMissing = missingFor('image')
  const blocked: EntryBlocks = {
    existing: missingFor('existing') ?? (defaultCatalog ? undefined : copy.create.start.existingUnavailable),
    template: missingFor('template') ?? (defaultCatalog ? undefined : copy.create.start.templateUnavailable),
    ai: aiPolicyExplanation(tools.data?.codexUnavailableReason, tools.data?.codexPolicy) ?? (!aiGroupId ? buildText.page.noGroup.body : missingFor('ai') ?? (tools.data?.codexAvailable ? undefined : copy.create.start.aiUnavailable)),
    image: imageMissing
      ? `${copy.create.advanced.unavailable}${imageMissing}`
      : imageCatalog
        ? undefined
        : copy.create.advanced.unavailable,
  }
  const setupLink =
    me.isConsoleAdmin && (['existing', 'template', 'ai', 'image'] as const).some((entry) => missingSetupFor(entry).length > 0)
  const catalogLoading = connections.isPending || templates.isPending || definitions.isPending || tools.isPending
  // The catalog is the evidence that creating is allowed. A first read that failed is this panel's failure; a
  // re-read that failed keeps what was shown, says so, and holds every create entry until a read succeeds.
  const catalogQueries = [templates, definitions, connections]
  const catalogFailed = catalogQueries.some((query) => query.data === undefined && query.isError)
  const catalogStale = !catalogFailed && catalogQueries.some((query) => query.data !== undefined && query.isError)
  const catalogReadAt = Math.min(...catalogQueries.map((query) => query.dataUpdatedAt))
  const retryCatalog = () => {
    void templates.refetch()
    void definitions.refetch()
    void connections.refetch()
  }
  const canCreate = me.canCreateApps
  const sourceProblem = values.entry === 'template' && selectedTemplate
    ? templateSourceProblem(selectedTemplate, connections.data?.sources ?? [])
    : undefined
  const templateProblem = values.entry !== 'template' || catalogLoading || catalogFailed
    ? undefined
    : sourceProblem === 'not-admitted' && selectedTemplate?.githubTemplate
      ? copy.create.start.templateNotAdmitted(selectedTemplate.githubTemplate.repository)
      : sourceProblem === 'no-connection'
        ? copy.create.start.templateNoConnection
        : !selectedTemplate || !templateUsableFor(selectedTemplate, 'github-template')
          ? copy.create.start.templateUnavailable
          : undefined
  const entryReady = (entry: CreateEntry | undefined) =>
    entry !== undefined && canCreate && !catalogLoading && !catalogFailed && !catalogStale && !blocked[entry] && (entry !== 'template' || (Boolean(templateCatalog) && !templateProblem))

  const catalog = values.entry === 'image' ? imageCatalog : templateCatalog
  const url = domain && isValidAppName(values.urlName) ? appUrl(values.urlName, domain) : undefined

  const chooseTemplate = (id: string) => {
    const selected = templateRows.find((item) => item.id === id)
    if (!selected || !templateUsableFor(selected, 'github-template')) return
    onEntryChange('template')
    form.setFieldValue('templateId', id)
    const metadata = businessTemplateById(id)
    if (!draft) {
      form.setFieldValue('displayName', metadata?.name ?? '')
      form.setFieldValue('description', metadata?.lead ?? '')
    }
    syncUrlName(form)
  }
  const initialized = useRef(false)
  useEffect(() => {
    if (catalogLoading || catalogFailed || initialized.current) return
    initialized.current = true
    if (search.intent !== undefined && search.intent !== saved?.seed?.intent) form.setFieldValue('intent', search.intent)
    if (search.template && search.template !== saved?.seed?.template) {
      const selected = templateRows.find((item) => item.id === search.template)
      if (selected && templateUsableFor(selected, 'github-template')) {
        chooseTemplate(search.template)
      } else {
        // Preserve unavailable deep links: confirmation must explain the selected
        // template's problem, never silently substitute another business app.
        onEntryChange('template')
        form.setFieldValue('templateId', search.template)
      }
    } else if (!form.state.values.entry) {
      const first = joinBusinessTemplates(templateRows).find((item) => templateUsableFor(item, 'github-template'))
      if (first) chooseTemplate(first.id)
    }
  }, [catalogLoading, catalogFailed, templateRows])
  useEffect(() => {
    if (run.state.failure?.field) patch({ failure: undefined })
  }, [values.entry, values.templateId, values.repository?.fullName, values.urlName])

  useEffect(() => {
    if (!failure) return
    const field = failure.field !== undefined
    const id = field ? 'create-field-error' : 'create-failure'
    const frame = requestAnimationFrame(() => {
      focusHeading(id)
      // The field notice sits at the top of the step: bring it below the sticky header (scroll-mt).
      document.getElementById(id)?.scrollIntoView({ block: field ? 'start' : 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [failure, step])


  /**
   * True when every field of the step passes its schema; otherwise the errors
   * show under the fields and the first invalid control takes the focus.
   */
  const validate = async (fields: Array<keyof CreateValues>) => {
    await Promise.all(fields.map((field) => form.validateField(field, 'submit')))
    const valid = fields.every((field) => (form.getFieldMeta(field)?.errors.length ?? 0) === 0)
    if (!valid) requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
    return valid
  }

  const onEntryChange = (entry: CreateValues['entry']) => {
    if (entry !== form.state.values.entry) form.setFieldValue('entry', entry)
    syncUrlName(form)
  }

  const chooseImage = async () => {
    if (!entryReady('image') || !(await validate(['imageRef']))) return
    onEntryChange('image')
    patch({ step: 1 })
  }

  /** The fix for a taken name first (the one-click suggestion), else the URL name input. */
  const focusTakenName = () =>
    requestAnimationFrame(() =>
      (formRef.current?.querySelector<HTMLElement>('#create-url-suggestion') ?? formRef.current?.querySelector<HTMLElement>('#create-url'))?.focus()
    )

  const availabilityRequest = (urlName: string): AvailabilityRequest => {
    const current = form.state.values
    return {
      projectId,
      groupPath: groupRows.find((group) => group.id === current.groupId)?.path ?? '',
      urlName,
      entry: current.entry,
      catalog: current.entry === 'template' ? templateCatalog : undefined,
      connections: sourceConnections,
      own: run.state.resume,
    }
  }

  /**
   * Who already uses `urlName` (Step 1, on blur and on 次へ). One check at a
   * time: the same question joins the running check, a different one makes it
   * stale. Resolves undefined when stale (newer check, changed name, left Step 1).
   */
  const checkName = (urlName: string): Promise<NameAvailability | undefined> => {
    const key = `${form.state.values.groupId}/${form.state.values.entry}/${urlName}`
    const running = nameCheck.current
    if (running?.key === key) return running.result
    running?.controller.abort()
    const controller = new AbortController()
    patch({ checkingName: true })
    const result = checkNameAvailability(availabilityRequest(urlName), { api: createApi, signal: controller.signal })
      .then((answer) => {
        if (controller.signal.aborted || form.state.values.urlName !== urlName) return undefined
        // A name the create itself reported taken stays taken, whatever the check says.
        const reported = run.state.nameTaken?.reported === true && run.state.nameTaken.urlName === urlName
        if (!reported) patch({ nameTaken: answer.taken ? { urlName, suggestion: answer.suggestion } : undefined })
        return answer
      })
      .finally(() => {
        if (nameCheck.current?.controller !== controller) return
        nameCheck.current = undefined
        patch({ checkingName: false })
      })
    nameCheck.current = { key, controller, result }
    return result
  }

  const cancelNameCheck = () => {
    nameCheck.current?.controller.abort()
    nameCheck.current = undefined
    patch({ checkingName: false })
  }

  const next = async () => {
    // Leaving the step that owns a rejected field re-confirms its value.
    if (run.state.failure?.field?.step === step) patch({ failure: undefined })
    if (step === 0) {
      if (entryReady(values.entry)) patch({ step: 1 })
      return
    }
    if (step !== 1) {
      if (!(await validate(stepFields(step, values.entry)))) return
      if (step < 3) patch({ step: (step + 1) as Step })
      return
    }
    // Step 1 also asks whether the URL name is free; 次へ stays pending meanwhile.
    if (run.state.advancing) return
    patch({ advancing: true })
    try {
      if (!(await validate(stepFields(step, values.entry)))) return
      const urlName = form.state.values.urlName
      const known = run.state.nameTaken
      const answer = known?.reported && known.urlName === urlName ? undefined : await checkName(urlName)
      if (run.state.step !== 1) return
      if (!answer || answer.taken) {
        // A reported or taken name shows its fix; a stale check just waits for the next 次へ.
        if (run.state.nameTaken?.urlName === urlName) focusTakenName()
        return
      }
      patch({ step: 2 })
    } finally {
      patch({ advancing: false })
    }
  }

  const back = () => {
    if (step === 1) cancelNameCheck()
    patch({ failure: undefined, advancing: false, step: (step > 0 ? step - 1 : 0) as Step })
  }

  const details = {
    projectId,
    displayName: values.displayName.trim(),
    description: values.description.trim(),
    tags: values.tags,
    groupId: values.groupId,
    urlName: values.urlName,
    share,
  }

  /** Runs one create attempt; a failure keeps what was made for the retry. */
  const attempt = async (perform: () => Promise<void>) => {
    patch({ failure: undefined })
    try {
      await perform()
    } catch (error) {
      const failed = error instanceof CreateFailed ? error : new CreateFailed(error, run.state.resume, false)
      if (failed.nameTaken && !failed.forbidden) {
        // The name is the user's to change: back to it, with the Step 1 check's inline error.
        const urlName = form.state.values.urlName
        patch({ resume: failed.progress, step: 1, nameTaken: { urlName, reported: true } })
        focusTakenName()
        void suggestFreeUrlName(availabilityRequest(urlName), { api: createApi }).then((suggestion) => {
          const current = run.state.nameTaken
          if (!suggestion || !current?.reported || current.urlName !== urlName) return
          patch({ nameTaken: { ...current, suggestion } })
          focusTakenName()
        })
      } else if (failed.field && !failed.forbidden) {
        if (failed.field.path.startsWith('destination.')) form.setFieldValue('urlNameEdited', true)
        patch({ resume: failed.progress, failure: failed, step: failed.field.step })
      } else {
        patch({ resume: failed.progress, failure: failed })
      }
    } finally {
      patch({ phase: undefined })
    }
  }

  const finish = async (app: { id: string; group: { path: string }; slug: string }) => {
    completedRef.current = true
    setCompleted(true)
    clearCreateSession(app.id)
    await queryClient.invalidateQueries()
    await navigate({ href: paths.app(app.group.path, app.slug) })
  }

  const buildRequest = useRef<{ intent: string } | undefined>(undefined)
  const startBuild = async (intent: string) => {
    if (startingBuild || !aiGroupId || !entryReady('ai') || !intent.trim()) return
    buildRequest.current = { intent }
    setStartingBuild(true)
    setBuildError(undefined)
    try {
      const config = await queryClient.ensureQueryData(consoleConfigQuery)
      const session = await beginBuild(projectId, intent, { groupId: aiGroupId, ownerSubject: me.person.subject, newSessionEngine: newSessionEngine(config) })
      completedRef.current = true
      setCompleted(true)
      await navigate({ href: paths.build(session.id) })
    } catch (error) {
      setBuildError({ error })
    } finally {
      setStartingBuild(false)
    }
  }
  // The start's failure is shown under the whole form; bring it into view where the action was pressed.
  useEffect(() => {
    if (buildError) document.getElementById('build-start-failure')?.scrollIntoView?.({ block: 'nearest' })
  }, [buildError])
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!search.intent?.trim() || autoStarted.current || !entryReady('ai')) return
    autoStarted.current = true
    void startBuild(search.intent)
  }, [search.intent, catalogLoading, catalogFailed, tools.data, canCreate, aiGroupId])

  const createPath = (): CreatePath | undefined =>
    values.entry === 'template'
      ? { kind: 'template' }
      : values.entry === 'existing' && values.repository
        ? { kind: 'existing', repository: values.repository }
        : values.entry === 'image'
          ? { kind: 'image', imageRef: values.imageRef.trim() }
          : undefined

  // An unconfirmed step blocks every create until the readback below has run, also after a reload.
  const unconfirmed = run.state.resume.unconfirmed !== undefined

  const submitApp = () => {
    const path = createPath()
    if (!path || !catalog || !values.groupId || !domain || templateProblem || run.state.phase || run.state.resume.unconfirmed) return
    void attempt(async () => {
      const app = await submitCreate({ ...details, path }, run.state.resume, {
        api: createApi,
        catalog,
        domain,
        connections: sourceConnections,
        onPhase: (next) => patch({ phase: next }),
        onProgress: (resume) => patch({ resume }),
      })
      await finish(app)
    })
  }

  const [confirming, setConfirming] = useState(false)
  const [stillUnknown, setStillUnknown] = useState(false)
  /** 「最新の状態を確認する」: read back what the unconfirmed step may have made; never resends it. */
  const confirmLatest = async () => {
    const path = createPath()
    if (confirming || !path || !catalog) return
    setConfirming(true)
    setStillUnknown(false)
    try {
      const confirmed = await confirmCreate({ ...details, path }, run.state.resume, { api: createApi, catalog, connections: sourceConnections })
      patch({ resume: confirmed.progress, failure: undefined })
      if (confirmed.app) await finish(confirmed.app)
    } catch {
      setStillUnknown(true)
    } finally {
      setConfirming(false)
    }
  }

  const busy = phase !== undefined || startingBuild
  const retrying = failure !== undefined && !failure.forbidden
  const blockedSubmit = !canCreate || busy || failure?.forbidden === true || unconfirmed
  const primary =
    step === 0
      ? { label: copy.create.next, disabled: !entryReady(values.entry) }
      : step < 3
        ? { label: copy.create.next, disabled: false }
        : { label: search.resume ? copy.create.confirm.resume : retrying ? copy.create.confirm.retry : copy.create.confirm.submit, disabled: !entryReady(values.entry) || !catalog || !domain || blockedSubmit }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (primary.disabled || busy) return
    if (step < 3) void next()
    else submitApp()
  }

  const staleCatalog = catalogStale
    ? <StaleCatalogNotice readAt={catalogReadAt} retrying={catalogQueries.some((query) => query.isFetching)} onRetry={retryCatalog} />
    : null
  const stepLabels = copy.create.steps
  const detailsTitle = values.entry === 'existing' ? copy.create.existing.title : copy.create.details.title
  const stepTitle = [copy.create.start.title, detailsTitle, copy.create.share.title, copy.create.confirm.title][step]

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={copy.create.title} lead={copy.create.stepLabel(step + 1, stepLabels.length)} />
      <div className="mt-6">
        <Stepper step={step} labels={stepLabels} />
      </div>
      {!canCreate ? (
        <div className="mt-6">
          <Notice tone="error">{copy.create.forbidden}</Notice>
        </div>
      ) : null}

      <Card className="mt-6">
        <CardBody className="px-5 py-6 sm:px-8 sm:py-8">
          <form ref={formRef} onSubmit={onSubmit} noValidate aria-labelledby="create-step-title">
            <h2 id="create-step-title" tabIndex={-1} className="mb-6 text-lg font-semibold text-stone-900 focus:outline-none">
              {stepTitle}
            </h2>

            {failure?.field && failure.field.step === step ? (
              <div id="create-field-error" tabIndex={-1} className="mb-6 scroll-mt-36 focus:outline-none">
                <FieldFailureNotice failure={failure} onFix={() => {
                  const field = failure.field!
                  if (field.path.startsWith('existing.')) form.setFieldValue('repository', undefined)
                  if (field.path.startsWith('destination.')) form.setFieldValue('urlNameEdited', true)
                  patch({ step: field.step })
                  requestAnimationFrame(() => {
                    const id = field.step === 0 ? 'create-step-title' : field.path.startsWith('existing.') ? 'create-repository' : 'create-url'
                    document.getElementById(id)?.focus()
                  })
                }} />
              </div>
            ) : null}

            {step === 0 ? (
              <StartStep
                form={form}
                disabled={!canCreate || startingBuild}
                loading={catalogLoading}
                catalogFailed={catalogFailed}
                onRetryCatalog={retryCatalog}
                stale={staleCatalog}
                blocked={blocked}
                setupLink={setupLink}
                catalog={templateRows}
                codexAvailable={tools.data?.codexAvailable === true}
                codexUnavailableReason={tools.data?.codexUnavailableReason}
                codexPolicy={tools.data?.codexPolicy}
                onBuild={() => void startBuild(values.intent)}
                onCustomize={(template) => void startBuild(template.seed)}
                startingBuild={startingBuild}
                onTemplate={chooseTemplate}
                onExisting={() => { onEntryChange('existing'); patch({ step: 1 }) }}
                onUseImage={() => void chooseImage()}
              />
            ) : step === 1 ? (
              <DetailsStep
                form={form}
                projectId={projectId}
                sourceConnectionId={environment.source?.id}
                groups={flatGroups}
                domain={domain}
                nameTaken={nameTaken}
                checkingName={checkingName === true}
                onUrlNameSettled={() => {
                  const urlName = form.state.values.urlName
                  if (isValidAppName(urlName)) void checkName(urlName)
                }}
              />
            ) : step === 2 ? (
              <ShareStep form={form} groups={flatGroups} isConsoleAdmin={me.isConsoleAdmin} shareText={shareText} />
            ) : step === 3 ? (
              <div className="space-y-6">
                {staleCatalog}
                <ConfirmStep
                  form={form}
                  url={url}
                  groupName={ownerGroup?.name ?? ''}
                  shareText={shareText}
                  templateName={templateCatalog ? businessTemplateById(templateCatalog.template.id)?.name ?? templateCatalog.template.displayName : undefined}
                  sourceProblem={templateProblem}
                  onChooseTemplate={() => patch({ step: 0 })}
                />
                {phase !== undefined && values.entry ? (
                  <CreatingPanel entry={values.entry} phase={phase} />
                ) : null}
              </div>
            ) : (
              <Notice tone="error">{copy.common.loadFailed}</Notice>
            )}

            {unconfirmed ? (
              <div id="create-failure" tabIndex={-1} className="mt-6 focus:outline-none">
                <UnconfirmedCreateNotice confirming={confirming} stillUnknown={stillUnknown} disabled={!catalog || !createPath()} onConfirm={() => void confirmLatest()} />
              </div>
            ) : failure && !failure.field ? (
              <div id="create-failure" tabIndex={-1} className="mt-6 focus:outline-none">
                <FailureNotice failure={failure} />
              </div>
            ) : null}

            <div className="mt-8 flex flex-col-reverse gap-3 border-t border-stone-100 pt-5 sm:flex-row sm:items-center">
              {step > 0 ? (
                <Button type="button" tone="secondary" onClick={back} disabled={busy}>
                  {copy.create.back}
                </Button>
              ) : null}
              <div className="flex flex-col-reverse gap-3 sm:ml-auto sm:flex-row sm:items-center">
                <Button type="submit" tone="primary" loading={busy || advancing === true} disabled={primary.disabled}>
                  {primary.label}
                </Button>
              </div>
            </div>
          </form>
        </CardBody>
      </Card>
      {buildError ? <div id="build-start-failure" className="mt-4"><BuildStartFailure error={buildError.error} busy={startingBuild} onRetry={() => { const request = buildRequest.current; if (request) void startBuild(request.intent) }} /></div> : null}
    </div>
  )
}
