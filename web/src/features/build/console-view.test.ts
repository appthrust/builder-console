// The console-v1 view model from server values (shared S4-0 fixtures read by
// the production readers): plan and confirmation by typed kind/state, never text.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildSessionReader, buildTurnReader } from '../../api/contracts/console/build-sessions'
import { buildCopy } from '../../model/build/copy'
import type { BuildSession, BuildTurn } from '../../model/contracts/console'
import { deriveConsoleBuildView, SLOW_OBSERVATION_MS, type ConsoleViewInput } from './console-view'

type Fixture = { name: string; raw: string }
const fixtures = JSON.parse(readFileSync(new URL('../../../../cmd/server/internal/api/testdata/build-conversation.json', import.meta.url), 'utf8')) as Fixture[]
const wire = (name: string) => JSON.parse(fixtures.find((item) => item.name === name)!.raw) as Record<string, unknown>
const session = (changes: Record<string, unknown> = {}): BuildSession => buildSessionReader.parse({ ...wire('session'), ...changes })
const turn = (name: string, changes: Record<string, unknown> = {}): BuildTurn => buildTurnReader.parse({ ...wire(name), ...changes })
const input = (changes: Partial<ConsoleViewInput>): ConsoleViewInput => ({ session: session(), turns: [], activeTurn: undefined, intent: undefined, sending: false, blocked: false, now: Date.parse('2026-11-12T00:00:10Z'), ...changes })

describe('plan kind', () => {
  test('a conversation turn saying 「この内容で提案して」 is a conversation, not a plan', () => {
    const said = turn('turn-running', { state: 'succeeded', nextAction: 'none', request: { kind: 'conversation', message: buildCopy.questions.kickoffReply, intent: 'auto', baseSpecRevision: 0 } })
    const view = deriveConsoleBuildView(input({ turns: [said] }))
    expect(view.plan).toBeUndefined()
    expect(view.turns.map((item) => item.kind)).toEqual(['conversation'])
  })
  test('the plan is the latest request_plan turn by its typed kind', () => {
    const plan = turn('plan-turn', { id: '89c00000-0000-4000-8000-000000000003', ordinal: 2 })
    const view = deriveConsoleBuildView(input({ turns: [turn('turn-explicit-keep'), plan] }))
    expect(view.plan?.id).toBe(plan.id)
    expect(view.plan?.kind).toBe('request_plan')
  })
})

test('a turn the server asks to confirm is the confirmation; a resolved one is not', () => {
  expect(deriveConsoleBuildView(input({ turns: [turn('turn-confirmation-no-new-revision')] })).confirmation?.state).toEqual({ kind: 'known', value: 'awaiting_confirmation' })
  expect(deriveConsoleBuildView(input({ turns: [turn('turn-explicit-accept')] })).confirmation).toBeUndefined()
})

describe('active turn and progress', () => {
  const active = session({ activeTurnId: '89c00000-0000-4000-8000-000000000002', nextAction: 'observe', capabilities: { canConverse: false, canRequestPlan: false } })
  test('the observed active turn replaces its listed copy; progress is the server stage and time only', () => {
    const listed = turn('turn-running', { progress: { stage: 'accepted', observedAt: '2026-11-12T00:00:00Z', activity: [] } })
    const observed = turn('turn-running', { sessionVersion: 3, updatedAt: '2026-11-12T00:00:05Z', progress: { stage: 'thinking', observedAt: '2026-11-12T00:00:05Z', activity: ['入力を確認しています'] } })
    const view = deriveConsoleBuildView(input({ session: active, turns: [listed], activeTurn: observed }))
    expect(view.turns).toHaveLength(1)
    expect(view.activeTurn).toBe(observed)
    expect(view.progress).toEqual({ stage: { kind: 'known', value: 'thinking' }, observedAt: '2026-11-12T00:00:05Z', activity: ['入力を確認しています'], slow: false })
  })
  test('no new observation for 60 s reads as slow, never as failed', () => {
    const observed = turn('turn-running')
    const view = deriveConsoleBuildView(input({ session: active, activeTurn: observed, now: Date.parse('2026-11-12T00:00:00Z') + SLOW_OBSERVATION_MS + 1 }))
    expect(view.progress?.slow).toBe(true)
    expect(view.failure).toBeUndefined()
  })
  test('an unknown stage stays unknown (shown as generic work)', () => {
    const view = deriveConsoleBuildView(input({ session: active, activeTurn: buildTurnReader.parse(wire('turn-stage-unknown-reader')) }))
    expect(view.progress?.stage).toEqual({ kind: 'unknown' })
  })
})

describe('what may be sent', () => {
  test('the server capabilities, withheld while a write is open, sign-in expired or the state is unknown', () => {
    expect(deriveConsoleBuildView(input({})).canSend).toBe(true)
    expect(deriveConsoleBuildView(input({ sending: true, intent: { family: 'turn', key: 'k', version: 1, status: 'pending', body: { kind: 'request_plan', specRevision: 0 } } })).canSend).toBe(false)
    expect(deriveConsoleBuildView(input({ blocked: true })).canRequestPlan).toBe(false)
    const future = buildSessionReader.parse(wire('session-reader-future-lifecycle'))
    const view = deriveConsoleBuildView(input({ session: future }))
    expect(view.unsupported).toBe(true)
    expect(view.canSend).toBe(false)
    expect(deriveConsoleBuildView(input({ session: session({ capabilities: { canConverse: false, canRequestPlan: true } }) })).canSend).toBe(false)
  })
  test('an unconfirmed write offers only the re-read; an interrupted one its resend', () => {
    const intent = { family: 'publish', key: 'k', version: 1, body: { name: '名前', shareScope: 'group' } } as const
    expect(deriveConsoleBuildView(input({ intent: { ...intent, status: 'unconfirmed' } })).write).toEqual({ family: 'publish', status: 'unconfirmed' })
    expect(deriveConsoleBuildView(input({ intent: { ...intent, status: 'pending' } })).write).toEqual({ family: 'publish', status: 'interrupted' })
    expect(deriveConsoleBuildView(input({ intent: { ...intent, status: 'pending' }, sending: true })).write).toEqual({ family: 'publish', status: 'sending' })
  })
})
