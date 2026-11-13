// Test seam: proposal domain values made from wire fixtures by the production
// contract, never by casting a literal to a domain type. A fixture the
// contract rejects fails the test that uses it.
import type { Proposal } from '../../model/contracts/proposal'
import { decodeResponse } from '../boundary'
import { getSourceChangeProposalContract } from '../contracts/platform/proposal'

/** A Platform `SourceChangeProposal` wire value as the Go converter marshals it (dto_source_change_proposal.go). */
export function proposalWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'proposal-1', projectId: 'commerce', applicationId: 'mitsumori', sourceRepositoryId: 'mitsumori-src',
    proposer: 'sub-sato', reviewers: ['sub-yamada'], title: '一覧に絞り込みを足す', summary: '状態で絞り込めるようにします。',
    tasks: [{ title: '絞り込みを足す', description: '一覧の上に状態の絞り込みを置きます。', acceptanceCriteria: ['状態で絞り込める'] }],
    base: { kind: 'GitCommit', gitCommit: { sha: 'a'.repeat(40) } },
    head: { kind: 'GitBranch', name: 'appthrust/proposal/draft-1' },
    headRevision: { kind: 'GitCommit', gitCommit: { sha: 'b'.repeat(40) } },
    change: { files: 1, additions: 2, deletions: 1 },
    phase: 'Proposed', originDraftId: 'draft-1', previewWorkspaceId: 'ws-1',
    decisions: [], createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:05:00Z',
    ...overrides,
  }
}

export function proposalOf(wire: unknown): Proposal {
  const result = decodeResponse(getSourceChangeProposalContract, wire)
  if (!result.ok) throw new Error(`proposal fixture does not match its contract: ${result.error.issues.map((issue) => `${issue.code} ${issue.path}`).join(', ')}`)
  return result.value
}
