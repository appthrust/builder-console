import { useMatch } from '@tanstack/react-router'
import { useSelector } from '@tanstack/react-store'
import { membershipRoots, type Group, type Me } from '../api/console'
import { useGroups, useMe } from '../api/queries'
import { setMembershipGroup, shellStore } from './store'

export type Shell = {
  me: Me
  groups: Group[]
  /**
   * The group the caller is "in": the group of the page being shown (group or
   * app URL), else the membership chosen in the top bar, else the first direct one.
   */
  currentGroup: Group | undefined
  /** Selected direct membership, independent of the group currently being viewed. */
  membershipGroup: Group | undefined
  viewingOtherGroup: boolean
  /** Membership roots (`membershipRoots`): the choices of the 所属 switcher. */
  homeGroups: Group[]
  /** Group path of the page being shown, when it is a group or app page. */
  pageGroupPath: string | undefined
  setMembershipGroup: (groupId: string) => void
}

export function useShell(): Shell {
  const { data: me } = useMe()
  const { data: groups } = useGroups()
  const chosenId = useSelector(shellStore, (state) => state.membershipGroupId)
  const pageGroupPath = useMatch({ from: '/$', shouldThrow: false, select: (match) => match.loaderData?.groupPath })
  const homeGroups = membershipRoots(me, groups)
  const pageGroup = pageGroupPath ? groups.find((group) => group.path === pageGroupPath) : undefined
  const directPageGroup = homeGroups.find((group) => group.id === pageGroup?.id)
  const membershipGroup = directPageGroup ?? homeGroups.find((group) => group.id === chosenId) ?? homeGroups[0]
  const currentGroup = pageGroup ?? membershipGroup
  const viewingOtherGroup = Boolean(pageGroup && !me.effectiveGroupIds.includes(pageGroup.id))
  return { me, groups, currentGroup, membershipGroup, viewingOtherGroup, homeGroups, pageGroupPath, setMembershipGroup }
}
