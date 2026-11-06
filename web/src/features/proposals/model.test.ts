import { expect, test } from 'bun:test'
import type { SourceChangeProposal } from '@appthrust/api-schema/platform-api'
import { isProductLanguage } from '../../model/build/wording'
import { canReview, proposalTerminal, proposalWaiting, requestedChanges } from './model'
import { textJa } from './copy'
import { textEn } from './copy.en'

function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'function') return [String(value('Alex'))]
  return Object.values(value as Record<string, unknown>).flatMap(leaves)
}

test('both languages stay in product vocabulary', () => {
  for (const value of [...leaves(textJa), ...leaves(textEn)]) expect(isProductLanguage(value)).toBe(true)
  for (const value of leaves(textEn)) expect(value).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
})

test('review authority uses the principal subject, and only Proposed admits actions', () => {
  const proposal = { phase: 'Proposed', proposer: 'proposer', reviewers: ['owner'] } as SourceChangeProposal
  expect(canReview(proposal, 'owner')).toBe(true)
  expect(canReview(proposal, 'proposer')).toBe(false)
  expect(canReview({ ...proposal, phase: 'Applying' }, 'owner')).toBe(false)
  expect(canReview({ ...proposal, reviewers: ['proposer'] }, 'proposer')).toBe(true)
})

test('waiting and terminal phases are distinct; only current change requests show feedback', () => {
  for (const phase of ['Proposed', 'Accepted', 'Applying'] as const) expect(proposalWaiting(phase)).toBe(true)
  for (const phase of ['Applied', 'Rejected', 'Withdrawn', 'Expired'] as const) expect(proposalTerminal(phase)).toBe(true)
  expect(proposalWaiting('ChangesRequested')).toBe(false)
  expect(proposalTerminal('ApplyFailed')).toBe(false)
  const proposal = { phase: 'ChangesRequested', decisions: [{ decision: 'RequestChanges', comment: 'First' }, { decision: 'RequestChanges', comment: 'Second' }] } as SourceChangeProposal
  expect(requestedChanges(proposal)).toBe('Second')
  expect(requestedChanges({ ...proposal, phase: 'Proposed' })).toBeUndefined()
})
