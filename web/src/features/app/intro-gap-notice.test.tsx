import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
import { text } from './copy'
import { IntroGapNotice, introGapHref, introGaps } from './intro-gap-notice'

const full = {
  id: 'app-1', slug: 'keihi', group: { id: 'g', path: 'sales/east', name: '東日本' },
  description: '経費を申請します。', capabilities: ['申請する'], screenshots: [{ id: 's', caption: '', width: 1, height: 1 }], guide: '# つかいかた',
}

let restoreLanguage: () => void
const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage })
  localStorage.clear()
})
afterEach(() => {
  if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  restoreLanguage()
})

test('gaps are the empty parts in page order; the link goes to the first gap’s editor', () => {
  expect(introGaps(full)).toEqual([])
  expect(introGaps({ ...full, description: '  ', guide: '\n' })).toEqual(['description', 'guide'])
  expect(introGaps({ ...full, capabilities: [], screenshots: [] })).toEqual(['capabilities', 'screenshots'])
  expect(introGapHref(full, ['description', 'screenshots'])).toBe('/sales/east/keihi/-/settings#name')
  expect(introGapHref(full, ['capabilities'])).toBe('/sales/east/keihi/-/guide')
  expect(introGapHref(full, ['screenshots'])).toBe('/sales/east/keihi#screenshots')
  expect(text.maintainer.gapDetail([text.maintainer.gapItems.capabilities, text.maintainer.gapItems.screenshots]))
    .toBe('「できること」と画面の写真がありません。利用者のホームで、何のアプリか伝わりません。')
})

test('the notice names the gaps, hides when complete, and stays closed for that app once dismissed', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (app: typeof full) => {
    const rootRoute = createRootRoute({ component: () => <IntroGapNotice key={app.id} app={app} /> })
    const router = createRouter({ routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: '/' })]), history: createMemoryHistory({ initialEntries: ['/'] }) })
    await router.load()
    await act(async () => { root.render(<RouterProvider router={router} />) })
  }
  try {
    await render(full)
    expect(container.querySelector('[data-testid="intro-gap-notice"]')).toBeNull()
    const lacking = { ...full, screenshots: [] }
    await render(lacking)
    const notice = container.querySelector('[data-testid="intro-gap-notice"]')!
    expect(notice.textContent).toContain(text.maintainer.gapTitle)
    expect(notice.textContent).toContain('画面の写真がありません。')
    expect(notice.querySelector('a')?.getAttribute('href')).toBe('/sales/east/keihi#screenshots')
    const dismiss = [...notice.querySelectorAll('button')].find((button) => button.textContent === text.maintainer.gapDismiss)!
    await act(async () => { dismiss.click() })
    expect(container.querySelector('[data-testid="intro-gap-notice"]')).toBeNull()
    await render({ ...lacking, id: 'app-2' })
    expect(container.querySelector('[data-testid="intro-gap-notice"]')).not.toBeNull()
    await render(lacking)
    expect(container.querySelector('[data-testid="intro-gap-notice"]')).toBeNull()
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
})
