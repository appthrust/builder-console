import { expect, test } from 'bun:test'
import { proposalOf, proposalWire } from '../../api/testing/proposal-domain'
import { isProductLanguage } from '../../model/build/wording'
import { proposalTerminal, proposalWaiting, requestedChanges, reviewGate } from './model'
import { textJa } from './copy'
import { textEn } from './copy.en'

function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'function') return [String(value('Alex'))]
  return Object.values(value as Record<string, unknown>).flatMap(leaves)
}

const at = '2026-11-13T00:01:00Z'
const proposal = (overrides: Record<string, unknown> = {}) => proposalOf(proposalWire({ proposer: 'proposer', reviewers: ['owner'], ...overrides }))
const phase = (value: string) => proposal({ phase: value }).phase

test('both languages stay in product vocabulary', () => {
  for (const value of [...leaves(textJa), ...leaves(textEn)]) expect(isProductLanguage(value)).toBe(true)
  for (const value of leaves(textEn)) expect(value).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
})

test('review authority uses the principal subject, and only a known Proposed admits actions', () => {
  expect(reviewGate(proposal(), 'owner')).toBe('review')
  expect(reviewGate(proposal(), 'proposer')).toBe('none')
  expect(reviewGate(proposal({ phase: 'Applying' }), 'owner')).toBe('none')
  expect(reviewGate(proposal({ reviewers: ['proposer'] }), 'proposer')).toBe('review')
})

test('an unknown phase, decision or revision kind never admits a review write, and only for a reviewer is it explained', () => {
  const unknown = [
    proposal({ phase: 'Merging' }),
    proposal({ decisions: [{ subject: 'owner', decision: 'Delegate', at }] }),
    proposal({ base: { kind: 'Snapshot', snapshot: { id: 's1' } } }),
    proposal({ head: { kind: 'Tag', name: 'v2' } }),
    proposal({ headRevision: { kind: 'Snapshot' } }),
  ]
  for (const item of unknown) {
    expect(reviewGate(item, 'owner')).toBe('unsupported')
    expect(reviewGate(item, 'proposer')).toBe('none')
  }
  // A known phase that is not awaiting review stays closed even with an unknown revision.
  expect(reviewGate(proposal({ phase: 'Applied', base: { kind: 'Snapshot' } }), 'owner')).toBe('none')
})

test('waiting and terminal phases are distinct; an unknown phase is neither', () => {
  for (const value of ['Proposed', 'Accepted', 'Applying']) expect(proposalWaiting(phase(value))).toBe(true)
  for (const value of ['Applied', 'Rejected', 'Withdrawn', 'Expired']) expect(proposalTerminal(phase(value))).toBe(true)
  expect(proposalWaiting(phase('ChangesRequested'))).toBe(false)
  expect(proposalTerminal(phase('ApplyFailed'))).toBe(false)
  expect(proposalWaiting(phase('Merging'))).toBe(false)
  expect(proposalTerminal(phase('Merging'))).toBe(false)
})

test('only current change requests show feedback; an unknown decision is never read as one', () => {
  const requested = proposal({ phase: 'ChangesRequested', decisions: [{ subject: 'owner', decision: 'RequestChanges', comment: 'First', at }, { subject: 'owner', decision: 'RequestChanges', comment: 'Second', at }] })
  expect(requestedChanges(requested)).toBe('Second')
  expect(requestedChanges(proposal({ phase: 'Proposed', decisions: [{ subject: 'owner', decision: 'RequestChanges', comment: 'First', at }] }))).toBeUndefined()
  expect(requestedChanges(proposal({ phase: 'ChangesRequested', decisions: [{ subject: 'owner', decision: 'Delegate', comment: 'Not a request', at }] }))).toBeUndefined()
})
