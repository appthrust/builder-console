import { afterEach, beforeEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../test/language'
import { turnOf } from '../../api/testing/build-domain'
import { buildCopy } from '../../model/build/copy'
import { aiPolicyExplanation } from '../../copy/ai-policy'
import { classifyBuildFailure } from '../../model/build/failure'
import { setLanguage } from '../../shell/language'
import { text } from './copy'
import { AnalysingStep } from './page'

let restoreLanguage: () => void
beforeEach(() => { restoreLanguage = preserveLanguage() })
afterEach(() => restoreLanguage())

test.each(['ja', 'en'] as const)('analysis quota failures offer retry after administrator recovery, not Excel changes in %s', (language) => {
  setLanguage(language)
  for (const error of [
    'Codex task failed: Codex error: stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at <REDACTED>',
    'Provider error: insufficient_quota',
    'You exceeded your current quota, please check your plan and billing details.',
  ]) {
    const html = renderToStaticMarkup(<AnalysingStep problem="failed" error={error} codexAvailable canContinueOffline={false} onRetry={() => {}} onOffline={() => {}} />)
    expect(html).toContain('excel2app-analysis-quota')
    expect(html).toContain(buildCopy.failure.quota.title)
    expect(html).toContain(buildCopy.failure.quota.reason)
    expect(html).not.toContain(text.analysis.failedTitle)
    expect(html).not.toContain(text.analysis.failedBody)
    expect(html).toContain('excel2app-analysis-retry')
    expect(html).not.toContain(error)
  }
})

test('a quota rejection before a turn starts has the same notice and manual retry', () => {
  const html = renderToStaticMarkup(<AnalysingStep problem="quota" codexAvailable={false} canContinueOffline onRetry={() => {}} onOffline={() => {}} />)
  expect(html).toContain(buildCopy.failure.quota.title)
  expect(html).toContain('excel2app-analysis-retry')
  expect(html).not.toContain('excel2app-offline')
  expect(html).not.toContain(text.analysis.unavailableBody)
})

test('ordinary analysis failure retains the existing Excel recovery', () => {
  const html = renderToStaticMarkup(<AnalysingStep problem="failed" error="No readable sheets" codexAvailable canContinueOffline={false} onRetry={() => {}} onOffline={() => {}} />)
  expect(html).toContain(text.analysis.failedTitle)
  expect(html).toContain(text.analysis.failedBody)
  expect(html).toContain('excel2app-analysis-retry')
  expect(html).not.toContain('excel2app-analysis-quota')
})

test('failed-stage progress retains completed and reused files for a continue retry', () => {
  const workbooks = ['April.xlsx', 'May.xlsx', 'Customers.xlsx'].map((fileName, index) => ({ id: `wb-${String(index + 1).padStart(12, '0')}`, fileName, sheetCount: 1, rowCount: 3, bytes: 100, digest: 'a'.repeat(64), truncated: false, addedAt: '2026-11-01T00:00:00Z' }))
  const turn = {
    id: 'turn-1', kind: 'excel-analysis' as const, userMessage: 'Analyze workbooks', status: 'failed' as const, startedAt: '2026-11-01T00:01:00Z', devWorkspaceId: 'ws-1',
    excelProgress: { stage: 'reading' as const, workbooks: workbooks.map((workbook, index) => ({ workbookId: workbook.id, state: (['reused', 'read', 'failed'] as const)[index]! })) },
  }
  const html = renderToStaticMarkup(<AnalysingStep workbooks={workbooks} turn={turnOf(turn)} problem="failed" error="Reading stopped" codexAvailable canContinueOffline={false} onRetry={() => {}} onOffline={() => {}} />)
  for (const state of ['reused', 'read', 'failed']) expect(html).toContain(`data-state="${state}"`)
  expect(html).toContain('data-stage="reading"')
  expect(html).toContain('excel2app-analysis-retry')
  expect(html).not.toContain('excel2app-offline')
})

test('designing comes from persisted progress and a 412 never silently offers offline when AI is available', () => {
  const turn = { id: 'turn-1', kind: 'excel-analysis' as const, userMessage: 'Analyze workbooks', status: 'running' as const, startedAt: '2026-11-01T00:01:00Z', devWorkspaceId: 'ws-1', excelProgress: { stage: 'designing' as const, workbooks: [] } }
  expect(renderToStaticMarkup(<AnalysingStep turn={turnOf(turn)} codexAvailable canContinueOffline={false} onRetry={() => {}} onOffline={() => {}} />)).toContain('data-stage="designing"')
  const html = renderToStaticMarkup(<AnalysingStep problem="unavailable" codexAvailable canContinueOffline onRetry={() => {}} onOffline={() => {}} />)
  expect(html).toContain('excel2app-analysis-retry')
  expect(html).not.toContain('excel2app-offline')
})

test.each(['ai_policy_pending', 'ai_policy_denied', 'ai_model_denied', 'ai_model_unresolved', 'ai_approval_policy_denied'] as const)('analysis availability explains %s and retains offline continuation without retry', (reason) => {
  const html = renderToStaticMarkup(<AnalysingStep codexAvailable={false} codexUnavailableReason={reason} codexPolicy="default" canContinueOffline onRetry={() => {}} onOffline={() => {}} />)
  expect(html).toContain(aiPolicyExplanation(reason, 'default')!)
  expect(html).toContain('excel2app-offline')
  expect(html).not.toContain('excel2app-analysis-retry')
  expect(html).not.toContain(text.analysis.noRuntimeBody)
})

test('an admission policy error wins over stale available tools and does not offer retry', () => {
  const failure = classifyBuildFailure('runtime unavailable', 412, 'turn', undefined, undefined, undefined, undefined, { reason: 'ai_approval_policy_denied', policy: 'default' })
  const html = renderToStaticMarkup(<AnalysingStep problem="policy" failure={failure} codexAvailable canContinueOffline={false} onRetry={() => {}} onOffline={() => {}} />)
  expect(html).toContain(failure.reason)
  expect(html).toContain('excel2app-analysis-policy')
  expect(html).not.toContain('excel2app-analysis-retry')
  expect(html).not.toContain('excel2app-offline')
})
