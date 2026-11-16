import { afterEach, expect, test } from 'bun:test'
import { ConsoleApiError } from '../../api/console'
import { setLanguage } from '../../shell/language'
import { buildCopy } from './copy'
import { buildFailureReference, classifyBuildFailure, classifyRunFailure, failureOffers, planRejectionFailure } from './failure'
import { aiPolicyCopy, aiPolicyExplanation } from '../../copy/ai-policy'
import { RUN_FAILURE_REASONS, type ImplementationRun, type RunFailureReason } from '../contracts/build'

afterEach(() => setLanguage('ja'))

test.each(['groupId must be one of your directory groups', 'share.groupIds contains an invalid groupId'])('console invalid_request identifies the department settings problem: %s', (message) => {
  const error = new ConsoleApiError(400, { error: 'invalid_request', message })
  const failure = classifyBuildFailure(error.message, error.status, 'prepare', undefined, error.code)
  expect(failure).toEqual({
    kind: 'group', title: '所属する部署が確認できませんでした',
    reason: '管理者に部署への追加を依頼してから、もう一度試してください。', raw: message,
  })
})

test('legacy console create 404 is a department problem, not a missing draft or platform failure', () => {
  const error = new ConsoleApiError(404, { error: 'not_found', message: 'The requested resource was not found' })
  expect(classifyBuildFailure(error.message, error.status, 'prepare', undefined, error.code, 'apps.create')).toMatchObject({ kind: 'group', ...buildCopy.failure.group, raw: error.message })
  expect(classifyBuildFailure(error.message, error.status, 'prepare', undefined, error.code).kind).toBe('platform')
  expect(classifyBuildFailure(error.message, error.status, 'turn', undefined, error.code).kind).toBe('failed')
  expect(classifyBuildFailure(error.message, error.status, 'prepare').kind).toBe('platform')
})

test('unrelated invalid requests retain their preparation failure classification', () => {
  const error = new ConsoleApiError(400, { error: 'invalid_request', message: 'displayName is required' })
  expect(classifyBuildFailure(error.message, error.status, 'prepare', undefined, error.code).kind).toBe('platform')
  expect(classifyBuildFailure('groupId is invalid', 400, 'prepare').kind).toBe('platform')
})

test('department failure is localized without a platform support reference', () => {
  setLanguage('en')
  const failure = classifyBuildFailure('groupId must be one of your directory groups', 400, 'prepare', { draftId: 'draft-1', at: '2026-10-18T11:22:00Z' }, 'invalid_request')
  expect(failure).toMatchObject({ kind: 'group', title: 'Your department could not be verified', reason: 'Ask your administrator to add you to a department, then try again.' })
  expect(failure.reference).toBeUndefined()
})

test.each(['slug facility-inspection-map-2 is taken', 'slug taken', 'この名前は使用されています'])('console slug_taken uses the name-taken failure regardless of server wording: %s', (message) => {
  const error = new ConsoleApiError(409, { error: 'slug_taken', message })
  expect(classifyBuildFailure(error.message, error.status, 'prepare', undefined, error.code)).toMatchObject({
    kind: 'name-taken', title: buildCopy.failure.nameTaken, reason: buildCopy.failure.chooseName, raw: message,
  })
})

test('publish conflicts prefer the structured reason over diagnostic wording', () => {
  const failure = classifyBuildFailure('forbidden workspace validation failure', 503, 'prepare', undefined, 'PublishURLConflict')
  expect(failure).toMatchObject({
    kind: 'name-taken', reasonCode: 'PublishURLConflict', title: 'URL の名前が別のアプリで使われています', reason: buildCopy.failure.chooseName,
  })
  expect(failure.suggestedName).toBeUndefined()
  setLanguage('en')
  expect(classifyBuildFailure('conflict', undefined, 'prepare', undefined, 'PublishURLConflict').title).toBe('This URL name is used by another app')
})

test('only the exact old publish gate message falls back to a URL name conflict', () => {
  const message = 'Another publish already uses this URL.'
  expect(classifyBuildFailure(message, undefined, 'prepare')).toMatchObject({ kind: 'name-taken', reasonCode: 'PublishURLConflict' })
  expect(classifyBuildFailure(message, undefined, 'prepare', undefined, 'OtherGate').kind).toBe('platform')
  expect(classifyBuildFailure(`Unrelated: ${message}`, undefined, 'prepare').kind).toBe('platform')
  expect(classifyBuildFailure(message, undefined, 'turn').kind).toBe('failed')
})

test('unrelated console conflicts still use the preparation failure and its succeeded execution reference', () => {
  const error = new ConsoleApiError(409, { error: 'already_bound', message: 'already bound' })
  const reference = { draftId: 'draft-ae97efbc', executionId: 'exec-757eeaee', at: new Date(2026, 9, 18, 11, 17).toISOString() }
  const failure = classifyBuildFailure(error.message, error.status, 'prepare', reference, error.code)
  expect(failure).toMatchObject({ kind: 'platform', ...buildCopy.failure.platform, reference, raw: error.message })
  expect(buildFailureReference(failure.reference!)).toBe('問い合わせ番号: draft-ae97efbc / exec-757eeaee 11:17')
})

test.each(['StreamInterrupted', 'RuntimeRestarted', 'RuntimeUnavailable', 'TaskFailed', 'TaskCancelled', 'InputRequired'] as const)('implementation reason %s wins over conflicting legacy text', (reason) => {
  const failure = classifyBuildFailure('forbidden network workspace AI task stream failed', 503, 'implement', undefined, undefined, undefined, { kind: 'known', value: reason })
  expect(failure).toMatchObject(reason === 'StreamInterrupted' || reason === 'RuntimeRestarted'
    ? { kind: 'interrupted', ...buildCopy.failure.resumable }
    : reason === 'RuntimeUnavailable'
      ? { kind: 'unavailable', ...buildCopy.failure.unavailable }
      : { kind: 'failed', title: buildCopy.failure.failed.implement, reason: buildCopy.failure.retry })
})

test('legacy AI task stream failed remains resumable only for implementation', () => {
  expect(classifyBuildFailure('AI task stream failed', undefined, 'implement')).toMatchObject({ kind: 'interrupted', ...buildCopy.failure.resumable })
  expect(classifyBuildFailure('AI task stream failed', undefined, 'turn').kind).toBe('failed')
})

// APT-1158: Platform's `failure` decides; `retryable` sets the default and a known reason only narrows it.
const reference = { draftId: 'draft-1', executionId: 'impl-1', at: '2026-11-17T00:00:00Z' }
const failedRun = (failure?: { reason: RunFailureReason | 'TaskStalled'; retryable: boolean }, failureReason?: 'TaskFailed' | 'StreamInterrupted' | 'InputRequired'): Pick<ImplementationRun, 'status' | 'error' | 'failure' | 'failureReason'> => ({
  status: { kind: 'known', value: 'failed' }, error: 'Codex task failed: insufficient_quota (ai_policy_denied)',
  ...(failure ? { failure: { reason: failure.reason === 'TaskStalled' ? { kind: 'unknown' } : { kind: 'known', value: failure.reason }, retryable: failure.retryable } } : {}),
  ...(failureReason ? { failureReason: { kind: 'known', value: failureReason } } : {}),
})
const decide = (failure?: Parameters<typeof failedRun>[0], failureReason?: Parameters<typeof failedRun>[1]) => classifyRunFailure(failedRun(failure, failureReason), undefined, 'stopped', reference)

const then = () => buildCopy.failure.run.then

test('an unknown reason follows retryable with the generic wording, never the text classifiers', () => {
  const retryable = decide({ reason: 'TaskStalled', retryable: true })
  expect(retryable).toMatchObject({ kind: 'failed', title: buildCopy.failure.failed.implement, reason: buildCopy.failure.retry, offers: { retry: true, skip: true, change: true } })
  expect(retryable.reference).toBeUndefined()
  expect(decide({ reason: 'TaskStalled', retryable: false })).toMatchObject({ kind: 'blocked', title: buildCopy.failure.failed.implement, reason: buildCopy.failure.run.blocked + then(), offers: { retry: false, skip: true, change: true }, reference })
})

test.each([
  ['StreamInterrupted', { kind: 'interrupted', ...buildCopy.failure.resumable }, true],
  ['RuntimeRestarted', { kind: 'interrupted', ...buildCopy.failure.resumable }, true],
  ['RuntimeUnavailable', { kind: 'unavailable', ...buildCopy.failure.unavailable }, true],
  ['TaskTimedOut', { kind: 'failed', ...buildCopy.failure.run.timedOut }, true],
  // Platform admits no new run while the proposal awaits review (admitImprovementImplementation).
  ['ProposalPending', { kind: 'failed', ...buildCopy.failure.run.proposalPending }, false],
  ['TaskFailed', { kind: 'failed', title: buildCopy.failure.failed.implement, reason: buildCopy.failure.retry }, true],
] as const)('retryable known reason %s keeps the retry; skip and change follow run admission', (reason, shown, newRun) => {
  expect(decide({ reason, retryable: true })).toMatchObject({ ...shown, offers: { retry: true, skip: newRun, change: newRun } })
})

test('an exhausted quota keeps the retry and a change, but not skip: the next task meets the same quota', () => {
  expect(decide({ reason: 'ProviderQuotaExhausted', retryable: true })).toMatchObject({ kind: 'quota', ...buildCopy.failure.quota, offers: { retry: true, skip: false, change: true } })
})

test.each([
  ['InputRequired', { kind: 'blocked', title: buildCopy.failure.run.inputRequired.title, reason: buildCopy.failure.run.inputRequired.reason + then() }, true],
  ['AccessDenied', { kind: 'blocked', title: buildCopy.failure.run.accessDenied.title, reason: buildCopy.failure.run.accessDenied.reason + then() }, true],
  ['ConfigurationMissing', { kind: 'blocked', title: buildCopy.failure.run.configuration.title, reason: buildCopy.failure.run.configuration.reason + then() }, true],
  ['ConfigurationInvalid', { kind: 'blocked', title: buildCopy.failure.run.configuration.title, reason: buildCopy.failure.run.configuration.reason + then() }, true],
  ['PolicyDenied', { kind: 'policy', title: aiPolicyCopy.title, reason: aiPolicyExplanation('ai_policy_denied') + then() }, true],
  ['ProposalInvalid', { kind: 'blocked', title: buildCopy.failure.failed.implement, reason: buildCopy.failure.run.blocked + then() }, true],
  ['WorkspaceBranchDiverged', { kind: 'blocked', title: buildCopy.failure.failed.implement, reason: buildCopy.failure.run.blocked + then() }, true],
  // A closed proposal admits no new run: no skip, no change, and no sentence offering them.
  ['ProposalClosed', { kind: 'blocked', ...buildCopy.failure.run.proposalClosed }, false],
] as const)('non-retryable known reason %s offers no retry, names who acts and what changes, with its reference', (reason, shown, newRun) => {
  expect(decide({ reason, retryable: false })).toMatchObject({ ...shown, offers: { retry: false, skip: newRun, change: newRun }, reference })
})

test('a known reason never widens: retry always equals retryable; against its usual retryable only the generic wording stands', () => {
  for (const reason of RUN_FAILURE_REASONS) {
    for (const retryable of [true, false]) {
      const failure = decide({ reason, retryable })
      expect(failure.offers?.retry).toBe(retryable)
      expect(failureOffers(failure).retry).toBe(retryable)
    }
  }
  // Quota and interruptions are written for a retry: without one, the generic blocked sentence stands.
  expect(decide({ reason: 'ProviderQuotaExhausted', retryable: false })).toMatchObject({ kind: 'blocked', reason: buildCopy.failure.run.blocked + then(), offers: { retry: false, skip: true, change: true } })
  expect(decide({ reason: 'StreamInterrupted', retryable: false })).toMatchObject({ kind: 'blocked', offers: { retry: false } })
  // A reason written for a blocked run never brings its wording when Platform says retryable.
  expect(decide({ reason: 'AccessDenied', retryable: true })).toMatchObject({ kind: 'failed', reason: buildCopy.failure.retry, offers: { retry: true, skip: true, change: true } })
})

test('copy names no reason and no internal term in either language', () => {
  for (const language of ['ja', 'en'] as const) {
    setLanguage(language)
    for (const reason of RUN_FAILURE_REASONS) {
      for (const retryable of [true, false]) {
        const { title, reason: sentence } = decide({ reason, retryable })
        expect(`${title} ${sentence}`).not.toMatch(/retryable|failure|Reason|Proposal(?:Closed|Pending|Invalid)|Configuration|AccessDenied|InputRequired|Platform API/)
        if (language === 'en') expect(sentence).not.toMatch(/\.\S|\s{2}/)
      }
    }
  }
})

test('without failure (older Platform, unreadable failure, cancelled run) the run reads exactly as before', () => {
  const legacy = (failureReason?: Parameters<typeof failedRun>[1]) => classifyBuildFailure(failedRun(undefined, failureReason).error!, undefined, 'implement', reference, undefined, undefined, failureReason ? { kind: 'known', value: failureReason } : undefined)
  for (const failureReason of [undefined, 'TaskFailed', 'StreamInterrupted', 'InputRequired'] as const) {
    const failure = decide(undefined, failureReason)
    expect(failure).toEqual(legacy(failureReason))
    expect(failure.offers).toBeUndefined()
  }
  // Today the text rules still decide: the policy code wins and takes both actions away.
  expect(failureOffers(decide(undefined, 'TaskFailed'))).toEqual({ retry: false, skip: false, change: false })
  const cancelled = classifyRunFailure({ ...failedRun({ reason: 'TaskFailed', retryable: true }), status: { kind: 'known', value: 'cancelled' }, error: undefined }, undefined, 'stopped', reference)
  expect(cancelled.offers).toBeUndefined()
  // As today, no change instruction starts a run while a failure without Platform's decision is shown.
  expect(failureOffers({ kind: 'quota', title: '', reason: '' })).toEqual({ retry: true, skip: false, change: false })
  expect(failureOffers({ kind: 'failed', title: '', reason: '' })).toEqual({ retry: true, skip: true, change: false })
  expect(failureOffers({ kind: 'unconfirmed', title: '', reason: '' })).toEqual({ retry: false, skip: false, change: false })
})

test.each([
  'Codex task failed: Codex error: stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at <REDACTED>',
  'Provider error: insufficient_quota',
  'You exceeded your current quota, please check your plan and billing details.',
])('provider allowance exhaustion is distinct in every AI context: %s', (message) => {
  for (const context of ['turn', 'plan', 'implement'] as const) {
    expect(classifyBuildFailure(message, 429, context)).toEqual({ kind: 'quota', ...buildCopy.failure.quota, raw: message })
  }
  for (const reason of ['TaskFailed', 'StreamInterrupted', 'RuntimeUnavailable'] as const) {
    expect(classifyBuildFailure(message, 503, 'implement', undefined, undefined, undefined, { kind: 'known', value: reason })).toEqual({ kind: 'quota', ...buildCopy.failure.quota, raw: message })
  }
  expect(buildCopy.failure.quota).toEqual({
    title: 'AI の利用枠が切れています',
    reason: '管理者に AI の利用枠の回復を依頼してください。回復後に、もう一度試すボタンを押すと止まったところから再開できます。Excel や入力内容の問題ではありません。',
  })
  setLanguage('en')
  expect(classifyBuildFailure(message, undefined, 'turn')).toMatchObject({
    title: 'AI usage allowance has run out',
    reason: 'Ask your administrator to restore the AI allowance. Once restored, press the retry button to continue from where work stopped. This is not a problem with your Excel file or input.',
  })
})

test.each([
  'Rate limit reached for requests',
  'Too many requests',
  'Codex error: stream disconnected before completion',
  'conversation turn limit 50 reached',
])('unrelated limits and transport failures are not account exhaustion: %s', (message) => {
  for (const context of ['turn', 'plan', 'implement'] as const) {
    expect(classifyBuildFailure(message, 429, context).kind).not.toBe('quota')
  }
})

test('a policy code named only in the error text keeps the structured policy name', () => {
  const failure = classifyBuildFailure('workspace: ai_policy_denied', 412, 'implement', undefined, undefined, undefined, undefined, { policy: 'named-policy' })
  expect(failure).toMatchObject({ kind: 'policy', reason: aiPolicyExplanation('ai_policy_denied', 'named-policy') })
  expect(failure.reason).toContain('「named-policy」')
})

test.each([
  ['ai_policy_pending', '適用待ち'],
  ['ai_policy_denied', 'AI の利用が許可されていません'],
  ['ai_model_denied', '利用できるモデルが許可されていません'],
  ['ai_model_unresolved', '利用できるモデルが許可されていません'],
  ['ai_approval_policy_denied', '自動実行（unattended）が許可されていません'],
] as const)('structured %s takes precedence over runtime, quota, status and legacy reasons', (reason, explanation) => {
  const raw = 'ai_model_denied: forbidden workspace insufficient_quota'
  for (const context of ['turn', 'plan', 'prepare', 'implement', 'publish'] as const) {
    const failure = classifyBuildFailure(raw, 412, context, undefined, 'failed_precondition', undefined, { kind: 'known', value: 'RuntimeUnavailable' }, { reason, policy: 'default' })
    expect(failure).toMatchObject({ kind: 'policy', raw, reason: aiPolicyExplanation(reason, 'default') })
    expect(failure.reason).toContain('「default」')
    expect(failure.reason).toContain(explanation)
    expect(failure.reason).toContain('基盤の担当者に確認してください')
    expect(failure.reason).not.toMatch(/もう一度|5 分/)
  }
})

test.each(['ai_policy_pending', 'ai_model_unresolved', 'ai_approval_policy_denied'])('legacy %s diagnostics also classify as policy', (reason) => {
  expect(classifyBuildFailure(`workspace: ${reason}`, 412, 'implement').kind).toBe('policy')
})

test('non-policy availability reasons keep the existing runtime copy', () => {
  for (const reason of ['runtime', 'credential']) {
    expect(classifyBuildFailure('unavailable', 412, 'turn', undefined, undefined, undefined, undefined, { reason })).toMatchObject({ kind: 'unavailable', ...buildCopy.failure.unavailable })
    expect(aiPolicyExplanation(reason)).toBeUndefined()
  }
  setLanguage('en')
  const failure = classifyBuildFailure('unavailable', 412, 'turn', undefined, undefined, undefined, undefined, { reason: 'ai_approval_policy_denied', policy: 'default' })
  expect(failure.reason).toContain('“default” does not allow unattended execution.')
  expect(failure.reason).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
})

test('a validation that names a taken repository or URL is the name choice, not a plan to make again', () => {
  const repository = planRejectionFailure(['name already exists: mitsumori: GitHub repository acme/mitsumori already exists. Choose a different repository name.'])
  expect(repository).toMatchObject({ kind: 'name-taken', title: buildCopy.failure.nameTaken, suggestedName: 'mitsumori-2' })
  const url = planRejectionFailure(['Launch needs changes before resources can be created.', 'Another publish already uses this URL.'])
  expect(url).toMatchObject({ kind: 'name-taken', reasonCode: 'PublishURLConflict', title: buildCopy.failure.urlNameTaken })
  expect(url.reference).toBeUndefined()
})

test('a plan for another destination is made again; no reason code is needed and no reference is offered', () => {
  const reference = { draftId: 'd', at: '2026-11-15T00:00:00Z' }
  expect(planRejectionFailure(['The request does not match the Project repository destination.'], reference)).toMatchObject({ kind: 'plan', plan: 'destination', ...buildCopy.failure.plan.destination })
  const unbound = planRejectionFailure(['Creation plan needs changes before AppThrust tools can run.', 'Validate a repository destination before approving this creation plan.'], reference)
  expect(unbound.reference).toBeUndefined()
  expect(unbound.recheck).toBeUndefined()
  // A destination Platform calls unusable may be fixed by an administrator, outside the plan: the same plan may be checked again.
  expect(planRejectionFailure(['Image access is not ready for the repository destination.'], reference)).toMatchObject({ kind: 'plan', plan: 'destination', recheck: true })
})

test('a validation answer with a reason this console does not know is the platform failure with its reference; the same plan may be checked again', () => {
  const reference = { draftId: 'd', at: '2026-11-15T00:00:00Z' }
  const lines = ['Creation plan needs changes before AppThrust tools can run.', 'Tool sequence appthrust.database.attach is not supported by this Platform.']
  const failure = planRejectionFailure(lines, reference)
  expect(failure).toMatchObject({ kind: 'platform', ...buildCopy.failure.platform, reference, recheck: true, raw: lines.join('\n') })
  expect(failure.plan).toBeUndefined()
})

test('a failed request in the plan context keeps its class: the plan\'s field names are read only in a generation\'s stored error', () => {
  const reference = { draftId: 'd', at: '2026-11-15T00:00:00Z' }
  const text = "'creationPlan.applicationStackRequest' is required"
  for (const status of [500, 400]) expect(classifyBuildFailure(text, status, 'plan', reference)).toMatchObject({ kind: 'platform', reference })
  expect(classifyBuildFailure(text, undefined, 'plan', reference)).toMatchObject({ kind: 'plan', plan: 'incomplete' })
})

test('plan generations stopped by Platform\'s plan check read as the plan to make again; an unset destination as the destination notice', () => {
  expect(classifyBuildFailure("invalid_argument: 'creationPlan.summary' is required", undefined, 'plan', { draftId: 'd', at: '2026-11-15T00:00:00Z' })).toMatchObject({ kind: 'plan', plan: 'incomplete' })
  expect(classifyBuildFailure('conflict: Validate a repository destination before approving this creation plan.', undefined, 'plan')).toMatchObject({ kind: 'plan', plan: 'destination' })
  const blocked = classifyBuildFailure('failed_precondition: No repository destination is configured.', undefined, 'plan', { draftId: 'd', at: '2026-11-15T00:00:00Z' })
  expect(blocked).toMatchObject({ kind: 'destination', destination: 'blocked', ...buildCopy.failure.destination.blocked })
  expect(blocked.reference).toBeUndefined()
  // Platform #6919's early generation failures: an unset or ambiguous destination waits for an administrator; a direct
  // template stack (no longer valid) is a plan to make again, here and as a validation static error.
  const templateStack = "'creationPlan.applicationStackRequest.source.kind' must not be github-template; request a new repository through 'creationPlan.applicationSourceRepositoryRequest'"
  expect(classifyBuildFailure('failed_precondition: Multiple repository destinations are available; ask a Project administrator to select a default.', undefined, 'plan')).toMatchObject({ kind: 'destination', destination: 'blocked' })
  expect(classifyBuildFailure(`invalid_argument: ${templateStack}`, undefined, 'plan')).toMatchObject({ kind: 'plan', plan: 'incomplete' })
  expect(planRejectionFailure(['Creation plan needs changes before AppThrust tools can run.', templateStack])).toMatchObject({ kind: 'plan', plan: 'incomplete' })
  // Other generation failures keep their classes; unknown text is not taken for a plan rejection.
  expect(classifyBuildFailure('application draft plan generation timed out', undefined, 'plan').kind).toBe('timeout')
  expect(classifyBuildFailure('failed_precondition: Some newer Platform reason.', undefined, 'plan').kind).toBe('failed')
})

test('the plan copy is plain in both languages, without Platform\'s words', () => {
  for (const language of ['ja', 'en'] as const) {
    setLanguage(language)
    const copy = buildCopy.failure.plan
    const words = [copy.destination, copy.incomplete].flatMap((item) => [item.title, item.reason]).join(' ')
    expect(words).not.toMatch(/creationPlan|destinationRevision|AppThrust/)
    if (language === 'en') expect(words + copy.recheck + copy.replan).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
    else expect(words).not.toMatch(/問い合わせ番号|あなたの入力や操作の問題ではありません/)
  }
})
