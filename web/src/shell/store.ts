// Shell UI state (TanStack Store): the mobile nav drawer, whether the desktop
// nav and the build session's 「いま作っているもの」 pane are folded away, and the
// 所属 the caller chose in the top bar. Choices survive reloads (localStorage).
import { Store } from '@tanstack/react-store'

const MEMBERSHIP_KEY = 'builder-console:membership'
const NAV_COLLAPSED_KEY = 'builder-console:nav-collapsed'
const ARTIFACT_COLLAPSED_KEY = 'builder-console:build-artifact-collapsed'

export type ShellState = {
  navOpen: boolean
  /** Desktop (md+) left nav folded to nothing; the top bar keeps the toggle. */
  navCollapsed: boolean
  /** Build session (md+) side pane folded to a strip; mobile tabs are unaffected. */
  artifactCollapsed: boolean
  /** Group id chosen in the 所属 switcher; null = first direct membership. */
  membershipGroupId: string | null
}

// Static page imports also run outside a browser, before storage is installed.
function readStoredValue(key: string): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
}

function writeFlag(key: string, value: boolean) {
  if (value) localStorage.setItem(key, '1')
  else localStorage.removeItem(key)
}

export const shellStore = new Store<ShellState>({
  navOpen: false,
  navCollapsed: readStoredValue(NAV_COLLAPSED_KEY) === '1',
  artifactCollapsed: readStoredValue(ARTIFACT_COLLAPSED_KEY) === '1',
  membershipGroupId: readStoredValue(MEMBERSHIP_KEY),
})

export function setNavOpen(navOpen: boolean) {
  shellStore.setState((state) => (state.navOpen === navOpen ? state : { ...state, navOpen }))
}

export function setNavCollapsed(navCollapsed: boolean) {
  writeFlag(NAV_COLLAPSED_KEY, navCollapsed)
  shellStore.setState((state) => (state.navCollapsed === navCollapsed ? state : { ...state, navCollapsed }))
}

export function setArtifactCollapsed(artifactCollapsed: boolean) {
  writeFlag(ARTIFACT_COLLAPSED_KEY, artifactCollapsed)
  shellStore.setState((state) => (state.artifactCollapsed === artifactCollapsed ? state : { ...state, artifactCollapsed }))
}

export function setMembershipGroup(groupId: string) {
  localStorage.setItem(MEMBERSHIP_KEY, groupId)
  shellStore.setState((state) => ({ ...state, membershipGroupId: groupId }))
}
