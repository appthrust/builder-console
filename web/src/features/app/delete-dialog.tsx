import type { ApplicationSourceRepository } from '@appthrust/api-schema/platform-api'
import type { BusinessApp } from '../../api/console-unverified'
import { copy } from '../../copy'
import type { AppView } from '../../model/app'
import { ConfirmDialog, Notice } from '../../ui'
import { text } from './copy'
import { SourceStillReferencedError, useDeleteApp } from './mutations'
import { repositoryNameOf, sourceRepositoryIdFor } from './platform'

/** What deleting removes, and that the GitHub repository (置き場) stays, named once the platform reports it. */
export function deleteHelpText(view: AppView, sourceRepository: ApplicationSourceRepository | undefined): string {
  const help = copy.app.settings.deleteHelp
  return sourceRepositoryIdFor(view) ? help + copy.app.settings.deleteKeepsRepository(repositoryNameOf(sourceRepository)) : help
}

/** Type-the-name delete confirmation (ux-design §6.5); used by the header menu, the overview and 危険な操作. */
export function DeleteAppDialog({
  projectId,
  app,
  view,
  sourceRepository,
  open,
  onOpenChange,
}: {
  projectId: string
  app: BusinessApp
  view: AppView
  sourceRepository: ApplicationSourceRepository | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const mutation = useDeleteApp(projectId, app, view)
  const busy = mutation.error instanceof SourceStillReferencedError
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) mutation.reset()
        onOpenChange(next)
      }}
      title={text.settings.deleteDialogTitle(app.displayName)}
      body={
        <div className="space-y-3">
          <p>{deleteHelpText(view, sourceRepository)}</p>
          {busy ? <Notice tone="error">{copy.app.settings.deleteSourceBusy}</Notice> : null}
        </div>
      }
      confirmLabel={mutation.isPending ? copy.app.settings.deleting : copy.app.settings.deleteConfirm}
      tone="danger"
      confirmText={app.displayName}
      onConfirm={() => mutation.mutate()}
      pending={mutation.isPending}
      error={busy ? undefined : mutation.error ?? undefined}
    />
  )
}
