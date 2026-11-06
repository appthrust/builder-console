import { describe, expect, test } from 'bun:test'
import { appOrigin, stateFromReason } from './access-request'

describe('appOrigin', () => {
  test('derives the app origin from the console host', () => {
    expect(appOrigin('equipment-loan-ledger', 'console.pj-example.appthrust.ink')).toBe('https://equipment-loan-ledger.pj-example.appthrust.ink')
  })

  test.each(['_', '', 'console', '../app', 'other.app', 'app/name', 'a'.repeat(64)])(
    'does not turn an unknown or invalid app name into a link: %s', (name) => {
      expect(appOrigin(name, 'console.pj-example.appthrust.ink')).toBeUndefined()
    },
  )

  test('removes only a leading console label', () => {
    expect(appOrigin('app', 'console.console.example')).toBe('https://app.console.example')
    expect(appOrigin('app', 'project.example')).toBe('https://app.project.example')
    expect(appOrigin('app', 'project.console.example')).toBe('https://app.project.console.example')
  })
})

describe('stateFromReason', () => {
  test('preserves each known denial reason', () => {
    expect(stateFromReason('not_visible')).toBe('not_visible')
    expect(stateFromReason('unknown_person')).toBe('unknown_person')
    expect(stateFromReason('unknown_app')).toBe('unknown_app')
  })

  test.each([undefined, '', 'new_reason', 'granted', 'pending', 'UNKNOWN_APP'])('defaults %s to not_visible', (reason) => {
    expect(stateFromReason(reason)).toBe('not_visible')
  })
})
