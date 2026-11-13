import { useQueryClient } from '@tanstack/react-query'
import { consoleKeys } from '../../api/queries/console'
import { keys } from '../../api/queries/shared'
import { copy } from '../../copy'
import type { AppView } from '../../model/app'
import type { BusinessApp } from '../../model/contracts/console'
import { ConfirmDialog, Notice } from '../../ui'
import { text } from './copy'
import { SourceStillReferencedError, useDeleteApp } from './mutations'
import { UnconfirmedNotice, useWriteConfirmation } from './notices'
import { repositoryNameOf, sourceRepositoryIdFor, type SourceRepositoryRef } from './platform'

/** What deleting removes, and that the GitHub repository (置き場) stays, named once the platform reports it. */
export function deleteHelpText(view: AppView, sourceRepository: SourceRepositoryRef | undefined): string {
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
  sourceRepository: SourceRepositoryRef | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const mutation = useDeleteApp(projectId, app, view)
  const busy = mutation.error instanceof SourceStillReferencedError
  // A delete whose answer could not be read may have happened: read the app and its resources back before offering it again.
  const confirmation = useWriteConfirmation([mutation.error], mutation.reset, () => Promise.all([
    queryClient.refetchQueries({ queryKey: consoleKeys.app(app.id) }),
    ...[keys.stacks, keys.applications, keys.sourceRepositories].map((key) => queryClient.refetchQueries({ queryKey: key(projectId) })),
  ]))
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !confirmation.unconfirmed) mutation.reset()
        onOpenChange(next)
      }}
      title={text.settings.deleteDialogTitle(app.displayName)}
      body={
        <div className="space-y-3">
          <p>{deleteHelpText(view, sourceRepository)}</p>
          {busy ? <Notice tone="error">{copy.app.settings.deleteSourceBusy}</Notice> : null}
          {confirmation.unconfirmed ? <UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} /> : null}
        </div>
      }
      confirmLabel={mutation.isPending ? copy.app.settings.deleting : copy.app.settings.deleteConfirm}
      tone="danger"
      confirmText={app.displayName}
      onConfirm={() => mutation.mutate()}
      pending={mutation.isPending}
      disabled={confirmation.unconfirmed}
      error={busy || confirmation.unconfirmed ? undefined : mutation.error ?? undefined}
    />
  )
}
