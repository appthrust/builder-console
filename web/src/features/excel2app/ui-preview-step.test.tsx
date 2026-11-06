import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { UiDesign } from '@appthrust/api-schema/platform-api'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
import { buildCopy } from '../../model/build/copy'
import { classifyBuildFailure } from '../../model/build/failure'
import { textJa } from './assistant-copy'
import { designFromReadings } from './design'
import { planApp } from './model'
import { previewTextJa } from './preview-copy'
import { SAMPLE_SETS } from './samples'
import { defaultUiDesign, screenId } from './ui-design'
import { changedScreenId, UiPreviewStep, type UiPreviewStepProps } from './ui-preview-step'
import type { UiPreviewChatMessage } from './use-excel2app-draft'

let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())

const workbook = SAMPLE_SETS.find((sample) => sample.id === 'defects')!.workbooks[0]!
const summary = { id: 'wb-000000000001', fileName: workbook.fileName, sheetCount: 3, rowCount: 28, truncated: false, bytes: 100, digest: 'a'.repeat(64), addedAt: '2026-10-26T00:01:00Z' }
const grids = new Map([[summary.id, workbook]])
const plan = planApp(designFromReadings([{ summary, grid: workbook }]), '不具合管理台帳')
const design: UiDesign = defaultUiDesign(plan)
const ENTITY = '不具合一覧'

const render = (props: Partial<UiPreviewStepProps> = {}) =>
  renderToStaticMarkup(
    <UiPreviewStep
      plan={plan}
      design={design}
      grids={grids}
      messages={[{ role: 'assistant', text: '画面を用意しました。' }]}
      busy={false}
      onSend={() => {}}
      onUndo={() => {}}
      canUndo={false}
      suggestions={['一覧をカード表示に', '状態でグループ化']}
      {...props}
    />,
  )

/** The opening tag of the element carrying `testId`. */
const tagOf = (html: string, testId: string) => {
  const at = html.indexOf(`data-testid="${testId}"`)
  expect(at).toBeGreaterThan(-1)
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1)
}

test('the preview frame and the chat render side by side with the conversation and suggestions', () => {
  const html = render()
  expect(html).toContain(textJa.chat.lead)
  expect(html).toContain('data-testid="excel2app-preview"')
  expect(html).toContain('data-testid="excel2app-ui-preview"')
  expect(html).not.toContain('excel2app-ui-preview-skeleton')
  // The frame and the chat share one height on wide containers; narrow ones stack.
  expect(html).toContain('@2xl:grid-cols-[minmax(0,1fr)_17rem]')
  expect(html).toContain('@2xl:grid-rows-[minmax(0,1fr)]')
  expect(html).toContain(`aria-label="${textJa.chat.messages}"`)
  expect(tagOf(html, 'excel2app-chat-message')).toContain('data-role="assistant"')
  expect(html).toContain('画面を用意しました。')
  expect(html.split('data-testid="excel2app-chat-suggestion"').length - 1).toBe(2)
  expect(tagOf(html, 'excel2app-chat-suggestion')).not.toContain('disabled=""')
  expect(tagOf(html, 'excel2app-chat-undo')).toContain('disabled=""')
  expect(tagOf(html, 'excel2app-chat-input')).toContain(`aria-label="${textJa.chat.input}"`)
  expect(html).not.toContain('excel2app-chat-thinking')
})

test('undo is offered once there is a change to undo', () => {
  expect(tagOf(render({ canUndo: true }), 'excel2app-chat-undo')).not.toContain('disabled=""')
})

test('a running turn shows the typing bubble with the newest activity line and dims the pending message', () => {
  const messages: UiPreviewChatMessage[] = [
    { role: 'assistant', text: '画面を用意しました。' },
    { role: 'user', text: '一覧をカード表示に', pending: true },
  ]
  const html = render({ messages, busy: true, canUndo: true, activityTail: 'reading spec.md\nwriting ui-design.json\n\n' })
  expect(html).toContain('data-testid="excel2app-chat-thinking"')
  expect(html).toContain(textJa.chat.thinking)
  expect(html).toContain('writing ui-design.json')
  expect(html).not.toContain('reading spec.md')
  expect(tagOf(html, 'excel2app-chat-activity')).toContain('aria-hidden="true"')
  const pending = html.slice(html.indexOf('data-state="pending"'))
  expect(pending).toContain('opacity-60')
  expect(pending).toContain(`(${textJa.chat.pending})`)
  // Nothing new can be sent or undone while the turn runs.
  expect(tagOf(html, 'excel2app-chat-send')).toContain('disabled=""')
  expect(tagOf(html, 'excel2app-chat-suggestion')).toContain('disabled=""')
  expect(tagOf(html, 'excel2app-chat-undo')).toContain('disabled=""')
})

test('a failed turn renders as a notice with retry on the last message only', () => {
  const failed: UiPreviewChatMessage = { role: 'assistant', text: 'Codex が応答しませんでした', failed: true }
  const html = render({ messages: [failed, { role: 'user', text: '色を青に' }, failed], onRetry: () => {} })
  expect(html.split('data-state="failed"').length - 1).toBe(2)
  expect(html).toContain(textJa.chat.failed)
  expect(html).toContain('Codex が応答しませんでした')
  expect(html.split('data-testid="excel2app-chat-retry"').length - 1).toBe(1)
  expect(html).toContain(textJa.chat.retry)
  expect(render({ messages: [failed] })).not.toContain('excel2app-chat-retry')
  expect(render({ messages: [failed], onRetry: () => {}, busy: true })).not.toContain('excel2app-chat-retry')
})

test.each(['ja', 'en'] as const)('quota failure in UI chat explains the account problem and retains manual retry in %s', (language) => {
  setLanguage(language)
  for (const error of [
    'Codex task failed: Codex error: stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at <REDACTED>',
    'insufficient_quota',
    'You exceeded your current quota, please check your plan and billing details.',
  ]) {
    const html = render({ messages: [{ role: 'assistant', text: error, failed: true }], onRetry: () => {} })
    expect(html).toContain(buildCopy.failure.quota.title)
    expect(html).toContain(buildCopy.failure.quota.reason)
    expect(html).toContain('excel2app-chat-retry')
    expect(html).not.toContain(error)
  }
})

test('policy failure in UI chat names the policy and does not offer retry', () => {
  const failure = classifyBuildFailure('runtime unavailable', 412, 'turn', undefined, undefined, undefined, undefined, { reason: 'ai_approval_policy_denied', policy: 'default' })
  const html = render({ messages: [{ role: 'assistant', text: failure.reason, failed: true, failure }], onRetry: () => {} })
  expect(html).toContain(failure.title)
  expect(html).toContain(failure.reason)
  expect(html).not.toContain('excel2app-chat-retry')
})

test('created drafts keep preview and history but disable every design action', () => {
  const html = render({ readOnly: true, canUndo: true, messages: [{ role: 'assistant', text: '画面の履歴', failed: true }], onRetry: () => {} })
  expect(html).toContain('data-testid="excel2app-ui-preview"')
  expect(html).toContain('画面の履歴')
  for (const control of ['input', 'send', 'suggestion', 'undo']) {
    expect(tagOf(html, `excel2app-chat-${control}`)).toContain('disabled=""')
  }
  expect(html).not.toContain('excel2app-chat-retry')
  expect(html).not.toContain(textJa.chat.lead)
})

test('before the first design the frame is a skeleton and nothing can be sent', () => {
  const preparing = render({ design: null, busy: true, activityTail: 'deriving screens from spec.md', messages: [] })
  expect(preparing).toContain('data-testid="excel2app-ui-preview-skeleton"')
  expect(preparing).not.toContain('data-testid="excel2app-ui-preview"')
  expect(preparing).toContain(previewTextJa.preparing)
  expect(preparing).toContain('aria-busy="true"')
  // The activity line belongs to the skeleton; the typing bubble does not repeat it.
  expect(preparing.split('deriving screens from spec.md').length - 1).toBe(1)
  expect(preparing).toContain('data-testid="excel2app-ui-preview-activity"')
  expect(tagOf(preparing, 'excel2app-chat-send')).toContain('disabled=""')

  const failed = render({ design: null, messages: [{ role: 'assistant', text: 'タイムアウトしました', failed: true }], onRetry: () => {} })
  expect(failed).toContain(previewTextJa.notReady)
  expect(failed).not.toContain('motion-safe:animate-pulse')
  expect(failed).toContain('data-testid="excel2app-chat-retry"')
  expect(tagOf(failed, 'excel2app-chat-suggestion')).toContain('disabled=""')
})

test('chat copy switches to English', () => {
  setLanguage('en')
  const html = render({ busy: true })
  expect(html).toContain('AI is thinking…')
  expect(html).toContain('aria-label="Conversation"')
})

test('a new design focuses the first shown screen it changed', () => {
  const list = screenId('list', ENTITY)
  const withCards = { ...design, lists: { ...design.lists, [ENTITY]: { ...design.lists[ENTITY], layout: 'cards' as const } } }
  expect(changedScreenId(design, withCards)).toBe(list)
  const form = design.forms[ENTITY]
  expect(changedScreenId(design, { ...design, forms: { ...design.forms, [ENTITY]: { ...form, twoColumns: !form.twoColumns } } })).toBe(screenId('form', ENTITY))
  const renamed = { ...design, screens: design.screens.map((screen) => (screen.id === list ? { ...screen, title: '不具合の一覧' } : screen)) }
  expect(changedScreenId(design, renamed)).toBe(list)
  const dashboard = { ...design, dashboard: { cards: design.dashboard.cards.slice(1) } }
  expect(changedScreenId(design, dashboard)).toBe(design.screens.find((screen) => screen.kind === 'dashboard')?.id)
  // App-wide settings and an identical copy (a re-poll) move nothing.
  expect(changedScreenId(design, { ...design, accent: 'rose', density: 'compact' })).toBeUndefined()
  expect(changedScreenId(design, structuredClone(design))).toBeUndefined()
})
