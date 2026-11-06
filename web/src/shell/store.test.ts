import { afterEach, beforeEach, expect, test } from 'bun:test'
import type * as ShellStoreModule from './store'

let storageDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
})
afterEach(() => {
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

// Each import must evaluate initialization even if a page already loaded the store.
test('shell state imports without localStorage before page test setup', async () => {
  Reflect.deleteProperty(globalThis, 'localStorage')
  const specifier = './store.ts?storage-absent'
  const { shellStore } = await import(specifier) as typeof ShellStoreModule
  expect(shellStore.state).toEqual({
    navOpen: false,
    navCollapsed: false,
    artifactCollapsed: false,
    membershipGroupId: null,
  })
})

test.each([false, true])('browser shell choices persist across store imports: saved=%s', async (saved) => {
  const values = new Map<string, string>(saved ? [
    ['builder-console:nav-collapsed', '1'],
    ['builder-console:build-artifact-collapsed', '1'],
    ['builder-console:membership', 'group-1'],
  ] : [])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    },
  })
  const { shellStore, setNavOpen, setNavCollapsed, setArtifactCollapsed, setMembershipGroup } =
    await import(`./store.ts?storage-saved=${saved}`) as typeof ShellStoreModule
  expect(shellStore.state).toEqual({
    navOpen: false,
    navCollapsed: saved,
    artifactCollapsed: saved,
    membershipGroupId: saved ? 'group-1' : null,
  })

  setNavOpen(true)
  setNavCollapsed(true)
  setArtifactCollapsed(true)
  setMembershipGroup('group-2')
  expect(shellStore.state).toEqual({
    navOpen: true,
    navCollapsed: true,
    artifactCollapsed: true,
    membershipGroupId: 'group-2',
  })
  expect(Object.fromEntries(values)).toEqual({
    'builder-console:nav-collapsed': '1',
    'builder-console:build-artifact-collapsed': '1',
    'builder-console:membership': 'group-2',
  })

  setNavCollapsed(false)
  setArtifactCollapsed(false)
  expect(shellStore.state.navCollapsed).toBe(false)
  expect(shellStore.state.artifactCollapsed).toBe(false)
  expect(Object.fromEntries(values)).toEqual({ 'builder-console:membership': 'group-2' })
})
