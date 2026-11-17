// The improvement session's admission (use-improve-session.ts): Platform starts a run only while the proposal is
// being drafted or was sent back for changes (platform-api application_draft_proposal.go
// admitImprovementImplementation); an unread proposal, one awaiting review or apply, one that could not be applied,
// a closed one and a phase this console does not know take no new changes.
import { expect, test } from 'bun:test'
import { proposalOf, proposalWire } from '../../api/testing/proposal-domain'
import { isOneOf } from '../../model/contracts/build'
import { improvementAdmitted } from '../proposals/model'

const phase = (value: string) => proposalOf(proposalWire({ phase: value })).phase

test('an unknown phase is not admitted and is never read as Applied or Drafting', () => {
  const unknown = phase('Merging')
  expect(improvementAdmitted(unknown)).toBe(false)
  expect(isOneOf(unknown, 'Applied')).toBe(false)
  expect(isOneOf(unknown, 'Drafting')).toBe(false)
})

test('only a proposal being drafted or sent back for changes is admitted, as Platform admits it', () => {
  expect(improvementAdmitted(undefined)).toBe(false)
  for (const value of ['Proposed', 'Accepted', 'Applying', 'ApplyFailed', 'Applied', 'Rejected', 'Withdrawn', 'Expired']) expect(improvementAdmitted(phase(value))).toBe(false)
  for (const value of ['Drafting', 'ChangesRequested']) expect(improvementAdmitted(phase(value))).toBe(true)
})
