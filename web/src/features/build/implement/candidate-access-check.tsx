import type { CandidateAccessCheck } from '../../../model/contracts/build'
import { isOneOf } from '../../../model/contracts/build'
import { localized } from '../../../shell/language'

const copy = localized({
  ja: { passed: '今回の変更：利用者の検査に合格（稼働中の版とは別）', failed: '今回の変更：利用者の検査に不合格', unverified: '今回の変更：利用者の検査は未確認' },
  en: { passed: 'Candidate: passed access check (not the running version)', failed: 'Candidate: failed access check', unverified: 'Candidate: access check unverified' },
})

export function CandidateAccessCheckStatus({ check }: { check?: CandidateAccessCheck }) {
  if (!check) return null
  const complete = check.criteria.length > 0 && check.criteria.every((criterion) => isOneOf(criterion.state, 'passed'))
  const state = isOneOf(check.state, 'passed') && complete ? 'passed' : isOneOf(check.state, 'failed') ? 'failed' : 'unverified'
  return <p className="mt-1 text-xs text-stone-600" data-testid="candidate-access-check">{copy[state]}</p>
}
