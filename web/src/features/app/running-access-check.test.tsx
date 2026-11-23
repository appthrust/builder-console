import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { publishReader } from '../../api/contracts/platform/app'
import type { RunningAccessCheck } from '../../model/contracts/app'
import { runningAccessCheckState, RunningAccessCheckStatus } from './running-access-check'

const artifactDigest = `sha256:${'a'.repeat(64)}`
const passed: RunningAccessCheck = {
  state: { kind: 'known', value: 'passed' }, reason: { kind: 'known', value: 'AllServingVersionsPassed' },
  checkedAt: '2026-11-23T00:00:00Z', policyRevision: 'app-access/v1',
  servingVersions: [{ releaseId: 'revision-one', artifactDigest, commitSha: 'b'.repeat(40), sourceDigest: `sha256:${'c'.repeat(64)}` }],
}

test('only a nonempty complete current-policy serving proof displays passed', () => {
  expect(runningAccessCheckState(passed)).toBe('passed')
  for (const check of [undefined, { ...passed, servingVersions: [] }, { ...passed, checkedAt: undefined },
    { ...passed, policyRevision: 'old' }, { ...passed, state: { kind: 'unknown' } as const },
    { ...passed, reason: { kind: 'known', value: 'ProvenanceMismatch' } as const },
    { ...passed, servingVersions: [...passed.servingVersions, { releaseId: 'unverified-revision', artifactDigest: '' }] },
  ]) expect(runningAccessCheckState(check)).toBe('unverified')
})

test('digest mismatch and a failed refresh remove the passed display', () => {
  expect(renderToStaticMarkup(<RunningAccessCheckStatus check={passed} observedDigest={artifactDigest} />)).toContain('data-state="passed"')
  expect(renderToStaticMarkup(<RunningAccessCheckStatus check={passed} observedDigest={`sha256:${'d'.repeat(64)}`} />)).not.toContain('data-state="passed"')
  expect(renderToStaticMarkup(<RunningAccessCheckStatus check={passed} unavailable />)).not.toContain('data-state="passed"')
  expect(renderToStaticMarkup(<RunningAccessCheckStatus />)).toContain('data-state="unverified"')
})

test('public-only is not a protected-access pass', () => {
  const check: RunningAccessCheck = { state: { kind: 'known', value: 'notApplicable' }, reason: { kind: 'known', value: 'PublicOnly' }, servingVersions: [] }
  expect(runningAccessCheckState(check)).toBe('notApplicable')
  expect(renderToStaticMarkup(<RunningAccessCheckStatus check={check} />)).not.toContain('data-state="passed"')
})

test('old API omissions and unknown states/reasons stay unverified', () => {
  const publish = { id: 'web', applicationId: 'app', branchId: 'production', componentId: 'web' }
  expect(publishReader.parse(publish).runningAccessCheck).toBeUndefined()
  const wire = { ...passed, state: 'future-state', reason: 'future-reason' }
  const check = publishReader.parse({ ...publish, runningAccessCheck: wire }).runningAccessCheck
  expect(check?.state).toEqual({ kind: 'unknown' })
  expect(check?.reason).toEqual({ kind: 'unknown' })
  expect(runningAccessCheckState(check)).toBe('unverified')
  expect(publishReader.safeParse({ ...publish, runningAccessCheck: { ...wire, servingVersions: null } }).success).toBe(false)
})
