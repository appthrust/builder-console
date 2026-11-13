import { isResponseContractError } from '../../api/boundary'
import { isOneOf, type BuildDraft, type BuildExecutionStep } from '../../model/contracts/build'
import { useQueryClient } from '@tanstack/react-query'
import { useCreateStore, useSelector } from '@tanstack/react-store'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../../api/build'
import { buildDraftOptions, readDraft } from '../../api/queries/build'
import { type Me } from '../../model/contracts/console'
import { platformErrorEnvelope } from '../../api/platform-error'
import { isSessionExpiredError, sessionExpiryStore } from '../../api/session-expiry'
import { classifyBuildFailure } from '../../model/build/failure'
import { buildCopy } from '../../model/build/copy'
import { messagesFromDraft, planProposal } from '../../model/build/messages'
import { composeBuildIntent, conversationTurns, decomposeBuildIntent, isPrepareTurn, prepareAnswers } from '../../model/build/questions'
import { parseSpec, serializeSpec } from '../../model/build/spec'
import { deriveStage, hasUnplannedKickoff, needsPlanRefresh } from '../../model/build/stage'
import type { BuildFailure, BuildMessage } from '../../model/build/types'
import { implemented } from './implement'
import { acknowledgeReply, initialSession, queueReply, readBuildSession, saveBuildSession, startConversation, startPrepareConversation, type BuildSession } from './session'
import { draftFailure, useDraftCreation, useDraftCreationEffects, writeDraft } from './use-draft-creation'
import { text } from './copy'

import { isBuildPending } from '../../model/build/progress'
/** Backoff for an AI gate 412 (about two minutes in total, the length of a platform rollout). */
const UNAVAILABLE_RETRY_DELAYS = [10_000, 20_000, 30_000, 60_000]
/** A draft-write conflict waits independently of the conversation, capped at 30 seconds. */
const NAME_RETRY_DELAYS = [1_000, 3_000, 10_000, 30_000]

export function useBuildSession(observed: BuildDraft, me: Me, groupId: string, ownerGroupName?: string) {
  const { projectId } = me
  const queryClient = useQueryClient()
  // The session's writes reach the draft cache at once (`receive`), but the page re-renders with them only after
  // React Query's batched observer notification. The session store changes synchronously (a reply acknowledged, a
  // request cleared), so a render in between must already read the written draft: with the observed one the write
  // looks undone and is sent again (the hidden preparation turn was queued twice and answered 409).
  const draft = queryClient.getQueryData<BuildDraft>(buildDraftOptions(projectId, observed.id).queryKey) ?? observed
  const [initial] = useState(() => {
    const saved = readBuildSession(draft.id)
    return saved?.projectId === projectId && saved.ownerSubject === me.person.subject
      ? saved
      : initialSession({ baseIntent: draft.intent, projectId, ownerSubject: me.person.subject, groupId })
  })
  const store = useCreateStore<BuildSession>(initial)
  const session = useSelector(store)
  const [failure, setFailure] = useState<BuildFailure>()
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [nameRetryAt, setNameRetryAt] = useState(0)
  const nameRetries = useRef(0)
  const lock = useRef(false)
  const retryContext = useRef<'turn' | 'plan' | 'prepare' | 'implement' | 'publish'>('turn')
  const observedFailures = useRef(new Set<string>())
  const blockedUntil = useRef(0)
  // A 412 from the AI gate is usually the platform rolling out (the API pod restarts, the
  // runtime target is briefly unadmitted). Retry with backoff before declaring it unavailable.
  const unavailableRetries = useRef(0)
  const draftRef = useRef(draft)
  draftRef.current = draft
  // The created app, its preparation, the plan's default publish address and the implementation run (shared with console-v1).
  const creation = useDraftCreation({ projectId, draft, tab: session, hasPending: session.pending.length > 0, now })
  const { app, appView, appProgress, generation, execution, domain, proposalDraft, published, implementation, implementing } = creation
  const turn = draft.conversationTurns.at(-1)
  const running = [generation, turn, execution].some(isBuildPending)
  const result = deriveStage({ draft, generation, turn, execution, appProgress, implementation: { phase: implementation.state.phase, done: implementation.state.phase === 'done', implemented: implemented(implementation.state), activityTail: implementation.state.activityTail }, published, lastPlannedIntent: session.lastPlannedIntent, now })
  const { spec } = useMemo(() => parseSpec(draft.specMarkdown), [draft.specMarkdown])
  const preparationDone = Boolean(appView?.platform) && !appProgress
  const messages = useMemo(() => messagesFromDraft(proposalDraft, session.messages, { lastPlannedIntent: session.lastPlannedIntent, preparationDone }), [proposalDraft, session.messages, session.lastPlannedIntent, preparationDone])
  const proposal = useMemo(() => planProposal(proposalDraft, session.lastPlannedIntent), [proposalDraft, session.lastPlannedIntent])
  const initialMessage: BuildMessage = { role: 'user', text: decomposeBuildIntent(session.baseIntent), at: draft.createdAt }
  // 用意する: the draft is read-only while the execution runs, but the AI can still ask preparation questions.
  const preparing = isBuildPending(execution)
  const conversing = preparing ? isBuildPending(generation) || isBuildPending(turn) : running
  const answers = useMemo(() => prepareAnswers(draft.conversationTurns, draft.publishPreferences, ownerGroupName), [draft.conversationTurns, draft.publishPreferences, ownerGroupName])

  function patch(next: Partial<BuildSession> | ((current: BuildSession) => BuildSession)) {
    store.setState((current) => typeof next === 'function' ? next(current) : { ...current, ...next })
    saveBuildSession(draft.id, store.state)
  }
  /**
   * Writes a write's answer into the draft cache. Draft reads still in flight (polls and `readDraft`, which all
   * run as the draft query) are cancelled first: they started before this answer arrived, so landing afterwards
   * they would bring back the draft as it was before the write, which then looks undone and is sent again (a
   * second …/run, a hidden preparation turn answered 409).
   */
  async function receive(next: BuildDraft) {
    await writeDraft(queryClient, projectId, draftRef, next)
  }
  function fail(error: unknown, context: 'turn' | 'plan' | 'prepare' | 'implement' | 'publish', at = new Date().toISOString(), failedStep?: BuildExecutionStep) {
    const preparationExecution = context === 'prepare' ? draftRef.current.creationExecutions.at(-1) : undefined
    // Console binding can fail after creation succeeded; keep that execution in the support reference.
    const reference = { draftId: draft.id, at, ...(preparationExecution ? { executionId: preparationExecution.id } : {}) }
    // A write that answered 2xx with an answer this console cannot read may have happened: nothing
    // from it enters the draft cache, the draft is read back, and only `confirm` (a re-read) is offered.
    const unconfirmed = isResponseContractError(error)
    if (unconfirmed) void queryClient.invalidateQueries({ queryKey: buildDraftOptions(projectId, draft.id).queryKey })
    const next = draftFailure(error, context, reference, failedStep)
    retryContext.current = context
    setFailure(next)
    patch((current) => {
      // The same failure repeated (retry, reload) stays one notice.
      const last = current.messages.at(-1)
      const messages = last?.role === 'notice' && last.title === next.title && last.detail === next.reason ? current.messages.slice(0, -1) : current.messages
      const retry = unconfirmed ? 'confirm' as const : next.kind !== 'policy' ? context : undefined
      return { ...current, ...(next.kind === 'quota' || next.kind === 'policy' ? { planRequested: false } : {}), messages: [...messages, { role: 'notice', tone: unconfirmed ? 'warning' : 'error', title: next.title, detail: next.reason, ...(retry ? { retry } : {}), at, ...(next.reference ? { reference: next.reference } : {}) }] }
    })
  }
  async function perform(context: 'turn' | 'plan' | 'prepare' | 'implement' | 'publish', action: () => Promise<void>) {
    if (lock.current || sessionExpiryStore.state) return
    lock.current = true
    setBusy(true)
    try { await action() } catch (error) { if (!isSessionExpiredError(error)) fail(error, context) } finally { lock.current = false; setBusy(false) }
  }
  useEffect(() => { saveBuildSession(draft.id, store.state) }, [draft.id, store])
  useEffect(() => {
    if (!running && !session.pending.length && !session.prepareRequested && !appProgress) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, session.pending.length, session.prepareRequested, Boolean(appProgress)])

  useEffect(() => {
    nameRetries.current = 0
    setNameRetryAt(0)
  }, [answers.name])
  useEffect(() => {
    if (!nameRetryAt) return
    const timer = window.setTimeout(() => setNameRetryAt(0), Math.max(0, nameRetryAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [nameRetryAt])

  function send(text: string) {
    const reply = text.trim()
    // A state this console does not know offers no write (stage.ts `unsupported`); reading stays.
    if (!reply || reply.length > 4000 || result.unsupported) return
    if (result.stage === 'build' || result.stage === 'publish') {
      patch((current) => queueReply({ ...current, continuedAfterPublishAt: draft.publishedAt }, reply, new Date().toISOString()))
      return
    }
    patch((current) => queueReply({ ...current, reusePlan: false }, reply, new Date().toISOString()))
    setFailure(undefined)
  }

  useEffect(() => {
    if (busy || lock.current || failure || running) return
    const next = startConversation(store.state, draft, new Date().toISOString())
    if (next !== store.state) patch(next)
  }, [draft, busy, failure, running])

  useEffect(() => {
    if (busy || lock.current || failure) return
    const next = startPrepareConversation(store.state, draft, new Date().toISOString())
    if (next !== store.state) patch(next)
  }, [draft, busy, failure])

  // Mutations are serialized locally and on the server. A 409 is not a lost reply.
  useEffect(() => {
    const pending = session.pending[0]
    // HTTP failures retain their pending reply and notice across reload; only an explicit retry resumes it.
    const lastMessage = session.messages.at(-1)
    if (lastMessage?.role === 'notice' && (lastMessage.retry === 'turn' || (lastMessage.tone === 'error' && !lastMessage.retry))) return
    if (!pending || conversing || busy || lock.current || failure || result.unsupported || Date.now() < blockedUntil.current) return
    // 用意する questions are answered in the conversation, even when the app was made before the answer.
    const asking = preparing || answers.open || isPrepareTurn(pending.text)
    if (draft.createdApplicationStackId && !asking) {
      if (!app?.stackId || !implementation.state.tasks.length || implementation.pending || implementation.state.failure) return
      void perform('implement', async () => {
        if (await implementation.requestChange(pending.text)) {
          patch((current) => ({ ...current, pending: current.pending.filter((message) => message.at !== pending.at) }))
        }
      })
      return
    }
    void perform('turn', async () => {
      const currentDraft = draftRef.current
      const replies = conversationTurns(currentDraft.conversationTurns).map((item) => item.userMessage)
      const intent = composeBuildIntent(decomposeBuildIntent(session.baseIntent), [...replies, pending.text])
      // The intent is the plan's input; 用意する answers do not change the plan in use.
      if (!asking) await receive(await api.updateDraft(projectId, draft.id, { intent }))
      try {
        const created = await api.createTurn(projectId, draft.id, { message: pending.text })
        const latest = draftRef.current
        await receive({ ...latest, conversationTurns: [...latest.conversationTurns, created] })
        patch((current) => acknowledgeReply(current, pending.at))
      } catch (error) {
        // The turn was answered 2xx, so it was most likely accepted: the reply leaves the queue
        // (no resend); the draft read back shows it, and `fail` reports the unreadable answer.
        if (isResponseContractError(error)) {
          patch((current) => acknowledgeReply(current, pending.at))
          throw error
        }
        const envelope = platformErrorEnvelope(error)
        const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : envelope?.status
        if (status === 409) {
          blockedUntil.current = Date.now() + 3000
          draftRef.current = await readDraft(queryClient, projectId, draft.id)
          return
        }
        const policyDenied = classifyBuildFailure(envelope?.message ?? (error instanceof Error ? error.message : ''), typeof status === 'number' ? status : undefined, 'turn', undefined, envelope?.code, undefined, undefined, envelope?.details).kind === 'policy'
        if (status === 412 && !policyDenied && unavailableRetries.current < UNAVAILABLE_RETRY_DELAYS.length) {
          blockedUntil.current = Date.now() + UNAVAILABLE_RETRY_DELAYS[unavailableRetries.current]!
          unavailableRetries.current++
          return
        }
        unavailableRetries.current = 0
        throw error
      }
    })
  }, [session.pending, session.messages, conversing, preparing, answers.open, busy, failure, result.unsupported, now, implementation.pending, implementation.state.failure])

  async function generate() {
    const previousGenerationId = draftRef.current.creationPlanGenerations.at(-1)?.id
    // A reload/another tab may have already accepted this handoff. Read before writing (as the draft query, which a
    // write's answer cancels: an implementation start or cancel landing meanwhile is never overwritten by this read).
    const current = await readDraft(queryClient, projectId, draft.id)
    draftRef.current = current
    const latestGeneration = current.creationPlanGenerations.at(-1)
    if (current.createdApplicationStackId || current.creationExecutions.length
      || latestGeneration?.id !== previousGenerationId
      || !needsPlanRefresh(current, store.state.lastPlannedIntent)) {
      patch({ planRequested: false })
      return
    }
    if ([latestGeneration, current.conversationTurns.at(-1)].some(isBuildPending)) return
    const intent = composeBuildIntent(decomposeBuildIntent(session.baseIntent), conversationTurns(current.conversationTurns).map((item) => item.userMessage), true)
    const updated = current.intent === intent ? current : await api.updateDraft(projectId, draft.id, { intent })
    await receive(updated)
    const attemptKey = `build-plan-${draft.id}-${current.conversationTurns.at(-1)?.id ?? 'initial'}-${previousGenerationId ?? 'initial'}`
    const created = await api.createGeneration(projectId, draft.id, {}, attemptKey)
    patch({ lastPlannedIntent: intent, planRequested: false, reusePlan: false })
    await receive({ ...draftRef.current, creationPlanGenerations: [...draftRef.current.creationPlanGenerations, created] })
  }

  // The plan must be (re)made before the preparation: an accepted kickoff, or 用意する on a plan the spec has outgrown.
  const planFirst = (isOneOf(turn?.status, 'succeeded') && (session.planRequested || hasUnplannedKickoff(draft))) || (session.prepareRequested && !session.reusePlan && needsPlanRefresh(draft, session.lastPlannedIntent))
  const unobservedFailure = [generation, turn].some((operation) => isOneOf(operation?.status, 'failed') && !observedFailures.current.has(operation!.id))
  const creationEffects = useDraftCreationEffects(creation, {
    projectId, groupId, draft, draftRef, tab: session, currentTab: () => store.state, patch, receive, perform, fail,
    clearFailure: () => setFailure(undefined), busy, lock, failure, running, unsupported: Boolean(result.unsupported),
    holdPreparation: session.pending.length > 0 || unobservedFailure || planFirst, observedFailures,
    displayName: answers.name ?? spec.name ?? draft.title, description: spec.oneLine ?? '',
  })

  useEffect(() => {
    // A phase or job state this console does not know starts nothing on its own (stage.ts `unsupported`).
    if (running || busy || lock.current || session.pending.length || failure || draft.createdApplicationStackId || result.unsupported) return
    if ([generation, turn, execution].some((operation) => isOneOf(operation?.status, 'failed') && !observedFailures.current.has(operation!.id))) return
    if (planFirst) void perform('plan', generate)
  }, [draft, session.prepareRequested, session.planRequested, session.pending.length, running, busy, failure, creation.defaultPending])

  useEffect(() => {
    for (const [context, operation] of [['turn', turn], ['plan', generation]] as const) {
      if (!operation || !isOneOf(operation.status, 'failed') || observedFailures.current.has(operation.id)) continue
      observedFailures.current.add(operation.id)
      const kind = classifyBuildFailure(operation.error ?? '', undefined, context).kind
      if (context === 'plan' && session.planRetries === 0 && kind !== 'quota' && kind !== 'policy') {
        patch((current) => ({ ...current, planRetries: 1, planRequested: true, messages: [...current.messages, { role: 'notice', tone: 'info', title: text.session.retryPlan, at: new Date().toISOString() }] }))
      } else fail(new Error(operation.error ?? text.session.operationFailed), context, operation.finishedAt)
    }
  }, [turn, generation])

  // Draft preferences are authoritative across tabs. During implementation only the
  // preferences/title are writable; specification alignment waits for its lock.
  useEffect(() => {
    const name = answers.name
    const preferences = { ...draft.publishPreferences, ...(name ? { name } : {}), ...(answers.shareChoice ? { shareScope: answers.shareChoice } : {}) }
    const preferencesChanged = preferences.name !== draft.publishPreferences?.name || preferences.shareScope !== draft.publishPreferences?.shareScope
    const titleChanged = Boolean(name && draft.title !== name)
    const specChanged = Boolean(name && spec.name !== name && !implementing)
    if ((!preferencesChanged && !titleChanged && !specChanged) || running || busy || lock.current || failure || nameRetryAt) return
    void perform('prepare', async () => {
      const current = parseSpec(draftRef.current.specMarkdown)
      try {
        await receive(await api.updateDraft(projectId, draft.id, {
          ...(preferencesChanged ? { publishPreferences: preferences } : {}),
          ...(titleChanged ? { title: name } : {}),
          ...(specChanged ? { specMarkdown: serializeSpec({ ...current.spec, name }, current.body) } : {}),
        }))
        nameRetries.current = 0
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : platformErrorEnvelope(error)?.status
        if (status !== 409) throw error
        // Another tab/run can win after the guard. Do not mark an AI turn failed or
        // block queued answers: only this draft write waits for its next attempt.
        setNameRetryAt(Date.now() + NAME_RETRY_DELAYS[Math.min(nameRetries.current, NAME_RETRY_DELAYS.length - 1)]!)
        nameRetries.current = Math.min(nameRetries.current + 1, NAME_RETRY_DELAYS.length - 1)
      }
    })
  }, [answers.name, answers.shareChoice, draft.publishPreferences, draft.title, spec.name, running, implementing, busy, failure, nameRetryAt])

  function retry(context?: 'turn' | 'plan' | 'prepare' | 'implement' | 'publish' | 'confirm') {
    const last = session.messages.at(-1)
    context ??= last?.role === 'notice' && last.retry ? last.retry : retryContext.current
    setFailure(undefined)
    creationEffects.resetBinding()
    patch((current) => ({ ...current, messages: current.messages.filter((message) => message.role !== 'notice' || !message.retry) }))
    // After an unreadable write answer only the draft is read again; the write itself is never resent from here.
    if (context === 'confirm') void queryClient.invalidateQueries({ queryKey: buildDraftOptions(projectId, draft.id).queryKey })
    else if (context === 'publish' || context === 'implement' || context === 'prepare') creationEffects.retry(context)
    else if (context === 'plan') patch({ planRequested: true })
    else if (context === 'turn' && !store.state.pending.length && isOneOf(turn?.status, 'failed')) send(turn!.userMessage)
  }
  return {
    session, spec, app, implementation, failure, busy, result, proposal, domain,
    messages: [initialMessage, ...messages],
    queued: session.pending.length > 0 && conversing,
    /** The AI is still asking its 用意する questions; its options stay answerable after the app is made. */
    prepareOpen: answers.open,
    /** The AI gate answered 412 and the reply is being retried; `now` ticks while a reply is pending. */
    waitingForAi: session.pending.length > 0 && unavailableRetries.current > 0 && now < blockedUntil.current + 1000,
    waitingForPublish: creationEffects.waitingForPublish,
    send, retry, patch, receive, perform,
    requestPlan: () => {
      if (lock.current || running || store.state.pending.length || result.primary.action !== 'plan') return
      if (hasUnplannedKickoff(draft)) retry('plan')
      else send(buildCopy.questions.kickoffReply)
    },
    prepare: creationEffects.prepare,
    /** The shared name-collision recovery (use-draft-creation `rename`). */
    rename: creationEffects.rename,
    // PublishStep has written the answered app into its cache entry.
    published: () => creationEffects.markPublished(),
  }
}
