import { Trash2 } from 'lucide-react'
import type { BusinessApp } from '../../model/contracts/console'
import { copy } from '../../copy'
import type { AppView } from '../../model/app'
import type { AccessDisplay } from '../../model/access'
import { Button, Notice } from '../../ui'
import { text } from './copy'
import { deleteHelpText } from './delete-dialog'
import { webScope, type SourceRepositoryRef } from './platform'
import { EnvSection } from './settings/env-section'
import { GeneralSection } from './settings/general-section'
import { SettingsCard } from './settings/parts'
import { PlacementSection } from './settings/placement-section'
import { ShareSection } from './settings/share-section'

/** 設定 (ux-design §7.3): every section saves on its own, with its own pending and error state. */
export function SettingsTab({
  projectId,
  app,
  view,
  access,
  onShare,
  sourceRepository,
  canEdit,
  onDelete,
}: {
  projectId: string
  app: BusinessApp
  view: AppView
  access: AccessDisplay
  onShare: () => void
  sourceRepository: SourceRepositoryRef | undefined
  canEdit: boolean
  onDelete: () => void
}) {
  return (
    <div className="grid items-start gap-6 md:grid-cols-[9rem_minmax(0,1fr)]">
      <nav aria-label={text.settings.navigation} className="sticky top-16 z-10 flex flex-wrap gap-1 rounded-lg border border-stone-200 bg-white p-2 md:top-24 md:flex-col">
        {Object.entries(text.settings.sections).map(([id, label]) => (
          <a key={id} href={`#${id}`} className="inline-flex min-h-10 items-center rounded-md px-3 text-sm text-stone-700 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-accent">{label}</a>
        ))}
      </nav>
      <div className="min-w-0 space-y-6">
      {!canEdit ? <Notice>{copy.app.settings.readOnly}</Notice> : null}
      <GeneralSection app={app} canEdit={canEdit} />
      <PlacementSection app={app} canEdit={canEdit} />
      <ShareSection access={access} onShare={onShare} />
      <EnvSection scope={webScope(projectId, view)} canEdit={canEdit} />
      <SettingsCard id="danger" title={copy.app.settings.danger} lead={text.settings.dangerLead} danger>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-stone-900">{copy.app.settings.deleteTitle}</h3>
            <p className="mt-0.5 text-sm text-stone-500">{deleteHelpText(view, sourceRepository)}</p>
          </div>
          <Button tone="danger" icon={<Trash2 />} disabled={!canEdit} onClick={onDelete}>
            {copy.app.settings.deleteAction}
          </Button>
        </div>
      </SettingsCard>
      </div>
    </div>
  )
}
