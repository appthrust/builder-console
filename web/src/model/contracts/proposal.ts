// Source change proposal domain values that arrive through the response
// boundary (api/contracts/platform/proposal.ts). Feature and model code reads
// these types and the pure operations below, never the wire.
//
// Each type keeps only the fields the console reads (the reader drops the
// rest). The phase and each decision are open values; the base revision, the
// head reference and the head revision are open unions: a kind this console
// does not know is `{ kind: 'unsupported' }`, never read as a known one. Any of
// them unknown means the console cannot say what a review would approve, so it
// offers no review write (features/proposals/model.ts `reviewGate`).
import type {
  SourceChangeProposalDecisionKind,
  SourceChangeProposalPhase,
  SourceChangeProposalTask,
  SourceChangeSummary,
} from '@appthrust/api-schema/platform-api'
import type { OpenValue, Supported } from '../../api/boundary'

export type ProposalPhase = SourceChangeProposalPhase
export type ProposalDecisionKind = SourceChangeProposalDecisionKind
export type ProposalTask = SourceChangeProposalTask
export type ProposalChangeSummary = SourceChangeSummary

/** A source revision; only Git commits are known to this console. */
export type ProposalRevision = Supported<{ kind: 'GitCommit'; gitCommit: { sha: string } }, Record<string, never>>
/** The proposal's head reference; only Git branches are known to this console. */
export type ProposalRef = Supported<{ kind: 'GitBranch'; name: string }, Record<string, never>>

/** One reviewer decision; `subject` is the reviewer's principal subject. */
export interface ProposalDecision {
  subject: string
  decision: OpenValue<ProposalDecisionKind>
  comment?: string
  at: string
}

export interface Proposal {
  id: string
  projectId: string
  applicationId: string
  /** Principal subject of the proposer. */
  proposer: string
  /** Principal subjects allowed to decide; never empty. */
  reviewers: string[]
  title: string
  summary: string
  tasks: ProposalTask[]
  base: ProposalRevision
  head: ProposalRef
  headRevision?: ProposalRevision
  change?: ProposalChangeSummary
  phase: OpenValue<ProposalPhase>
  originDraftId?: string
  previewWorkspaceId?: string
  decisions: ProposalDecision[]
  updatedAt: string
}

export type ProposalList = { data: Proposal[] }

/** The bounded unified diff; `truncated` says it is not the full patch. */
export interface ProposalDiff {
  summary: ProposalChangeSummary
  unifiedDiff: string
  truncated: boolean
}

/** A reviewer's decision as the console sends it (the server assigns actor and time). */
export type ProposalDecisionCommand = { decision: ProposalDecisionKind; comment?: string }

/** The list filters the console asks for. */
export type ProposalListFilters = { applicationId?: string; phase?: ProposalPhase; reviewer?: 'me'; proposer?: 'me' }
