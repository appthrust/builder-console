// Source change proposal operations behind the proposal screens, the
// improvement session's outcome and the 作りかけ list: list, get, diff and the
// reviewer decision. Readers keep only the fields the console reads
// (canonical leaf schemas; unknown fields dropped) and own two kinds of
// difference:
// - open enums: the proposal phase and each decision kind;
// - open unions: the base / head revision (`SourceRevision`, kind GitCommit)
//   and the head reference (`SourceRef`, kind GitBranch). A new kind becomes
//   `unsupported`; a known kind that is broken (a GitCommit without its sha)
//   fails the answer.
// Nothing is defaulted: the Go converter always writes reviewers, tasks and
// decisions as arrays (platform-api internal/api/dto_source_change_proposal.go:35-36)
// and the list handler starts from an empty `data` (internal/handler/
// source_change_proposal.go:166), so an absent or null collection is a failure,
// never "no reviewers" or "no decisions".
// The decision answer carries the written proposal under `resource`. A
// malformed success answer never becomes a value: the decision may still have
// been recorded, so callers read back, never resend.
import {
  SourceChangeProposal,
  SourceChangeProposalDecision,
  SourceChangeProposalDecisionKind,
  SourceChangeProposalDiffResponse,
  SourceChangeProposalPhase,
  SourceRef,
  SourceRevision,
} from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import type { Proposal, ProposalDecision, ProposalDiff, ProposalList, ProposalRef, ProposalRevision } from '../../../model/contracts/proposal'
import { openUnion } from '../../boundary'
import { platformContract } from '../define'
import { openCanonical } from './build'

const PROPOSALS = '/api/v1/projects/{projectId}/source-change-proposals'
const PROPOSAL = `${PROPOSALS}/{id}`

export const revisionReader: z.ZodType<ProposalRevision> = openUnion({
  discriminator: 'kind',
  identity: z.object({}),
  variants: { GitCommit: SourceRevision.options[0] },
})

export const refReader: z.ZodType<ProposalRef> = openUnion({
  discriminator: 'kind',
  identity: z.object({}),
  variants: { GitBranch: SourceRef.options[0] },
})

export const decisionReader: z.ZodType<ProposalDecision> = SourceChangeProposalDecision.extend({
  decision: openCanonical(SourceChangeProposalDecisionKind),
})

export const proposalReader: z.ZodType<Proposal> = SourceChangeProposal.pick({
  id: true, projectId: true, applicationId: true, proposer: true, reviewers: true, title: true, summary: true, tasks: true,
  change: true, originDraftId: true, previewWorkspaceId: true, updatedAt: true,
}).extend({
  base: revisionReader,
  head: refReader,
  headRevision: revisionReader.optional(),
  phase: openCanonical(SourceChangeProposalPhase),
  decisions: z.array(decisionReader).max(256),
})

export const diffReader: z.ZodType<ProposalDiff> = SourceChangeProposalDiffResponse

const listReader: z.ZodType<ProposalList> = z.object({ data: z.array(proposalReader) })
/** A write's answer: the written proposal (the envelope's operation receipt is not read). */
const resourceReader: z.ZodType<Proposal> = z.object({ resource: proposalReader }).transform(({ resource }) => resource)

export const listSourceChangeProposalsContract = platformContract({
  operationId: 'platformApiListSourceChangeProposals',
  method: 'GET',
  routeTemplate: PROPOSALS,
  successStatuses: [200],
  reader: listReader,
})

export const getSourceChangeProposalContract = platformContract({
  operationId: 'platformApiGetSourceChangeProposal',
  method: 'GET',
  routeTemplate: PROPOSAL,
  successStatuses: [200],
  reader: proposalReader,
})

/** The diff of a proposal whose head is resolved; until then the server answers an error (handler/source_change_proposal.go:496-498), never an empty diff. */
export const getSourceChangeProposalDiffContract = platformContract({
  operationId: 'platformApiGetSourceChangeProposalDiff',
  method: 'GET',
  routeTemplate: `${PROPOSAL}/diff`,
  successStatuses: [200],
  reader: diffReader,
})

/** 200, replayed with the recorded status (platform-api internal/handler/source_change_proposal.go:420). */
export const decideSourceChangeProposalContract = platformContract({
  operationId: 'platformApiDecideSourceChangeProposal',
  method: 'POST',
  routeTemplate: `${PROPOSAL}/decisions`,
  successStatuses: [200],
  reader: resourceReader,
})
