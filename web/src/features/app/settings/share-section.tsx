import { Button } from '../../../ui'
import { copy } from '../../../copy'
import { sharingCopy } from '../../../copy/sharing'
import type { AccessDisplay } from '../../../model/access'
import { SettingsCard } from './parts'

/** The same sharing dialog is reachable from the app header and settings. */
export function ShareSection({ access, onShare }: { access: AccessDisplay; onShare: () => void }) {
  return (
    <SettingsCard id="share" title={copy.app.settings.share}>
      <p className="mb-3 text-sm text-stone-700" data-testid="settings-access-status">{access.label}</p>
      <Button onClick={onShare}>{sharingCopy.title}</Button>
    </SettingsCard>
  )
}
