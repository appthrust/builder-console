// X2/X4 wire variants for the source change proposal operations
// (contracts/platform/proposal.ts). Fixtures are the shapes the Go converter
// marshals (platform-api internal/api/dto_source_change_proposal.go; the
// in-memory mock answers the same); each case varies one field. Every
// rejection is also checked for redaction by assertWireContractCases; accepted
// unknown values are checked not to carry the sentinel into the domain value.
import { describe, expect, test } from 'bun:test'
import { proposalWire } from '../../testing/proposal-domain'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import {
  decideSourceChangeProposalContract,
  getSourceChangeProposalContract,
  getSourceChangeProposalDiffContract,
  listSourceChangeProposalsContract,
} from './proposal'

const SECRET = 'SENTINEL-proposal-contract-7e3a'
const at = '2026-11-13T00:01:00Z'
const proposal = proposalWire()
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
const leaksNothing = (value: unknown) => expect(JSON.stringify(value)).not.toContain(SECRET)
const decision = { subject: 'sub-yamada', decision: 'RequestChanges', comment: '担当者でも絞り込みたい', at }
const operation = { id: 'op-1', type: 'sourceChangeProposal.decide', state: 'succeeded', writeChannel: 'A', resource: { kind: 'SourceChangeProposal', id: 'proposal-1', projectId: 'commerce' }, createdAt: at, links: { self: '/api/v1/projects/commerce/source-change-proposals/proposal-1' } }

describe('proposal (platformApiGetSourceChangeProposal)', () => {
  test('wire variants', () => {
    assertWireContractCases(getSourceChangeProposalContract, [
      {
        name: 'the marshalled proposal', variant: 'present', path: '/', wire: proposal,
        expect: { accept: true, check: (value) => {
          expect(value.phase).toEqual({ kind: 'known', value: 'Proposed' })
          expect(value.base).toEqual({ kind: 'supported', value: { kind: 'GitCommit', gitCommit: { sha: 'a'.repeat(40) } } })
          expect(value.head).toEqual({ kind: 'supported', value: { kind: 'GitBranch', name: 'appthrust/proposal/draft-1' } })
          expect(value.reviewers).toEqual(['sub-yamada'])
          expect(value.tasks[0]?.acceptanceCriteria).toEqual(['状態で絞り込める'])
        } },
      },
      // Collections: the converter always writes them (make(..., 0), dto_source_change_proposal.go:35-36); nothing is defaulted.
      { name: 'reviewers are required, never "nobody reviews"', variant: 'absent', path: '/reviewers', wire: without(proposal, 'reviewers'), expect: { accept: false, issues: [{ path: '/reviewers', code: 'missing' }] } },
      { name: 'null reviewers are broken', variant: 'null', path: '/reviewers', wire: { ...proposal, reviewers: null }, expect: { accept: false, issues: [{ path: '/reviewers', code: 'invalid_type' }] } },
      { name: 'an empty reviewer list is broken (a proposal always has a reviewer)', variant: 'empty', path: '/reviewers', wire: { ...proposal, reviewers: [] }, expect: { accept: false, issues: [{ path: '/reviewers', code: 'invalid_value' }] } },
      { name: 'a reviewer that is not a string is broken', variant: 'unknown', path: '/reviewers/*', wire: { ...proposal, reviewers: [{ subject: SECRET }] }, expect: { accept: false, issues: [{ path: '/reviewers/*', code: 'invalid_type' }] } },
      { name: 'no tasks', variant: 'empty', path: '/tasks', wire: { ...proposal, tasks: [] }, expect: { accept: true, check: (value) => expect(value.tasks).toEqual([]) } },
      { name: 'absent tasks are broken', variant: 'absent', path: '/tasks', wire: without(proposal, 'tasks'), expect: { accept: false, issues: [{ path: '/tasks', code: 'missing' }] } },
      { name: 'null tasks are broken', variant: 'null', path: '/tasks', wire: { ...proposal, tasks: null }, expect: { accept: false, issues: [{ path: '/tasks', code: 'invalid_type' }] } },
      { name: 'a task with null criteria is broken (a nil slice)', variant: 'null', path: '/tasks/*/acceptanceCriteria', wire: { ...proposal, tasks: [{ title: 'a', description: 'b', acceptanceCriteria: null }] }, expect: { accept: false, issues: [{ path: '/tasks/*/acceptanceCriteria', code: 'invalid_type' }] } },
      { name: 'no decisions yet', variant: 'empty', path: '/decisions', wire: proposal, expect: { accept: true, check: (value) => expect(value.decisions).toEqual([]) } },
      { name: 'absent decisions are broken, never "nobody decided"', variant: 'absent', path: '/decisions', wire: without(proposal, 'decisions'), expect: { accept: false, issues: [{ path: '/decisions', code: 'missing' }] } },
      { name: 'null decisions are broken', variant: 'null', path: '/decisions', wire: { ...proposal, decisions: null }, expect: { accept: false, issues: [{ path: '/decisions', code: 'invalid_type' }] } },
      { name: 'a decision', variant: 'present', path: '/decisions', wire: { ...proposal, decisions: [decision] }, expect: { accept: true, check: (value) => expect(value.decisions).toEqual([{ subject: 'sub-yamada', decision: { kind: 'known', value: 'RequestChanges' }, comment: '担当者でも絞り込みたい', at }]) } },
      { name: 'a decision without its subject is broken', variant: 'absent', path: '/decisions/*/subject', wire: { ...proposal, decisions: [without(decision, 'subject')] }, expect: { accept: false, issues: [{ path: '/decisions/*/subject', code: 'missing' }] } },
      {
        name: 'an unknown decision kind stays unknown: never Accept, Reject or RequestChanges', variant: 'unknown', path: '/decisions/*/decision',
        wire: { ...proposal, decisions: [{ ...decision, decision: SECRET }] },
        expect: { accept: true, check: (value) => { expect(value.decisions[0]?.decision).toEqual({ kind: 'unknown' }); leaksNothing(value) } },
      },
      // Phase: an open enum.
      { name: 'the phase is required', variant: 'absent', path: '/phase', wire: without(proposal, 'phase'), expect: { accept: false, issues: [{ path: '/phase', code: 'missing' }] } },
      { name: 'a null phase is broken', variant: 'null', path: '/phase', wire: { ...proposal, phase: null }, expect: { accept: false, issues: [{ path: '/phase', code: 'invalid_type' }] } },
      { name: 'an unknown phase stays unknown: never Proposed, Applied or closed', variant: 'unknown', path: '/phase', wire: { ...proposal, phase: SECRET }, expect: { accept: true, check: (value) => { expect(value.phase).toEqual({ kind: 'unknown' }); leaksNothing(value) } } },
      // Revisions and the head reference: open unions.
      { name: 'the base revision is required', variant: 'absent', path: '/base', wire: without(proposal, 'base'), expect: { accept: false, issues: [{ path: '/base', code: 'missing' }] } },
      { name: 'a null base revision is broken', variant: 'null', path: '/base', wire: { ...proposal, base: null }, expect: { accept: false, issues: [{ path: '/base', code: 'invalid_type' }] } },
      { name: 'a known GitCommit without its sha is broken, never unsupported', variant: 'absent', path: '/base/gitCommit/sha', wire: { ...proposal, base: { kind: 'GitCommit', gitCommit: {} } }, expect: { accept: false, issues: [{ path: '/base/gitCommit/sha', code: 'missing' }] } },
      { name: 'a GitCommit sha that is not a hash is broken', variant: 'unknown', path: '/base/gitCommit/sha', wire: { ...proposal, base: { kind: 'GitCommit', gitCommit: { sha: SECRET } } }, expect: { accept: false } },
      {
        name: 'an unknown revision kind is unsupported, its body dropped', variant: 'unknown', path: '/base',
        wire: { ...proposal, base: { kind: SECRET, snapshot: { id: SECRET } }, headRevision: { kind: SECRET } },
        expect: { accept: true, check: (value) => {
          expect(value.base).toEqual({ kind: 'unsupported', identity: {} })
          expect(value.headRevision).toEqual({ kind: 'unsupported', identity: {} })
          leaksNothing(value)
        } },
      },
      { name: 'a revision kind that is not a string is broken', variant: 'unknown', path: '/base/kind', wire: { ...proposal, base: { kind: 7 } }, expect: { accept: false, issues: [{ path: '/base/kind', code: 'invalid_type' }] } },
      { name: 'the head reference is required', variant: 'absent', path: '/head', wire: without(proposal, 'head'), expect: { accept: false, issues: [{ path: '/head', code: 'missing' }] } },
      { name: 'a known GitBranch without its name is broken', variant: 'absent', path: '/head/name', wire: { ...proposal, head: { kind: 'GitBranch' } }, expect: { accept: false, issues: [{ path: '/head/name', code: 'missing' }] } },
      { name: 'an unknown head kind is unsupported', variant: 'unknown', path: '/head', wire: { ...proposal, head: { kind: SECRET, name: SECRET } }, expect: { accept: true, check: (value) => { expect(value.head).toEqual({ kind: 'unsupported', identity: {} }); leaksNothing(value) } } },
      { name: 'no head revision yet (Go omitempty pointer): not resolved', variant: 'absent', path: '/headRevision', wire: without(proposal, 'headRevision'), expect: { accept: true, check: (value) => expect(value.headRevision).toBeUndefined() } },
      { name: 'a null head revision is broken', variant: 'null', path: '/headRevision', wire: { ...proposal, headRevision: null }, expect: { accept: false, issues: [{ path: '/headRevision', code: 'invalid_type' }] } },
      // Identity and optional observations.
      { name: 'an id that is not a DNS label is broken', variant: 'unknown', path: '/id', wire: { ...proposal, id: SECRET }, expect: { accept: false } },
      { name: 'the proposer is required', variant: 'absent', path: '/proposer', wire: without(proposal, 'proposer'), expect: { accept: false, issues: [{ path: '/proposer', code: 'missing' }] } },
      { name: 'no change summary yet', variant: 'absent', path: '/change', wire: without(proposal, 'change'), expect: { accept: true, check: (value) => expect(value.change).toBeUndefined() } },
      { name: 'a null change summary is broken', variant: 'null', path: '/change', wire: { ...proposal, change: null }, expect: { accept: false, issues: [{ path: '/change', code: 'invalid_type' }] } },
      { name: 'no preview workspace', variant: 'absent', path: '/previewWorkspaceId', wire: without(proposal, 'previewWorkspaceId'), expect: { accept: true, check: (value) => expect(value.previewWorkspaceId).toBeUndefined() } },
      {
        name: 'unknown and unread fields are dropped', variant: 'unknown', path: '/',
        wire: { ...proposal, preview: { branchId: 'b', branchName: SECRET, state: SECRET }, externalChangeRequest: { url: SECRET }, internalToken: SECRET },
        expect: { accept: true, check: (value) => leaksNothing(value) },
      },
    ])
  })
})

describe('proposals (platformApiListSourceChangeProposals)', () => {
  test('wire variants', () => {
    assertWireContractCases(listSourceChangeProposalsContract, [
      { name: 'the marshalled list', variant: 'present', path: '/data', wire: { data: [proposal], meta: { total: 1 } }, expect: { accept: true, check: (value) => expect(value.data.map((item) => item.id)).toEqual(['proposal-1']) } },
      { name: 'nothing to review is an empty list', variant: 'empty', path: '/data', wire: { data: [], meta: { total: 0 } }, expect: { accept: true, value: { data: [] } } },
      { name: 'an absent list is broken, never "nothing to review" (handler/source_change_proposal.go:166 always writes it)', variant: 'absent', path: '/data', wire: { meta: { total: 0 } }, expect: { accept: false, issues: [{ path: '/data', code: 'missing' }] } },
      { name: 'a null list is broken', variant: 'null', path: '/data', wire: { data: null }, expect: { accept: false, issues: [{ path: '/data', code: 'invalid_type' }] } },
      { name: 'a broken item fails the list, never dropped', variant: 'absent', path: '/data/*/reviewers', wire: { data: [proposal, without(proposal, 'reviewers')] }, expect: { accept: false, issues: [{ path: '/data/*/reviewers', code: 'missing' }] } },
      { name: 'an item in an unknown phase stays listed', variant: 'unknown', path: '/data/*/phase', wire: { data: [{ ...proposal, phase: SECRET }] }, expect: { accept: true, check: (value) => { expect(value.data[0]?.phase).toEqual({ kind: 'unknown' }); leaksNothing(value) } } },
    ])
  })
})

describe('diff (platformApiGetSourceChangeProposalDiff)', () => {
  const diff = { summary: { files: 1, additions: 2, deletions: 1 }, unifiedDiff: 'diff --git a/app.ts b/app.ts', truncated: false }
  test('wire variants', () => {
    assertWireContractCases(getSourceChangeProposalDiffContract, [
      { name: 'the bounded diff', variant: 'present', path: '/', wire: diff, expect: { accept: true, value: diff } },
      { name: 'an empty diff text', variant: 'empty', path: '/unifiedDiff', wire: { ...diff, unifiedDiff: '' }, expect: { accept: true, check: (value) => expect(value.unifiedDiff).toBe('') } },
      { name: 'truncation is required, never guessed "complete"', variant: 'absent', path: '/truncated', wire: without(diff, 'truncated'), expect: { accept: false, issues: [{ path: '/truncated', code: 'missing' }] } },
      { name: 'a null summary is broken', variant: 'null', path: '/summary', wire: { ...diff, summary: null }, expect: { accept: false, issues: [{ path: '/summary', code: 'invalid_type' }] } },
      { name: 'unknown fields are dropped', variant: 'unknown', path: '/', wire: { ...diff, workspace: SECRET }, expect: { accept: true, check: (value) => leaksNothing(value) } },
    ])
  })
})

describe('decision (platformApiDecideSourceChangeProposal)', () => {
  const decided = proposalWire({ phase: 'Accepted', decisions: [{ ...decision, decision: 'Accept' }] })
  test('the decided proposal is the value; anything else is unconfirmed, never success', () => {
    assertWireContractCases(decideSourceChangeProposalContract, [
      { name: 'the envelope resource', variant: 'present', path: '/resource', wire: { ...decided, operation, resource: decided }, expect: { accept: true, check: (value) => expect(value.phase).toEqual({ kind: 'known', value: 'Accepted' }) } },
      { name: 'no resource (the flattened proposal is not read)', variant: 'absent', path: '/resource', wire: { ...decided, operation }, expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
      { name: 'a null resource', variant: 'null', path: '/resource', wire: { ...decided, operation, resource: null }, expect: { accept: false, issues: [{ path: '/resource', code: 'invalid_type' }] } },
      { name: 'a resource with null decisions', variant: 'null', path: '/resource/decisions', wire: { operation, resource: { ...decided, decisions: null } }, expect: { accept: false, issues: [{ path: '/resource/decisions', code: 'invalid_type' }] } },
      { name: 'a resource that is a string', variant: 'unknown', path: '/resource', wire: { operation, resource: SECRET }, expect: { accept: false, issues: [{ path: '/resource', code: 'invalid_type' }] } },
      { name: 'a resource in an unknown phase is read as such', variant: 'unknown', path: '/resource/phase', wire: { operation, resource: { ...decided, phase: SECRET } }, expect: { accept: true, check: (value) => { expect(value.phase).toEqual({ kind: 'unknown' }); leaksNothing(value) } } },
    ])
  })
})
