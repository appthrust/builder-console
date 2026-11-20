import { describe, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { NO_APP_PERMISSIONS } from '../../model/contracts/console'
import { introOpenState } from './intro-page'
import { canPropose, ownerNames, proposalRefusal, proposalStatus } from './propose-button'
import { text } from './copy'

const settled = { loading: false, failed: false }

describe('whether the intro page can open the app (§6.4, §9)', () => {
  test('a URL opens it and nothing more is said; 問題あり keeps it open and says so', () => {
    expect(introOpenState(settled, { status: 'live', url: 'https://app.example.test' })).toBe('ready')
    expect(introOpenState(settled, { status: 'deploying', url: 'https://app.example.test' })).toBe('ready')
    expect(introOpenState(settled, { status: 'failed', url: 'https://app.example.test' })).toBe('trouble')
  })

  test('no URL yet is 準備中 and cannot be opened, even when the app is 問題あり', () => {
    expect(introOpenState(settled, { status: 'deploying' })).toBe('preparing')
    expect(introOpenState(settled, { status: 'unknown' })).toBe('preparing')
    expect(introOpenState(settled, { status: 'failed' })).toBe('preparing')
  })

  test('an unanswered or failed platform read claims no state', () => {
    expect(introOpenState({ loading: true, failed: false }, { status: 'unknown' })).toBe('loading')
    expect(introOpenState({ loading: false, failed: true }, { status: 'live', url: 'https://app.example.test' })).toBe('unavailable')
  })
})

describe('proposals by people who do not maintain the app (§6.6)', () => {
  test('only someone who may propose and does not maintain a bound app gets the button', () => {
    expect(canPropose({ stackId: 's', permissions: { ...NO_APP_PERMISSIONS, use: true, propose: true } })).toBe(true)
    expect(canPropose({ stackId: 's', permissions: { ...NO_APP_PERMISSIONS, use: true, propose: true, maintain: true } })).toBe(false)
    expect(canPropose({ stackId: 's', permissions: { ...NO_APP_PERMISSIONS, use: true } })).toBe(false)
    expect(canPropose({ stackId: null, permissions: { ...NO_APP_PERMISSIONS, use: true, propose: true } })).toBe(false)
  })

  test('the status follows the session and its proposal phase; unread, withdrawn, expired and unknown phases say nothing', () => {
    const known = (value: string) => ({ kind: 'known', value }) as never
    expect(proposalStatus(undefined, undefined)).toBeUndefined()
    expect(proposalStatus({}, undefined)).toBe('drafting')
    expect(proposalStatus({ proposalId: 'p' }, undefined)).toBeUndefined()
    for (const phase of ['Proposed', 'Accepted', 'Applying']) expect(proposalStatus({ proposalId: 'p' }, known(phase))).toBe('reviewing')
    expect(proposalStatus({ proposalId: 'p' }, known('ChangesRequested'))).toBe('changes')
    expect(proposalStatus({ proposalId: 'p' }, known('Applied'))).toBe('applied')
    expect(proposalStatus({ proposalId: 'p' }, known('Rejected'))).toBe('rejected')
    expect(proposalStatus({ proposalId: 'p' }, known('Withdrawn'))).toBeUndefined()
    expect(proposalStatus({ proposalId: 'p' }, known('Expired'))).toBeUndefined()
    expect(proposalStatus({ proposalId: 'p' }, { kind: 'unknown', value: 'Later' } as never)).toBeUndefined()
  })

  test('only the server refusal for a closed contribution scope is worded as such', () => {
    const refused = new ORPCError('FORBIDDEN', { status: 403, data: { error: { code: 'contribution_not_accepted', message: 'このアプリは、いま提案を受け付けていません。' } } })
    expect(proposalRefusal(refused)).toBe(text.propose.refused)
    expect(proposalRefusal(new ORPCError('FORBIDDEN', { status: 403, data: { error: { code: 'forbidden', message: 'no' } } }))).toBeUndefined()
    expect(proposalRefusal(new Error('network'))).toBeUndefined()
  })

  test('the owners are named in 「△△ さん」 without people the server can no longer resolve', () => {
    const person = { id: 'p1', subject: 's', pending: false, email: 'a@example.test', displayName: '鈴木 一郎', avatarVersion: null }
    expect(ownerNames({ owners: [person] })).toBe('鈴木 一郎')
    expect(ownerNames({ owners: [] })).toBeUndefined()
  })
})
