import type { ApplicationDraftImplementationFailureReason } from '@appthrust/api-schema/platform-api'
import { copy as consoleCopy } from '../../copy'
import { aiPolicyCopy, aiPolicyExplanation } from '../../copy/ai-policy'
import { isRepositoryDestinationReason } from '../create'
import { buildCopy } from './copy'
import type { BuildFailure } from './types'

/** Provider account exhaustion, not rate limiting or a disconnected stream on its own. */
export function isAIQuotaExhausted(text: string): boolean {
  return /you have no credits remaining|\binsufficient_quota\b|exceeded your current quota/i.test(text)
}

/** Raw diagnostics stay in the advanced disclosure; stable console codes do not depend on server wording. */
export function classifyBuildFailure(text: string, status: number | undefined, context: 'turn' | 'plan' | 'prepare' | 'implement' | 'publish', reference?: BuildFailure['reference'], code?: string, operation?: 'apps.create', failureReason?: ApplicationDraftImplementationFailureReason, details?: Record<string, unknown>): BuildFailure {
  const copy = buildCopy.failure
  // Admission reasons take precedence over generic status, runtime and provider errors.
  const policy = aiPolicyExplanation(details?.reason, details?.policy)
    ?? aiPolicyExplanation(text.match(/ai_(?:policy_|model_|approval_policy_)[a-z_]*/i)?.[0]?.toLowerCase(), details?.policy)
  if (policy) return { kind: 'policy', title: aiPolicyCopy.title, reason: policy, raw: text }
  // The platform refused to create the repository where the plan said (moved, mismatched or blocked destination).
  const destination = [details?.reason, code].find(isRepositoryDestinationReason)
  if (destination) {
    const words = consoleCopy.create.destination
    const changed = destination === 'DestinationChanged' || destination === 'DestinationMismatch'
    return { kind: 'destination', title: changed ? words.changedTitle : words.blockedTitle, reason: `${words.problem(destination, text)}${words.retryAfterFix}`, raw: text, ...(reference ? { reference } : {}) }
  }
  // A provider cause is more specific than the runtime's generic TaskFailed/stream reason.
  if (context !== 'prepare' && context !== 'publish' && isAIQuotaExhausted(text)) return { kind: 'quota', ...copy.quota, raw: text }
  if (context === 'implement' && failureReason) {
    if (failureReason === 'StreamInterrupted' || failureReason === 'RuntimeRestarted') return { kind: 'interrupted', ...copy.resumable, raw: text }
    if (failureReason === 'RuntimeUnavailable') return { kind: 'unavailable', ...copy.unavailable, raw: text }
    return { kind: 'failed', title: copy.failed.implement, reason: copy.retry, raw: text }
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

/** Use the failure's recorded time, never the render clock, in the copyable reference. */
export function buildFailureReference(reference: NonNullable<BuildFailure['reference']>): string {
  const at = new Date(reference.at)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return buildCopy.failure.reference(`${reference.draftId}${reference.executionId ? ` / ${reference.executionId}` : ''} ${time}`)
}
