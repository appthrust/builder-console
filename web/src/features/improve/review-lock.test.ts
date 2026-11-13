// The improvement session's review lock (use-improve-session.ts): while the
// session's proposal is unread, awaits review or apply, is closed, or is in a
// phase this console does not know, the session takes no new changes.
import { expect, test } from 'bun:test'
import { proposalOf, proposalWire } from '../../api/testing/proposal-domain'
import { isOneOf } from '../../model/contracts/build'
import { improvementLocked } from '../proposals/model'

const phase = (value: string) => proposalOf(proposalWire({ phase: value })).phase

test('an unknown phase locks the session and is never read as Applied or Drafting', () => {
  const unknown = phase('Merging')
  expect(improvementLocked(unknown)).toBe(true)
  expect(isOneOf(unknown, 'Applied')).toBe(false)
  expect(isOneOf(unknown, 'Drafting')).toBe(false)
})

test('an unread proposal, a waiting one and a closed one lock the session; a returned one does not', () => {
  expect(improvementLocked(undefined)).toBe(true)
  for (const value of ['Proposed', 'Accepted', 'Applying', 'Applied', 'Rejected', 'Withdrawn', 'Expired']) expect(improvementLocked(phase(value))).toBe(true)
  for (const value of ['Drafting', 'ChangesRequested', 'ApplyFailed']) expect(improvementLocked(phase(value))).toBe(false)
})
