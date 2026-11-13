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
import { createConnectionsQuery, useSourceRepositories } from '../../api/queries/catalog'
import { appQuery, writeAppCache } from '../../api/queries/console'
import { platformErrorEnvelope } from '../../api/platform-error'
import { isPublishPreparationPending, publishPreparationRetryDelay } from '../../api/publish-retry'
import { classifyBuildFailure, unconfirmedFailure } from '../../model/build/failure'
import { withDefaultPublish } from '../../model/build/plan'
import { appPreparationProgress, sourceBuildFailureProgress } from '../../model/build/progress'
import { draftPublished } from '../../model/build/stage'
import type { BuildFailure } from '../../model/build/types'
import { isOneOf, knownValue, type BuildDraft, type BuildExecutionStep, type CreationPlanValidation } from '../../model/contracts/build'
import { pickCreateEnvironment, summarizeCreationPlan } from '../../model/create'
import { sourceRepositoryFor } from '../app/platform'
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
  const envelope = platformErrorEnvelope(error)
  const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : envelope?.status
  const raw = envelope?.message ?? (error instanceof Error ? error.message : String(error))
  return classifyBuildFailure(failedStep?.message ?? raw, status, context, reference, failedStep?.detail?.reason ?? (isConsoleError(error) ? error.code : envelope?.code), error instanceof ConsoleAppCreationError ? 'apps.create' : undefined, undefined, envelope?.details)
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
    throw new Error([validation.message, ...(validation.staticErrors ?? []), ...diagnostics].filter(Boolean).join('\n'))
  }
  return validation.creationPlanFingerprint
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
  const appProgress = preparationInput ? appPreparationProgress(preparationInput, now, preparationClock.current.since) : sourceBuildFailureProgress(sourceRepository?.build)
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
  return { app, appViews, appView, appProgress, generation, execution, domain, creationPlan, defaultPending, proposalDraft, published, implementation, implementing }
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
  /** Failed jobs already reported; shared with the host's own failure observation. */
  observedFailures: MutableRefObject<Set<string>>
  /** The created console app's display name. */
  displayName: string
  /** Its one-line description. */
  description: string
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
  const [publishRetryAt, setPublishRetryAt] = useState(0)
  const publishRetries = useRef(0)
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
    // Plan replacement is forbidden after an execution exists.
    if (execution || !isOneOf(generation?.status, 'succeeded') || !creationPlan || creationPlan === draft.creationPlan || running || busy || lock.current || failure) return
    void host.perform('plan', async () => {
      const current = host.draftRef.current
      if (current.creationExecutions.length || !current.creationPlan) return
      const plan = withDefaultPublish(current.creationPlan, { domain })
      if (plan !== current.creationPlan) await host.receive(await api.updateDraft(projectId, draft.id, { creationPlan: plan }))
    })
  }, [draft.creationPlan, knownValue(generation?.status), execution, domain, running, busy, failure])

  useEffect(() => {
    // A phase or job state this console does not know starts nothing on its own (stage.ts `unsupported`).
    if (running || busy || lock.current || failure || draft.createdApplicationStackId || host.unsupported || host.holdPreparation) return
    if (isOneOf(execution?.status, 'failed') && !host.observedFailures.current.has(execution!.id)) return
    if (!tab.prepareRequested || defaultPending) return
    void host.perform('prepare', async () => {
      const creationPlanFingerprint = await validatePreparationPlan(projectId, draft.id)
      const clientRequestId = host.currentTab().executionRequestId ?? crypto.randomUUID()
      host.patch({ executionRequestId: clientRequestId })
      const begun = await api.createExecution(projectId, draft.id, { clientRequestId, creationPlanFingerprint })
      await host.receive(begun)
      const created = begun.creationExecutions.at(-1)
      if (!created) throw new Error(text.session.missingExecution)
      host.patch({ prepareRequested: false })
      await host.receive(await api.runExecution(projectId, draft.id, created.id))
    })
  }, [draft, tab.prepareRequested, host.holdPreparation, running, busy, failure, defaultPending])

  useEffect(() => {
    // A reload between begin and run resumes the existing execution, never begins a second one.
    if (!execution || !isOneOf(execution.status, 'running') || execution.runStartedAt || busy || lock.current || failure) return
    void host.perform('prepare', async () => { await host.receive(await api.runExecution(projectId, draft.id, execution.id)) })
  }, [execution, busy, failure])

  useEffect(() => {
    if (!execution || !isOneOf(execution.status, 'failed') || host.observedFailures.current.has(execution.id)) return
    host.observedFailures.current.add(execution.id)
    host.fail(new Error(execution.error ?? text.session.operationFailed), 'prepare', execution.finishedAt, execution.steps.find((step) => isOneOf(step.status, 'failed')))
  }, [execution])

  useEffect(() => {
    if (!draft.createdApplicationStackId || (!isOneOf(draft.phase, 'created') && !isOneOf(execution?.status, 'succeeded')) || app?.stackId || busy || lock.current || bindingFailed.current) return
    void host.perform('prepare', async () => {
      try {
        // A previously selected department stays fixed; repair only old empty sessions.
        if (!host.currentTab().groupId) host.patch({ groupId: host.groupId })
        const appName = draft.creationPlan ? summarizeCreationPlan(draft.creationPlan).appName : undefined
        const kept = await bindCreatedConsoleApp(
          { projectId, displayName: host.displayName, description: host.description, tags: [], groupId: host.currentTab().groupId, urlName: appName ?? '', share: { scope: 'private', groupIds: [], extraPersonIds: [] } },
          { stackId: draft.createdApplicationStackId!, createdAppId: host.currentTab().createdAppId },
          { api: createApi, onCreatedAppId: (createdAppId) => host.patch({ createdAppId }) },
        )
        host.patch({ createdAppId: kept.id, prepareRequested: false })
        // The decoded bind answer is the app; a read that started before the bind must not overwrite it.
        await writeAppCache(queryClient, kept)
        await queryClient.invalidateQueries({ queryKey: ['console', 'apps'] })
      } catch (error) { bindingFailed.current = true; throw error }
    })
  }, [draft.createdApplicationStackId, knownValue(draft.phase), knownValue(execution?.status), app?.stackId, busy, host.groupId])

  useEffect(() => {
    const platform = appView?.platform
    if (!isOneOf(draft.phase, 'created') || appViews.loading || appViews.failed || !platform?.webComponentId || !domain || busy || lock.current || failure) return
    const hasPublish = appViews.input.publishes.some((publish) => publish.applicationId === platform.id && publish.branchId === platform.branchId && publish.componentId === platform.webComponentId)
      || (platform.publish?.branchId === platform.branchId && platform.publish.componentId === platform.webComponentId)
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
    if (draft.createdApplicationStackId && implementation.state.phase === 'idle' && !published) implementation.start()
  }, [draft.createdApplicationStackId, implementation.state.phase, published])

  async function markPublished() {
    await host.perform('publish', async () => {
      await host.receive(await api.updateDraft(projectId, draft.id, { markPublished: true }))
      host.patch({ continuedAfterPublishAt: undefined })
      host.clearFailure()
    })
  }

  return {
    waitingForPublish: publishRetries.current >= 4,
    markPublished,
    /** 「この内容で作る」: request the preparation (the effect above starts it once nothing holds it). */
    prepare: () => { bindingFailed.current = false; host.clearFailure(); host.patch({ prepareRequested: true }) },
    /** A retry may bind again after a failed binding. */
    resetBinding: () => { bindingFailed.current = false },
    /** The creation's retries: 公開済み again, the implementation run, or a clean preparation after a failed one. */
    retry(context: 'publish' | 'implement' | 'prepare') {
      if (context === 'publish') void markPublished()
      else if (context === 'implement') implementation.retry()
      else if (!draft.createdApplicationStackId) {
        void host.perform('prepare', async () => {
          await host.receive(await api.cleanupCreation(projectId, draft.id))
          host.patch({ prepareRequested: true, reusePlan: true, executionRequestId: undefined })
        })
      }
    },
  }
}
