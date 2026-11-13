import { isOneOf } from '../../model/contracts/build'
import type { OpenValue } from '../../api/boundary'
import type { Proposal, ProposalPhase } from '../../model/contracts/proposal'

/** Closed for good. A phase this console does not know is not closed. */
export function proposalTerminal(phase: OpenValue<ProposalPhase>): boolean {
  return isOneOf(phase, 'Applied', 'Rejected', 'Withdrawn', 'Expired')
}

/** Waiting for the owners or for the apply. A phase this console does not know is not known to be waiting. */
export function proposalWaiting(phase: OpenValue<ProposalPhase>): boolean {
  return isOneOf(phase, 'Proposed', 'Accepted', 'Applying')
}

/**
 * Whether an improvement session with a proposal may not take new changes:
 * the proposal is not read yet, awaits review or apply, is closed, or is in a
 * phase this console does not know (never read as open for changes).
 */
export function improvementLocked(phase: OpenValue<ProposalPhase> | undefined): boolean {
  return !phase || phase.kind === 'unknown' || proposalWaiting(phase) || proposalTerminal(phase)
}

/**
 * What the caller may do as a reviewer:
 * - `review`: decide (Accept, RequestChanges, Reject);
 * - `unsupported`: the caller reviews this proposal, but its phase, a decision
 *   or a revision is something this console does not know, so it cannot say
 *   what a decision would approve: the actions are shown disabled;
 * - `none`: not a reviewer, or the proposal is not awaiting review.
 * Authority is the principal subject: a reviewer is never matched by name.
 */
export type ReviewGate = 'review' | 'unsupported' | 'none'

export function reviewGate(proposal: Proposal, subject: string): ReviewGate {
  if (!proposal.reviewers.includes(subject)) return 'none'
  if (proposal.phase.kind === 'unknown') return 'unsupported'
  if (proposal.phase.value !== 'Proposed') return 'none'
  const unknownRevision = [proposal.base, proposal.head, proposal.headRevision].some((revision) => revision?.kind === 'unsupported')
  const unknownDecision = proposal.decisions.some((decision) => decision.decision.kind === 'unknown')
  return unknownRevision || unknownDecision ? 'unsupported' : 'review'
}

export function requestedChanges(proposal: Proposal): string | undefined {
  return isOneOf(proposal.phase, 'ChangesRequested')
    ? [...proposal.decisions].reverse().find((decision) => isOneOf(decision.decision, 'RequestChanges'))?.comment
    : undefined
}
