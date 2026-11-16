import type { OpenValue } from '../../api/boundary'
import { isOneOf, type ImplementationFailureReason, type ImplementationRun, type ImplementationTask, type RunFailure } from '../contracts/build'
import { aiPolicyCopy, aiPolicyExplanation } from '../../copy/ai-policy'
import { buildCopy } from './copy'
import type { BuildFailure } from './types'

/** Provider account exhaustion, not rate limiting or a disconnected stream on its own. */
export function isAIQuotaExhausted(text: string): boolean {
  return /you have no credits remaining|\binsufficient_quota\b|exceeded your current quota/i.test(text)
}

/**
 * A write that answered 2xx with an answer this console could not read: it may have
 * happened, so the session reads the draft back instead of offering to send it again.
 */
export function unconfirmedFailure(reference?: BuildFailure['reference']): BuildFailure {
  return { kind: 'unconfirmed', ...buildCopy.failure.unconfirmed, ...(reference ? { reference } : {}) }
}

/**
 * Platform's repository destination stopped the creation before anything was made: it moved
 * (or the plan was bound to the current one, and the user approves again), it is not set, or the
 * request did not match it. Fixed words only: never the server's reason or message. Only a mismatch
 * (a console fault) carries the support reference; a move or an unset destination is not a fault to report.
 */
export function destinationFailure(rejection: 'changed' | 'blocked' | 'mismatch', reference?: BuildFailure['reference']): BuildFailure {
  return { kind: 'destination', destination: rejection, ...buildCopy.failure.destination[rejection], ...(reference && rejection === 'mismatch' ? { reference } : {}) }
}

/**
 * Platform's own sentences for a repository destination that stops a plan. A validation answer carries them as text
 * only (the source validation keeps the message, not the reason: platform-api internal/handler/application_draft.go
 * :1137-1158); the plan's static check (:2305-2306), the revision check and the request match (internal/
 * repositorydestination/request.go:56-73) and the resolver's blockers (resolver.go:383-409).
 */
const DESTINATION_SENTENCES: Record<'changed' | 'blocked' | 'mismatch', readonly string[]> = {
  changed: ['Validate a repository destination before approving this creation plan.', 'The repository destination changed. Validate and approve the new destination.'],
  mismatch: ['The request does not match the Project repository destination.'],
  blocked: [
    'No repository destination is configured.',
    'Multiple repository destinations are available; ask a Project administrator to select a default.',
    'The configured repository destination is unavailable.',
    'The configured repository destination is being deleted.',
    'The repository destination is not ready for its current configuration.',
    'The repository destination cannot create repositories.',
    'The repository destination is not available to this Project.',
    'Repository provisioning is not supported for this provider.',
    'Image access is not configured for the repository destination.',
    'Multiple image access connections match the repository destination.',
    'Image access is not ready for the repository destination.',
  ],
}
/** The plan's static check (application_draft.go:1113-1117) names the plan's own fields, `'creationPlan…'`; so does a generation stopped by it (application_draft_generation.go:615-621). */
const PLAN_FIELD = /\bcreationPlan\b|Creation plan could not be fingerprinted/

/** How the repository destination stopped a plan, when one of Platform's destination sentences is in `text`. */
export function destinationSentence(text: string): 'changed' | 'blocked' | 'mismatch' | undefined {
  return (['blocked', 'changed', 'mismatch'] as const).find((rejection) => DESTINATION_SENTENCES[rejection].some((sentence) => text.includes(sentence)))
}

function planFailure(plan: NonNullable<BuildFailure['plan']>, raw: string): BuildFailure {
  return { kind: 'plan', plan, ...buildCopy.failure.plan[plan], raw }
}

/**
 * Platform's creation-plan validation answered that this plan cannot be approved (`valid: false`). `lines` are its
 * sentences in order (verdict, plan check, sections). Only a reason this console knows is the user's to act on, with
 * no support reference: a name or URL another app holds is the name choice; a plan that does not carry the Project's
 * repository destination, or breaks the plan's rules, is fixed by a new plan. When Platform calls the destination
 * itself unusable (only `blocked` sentences), an administrator may fix it outside the plan: the same plan may also be
 * validated again (`recheck`). Any other reason is not taken for the user's problem: it is the platform failure with
 * its reference, Platform's sentences only in `raw` (the advanced disclosure), and the same plan may be validated
 * again (`recheck`). A destination that moved or is not set is first bound again by the caller (use-draft-creation),
 * so it reaches the destination display; it reaches this only for a plan without a new repository or one already
 * bound to the current revision.
 */
export function planRejectionFailure(lines: readonly string[], reference?: BuildFailure['reference']): BuildFailure {
  const raw = lines.join('\n')
  const said = [...new Set(lines.map((line) => line.trim()).filter(Boolean))]
  const destinations = said.map(destinationSentence).filter(Boolean)
  if (destinations.length) return { ...planFailure('destination', raw), ...(destinations.every((rejection) => rejection === 'blocked') ? { recheck: true } : {}) }
  const taken = said.map((line) => classifyBuildFailure(line, undefined, 'prepare')).find((failure) => failure.kind === 'name-taken')
  if (taken) return { ...taken, raw }
  if (said.some((line) => PLAN_FIELD.test(line))) return planFailure('incomplete', raw)
  return { kind: 'platform', ...buildCopy.failure.platform, raw, recheck: true, ...(reference ? { reference } : {}) }
}

/** A plan generation's stored error from Platform's own plan check (that sentence, after an error code). */
function planGenerationRejection(text: string): BuildFailure | undefined {
  const destination = destinationSentence(text)
  // Nothing to bind yet: while none is set only an administrator helps; a plan without the current one is made again.
  if (destination === 'blocked') return { ...destinationFailure('blocked'), raw: text }
  if (destination) return planFailure('destination', text)
  return PLAN_FIELD.test(text) ? planFailure('incomplete', text) : undefined
}

/**
 * Raw diagnostics stay in the advanced disclosure; stable console codes do not depend on server wording. `operation`
 * names the request that failed when its class differs from the context's: `plan.validate` is the plan's validation.
 */
export function classifyBuildFailure(text: string, status: number | undefined, context: 'turn' | 'plan' | 'prepare' | 'implement' | 'publish', reference?: BuildFailure['reference'], code?: string, operation?: 'apps.create' | 'plan.validate', failureReason?: OpenValue<ImplementationFailureReason>, details?: Record<string, unknown>): BuildFailure {
  const copy = buildCopy.failure
  // Admission reasons take precedence over generic status, runtime and provider errors.
  const policy = aiPolicyExplanation(details?.reason, details?.policy)
    ?? aiPolicyExplanation(policyCode(text))
  if (policy) return { kind: 'policy', title: aiPolicyCopy.title, reason: policy, raw: text }
  // A provider cause is more specific than the runtime's generic TaskFailed/stream reason.
  if (context !== 'prepare' && context !== 'publish' && isAIQuotaExhausted(text)) return { kind: 'quota', ...copy.quota, raw: text }
  // Only a plan generation's stored error (no HTTP status) is read for Platform's plan check: a failed request in the
  // plan context (the generation request, the plan's PATCH) keeps the class its status and text give it.
  const planRejected = context === 'plan' && status === undefined ? planGenerationRejection(text) : undefined
  if (planRejected) return planRejected
  if (context === 'implement' && failureReason) {
    // A reason this console does not know is a stop like any other, never a resumable interruption.
    switch (failureReason.kind === 'known' ? failureReason.value : undefined) {
      case 'StreamInterrupted': case 'RuntimeRestarted': return { kind: 'interrupted', ...copy.resumable, raw: text }
      case 'RuntimeUnavailable': return { kind: 'unavailable', ...copy.unavailable, raw: text }
      default: return { kind: 'failed', title: copy.failed.implement, reason: copy.retry, raw: text }
    }
  }
  if (context === 'prepare' && (code === 'PublishURLConflict' || (!code && text === 'Another publish already uses this URL.'))) {
    return { kind: 'name-taken', reasonCode: 'PublishURLConflict', title: copy.urlNameTaken, reason: copy.chooseName, raw: text }
  }
  if (status === 403 || /forbidden|role .*required|cannot create application drafts/i.test(text)) return { kind: 'forbidden', ...copy.forbidden, raw: text }
  if ((code === 'invalid_request' && /groupId/i.test(text)) || (context === 'prepare' && operation === 'apps.create' && status === 404 && code === 'not_found')) {
    return { kind: 'group', ...copy.group, raw: text }
  }
  if (status === 409 && /(?:conversation turn|plan generation).*running/i.test(text)) return { kind: 'failed', ...copy.busy, raw: text }
  if (/run[ -]?lease.*(?:lapsed|expired)|lease.*(?:lapsed|expired)|interrupted.*(?:rollout|restart)|(?:rollout|restart).*interrupted/i.test(text)) {
    return { kind: 'interrupted', title: buildCopy.progress.interrupted.title, reason: buildCopy.progress.interrupted.hint, raw: text }
  }
  if (/(?:generation|conversation.turn).*(?:limit|maximum|at most|20|50)|(?:limit|maximum|reached (?:20|50)).*(?:generation|conversation.turn)/i.test(text)) return { kind: 'limit', ...copy.limit, raw: text }
  // The plan's validation asks no AI: a gateway answer to it is the platform's failure, with its reference (APT-1094).
  if (operation === 'plan.validate' && (status === 502 || status === 503 || status === 504)) return { kind: 'platform', ...copy.platform, raw: text, ...(reference ? { reference } : {}) }
  if (status === 412 || status === 502 || status === 503 || status === 504 || /runtime is not available|codex.*(?:unavailable|not available|not configured)|codexAvailable/i.test(text)) return { kind: 'unavailable', ...copy.unavailable, raw: text }
  // The server reports interrupted task streams; retry asks it to resume unfinished work.
  if (context === 'implement' && /AI task stream failed|stream ended before task\.completed|failed to fetch|network|connection (?:interrupted|reset|closed)|load failed/i.test(text)) {
    return { kind: 'interrupted', ...copy.resumable, raw: text }
  }
  if (code === 'slug_taken' || /(?:name|repo(?:sitory)?).*(?:already exists|already taken|name.*taken|conflict)|already exists.*(?:name|repo(?:sitory)?)/i.test(text)) {
    const match = /(?:name|repo(?:sitory)?)\s+(?:already exists|already taken)\s*:\s*["'`]?([a-z0-9][a-z0-9._/-]*)/i.exec(text)
      ?? /(?:name|repo(?:sitory)?)\s+["'`]?([a-z0-9][a-z0-9._/-]*)["'`]?\s+(?:already exists|already taken|is already taken)/i.exec(text)
      ?? /["'`]([a-z0-9][a-z0-9._/-]*)["'`].*already exists/i.exec(text)
    const name = match?.[1]?.split('/').at(-1)?.replace(/\.git$/, '').replace(/[.]+$/, '')
    let suggestedName: string | undefined
    if (name) {
      // Only a short counter (`-2`…`-99`) is ours to bump; `-0001` or `-2024` is part of the name.
      const root = name.replace(/-[1-9]\d?$/, '')
      const occupied = new Set(text.match(/[a-z0-9][a-z0-9._-]*/gi) ?? [])
      let suffix = 2
      while (occupied.has(`${root}-${suffix}`)) suffix++
      suggestedName = `${root}-${suffix}`
    }
    return { kind: 'name-taken', title: copy.nameTaken, reason: suggestedName ? copy.suggestName(suggestedName) : copy.chooseName, ...(suggestedName ? { suggestedName } : {}), raw: text }
  }
  if (/workspace|RuntimeReady|PVCPending|PVCNotFound|PodUnschedulable|ImagePullBackOff|ErrImagePull|InitContainerFailed|PodNotCreated|RuntimeStarting|ClusterAccess/i.test(text)) {
    const reason = /PVCPending|PVCNotFound/i.test(text) ? copy.storage
      : /PodUnschedulable/i.test(text) ? copy.capacity
        : /ImagePullBackOff|ErrImagePull/i.test(text) ? copy.files
          : /InitContainerFailed/i.test(text) ? copy.initialization
            : /PodNotCreated|RuntimeStarting|ClusterAccess/i.test(text) ? copy.starting : copy.unknownWorkspace
    return { kind: 'workspace', title: copy.workspace.title, reason: reason + copy.workspace.contact, raw: text }
  }
  if (/timed out|timeout|deadline exceeded/i.test(text)) return { kind: 'timeout', ...copy.timeout, raw: text }
  if (context === 'prepare' || /gitops|\bpolicy\b|\bpreflight\b|\bdelivery\b|definitionRef|not allowed by the selected source connection|needs changes before resources can be created|changed while validating the creation plan|\bvalidation\b|\bserver.contract\b|\binvalid request\b|\bunknown field\b|(?:applicationStackRequest|applicationSourceRepositoryRequest)|['"`][\w.]+['"`] is required/i.test(text)) {
    return { kind: 'platform', ...copy.platform, raw: text, ...(reference ? { reference } : {}) }
  }
  return { kind: 'failed', title: copy.failed[context], reason: copy.retry, raw: text }
}

/** The AI policy reason code a legacy diagnostic names, if any. */
function policyCode(text: string): string | undefined {
  return text.match(/ai_(?:policy_|model_|approval_policy_)[a-z_]*/i)?.[0]?.toLowerCase()
}

/**
 * A stopped implementation run. With Platform's `failure` (APT-1158) its decision is used; without it (an older
 * Platform, an unreadable `failure`, a cancelled run) the run reads as before, from `failureReason` and the text.
 */
export function classifyRunFailure(run: Pick<ImplementationRun, 'status' | 'error' | 'failure' | 'failureReason'>, task: Pick<ImplementationTask, 'error' | 'failureReason'> | undefined, fallback: string, reference: NonNullable<BuildFailure['reference']>): BuildFailure {
  const text = run.error || task?.error || fallback
  if (run.failure && isOneOf(run.status, 'failed')) return decidedRunFailure(run.failure, text, reference)
  return classifyBuildFailure(text, undefined, 'implement', reference, undefined, undefined, run.failureReason ?? task?.failureReason)
}

type Refinement = Pick<BuildFailure, 'kind' | 'title' | 'reason'> & { skip?: false }

/**
 * The wording, and the skip taken away, for a reason this console knows, only when Platform's `retryable` is the one
 * written for it. Never adds an action: a new run is offered exactly when `retryable` says so.
 */
function refinement(reason: RunFailure['reason'], retryable: boolean, text: string): Refinement | undefined {
  const copy = buildCopy.failure
  const known = reason.kind === 'known' ? reason.value : undefined
  if (retryable) switch (known) {
    case 'StreamInterrupted': case 'RuntimeRestarted': return { kind: 'interrupted', ...copy.resumable }
    case 'RuntimeUnavailable': return { kind: 'unavailable', ...copy.unavailable }
    case 'TaskTimedOut': return { kind: 'failed', ...copy.run.timedOut }
    case 'ProviderQuotaExhausted': return { kind: 'quota', ...copy.quota, skip: false }
    case 'ProposalPending': return { kind: 'failed', ...copy.run.proposalPending, skip: false }
    default: return undefined
  }
  switch (known) {
    case 'InputRequired': return { kind: 'blocked', ...copy.run.inputRequired }
    case 'PolicyDenied': return {
      kind: 'policy', title: aiPolicyCopy.title, skip: false,
      reason: aiPolicyExplanation(policyCode(text)) ?? aiPolicyCopy.policy() + aiPolicyCopy.unknown + aiPolicyCopy.contact,
    }
    case 'AccessDenied': return { kind: 'blocked', ...copy.run.accessDenied, skip: false }
    case 'ConfigurationMissing': case 'ConfigurationInvalid': return { kind: 'blocked', ...copy.run.configuration, skip: false }
    case 'ProposalClosed': return { kind: 'blocked', ...copy.run.proposalClosed, skip: false }
    case 'ProposalInvalid': return { kind: 'blocked', title: copy.failed.implement, reason: copy.run.blocked, skip: false }
    default: return undefined
  }
}

/**
 * `retryable` decides whether a new run is offered; an unknown reason gets the generic wording for it. A run that
 * would stop the same way carries its support reference: the next step is someone else's.
 */
function decidedRunFailure(failure: RunFailure, text: string, reference: NonNullable<BuildFailure['reference']>): BuildFailure {
  const copy = buildCopy.failure
  const { skip = true, ...shown } = refinement(failure.reason, failure.retryable, text)
    ?? (failure.retryable ? { kind: 'failed' as const, title: copy.failed.implement, reason: copy.retry } : { kind: 'blocked' as const, title: copy.failed.implement, reason: copy.run.blocked })
  return { ...shown, offers: { retry: failure.retryable, skip }, raw: text, ...(failure.retryable ? {} : { reference }) }
}

/** Whether a stopped run offers a new run and a skip of its stopped task: Platform's decision, else by `kind` as before. */
export function failureOffers(failure: BuildFailure): { retry: boolean; skip: boolean } {
  if (failure.offers) return failure.offers
  return {
    retry: failure.kind !== 'policy' && failure.kind !== 'unconfirmed',
    skip: failure.kind !== 'policy' && failure.kind !== 'quota' && failure.kind !== 'unconfirmed',
  }
}

/** Use the failure's recorded time, never the render clock, in the copyable reference. */
export function buildFailureReference(reference: NonNullable<BuildFailure['reference']>): string {
  const at = new Date(reference.at)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return buildCopy.failure.reference(`${reference.draftId}${reference.executionId ? ` / ${reference.executionId}` : ''} ${time}`)
}
