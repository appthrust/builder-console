// The typed Reply as the screen presents it, over the shared S4-0 fixtures read
// by the production readers: each part in its own place, unknown states and
// codes stay unknown, the one repair and its exhaustion are distinct.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildSessionReader, buildTurnReader } from '../../api/contracts/console/build-sessions'
import type { BuildTurn } from '../contracts/console'
import { actionableTurnId, failureKind, failureNext, planPhase, planReadiness, publishNameProblem, replyView, turnPhase, waitingFor, type ConversationTurn, type PlanTurn } from './replies'

type Fixture = { name: string; raw: string }
const fixtures = JSON.parse(readFileSync(new URL('../../../../cmd/server/internal/api/testdata/build-conversation.json', import.meta.url), 'utf8')) as Fixture[]
const wire = (name: string) => JSON.parse(fixtures.find((item) => item.name === name)!.raw) as Record<string, unknown>
const turn = (name: string, changes: Record<string, unknown> = {}): BuildTurn => buildTurnReader.parse({ ...wire(name), ...changes })
const conversation = (name: string, changes: Record<string, unknown> = {}) => turn(name, changes) as ConversationTurn
/** A succeeded turn whose reply is the named S4-0 reply fixture. */
const answered = (replyName: string) => conversation('turn-running', { state: 'succeeded', nextAction: 'none', reply: wire(replyName) })

describe('replyView', () => {
  test('the answer is always its own part, also next to an edit proposal (APT-752)', () => {
    expect(replyView(answered('APT-752-question-answer'))?.answer).toBe('利用可能なカタログを確認して選びます。Rust の採用は保証できません。')
    const mixed = replyView(answered('mixed-question-edit-proposal'))!
    expect(mixed.answer).toBe('Rust の採用は保証できません。承認を二段階にする変更案を示します。')
    expect(mixed.proposal).toEqual({ summary: '承認を二段階に変更', changes: ['承認を二段階にする'] })
  })
  test('candidates stay concrete options; open decisions stay unresolved; reply chips belong to the next question', () => {
    const candidates = replyView(answered('APT-792-concrete-candidates'))!
    expect(candidates.candidates.map((item) => [item.label, item.description])).toEqual([['申請ノート', '申請を一か所で管理する名前です。'], ['承認ガイド', '承認の流れを案内する名前です。']])
    expect(candidates.nextQuestion).toBe('どちらが好みに近いですか？')
    expect(candidates.suggestedReplies.map((item) => item.message)).toEqual(['申請ノートを選びます'])
    expect(candidates.proposal).toBeUndefined()
    const undecided = replyView(answered('APT-792-undecided-name'))!
    expect(undecided.openDecisions).toEqual([{ topic: 'アプリ名', wish: 'ほかの名前にしたい' }])
    expect(undecided.proposal).toBeUndefined()
    expect(undecided.nextQuestion).toBeUndefined()
  })
  test('a decided proposal carries the decision; a turn without a reply has none', () => {
    expect(replyView(conversation('turn-explicit-accept'))?.proposal?.decision).toBe('accept_spec')
    expect(replyView(conversation('turn-explicit-keep'))?.proposal?.decision).toBe('keep_spec')
    expect(replyView(conversation('turn-running'))).toBeUndefined()
  })
})

describe('turnPhase', () => {
  test('working, confirming, answered', () => {
    expect(turnPhase(conversation('turn-running'))).toEqual({ kind: 'working', repair: false })
    expect(turnPhase(conversation('turn-confirmation-no-new-revision'))).toEqual({ kind: 'confirming' })
    expect(turnPhase(conversation('turn-explicit-accept'))).toEqual({ kind: 'answered' })
  })
  test('the one repair is its own working state, pending or running (§7)', () => {
    expect(turnPhase(conversation('turn-repair-required'))).toEqual({ kind: 'working', repair: true })
    expect(turnPhase(conversation('turn-running', { attempt: 1 }))).toEqual({ kind: 'working', repair: true })
    expect(waitingFor(conversation('turn-running', { attempt: 1 }))).toBe('repairing')
  })
  test('a reply that is still invalid after the repair is exhausted, not working and not a generic failure', () => {
    const exhausted = conversation('turn-running', { state: 'failed', attempt: 1, nextAction: 'none', failure: { error: 'reply_invalid', message: 'reply is still invalid' } })
    expect(turnPhase(exhausted)).toEqual({ kind: 'failed', failure: 'repair_exhausted' })
    expect(failureNext.repair_exhausted).toBe('resend')
  })
  test('an unknown state is unknown; an unknown failure code is an unknown failure', () => {
    expect(turnPhase(conversation('turn-state-unknown-reader'))).toEqual({ kind: 'unknown' })
    expect(turnPhase(conversation('turn-running', { state: 'failed', nextAction: 'none', failure: wire('error-unknown-reader') }))).toEqual({ kind: 'failed', failure: 'unknown' })
  })
})

describe('failureKind', () => {
  test('AI policy: pending approval is not a permanent denial', () => {
    expect(failureKind('failed_precondition', { reason: 'PolicyPending' })).toBe('policy_pending')
    expect(failureKind('failed_precondition', { reason: 'PolicyDenied' })).toBe('policy_denied')
    expect(failureNext.policy_pending).toBe('wait')
  })
  test('upstream reasons on a conflict, typed codes, and unknown codes', () => {
    expect(failureKind('conflict', { reason: 'AgentTurnActive' })).toBe('busy')
    expect(failureKind('conflict', { reason: 'WorkspaceNotRunning' })).toBe('needs_runtime')
    expect(failureKind('artifact_integrity_failed')).toBe('integrity')
    expect(failureKind('agent_interaction_required')).toBe('interaction_required')
    expect(failureKind('input_too_large')).toBe('too_large')
    expect(failureKind({ kind: 'unknown' })).toBe('unknown')
    expect(failureKind('constructor')).toBe('unknown')
  })
})

describe('progress and the plan', () => {
  test('an unknown stage is generic work, never an invented one', () => {
    expect(waitingFor(turn('turn-stage-unknown-reader'))).toBe('working')
    expect(waitingFor(turn('turn-running'))).toBe('thinking')
  })
  test('the plan hand-off: handed to planning, done, a projection conflict, an unknown state', () => {
    const plan = turn('plan-turn') as PlanTurn
    expect(planPhase(plan)).toEqual({ kind: 'handed_off' })
    expect(planPhase({ ...plan, state: { kind: 'known', value: 'succeeded' } })).toEqual({ kind: 'planned' })
    expect(planPhase({ ...plan, projection: { state: { kind: 'known', value: 'conflict' } } })).toEqual({ kind: 'failed', failure: 'draft_conflict' })
    expect(planPhase({ ...plan, state: { kind: 'unknown' } })).toEqual({ kind: 'unknown' })
    expect(planPhase({ ...plan, state: { kind: 'known', value: 'syncing_spec' }, progress: { stage: { kind: 'known', value: 'syncing_spec' }, observedAt: '2026-11-12T00:00:00Z', activity: [] } })).toEqual({ kind: 'working', waiting: 'saving_spec' })
  })
  test('only the newest answered or confirming conversation turn is actionable', () => {
    const first = answered('APT-792-concrete-candidates')
    const second = { ...answered('APT-752-question-answer'), id: '89c00000-0000-4000-8000-000000000009' }
    expect(actionableTurnId([first, second])).toBe(second.id)
    expect(actionableTurnId([first, conversation('turn-running', { id: second.id })])).toBeUndefined()
    expect(actionableTurnId([first, turn('plan-turn', { id: second.id })])).toBeUndefined()
  })
})

test('publish name bounds: nonblank, 40 Unicode scalars, one line', () => {
  expect(publishNameProblem('  ')).toBe('empty')
  expect(publishNameProblem('😀'.repeat(40))).toBeUndefined()
  expect(publishNameProblem('😀'.repeat(41))).toBe('too_long')
  expect(publishNameProblem('点検\n記録')).toBe('multiline')
  expect(publishNameProblem(' 点検記録 ')).toBeUndefined()
})

describe('planReadiness (session.plan)', () => {
  const session = (plan?: { specRevision: number; stale: boolean }) => buildSessionReader.parse({ ...wire('session'), ...(plan ? { plan } : {}) })
  test('absent: no plan, nothing to create from', () => {
    expect(planReadiness(session())).toEqual({ kind: 'none' })
  })
  test('current: creation may follow', () => {
    expect(planReadiness(session({ specRevision: 2, stale: false }))).toEqual({ kind: 'current', specRevision: 2 })
  })
  test('stale: the specification changed after planning; re-plan first', () => {
    expect(planReadiness(session({ specRevision: 2, stale: true }))).toEqual({ kind: 'stale', specRevision: 2 })
  })
})
