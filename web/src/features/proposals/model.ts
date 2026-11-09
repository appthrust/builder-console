import type { SourceChangeProposal, SourceChangeProposalPhase, SourceRevision } from '@appthrust/api-schema/platform-api'
import type { ConsoleStatus } from '../../copy'

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

export type ProposalBranchPreviewState = 'Pending' | 'Building' | 'Ready' | 'Failed' | 'Deleting'

/**
 * The Platform API change-preview fields of a proposal (`origin`,
 * `externalChangeRequest`, `preview`). The published `@appthrust/api-schema`
 * 0.1.1 predates them; the OpenAPI client passes them through untyped.
 */
export type ProposalChangePreview = {
  origin?: { kind: 'ApplicationDraft' | 'ExternalChangeRequest'; name: string }
  externalChangeRequest?: { repository: string; externalId: string; url: string; state?: 'Open' | 'Merged' | 'Closed' }
  preview?: {
    branchId: string
    branchName: string
    state: ProposalBranchPreviewState
    reason?: string
    revision?: SourceRevision
    url?: string
  }
}

export function proposalChangePreview(proposal: SourceChangeProposal): ProposalChangePreview {
  const { origin, externalChangeRequest, preview } = proposal as SourceChangeProposal & ProposalChangePreview
  return { origin, externalChangeRequest, preview }
}

const PREVIEW_STATUS: Record<ProposalBranchPreviewState, ConsoleStatus> = {
  Ready: 'live',
  Building: 'deploying',
  Pending: 'deploying',
  Failed: 'failed',
  Deleting: 'unknown',
}

/** The console status pill for a preview Branch state. */
export function previewStatus(state: ProposalBranchPreviewState): ConsoleStatus {
  return PREVIEW_STATUS[state]
}

const shortSha = (revision: SourceRevision | undefined) => revision?.gitCommit.sha.slice(0, 7)

/**
 * The commit the preview shows versus the proposal's latest head. `newerHead`
 * is set while a newer head is being built and the preview still shows the
 * older pinned commit.
 */
export function previewRevision(
  proposal: SourceChangeProposal,
  preview: NonNullable<ProposalChangePreview['preview']>,
): { pinned?: string; newerHead?: string } {
  const pinned = shortSha(preview.revision)
  const head = shortSha(proposal.headRevision)
  return {
    ...(pinned ? { pinned } : {}),
    ...(pinned && head && preview.revision?.gitCommit.sha !== proposal.headRevision?.gitCommit.sha ? { newerHead: head } : {}),
  }
}
