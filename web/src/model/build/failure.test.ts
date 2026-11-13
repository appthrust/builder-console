import { afterEach, expect, test } from 'bun:test'
import { ConsoleApiError } from '../../api/console'
import { setLanguage } from '../../shell/language'
import { buildCopy } from './copy'
import { buildFailureReference, classifyBuildFailure } from './failure'
import { aiPolicyExplanation } from '../../copy/ai-policy'

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
