import type { RunningAccessCheck } from '../../model/contracts/app'
import { isOneOf } from '../../model/contracts/build'
import { localized } from '../../shell/language'

const text = localized({
  ja: {
    passed: '稼働中の版：利用者の検査に合格',
    failed: '稼働中の版：利用者の検査に不合格',
    unverified: '稼働中の版：利用者の検査は未確認',
    notApplicable: '公開専用：利用者の検査は対象外',
  },
  en: {
    passed: 'Running versions: passed access check',
    failed: 'Running versions: failed access check',
    unverified: 'Running versions: access check unverified',
    notApplicable: 'Public-only: access check not applicable',
  },
})

const digest = /^sha256:[0-9a-f]{64}$/
const commit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The server verifies signatures and every serving target. Never infer a pass
 * from a build/task result, desired tag or an old API's missing field. An
 * independently refreshed digest can only veto, not manufacture, a pass. */
export function runningAccessCheckState(check: RunningAccessCheck | undefined, observedDigest?: string) {
  if (!check) return 'unverified'
  if (isOneOf(check.state, 'notApplicable') && isOneOf(check.reason, 'PublicOnly')) return 'notApplicable'
  if (!check.checkedAt || check.policyRevision !== 'app-access/v1' || check.servingVersions.length === 0) return 'unverified'
  const ids = new Set<string>()
  for (const version of check.servingVersions) {
    if (!version.releaseId || ids.has(version.releaseId) || !digest.test(version.artifactDigest) ||
      !version.sourceDigest || !digest.test(version.sourceDigest) || !version.commitSha || !commit.test(version.commitSha)) return 'unverified'
    ids.add(version.releaseId)
  }
  if (observedDigest !== undefined && !check.servingVersions.some((version) => version.artifactDigest === observedDigest)) return 'unverified'
  if (isOneOf(check.state, 'passed') && isOneOf(check.reason, 'AllServingVersionsPassed')) return 'passed'
  if (isOneOf(check.state, 'failed') && isOneOf(check.reason, 'CriterionFailed')) return 'failed'
  return 'unverified'
}

export function RunningAccessCheckStatus({ check, observedDigest, unavailable = false }: {
  check?: RunningAccessCheck; observedDigest?: string; unavailable?: boolean
}) {
  const state = runningAccessCheckState(unavailable ? undefined : check, observedDigest)
  return <div className="mt-3 text-sm text-stone-600" data-testid="running-access-check" data-state={state}>
    <p>{text[state]}</p>
    {(state === 'passed' || state === 'failed') && check ? <details className="mt-1 text-xs">
      <summary>{check.checkedAt}</summary>
      <ul>{check.servingVersions.map((version) => <li key={version.releaseId} className="break-all font-mono">{version.releaseId} · {version.artifactDigest}</li>)}</ul>
    </details> : null}
  </div>
}
