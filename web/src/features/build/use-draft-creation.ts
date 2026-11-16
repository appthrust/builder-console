// What happens to a Platform application draft after its plan exists, shared by
// both build engines (APT-753): the default publish address on the plan, the
// creation execution (validate → begin → run, resumed after a reload), binding
// the created app into the console, the publish repair, the implementation run
// and 「公開済み」. Engine-neutral: the conversation that produced the plan (the
// legacy Platform turns or the console-v1 session) is the host's; the host
// supplies the tab state, the write lock and how a failure is reported.
//
// Extracted unchanged from the legacy `useBuildSession` (features/build/use-build-session.ts):
// `useDraftCreation` is its app/preparation/implementation read model, `useDraftCreationEffects`
// its creation effects, in their original relative order.
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { isResponseContractError } from '../../api/boundary'
import * as api from '../../api/build'
import { isConsoleError } from '../../api/console'
import { buildDraftOptions } from '../../api/queries/build'
import { createApi } from '../../api/create'
import { createConnectionsQuery, repositoryDestinationQuery, useSourceRepositories } from '../../api/queries/catalog'
import { appQuery, writeAppCache } from '../../api/queries/console'
import { destinationRejection, platformErrorEnvelope } from '../../api/platform-error'
import { isPublishPreparationPending, publishPreparationRetryDelay } from '../../api/publish-retry'
import { classifyBuildFailure, destinationFailure, destinationSentence, planRejectionFailure, unconfirmedFailure } from '../../model/build/failure'
import type { ShownDestination } from '../../model/build/messages'
import { newRepositoryRequest, renameCreationPlan, withDefaultPublish, withDestinationRevision } from '../../model/build/plan'
import { appPreparationProgress, sourceBuildFailureProgress } from '../../model/build/progress'
import { draftPublished } from '../../model/build/stage'
import type { BuildFailure } from '../../model/build/types'
import { isOneOf, knownValue, type BuildDraft, type BuildExecutionStep, type CreationPlanValidation } from '../../model/contracts/build'
import type { RepositoryDestination } from '../../model/contracts/catalog'
import { pickCreateEnvironment, summarizeCreationPlan } from '../../model/create'
import { sourceRepositoryFor } from '../app/platform'
import { deriveAppView } from '../../model/app'
import { useAppViews } from '../app/use-app-views'
import { bindCreatedConsoleApp, ConsoleAppCreationError } from './bind-created-console-app'
import { text } from './copy'
import { implemented, useImplementation } from './implement'

export type CreationContext = 'plan' | 'prepare' | 'implement' | 'publish'

/**
 * Writes a write's answer into the draft cache. Draft reads still in flight (polls and `readDraft`, which all
 * run as the draft query) are cancelled first: they started before this answer arrived, so landing afterwards
 * they would bring back the draft as it was before the write, which then looks undone and is sent again (a
 * second …/run, a hidden preparation turn answered 409).
 */
export async function writeDraft(queryClient: QueryClient, projectId: string, draftRef: MutableRefObject<BuildDraft>, next: BuildDraft): Promise<void> {
  const { queryKey } = buildDraftOptions(projectId, next.id)
  await queryClient.cancelQueries({ queryKey, exact: true })
  draftRef.current = next
  queryClient.setQueryData(queryKey, next)
}

/**
 * A draft write's failure in the product's words. An answer this console cannot read is `unconfirmed`: it may
 * have happened, so the caller reads the draft back and offers only that re-read.
 */
export function draftFailure(error: unknown, context: 'turn' | CreationContext, reference: { draftId: string; at: string; executionId?: string }, failedStep?: BuildExecutionStep): BuildFailure {
  if (isResponseContractError(error)) return unconfirmedFailure(reference)
  if (error instanceof PlanDestinationError) return destinationFailure(error.rejection, reference)
  if (error instanceof PlanValidationError) return planRejectionFailure(error.lines, reference)
  const rejection = destinationRejection(error)
  if (rejection) return destinationFailure(rejection, reference)
  const envelope = platformErrorEnvelope(error)
  const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : envelope?.status
  const raw = envelope?.message ?? (error instanceof Error ? error.message : String(error))
  const operation = error instanceof ConsoleAppCreationError ? 'apps.create' as const : typeof error === 'object' && error !== null && failedValidationRequests.has(error) ? 'plan.validate' as const : undefined
  return classifyBuildFailure(failedStep?.message ?? raw, status, context, reference, failedStep?.detail?.reason ?? (isConsoleError(error) ? error.code : envelope?.code), operation, undefined, envelope?.details)
}

/** The approval stopped at the repository destination before anything was sent to create. */
export class PlanDestinationError extends Error {
  constructor(readonly rejection: 'changed' | 'blocked') {
    super(`repository destination ${rejection}`)
    this.name = 'PlanDestinationError'
  }
}

/**
 * Platform's validation answered that the stored plan cannot be approved (`valid: false`, or no fingerprint): an
 * answer about the plan, not a failed request. `lines` are its own sentences in order (verdict, plan check, sections).
 * Thrown only for that answer: it alone marks the plan rejected (`CreationTab.rejectedPlan`). A stop of a plan the
 * validation accepted (a gate that is not ready, say) is another error and is never remembered as a rejection.
 */
export class PlanValidationError extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join('\n'))
    this.name = 'PlanValidationError'
  }
}

/** Plan validation requests that failed (no answer about the plan): `draftFailure` reports them as the validation's failure. */
const failedValidationRequests = new WeakSet<object>()

/**
 * Before the plan is validated and approved, its new repository is bound to the destination the user approved: the
 * revision the proposal showed when 「この内容で作る」 was pressed (`approvedRevision`). Platform's answer now must be
 * that very revision, and the plan must carry it (Platform rejects an approval without a revision, and a create whose
 * revision is no longer current). Not resolved: nothing is approved. Any other revision (the destination moved after
 * it was shown, or the plan was made against another one): the approval stops, the plan is bound to the current
 * revision, and the proposal shows the current destination for the user to approve again; nothing is sent for them.
 * `stop` withdraws the approval before either stop is reported. A plan without a new repository (adoption, reuse) is not bound.
 * `rejected`: Platform's validation said the stored plan has no current destination. Only a plan bound to another
 * revision is bound again (and stops as `changed`); one that already carries the current revision returns unchanged,
 * because binding it again would change nothing: the caller then treats it as a plan to make again.
 */
export async function bindPlanDestination(
  projectId: string,
  draft: BuildDraft,
  approvedRevision: string | undefined,
  deps: { readDestination: () => Promise<RepositoryDestination>; updateDraft: typeof api.updateDraft; receive: (next: BuildDraft) => Promise<void>; stop: () => void },
  rejected = false,
): Promise<void> {
  const plan = draft.creationPlan
  const request = newRepositoryRequest(plan)
  if (!plan || !request) return
  const destination = await deps.readDestination()
  if (destination.kind !== 'resolved') {
    deps.stop()
    throw new PlanDestinationError('blocked')
  }
  const bound = request.destinationRevision === destination.revision
  if (rejected ? bound : approvedRevision === destination.revision && bound) return
  deps.stop()
  if (!bound) {
    await deps.receive(await deps.updateDraft(projectId, draft.id, { creationPlan: withDestinationRevision(plan, destination.revision) }))
  }
  throw new PlanDestinationError('changed')
}

/** Only the stale validation conflict gets one fresh validation; no cleanup or execution is retried here. */
export async function validatePreparationPlan(projectId: string, draftId: string, validatePlan: (projectId: string, draftId: string) => Promise<CreationPlanValidation> = api.validatePlan): Promise<string> {
  let validation: CreationPlanValidation
  try {
    validation = await validatePlan(projectId, draftId)
  } catch (error) {
    const envelope = platformErrorEnvelope(error)
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : envelope?.status
    const message = envelope?.message ?? (error instanceof Error ? error.message : String(error))
    if (status !== 409 || !/changed while validating the creation plan/i.test(message)) throw error
    validation = await validatePlan(projectId, draftId)
  }
  if (!validation.valid || !validation.creationPlanFingerprint) {
    const stack = validation.applicationStackValidation
    const diagnostics = [stack?.source, stack?.runtime, stack?.publish].filter((section) => section && !section.valid).map((section) => section!.message)
    throw new PlanValidationError([validation.message, ...(validation.staticErrors ?? []), ...diagnostics].filter(Boolean))
  }
  return validation.creationPlanFingerprint
}

/** The succeeded plan generation the draft's plan came from (`''` when none is recorded). */
function planGenerationOf(draft: BuildDraft): string {
  return [...draft.creationPlanGenerations].reverse().find((generation) => isOneOf(generation.status, 'succeeded'))?.id ?? ''
}

/** Platform's validation rejected the plan the draft holds now: nothing approves it again as it is (only `recheck`, when allowed). */
export function isPlanRejected(draft: BuildDraft, tab: Pick<CreationTab, 'rejectedPlan'>): boolean {
  return Boolean(draft.creationPlan) && tab.rejectedPlan !== undefined && tab.rejectedPlan.generationId === planGenerationOf(draft)
}

/** What the creation keeps in this tab; the legacy `BuildSession` carries these fields under the same names. */
export interface CreationTab {
  groupId: string
  createdAppId?: string
  continuedAfterPublishAt?: string
  prepareRequested: boolean
  reusePlan: boolean
  executionRequestId?: string
  /** The template release observed before any implementation task is pushed. */
  initialReleaseId?: string
  /** The destination revision the proposal showed when the user approved it; the approval binds only that one. */
  approvedDestinationRevision?: string
  /**
   * The plan generation whose plan Platform's validation answered `valid: false` (set from that answer only). While
   * the draft holds that plan nothing approves it again; a new plan (another generation) clears it by itself.
   * `recheck`: the cause may lie outside the plan (a reason this console does not know, or a destination Platform calls
   * unusable), so the user may have the same plan validated once more (「もう一度確かめる」, one validation per click).
   */
  rejectedPlan?: { generationId: string; recheck: boolean }
}

export interface DraftCreationInput {
  projectId: string
  /** The draft as last written or read (the cache entry first). */
  draft: BuildDraft
  tab: CreationTab
  /** A message still waits to be sent: a published draft is not shown as published meanwhile. */
  hasPending: boolean
  now: number
}

export type DraftCreation = ReturnType<typeof useDraftCreation>

/** The created app, its preparation progress, the plan with its default publish address, and the implementation run. */
export function useDraftCreation({ projectId, draft, tab, hasPending, now }: DraftCreationInput) {
  const appResult = useQuery({ ...appQuery(tab.createdAppId ?? ''), enabled: Boolean(tab.createdAppId) })
  const app = appResult.data
  const appViews = useAppViews(projectId)
  const repositories = useSourceRepositories(projectId)
  const appView = app ? appViews.viewFor(app) : undefined
  const sourceRepository = appView?.stack
    ? sourceRepositoryFor(appView, repositories.data?.data)
    : repositories.data?.data.find((repository) => repository.id === draft.createdSourceRepositoryId)
  const preparationInput = appView?.stack ? { view: appView, sourceRepository, shareSentence: '' } : undefined
  const preparationClock = useRef<{ activity?: string; since: string }>({ since: new Date(now).toISOString() })
  const nextPreparation = preparationInput ? appPreparationProgress(preparationInput, now) : undefined
  if (nextPreparation?.currentActivity !== preparationClock.current.activity) preparationClock.current = { activity: nextPreparation?.currentActivity, since: new Date(now).toISOString() }
  // Before the console app is bound, the created stack's own platform state decides whether a release already runs.
  const stackPlatform = !preparationInput && draft.createdApplicationStackId
    ? deriveAppView({ stackId: draft.createdApplicationStackId, createdAt: draft.createdAt }, appViews.input, now).platform
    : undefined
  const appProgress = preparationInput ? appPreparationProgress(preparationInput, now, preparationClock.current.since) : sourceBuildFailureProgress(sourceRepository?.build, stackPlatform)
  const generation = draft.creationPlanGenerations.at(-1)
  const execution = draft.creationExecutions.at(-1)
  const needsPublishDefault = Boolean(draft.creationPlan?.applicationStackRequest && !draft.creationPlan.applicationStackRequest.publish?.enabled)
  const connections = useQuery({ ...createConnectionsQuery(projectId), enabled: needsPublishDefault || (isOneOf(draft.phase, 'created') && !appView?.platform?.publish) })
  const domain = connections.data ? pickCreateEnvironment(connections.data.sources, connections.data.registries, connections.data.domains).domain : undefined
  const creationPlan = draft.creationPlan ? withDefaultPublish(draft.creationPlan, { domain }) : undefined
  const defaultPending = !execution && (creationPlan !== draft.creationPlan || (needsPublishDefault && connections.isPending))
  const proposalDraft = creationPlan === draft.creationPlan ? draft : { ...draft, creationPlan }
  const published = draftPublished(draft) && tab.continuedAfterPublishAt !== draft.publishedAt && !hasPending
  const implementation = useImplementation({ projectId, draft, handoff: execution?.approval?.implementationHandoff ?? draft.creationPlan?.implementationHandoff, enabled: Boolean(draft.createdApplicationStackId) && !published })
  const implementing = implementation.pending || implementation.state.phase === 'starting-workspace' || implementation.state.phase === 'running' || implementation.state.phase === 'pushing'
  // Where the plan's new repository goes, shown on the proposal before 「この内容で作る」. Nothing is approved before a first
  // read has shown it (pending or failed). A later re-read that fails keeps the destination already shown, and approval
  // stays offered for it: the control is `bindPlanDestination`, which reads Platform's current one fresh at approval and
  // goes on only when it is the revision shown.
  const needsDestination = Boolean(newRepositoryRequest(draft.creationPlan)) && !execution
  const destinationRead = useQuery({ ...repositoryDestinationQuery(projectId), enabled: needsDestination })
  const destination: ShownDestination | undefined = !needsDestination ? undefined
    : destinationRead.data ?? (destinationRead.isError ? { kind: 'failed' } : { kind: 'loading' })
  const retryDestination = () => { void destinationRead.refetch() }
  const planRejected = isPlanRejected(draft, tab)
  /** The rejected plan may be validated once more on the user's 「もう一度確かめる」. */
  const planRecheck = !draft.creationPlanUnreadable && planRejected && Boolean(tab.rejectedPlan?.recheck)
  return { app, appViews, appView, sourceRepository, appProgress, generation, execution, domain, creationPlan, defaultPending, proposalDraft, published, implementation, implementing, destination, retryDestination, planRejected, planRecheck }
}

export interface DraftCreationHost {
  projectId: string
  /** The group a new console app belongs to when the tab has none recorded. */
  groupId: string
  draft: BuildDraft
  /** The draft as of the latest write (updated by `receive`). */
  draftRef: MutableRefObject<BuildDraft>
  tab: CreationTab
  /** The tab state now (writes made since this render included). */
  currentTab(): CreationTab
  patch(next: Partial<CreationTab>): void
  receive(next: BuildDraft): Promise<void>
  perform(context: CreationContext, action: () => Promise<void>): Promise<void>
  fail(error: unknown, context: CreationContext, at?: string, failedStep?: BuildExecutionStep): void
  clearFailure(): void
  busy: boolean
  lock: MutableRefObject<boolean>
  failure?: BuildFailure
  /** A job of the draft is pending (the host's conversation jobs included). */
  running: boolean
  /** The draft's phase or a job state is unknown to this console: nothing starts on its own. */
  unsupported: boolean
  /** The host has to do something before the preparation may start (send a reply, make the plan first, report a failure). */
  holdPreparation: boolean
  /** The conversation has outgrown the plan on the draft (legacy `needsPlanRefresh`): a rejected plan is not checked again. */
  planOutgrown: boolean
  /** Failed jobs already reported; shared with the host's own failure observation. */
  observedFailures: MutableRefObject<Set<string>>
  /** The created console app's display name. */
  displayName: string
  /** Its one-line description. */
  description: string
  /** 「もう一度確かめる」 answered valid: the host says the plan is accepted and may be created with 「この内容で作る」. */
  planAccepted(): void
}

/**
 * The creation's effects, in the order the legacy hook ran them: default publish address, preparation
 * (validate → begin → run), resume of a begun execution, report of a failed execution, binding the created
 * app, the publish repair, the template release, and the implementation start.
 */
export function useDraftCreationEffects(creation: DraftCreation, host: DraftCreationHost) {
  const queryClient = useQueryClient()
  const { projectId, draft, tab, busy, lock, failure, running } = host
  const { app, appView, appViews, generation, execution, domain, creationPlan, defaultPending, implementation, published } = creation
  const canStartCreation = Boolean(draft.creationPlan) && !draft.creationPlanUnreadable
  const canFollowCreation = Boolean(execution || draft.createdApplicationId || draft.createdApplicationStackId)
  const [publishRetryAt, setPublishRetryAt] = useState(0)
  const publishRetries = useRef(0)

  useEffect(() => {
    // Old tab approval never authorizes a later unreadable plan (or a replacement made by re-planning).
    if (draft.creationPlanUnreadable && tab.prepareRequested) host.patch({ prepareRequested: false, approvedDestinationRevision: undefined })
  }, [draft.creationPlanUnreadable, tab.prepareRequested])
  const publishRepairAppId = useRef<string | undefined>(undefined)
  const bindingFailed = useRef(false)

  useEffect(() => {
    const release = appView?.platform?.lastRelease
    const history = appViews.input.releasesByApplication[draft.createdApplicationId ?? '']?.components.find((component) => component.id === appView?.platform?.webComponentId)?.releases
    if (!tab.initialReleaseId && history?.length === 1 && release && isOneOf(release.phase, 'Succeeded') && !implemented(implementation.state)) host.patch({ initialReleaseId: release.id })
  })

  useEffect(() => {
    if (!publishRetryAt) return
    const timer = window.setTimeout(() => setPublishRetryAt(0), Math.max(0, publishRetryAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [publishRetryAt])

  useEffect(() => {
    if (!canStartCreation) return
    // Plan replacement is forbidden after an execution exists.
    if (execution || !isOneOf(generation?.status, 'succeeded') || !creationPlan || creationPlan === draft.creationPlan || running || busy || lock.current || failure) return
    void host.perform('plan', async () => {
      const current = host.draftRef.current
      if (current.creationExecutions.length || !current.creationPlan) return
      const plan = withDefaultPublish(current.creationPlan, { domain })
      if (plan !== current.creationPlan) await host.receive(await api.updateDraft(projectId, draft.id, { creationPlan: plan }))
    })
  }, [draft.creationPlan, knownValue(generation?.status), execution, domain, running, busy, failure])

  /**
   * The plan's check before anything is created: bind the approved destination, then validate; answers Platform's
   * fingerprint. A plan written to another destination revision is no longer the plan Platform rejected (its approval
   * stops for the user, #30); `valid: false` (re)marks a rejection; a failed request changes nothing in the tab.
   */
  async function checkPlan(): Promise<string> {
    // Plan replacement is forbidden once an execution exists; a fresh approval binds the shown destination first.
    const destinationDeps = {
      readDestination: () => queryClient.fetchQuery({ ...repositoryDestinationQuery(projectId), staleTime: 0 }),
      updateDraft: api.updateDraft,
      receive: async (next: BuildDraft) => {
        host.patch({ rejectedPlan: undefined })
        await host.receive(next)
      },
      stop: () => host.patch({ prepareRequested: false, approvedDestinationRevision: undefined }),
    }
    if (!host.draftRef.current.creationExecutions.length) {
      await bindPlanDestination(projectId, host.draftRef.current, host.currentTab().approvedDestinationRevision, destinationDeps)
    }
    try {
      return await validatePreparationPlan(projectId, draft.id)
    } catch (error) {
      if (!(error instanceof PlanValidationError)) {
        if (typeof error === 'object' && error !== null) failedValidationRequests.add(error)
        throw error
      }
      // Platform answered that this plan cannot be approved: it is never validated or begun again unchanged, except
      // on the user's 「もう一度確かめる」 where the cause may lie outside the plan. A destination that is not set stops
      // as such; a plan bound to a revision that is no longer current is bound to the current one for the user to
      // approve again (#30's stop). Nothing validates the answered plan again by itself (a reload included). A plan that
      // already carries the current revision, or must change otherwise (not a name another app holds: renaming fixes
      // that one), is remembered as rejected.
      const destination = error.lines.map(destinationSentence).find(Boolean)
      if ((destination === 'changed' || destination === 'blocked') && !host.draftRef.current.creationExecutions.length) {
        await bindPlanDestination(projectId, host.draftRef.current, undefined, destinationDeps, true)
      }
      const rejection = planRejectionFailure(error.lines)
      const remembered = rejection.kind === 'plan' || rejection.recheck
      host.patch({ prepareRequested: false, approvedDestinationRevision: undefined, ...(remembered ? { rejectedPlan: { generationId: planGenerationOf(host.draftRef.current), recheck: Boolean(rejection.recheck) } } : {}) })
      throw error
    }
  }

  /** The preparation an approval asks for: the plan's check, then begin and run. */
  async function preparation() {
    if (host.draftRef.current.creationPlanUnreadable || !host.draftRef.current.creationPlan) return
    const creationPlanFingerprint = await checkPlan()
    const clientRequestId = host.currentTab().executionRequestId ?? crypto.randomUUID()
    host.patch({ executionRequestId: clientRequestId })
    const begun = await api.createExecution(projectId, draft.id, { clientRequestId, creationPlanFingerprint })
    await host.receive(begun)
    const created = begun.creationExecutions.at(-1)
    if (!created) throw new Error(text.session.missingExecution)
    host.patch({ prepareRequested: false })
    await host.receive(await api.runExecution(projectId, draft.id, created.id))
  }

  useEffect(() => {
    if (!canStartCreation) return
    // A phase or job state this console does not know starts nothing on its own (stage.ts `unsupported`).
    if (running || busy || lock.current || failure || draft.createdApplicationStackId || host.unsupported || host.holdPreparation) return
    if (isOneOf(execution?.status, 'failed') && !host.observedFailures.current.has(execution!.id)) return
    // A rejected plan is never prepared: only `recheck` checks it, from its click, and creates nothing.
    if (!tab.prepareRequested || defaultPending || creation.planRejected) return
    void host.perform('prepare', preparation)
  }, [draft, tab.prepareRequested, host.holdPreparation, running, busy, failure, defaultPending])

  useEffect(() => {
    if (!canFollowCreation) return
    // A reload between begin and run resumes the existing execution, never begins a second one.
    if (!execution || !isOneOf(execution.status, 'running') || execution.runStartedAt || busy || lock.current || failure) return
    void host.perform('prepare', async () => { await host.receive(await api.runExecution(projectId, draft.id, execution.id)) })
  }, [execution, busy, failure])

  useEffect(() => {
    if (!canFollowCreation) return
    if (!execution || !isOneOf(execution.status, 'failed') || host.observedFailures.current.has(execution.id)) return
    host.observedFailures.current.add(execution.id)
    host.fail(new Error(execution.error ?? text.session.operationFailed), 'prepare', execution.finishedAt, execution.steps.find((step) => isOneOf(step.status, 'failed')))
  }, [execution])

  useEffect(() => {
    if (!canFollowCreation) return
    if (!draft.createdApplicationStackId || (!isOneOf(draft.phase, 'created') && !isOneOf(execution?.status, 'succeeded')) || app?.stackId || busy || lock.current || bindingFailed.current) return
    const appName = appViews.input.applications.find((application) => application.id === draft.createdApplicationId)?.name
      ?? (draft.creationPlan ? summarizeCreationPlan(draft.creationPlan).appName : undefined)
    if (!appName) return
    void host.perform('prepare', async () => {
      try {
        // A previously selected department stays fixed; repair only old empty sessions.
        if (!host.currentTab().groupId) host.patch({ groupId: host.groupId })
        const kept = await bindCreatedConsoleApp(
          { projectId, displayName: host.displayName, description: host.description, tags: [], groupId: host.currentTab().groupId, urlName: appName, share: { scope: 'private', groupIds: [], extraPersonIds: [] } },
          { stackId: draft.createdApplicationStackId!, createdAppId: host.currentTab().createdAppId },
          { api: createApi, onCreatedAppId: (createdAppId) => host.patch({ createdAppId }) },
        )
        host.patch({ createdAppId: kept.id, prepareRequested: false })
        // The decoded bind answer is the app; a read that started before the bind must not overwrite it.
        await writeAppCache(queryClient, kept)
        await queryClient.invalidateQueries({ queryKey: ['console', 'apps'] })
      } catch (error) { bindingFailed.current = true; throw error }
    })
  }, [draft.createdApplicationStackId, knownValue(draft.phase), knownValue(execution?.status), app?.stackId, busy, host.groupId, appViews.input.applications])

  useEffect(() => {
    if (!canFollowCreation || appView?.unreadableStack || appView?.unreadableBuild) return
    const platform = appView?.platform
    if (!isOneOf(draft.phase, 'created') || appViews.loading || appViews.failed || !platform?.id || !platform.branchId || !platform.webComponentId || !domain || busy || lock.current || failure) return
    const hasPublish = appViews.input.publishes.some((publish) => publish.applicationId === platform.id && publish.branchId === platform.branchId && publish.componentId === platform.webComponentId)
      || (platform.publish?.applicationId === platform.id && platform.publish.branchId === platform.branchId && platform.publish.componentId === platform.webComponentId)
    if (hasPublish) {
      publishRetries.current = 0
      setPublishRetryAt(0)
      return
    }
    if (publishRepairAppId.current === platform.id || publishRetryAt) return
    void host.perform('prepare', async () => {
      // Reserve only in this mounted page. A rejected or interrupted request must
      // remain repairable on the next visit, with the same idempotency key.
      publishRepairAppId.current = platform.id
      try {
        await api.createPublish(projectId, {
          applicationId: platform.id, branchId: platform.branchId, componentId: platform.webComponentId!,
          destination: { type: 'gateway' }, customDomain: domain, hostnamePattern: 'wildcard', subdomain: platform.name,
          idempotencyKey: `build-publish-${draft.id}-${platform.id}`,
        })
      } catch (error) {
        if (!isPublishPreparationPending(error)) {
          publishRetries.current = 0
          throw error
        }
        publishRepairAppId.current = undefined
        setPublishRetryAt(Date.now() + publishPreparationRetryDelay(publishRetries.current++))
        return
      }
      publishRetries.current = 0
      appViews.refetch()
    })
  }, [knownValue(draft.phase), appView?.platform, appViews.loading, appViews.failed, domain, busy, failure, publishRetryAt])

  useEffect(() => {
    if (canFollowCreation && draft.createdApplicationStackId && implementation.state.phase === 'idle' && !published) implementation.start()
  }, [draft.createdApplicationStackId, implementation.state.phase, published])

  async function markPublished() {
    if (!canFollowCreation) return
    await host.perform('publish', async () => {
      await host.receive(await api.updateDraft(projectId, draft.id, { markPublished: true }))
      host.patch({ continuedAfterPublishAt: undefined })
      host.clearFailure()
    })
  }

  /**
   * 「この内容で作る」: approve what the proposal shows. A plan that makes a new repository is approved only with its
   * destination on screen, bound to the revision shown; while no destination has been shown (first read pending or
   * failed) or it is not set, it is read again instead and nothing is approved. A destination still on screen after a
   * failed re-read is approvable: the preparation reads Platform's current one fresh and stops unless it is that revision.
   */
  function approve() {
    if (!canStartCreation) return
    host.clearFailure()
    const shown = creation.destination
    if (shown && shown.kind !== 'resolved') {
      creation.retryDestination()
      return
    }
    bindingFailed.current = false
    host.patch({ prepareRequested: true, approvedDestinationRevision: shown?.revision })
  }
  /** Whether 「もう一度確かめる」 can run now: the one predicate for the action and for its buttons. */
  function recheckReady(): boolean {
    return canStartCreation && creation.planRecheck && !host.planOutgrown && !running && !busy && !lock.current && !draft.createdApplicationStackId && !host.unsupported && !host.holdPreparation && !defaultPending
  }
  /**
   * 「もう一度確かめる」: the plan Platform's validation rejected for a cause that may lie outside it is checked once, from
   * this click: one validation of the unchanged plan, after the destination check of any approval (a destination that
   * moved is bound to the current revision with one PATCH, and the approval stops for the user, #30). Never while the
   * conversation has outgrown the plan. The rejection stands until a valid answer: then the plan is approvable again
   * and nothing is created until 「この内容で作る」; `valid: false` leaves it rejected; a failed request (or a failed
   * destination read) leaves it rejected, nothing requested, and this action offered again.
   */
  function recheck() {
    if (!recheckReady()) return
    host.clearFailure()
    const shown = creation.destination
    if (shown && shown.kind !== 'resolved') {
      creation.retryDestination()
      return
    }
    bindingFailed.current = false
    host.patch({ approvedDestinationRevision: shown?.revision })
    void host.perform('prepare', async () => {
      await checkPlan()
      host.patch({ rejectedPlan: undefined, approvedDestinationRevision: undefined })
      host.planAccepted()
    })
  }
  /** A rejected plan is never approved as it is; a stop on the way of a check (the destination not set) is checked again. */
  function prepare() {
    if (creation.planRecheck) recheck()
    else if (!creation.planRejected) approve()
  }

  return {
    waitingForPublish: publishRetries.current >= 4,
    markPublished,
    prepare,
    recheck,
    /** 「もう一度確かめる」 would run now (its buttons are disabled otherwise). */
    canRecheck: recheckReady(),
    /**
     * The name collision's recovery (NameChoice), then the preparation again with the new name. A URL taken by
     * another app renames the application on the stored plan (never a schema-defaulted client copy, no cleanup);
     * a repository/package name collision cleans the failed creation up and renames the plan. `onRenamed` lets
     * the host drop what it showed about the collision.
     */
    rename(name: string, failure: BuildFailure | undefined, onRenamed: (updated: BuildDraft) => void) {
      if (!canStartCreation || !draft.creationPlan) return
      void host.perform('prepare', async () => {
        const publishConflict = failure?.reasonCode === 'PublishURLConflict'
        if (!publishConflict) await api.cleanupCreation(projectId, draft.id)
        const updated = await api.updateDraft(projectId, draft.id, publishConflict
          ? { renameApplication: { name } }
          : { creationPlan: renameCreationPlan(draft.creationPlan!, name, { domain }) })
        await host.receive(updated)
        // The renamed plan is not the plan Platform may have rejected: it is approved as the user chose its name.
        host.patch({ reusePlan: true, executionRequestId: undefined, rejectedPlan: undefined })
        onRenamed(updated)
        approve()
      })
    },
    /** A retry may bind again after a failed binding. */
    resetBinding: () => { bindingFailed.current = false },
    /** The creation's retries: 公開済み again, the implementation run, or a clean preparation after a failed one. */
    retry(context: 'publish' | 'implement' | 'prepare') {
      if (context === 'publish') void markPublished()
      else if (context === 'implement') implementation.retry()
      // A clean preparation never validates a rejected plan: a retry offered before the rejection does nothing now.
      else if (canStartCreation && !draft.createdApplicationStackId && !creation.planRejected) {
        void host.perform('prepare', async () => {
          await host.receive(await api.cleanupCreation(projectId, draft.id))
          host.patch({ prepareRequested: true, reusePlan: true, executionRequestId: undefined })
        })
      }
    },
  }
}
