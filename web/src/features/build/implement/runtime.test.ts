import { expect, test } from 'bun:test'
import type { ApplicationDraftImplementationTask, DevWorkspaceRead } from '@appthrust/api-schema/platform-api'
import { taskOf, workspaceOf } from '../../../api/testing/build-domain'
import * as model from './runtime'

const implementationPreviewUrl = (workspace: unknown) => model.implementationPreviewUrl(workspaceOf(workspace))
const previewDatabaseStatus = (workspace: unknown, tasks: readonly unknown[]) => model.previewDatabaseStatus(workspaceOf(workspace), tasks.map(taskOf))

test('only Ready workspaces expose a same-origin preview', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://console.test' } } })
  try {
    const workspace: DevWorkspaceRead = {
      id: 'ws-1', projectId: 'p1', scope: 'application', applicationId: 'app-1', displayName: '見積',
      ownerUserId: 'owner', phase: 'Ready', branchName: 'main', baseRef: 'main', createdAt: '2026-10-10T00:00:00Z', conditions: [],
      previewUrl: 'https://platform.test/api/v1/projects/p1/dev-workspaces/ws-1/proxy/preview/',
    }
    expect(implementationPreviewUrl(workspace)).toBe('/api/v1/projects/p1/dev-workspaces/ws-1/proxy/preview/')
    expect(implementationPreviewUrl({ ...workspace, phase: 'Starting' })).toBeUndefined()
    expect(implementationPreviewUrl({ ...workspace, phase: 'Sleeping' })).toBeUndefined()
    expect(implementationPreviewUrl({ ...workspace, previewUrl: undefined })).toBeUndefined()
    expect(() => implementationPreviewUrl({ ...workspace, previewUrl: 'https://other.test/preview' })).toThrow('outside the Platform API proxy')
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

const workspace: DevWorkspaceRead = {
  id: 'ws-1', projectId: 'p1', scope: 'applicationDraft', draftId: 'draft-1', displayName: '点検',
  ownerUserId: 'owner', phase: 'Ready', branchName: 'main', baseRef: 'main', conditions: [],
}
const readySince = '2026-10-31T01:00:00Z'
const ready: DevWorkspaceRead = {
  ...workspace,
  previewDatabase: { engine: 'PostgreSQL', ready: true, reason: 'PreviewDatabaseReady', resetGeneration: 0 },
  conditions: [{ type: 'PreviewDatabaseReady', status: 'True', reason: 'PreviewDatabaseReady', lastTransitionTime: readySince }],
}
function task(reportedAt: string, criteria: { criterion: string; met: boolean; note?: string }[]): ApplicationDraftImplementationTask {
  return { id: `task-${reportedAt}`, title: '一覧', status: 'done', verification: { reportedAt, criteria, repairAttempts: 0 } }
}

test('a workspace without a preview database is none', () => {
  expect(previewDatabaseStatus(workspace, [])).toBe('none')
})

test.each([
  ['Pending', 'starting'], ['PreviewDatabaseProvisioning', 'starting'], ['PreviewDatabaseStarting', 'starting'],
  ['PreviewDatabaseResetting', 'starting'], ['StorageVolumeProvisioning', 'starting'],
  ['PreviewDatabaseUnavailable', 'unavailable'], ['PreviewDatabaseUnsupported', 'unavailable'],
  ['WorkspaceSleeping', 'sleeping'], ['WorkspaceStopped', 'sleeping'], ['BudgetExceeded', 'unavailable'], [undefined, 'unavailable'],
] as const)('not ready because of %s is %s', (reason, status) => {
  expect(previewDatabaseStatus({ ...workspace, previewDatabase: { engine: 'PostgreSQL', ready: false, reason, resetGeneration: 0 } }, [])).toBe(status)
})

test('ready is only connectivity until the latest report confirms rows or totals', () => {
  expect(previewDatabaseStatus(ready, [])).toBe('ready-unverified')
  const counted = task('2026-10-31T02:00:00Z', [{ criterion: '一覧に Excel の行が出る', met: true, note: '取引: 120 行（見出しを除く）' }])
  expect(previewDatabaseStatus(ready, [counted])).toBe('ready-verified')
  expect(previewDatabaseStatus(ready, [task('2026-10-31T02:00:00Z', [{ criterion: 'Totals match', met: true, note: 'Total amount 1,234,000 matches the sheet' }])])).toBe('ready-verified')
  // Unmet, note-less or plan-like criteria prove nothing about the data.
  expect(previewDatabaseStatus(ready, [task('2026-10-31T02:00:00Z', [{ criterion: '件数', met: false, note: '取引: 120 行' }])])).toBe('ready-unverified')
  expect(previewDatabaseStatus(ready, [task('2026-10-31T02:00:00Z', [{ criterion: '一覧が表示される', met: true }])])).toBe('ready-unverified')
  expect(previewDatabaseStatus(ready, [task('2026-10-31T02:00:00Z', [{ criterion: '一覧が表示される', met: true, note: '画面を確認した' }])])).toBe('ready-unverified')
  // Only the latest report counts.
  expect(previewDatabaseStatus(ready, [counted, task('2026-10-31T03:00:00Z', [{ criterion: '色が青', met: true, note: '確認した' }])])).toBe('ready-unverified')
  // A report from before the database became ready (a reset or restart since) is stale.
  expect(previewDatabaseStatus(ready, [task('2026-10-31T00:30:00Z', [{ criterion: '件数', met: true, note: '120 rows' }])])).toBe('ready-unverified')
})
