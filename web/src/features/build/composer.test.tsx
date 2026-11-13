// Putting a message back into the composer (a 412 kept it from being sent): an
// empty composer takes it; text typed since is never replaced without asking.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { setLanguage } from '../../shell/language'
import { preserveLanguage } from '../../../test/language'
import { Composer } from './composer'
import { text } from './copy'

let root: Root
let container: HTMLDivElement
let restoreLanguage: () => void

beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  restoreLanguage()
})

const field = () => container.querySelector('textarea')!
const button = (name: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === name)
function type(value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field()), 'value')!.set!.call(field(), value)
  field().dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
}
async function render(restore?: { text: string; nonce: number }) {
  await act(async () => { root.render(<Composer disabled={false} placeholder="" restore={restore} onSubmit={() => {}} onChip={() => {}} />) })
}

test('an empty composer takes the restored message', async () => {
  await render()
  await render({ text: '承認を二段階にして', nonce: 1 })
  expect(field().value).toBe('承認を二段階にして')
  expect(container.textContent).not.toContain(text.composer.restoreOffer)
})

test('text typed since is kept; the swap is offered, then done or declined by the user', async () => {
  await render()
  await act(async () => { type('いま書いている文') })
  await render({ text: '承認を二段階にして', nonce: 1 })
  expect(field().value).toBe('いま書いている文')
  expect(container.textContent).toContain(text.composer.restoreOffer)

  await act(async () => { button(text.composer.restoreKeep)!.click() })
  expect(field().value).toBe('いま書いている文')
  expect(container.textContent).not.toContain(text.composer.restoreOffer)

  await render({ text: '承認を二段階にして', nonce: 2 })
  await act(async () => { button(text.composer.restoreReplace)!.click() })
  expect(field().value).toBe('承認を二段階にして')
  expect(container.textContent).not.toContain(text.composer.restoreOffer)
})

test('the same restore request is applied once', async () => {
  await render()
  await render({ text: '承認を二段階にして', nonce: 1 })
  await act(async () => { type('') })
  await render({ text: '承認を二段階にして', nonce: 1 })
  expect(field().value).toBe('')
})
