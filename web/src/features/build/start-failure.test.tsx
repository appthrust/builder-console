// Why a NEW-APP start stopped, in specific words with the step that helps: a
// start that may have happened or still runs is checked with the same key; a
// session the server stopped is replaced only when the user starts again.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { setLanguage } from '../../shell/language'
import { preserveLanguage } from '../../../test/language'
import { text as createText } from '../create/copy'
import { readConsoleStart, saveConsoleStart } from './console-session-state'
import { text } from './copy'
import { BuildStartError } from './entry'
import { newSessionEngine } from './new-session-engine'
import { BuildStartFailure } from './start-failure'

let root: Root
let container: HTMLDivElement
let restoreLanguage: () => void
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')

beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage })
  window.sessionStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  window.sessionStorage.clear()
  if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
  restoreLanguage()
})

const START = { intent: '点検を記録するアプリ', groupId: 'g-team-a', locale: 'ja' as const, key: 'start-key-1', sessionId: '89c00000-0000-4000-8000-000000000001' }

async function render(error: unknown) {
  const retries: number[] = []
  await act(async () => { root.render(<BuildStartFailure error={error} busy={false} onRetry={() => retries.push(1)} />) })
  const buttons = [...container.querySelectorAll('button')]
  return { retries, buttons, title: container.querySelector('[role="status"] p, [role="alert"] p')?.textContent }
}

test('an unconfirmed or slow start is checked with the same key; the kept start stays', async () => {
  saveConsoleStart(START)
  for (const reason of ['unconfirmed', 'timeout'] as const) {
    const shown = await render(new BuildStartError(reason, { sessionId: START.sessionId }))
    expect(shown.title).toBe(text.console.start[reason].title)
    expect(shown.buttons.map((item) => item.textContent)).toEqual([text.console.start.check])
    await act(async () => { shown.buttons[0]!.click() })
    expect(shown.retries).toEqual([1])
    expect(readConsoleStart()).toEqual(START)
  }
})

test('a session the server stopped is started again as a new one, only on request; its typed failure is named', async () => {
  saveConsoleStart(START)
  const shown = await render(new BuildStartError('failed', { sessionId: START.sessionId, failure: { error: { kind: 'known', value: 'failed_precondition' }, message: 'policy', details: { reason: 'PolicyPending' } } }))
  expect(shown.title).toBe(text.console.failure.policy_pending.title)
  expect(readConsoleStart()).toEqual(START)
  await act(async () => { shown.buttons.find((item) => item.textContent === text.console.start.restart)!.click() })
  expect(readConsoleStart()).toBeUndefined()
  expect(shown.retries).toEqual([1])

  const archived = await render(new BuildStartError('archived', { sessionId: START.sessionId }))
  expect(archived.title).toBe(text.console.start.archived.title)
})

test('any other error keeps the generic notice and its retry', async () => {
  const shown = await render(new Error('network'))
  expect(shown.title).toBe(createText.buildFailed)
  expect(shown.buttons.map((item) => item.textContent)).toEqual([createText.retryBuild])
})

test('the new-session engine is console-v1 only when the server config turns it on', () => {
  expect(newSessionEngine({ projectId: 'commerce' })).toBe('platform-v1')
  expect(newSessionEngine({ projectId: 'commerce', newAppConversation: false })).toBe('platform-v1')
  expect(newSessionEngine({ projectId: 'commerce', newAppConversation: 'true' })).toBe('platform-v1')
  expect(newSessionEngine({ projectId: 'commerce', newAppConversation: true })).toBe('console-v1')
})
