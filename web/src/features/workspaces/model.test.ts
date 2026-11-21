import { describe, expect, test } from 'bun:test'
import type { BuildDraft } from '../../model/contracts/build'
import type { MyWorkspace, WorkspaceActions, WorkspaceState } from '../../model/contracts/workspace'
import { cleanupSelection, durationLabel, groupWorkspaces, hasPublishedBranch, isIdle, leaseHint, openHref, parseGoDuration, runningCount, sessionWorkspaceId } from './model'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString()
const days = (n: number) => minutes(n * 24 * 60)
const allowed = (overrides: Partial<WorkspaceActions> = {}): WorkspaceActions => ({
  open: true, stop: true, start: false, restart: true, extendLease: true, keepLonger: false, delete: true, commit: true, blockedBy: {}, ...overrides,
})

function row(id: string, state: WorkspaceState | 'future', fields: Partial<MyWorkspace> = {}): MyWorkspace {
  return {
    id, projectId: 'commerce', displayName: id, scope: { kind: 'known', value: 'application' },
    state: state === 'future' ? { kind: 'unknown' } : { kind: 'known', value: state },
    sourceVolume: { state: { kind: 'known', value: 'Retained' } },
    allowedActions: allowed(),
    ...fields,
  }
}

describe('grouping (builder-console.md §2)', () => {
  const rows = [
    row('ready', 'Ready'), row('sleeping', 'Sleeping'), row('degraded', 'Degraded'), row('committing', 'Committing'), row('starting', 'Starting'),
    row('stopped', 'Stopped'), row('retired', 'Retired'), row('failed', 'Failed'), row('deleting', 'Deleting'), row('future', 'future'), row('sleeping-2', 'Sleeping'),
  ]

  test('Running is Ready, Degraded, Committing and Starting; Sleeping alone; everything else in the third group, in server order', () => {
    const groups = groupWorkspaces(rows)
    expect(groups.running.map((workspace) => workspace.id)).toEqual(['ready', 'degraded', 'committing', 'starting'])
    expect(groups.sleeping.map((workspace) => workspace.id)).toEqual(['sleeping', 'sleeping-2'])
    expect(groups.other.map((workspace) => workspace.id)).toEqual(['stopped', 'retired', 'failed', 'deleting', 'future'])
  })

  test('the badge counts running workspaces only; an unknown state is never running', () => {
    expect(runningCount(rows)).toBe(4)
    expect(runningCount([row('future', 'future')])).toBe(0)
  })
})

describe('idle rows and 片づける', () => {
  const idleAfter = '168h0m0s'
  const week = parseGoDuration(idleAfter)!

  test('Go durations parse; anything else does not', () => {
    expect(week).toBe(7 * 24 * 3_600_000)
    expect(parseGoDuration('1h30m')).toBe(90 * 60_000)
    expect(parseGoDuration('0')).toBe(0)
    expect(parseGoDuration('7 days')).toBeUndefined()
    expect(parseGoDuration('')).toBeUndefined()
    expect(durationLabel(week)).toEqual({ unit: 'days', value: 7 })
    expect(durationLabel(36 * 3_600_000)).toEqual({ unit: 'hours', value: 36 })
  })

  test('idle is the server rule: retained, not running, last activity strictly older than idleAfter (none counts as idle)', () => {
    expect(isIdle(row('a', 'Stopped', { lastActivityAt: days(-8) }), NOW, week)).toBe(true)
    expect(isIdle(row('a', 'Stopped', { lastActivityAt: days(-7) }), NOW, week)).toBe(false)
    expect(isIdle(row('a', 'Stopped'), NOW, week)).toBe(true)
    expect(isIdle(row('a', 'Ready', { lastActivityAt: days(-30) }), NOW, week)).toBe(false)
    expect(isIdle(row('a', 'Sleeping', { lastActivityAt: days(-30), sourceVolume: { state: { kind: 'known', value: 'Released' } } }), NOW, week)).toBe(false)
    expect(isIdle(row('a', 'Sleeping', { lastActivityAt: days(-30), sourceVolume: { state: { kind: 'unknown' } } }), NOW, week)).toBe(false)
  })

  test('selects idle Sleeping and Stopped rows the caller may delete, never Retired, Failed or running ones', () => {
    const rows = [
      row('idle-sleeping', 'Sleeping', { lastActivityAt: days(-9) }),
      row('recent-sleeping', 'Sleeping', { lastActivityAt: days(-2) }),
      row('idle-stopped', 'Stopped', { lastActivityAt: days(-12) }),
      row('idle-retired', 'Retired', { lastActivityAt: days(-12) }),
      row('idle-failed', 'Failed', { lastActivityAt: days(-12) }),
      row('not-mine', 'Stopped', { lastActivityAt: days(-12), allowedActions: allowed({ delete: false }) }),
      row('old-actions', 'Stopped', { lastActivityAt: days(-12), allowedActions: undefined }),
    ]
    expect(cleanupSelection(rows, NOW, idleAfter)).toEqual(['idle-sleeping', 'idle-stopped'])
    expect(cleanupSelection(rows, NOW, 'forever')).toEqual([])
  })
})

describe('lease hint (builder-console.md §4)', () => {
  const lease = (expiresAt: string) => ({ ttlSeconds: 3600, expiresAt })

  test('whole minutes left, rounded up', () => {
    expect(leaseHint(row('a', 'Ready', { lease: lease(minutes(12)) }), NOW)).toEqual({ minutes: 12, expired: false, warning: false, canExtend: true })
    expect(leaseHint(row('a', 'Ready', { lease: lease(new Date(NOW + 11 * 60_000 + 1).toISOString()) }), NOW)?.minutes).toBe(12)
  })

  test('warning from five minutes before expiry, and once it has passed', () => {
    expect(leaseHint(row('a', 'Ready', { lease: lease(new Date(NOW + 5 * 60_000 + 1).toISOString()) }), NOW)?.warning).toBe(false)
    expect(leaseHint(row('a', 'Ready', { lease: lease(minutes(5)) }), NOW)).toEqual({ minutes: 5, expired: false, warning: true, canExtend: true })
    expect(leaseHint(row('a', 'Degraded', { lease: lease(minutes(-1)) }), NOW)).toEqual({ minutes: 0, expired: true, warning: true, canExtend: true })
  })

  test('extending follows allowedActions only', () => {
    expect(leaseHint(row('a', 'Ready', { lease: lease(minutes(12)), allowedActions: allowed({ extendLease: false }) }), NOW)?.canExtend).toBe(false)
    expect(leaseHint(row('a', 'Ready', { lease: lease(minutes(12)), allowedActions: undefined }), NOW)?.canExtend).toBe(false)
  })

  test('no hint without a running state or an expiry', () => {
    expect(leaseHint(row('a', 'Sleeping', { lease: lease(minutes(12)) }), NOW)).toBeUndefined()
    expect(leaseHint(row('a', 'future', { lease: lease(minutes(12)) }), NOW)).toBeUndefined()
    expect(leaseHint(row('a', 'Ready', { lease: { ttlSeconds: 3600 } }), NOW)).toBeUndefined()
    expect(leaseHint(row('a', 'Ready', { lease: lease('not a time') }), NOW)).toBeUndefined()
  })
})

describe('where a workspace opens', () => {
  type Draft = Pick<BuildDraft, 'id' | 'kind' | 'activeWorkspaceId' | 'implementationWorkspaceId' | 'devWorkspaceId' | 'implementationRuns'>
  const draft = (id: string, fields: Partial<Draft> = {}): Draft => ({ id, implementationRuns: [], ...fields })
  const run = (devWorkspaceId: string) => ({ devWorkspaceId }) as BuildDraft['implementationRuns'][number]

  test('the AI session using it: improve for an improvement, build otherwise', () => {
    const drafts = [draft('improve-1', { kind: 'improvement', activeWorkspaceId: 'ws-app' }), draft('build-1', { implementationRuns: [run('ws-run')] })]
    expect(openHref(row('ws-app', 'Ready'), drafts)).toBe('/-/improve/improve-1')
    expect(openHref(row('ws-run', 'Sleeping'), drafts)).toBe('/-/build/build-1')
  })

  test('a draft workspace without a listed session opens its draft; anything else has no page', () => {
    expect(openHref(row('ws-1', 'Ready', { scope: { kind: 'known', value: 'applicationDraft' }, draftId: 'draft-9' }), [])).toBe('/-/build/draft-9')
    expect(openHref(row('ws-1', 'Ready', { applicationId: 'mitsumori' }), [])).toBeUndefined()
    expect(openHref(row('ws-1', 'Ready', { scope: { kind: 'unknown' }, draftId: 'draft-9' }), [])).toBeUndefined()
  })

  test("a session page's workspace: latest run first, then active, implementation, conversation", () => {
    expect(sessionWorkspaceId({ implementationRuns: [run('ws-old'), run('ws-new')], activeWorkspaceId: 'ws-active' })).toBe('ws-new')
    expect(sessionWorkspaceId({ implementationRuns: [run('')], activeWorkspaceId: 'ws-active', devWorkspaceId: 'ws-chat' })).toBe('ws-active')
    expect(sessionWorkspaceId({ implementationRuns: [], devWorkspaceId: 'ws-chat' })).toBe('ws-chat')
    expect(sessionWorkspaceId({ implementationRuns: [] })).toBeUndefined()
  })
})

test('a pushed branch or a pull request means the work survives deletion', () => {
  expect(hasPublishedBranch({})).toBe(false)
  expect(hasPublishedBranch({ branchUrl: 'https://github.com/acme/a/tree/x' })).toBe(true)
  expect(hasPublishedBranch({ pullRequestUrl: 'https://github.com/acme/a/pull/1' })).toBe(true)
})
