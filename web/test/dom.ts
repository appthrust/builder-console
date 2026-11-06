import { afterEach } from 'bun:test'
import { Window } from 'happy-dom'

const window = new Window({ url: 'http://localhost:32122' })
// happy-dom 20.8 leaves some ECMAScript globals undefined under Bun 1.3.
// Browser bundles that access builtins through window need the real values.
for (const key of Object.getOwnPropertyNames(globalThis)) {
  if (key in window && (window as unknown as Record<string, unknown>)[key] === undefined && key !== 'global')
    (window as unknown as Record<string, unknown>)[key] = (globalThis as unknown as Record<string, unknown>)[key]
}
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'Event', 'CustomEvent', 'EventTarget', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'scrollTo'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : window[key] })
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

const sharedDOMDescriptors = {
  window: Object.getOwnPropertyDescriptor(globalThis, 'window')!,
  document: Object.getOwnPropertyDescriptor(globalThis, 'document')!,
}

// Bun 1.3.14 and 1.4.2 run preload afterEach hooks after the test file's
// afterEach hooks. Preload afterAll runs only once for the entire suite, too
// late to protect modules that capture window when imported.
// Keep replacements inside a test/beforeEach and restore them in afterEach.
afterEach(() => {
  const leaked = (['window', 'document'] as const).filter(
    (key) => globalThis[key] !== sharedDOMDescriptors[key].value
  )
  if (leaked.length === 0) return

  Object.defineProperties(globalThis, sharedDOMDescriptors)
  throw new Error(
    `Shared DOM global leak: ${leaked.map((key) => `globalThis.${key}`).join(', ')}. Restore the original descriptors in afterEach or finally; the shared DOM has been restored.`
  )
})
