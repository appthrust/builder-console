import type { SourceChangeProposal, SourceChangeProposalPhase } from '@appthrust/api-schema/platform-api'

export function proposalTerminal(phase: SourceChangeProposalPhase): boolean {
  return phase === 'Applied' || phase === 'Rejected' || phase === 'Withdrawn' || phase === 'Expired'
}

export function proposalWaiting(phase: SourceChangeProposalPhase): boolean {
  return phase === 'Proposed' || phase === 'Accepted' || phase === 'Applying'
}

export function canReview(proposal: SourceChangeProposal, subject: string): boolean {
  return proposal.phase === 'Proposed' && proposal.reviewers.includes(subject)
}

export function requestedChanges(proposal: SourceChangeProposal): string | undefined {
  return proposal.phase === 'ChangesRequested'
    ? [...proposal.decisions].reverse().find((decision) => decision.decision === 'RequestChanges')?.comment
    : undefined
}
