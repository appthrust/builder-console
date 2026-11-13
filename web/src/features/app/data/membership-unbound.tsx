// 412 `database_access_membership_unbound` (design/platform/
// team-membership-database-access-visibility.md): the caller has a Team role,
// but the membership gives the Gateway identity no database access. Shared by
// the データ tab and the データベースの変更 card; it is fixed on the
// Dashboard's Team settings, linked when the console config names it.
import { ExternalLink } from 'lucide-react'
import { membershipUnboundReason } from '../../../api/queries/data'
import { useDashboardSettingsUrl } from '../../../api/queries/console'
import { LinkButton, Notice } from '../../../ui'
import { dataText } from './copy'

export function MembershipUnboundNotice({ error }: { error: unknown }) {
  const settingsUrl = useDashboardSettingsUrl()
  const reason = membershipUnboundReason(error)
  return (
    <Notice tone="warning" title={dataText.membershipUnboundTitle} actions={
      settingsUrl ? <LinkButton external href={settingsUrl} icon={<ExternalLink />}>{dataText.teamSettings}</LinkButton> : undefined
    }>
      {reason ? dataText.membershipUnbound[reason] : null}
    </Notice>
  )
}
