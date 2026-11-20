import { useQueryClient } from '@tanstack/react-query'
import { isResponseContractError } from '../../api/boundary'
import { isAccessDenied, platformErrorEnvelope } from '../../api/platform-error'
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

/** What a refused deletion says: a title and its sentences, never Platform's message. */
export interface DeletionRefusal {
  title: string
  lines: string[]
}

/** Platform's kind for an app's work areas (those of its build and improvement sessions among them); other kinds are not named. */
const WORK_AREA_KIND = 'DevWorkspace'

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
}

/**
 * A deletion Platform refused, in the user's words; one attempt per 「完全に削除する」, the console never waits and
 * sends again on its own:
 * - 412 `branch_has_active_delivery` (platform-api application_branch.go `applicationBranchActiveDeliveryError`):
 *   what is left, from `activeConsumers` (kind and count); work areas are named and counted, and since nothing here
 *   removes them, the user is told who can;
 * - 409 `dependents_deleting` (with its `dependents`) or any refusal marked `retryable`: Platform is still clearing
 *   something, and the user presses 「完全に削除する」 again shortly;
 * - any other Platform refusal: that the app was not deleted, and what to do.
 * Undefined where ActionError already speaks: sign-in, an unreadable answer, an error that is not Platform's answer.
 */
export function deletionRefusal(error: unknown): DeletionRefusal | undefined {
  if (isResponseContractError(error) || isAccessDenied(error)) return undefined
  const envelope = platformErrorEnvelope(error)
  if (!envelope) return undefined
  const words = copy.app.settings.deleteRefused
  const details = envelope.details
  if (details?.reason === 'branch_has_active_delivery') {
    const consumers = entries(details.activeConsumers)
    const workAreas = consumers.reduce((sum, item) => item.kind === WORK_AREA_KIND && typeof item.count === 'number' && item.count > 0 ? sum + item.count : sum, 0)
    const others = consumers.length === 0 || consumers.some((item) => item.kind !== WORK_AREA_KIND)
    return {
      title: words.inUse,
      lines: [...(workAreas ? [words.workAreas(workAreas)] : []), ...(others ? [words.others] : []), workAreas ? words.workAreasNext : words.othersNext],
    }
  }
  if (details?.reason === 'dependents_deleting' || details?.retryable === true) {
    const dependents = entries(details.dependents)
    const workAreas = dependents.filter((item) => item.kind === WORK_AREA_KIND).length
    return { title: words.waiting, lines: [workAreas && workAreas === dependents.length ? words.waitingWorkAreas(workAreas) : words.waitingOthers, words.waitingNext] }
  }
  return { title: words.failed, lines: [envelope.status === 403 ? copy.errors.forbidden : words.failedNext] }
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
  const refusal = busy ? undefined : deletionRefusal(mutation.error)
  // A delete whose answer could not be read may have happened: read the app and its resources back before offering it again.
  const confirmation = useWriteConfirmation([mutation.error], mutation.reset, () => Promise.all([
    queryClient.refetchQueries({ queryKey: consoleKeys.app(app.id) }),
    ...[keys.stacks, keys.applications, keys.sourceRepositories].map((key) => queryClient.refetchQueries({ queryKey: key(projectId) })),
  ]))
  if (view.unreadableStack || view.unreadableBuild) return null
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
          {refusal ? <Notice tone="error" title={refusal.title}>{refusal.lines.map((line) => <p key={line}>{line}</p>)}</Notice> : null}
          {confirmation.unconfirmed ? <UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} /> : null}
        </div>
      }
      confirmLabel={mutation.isPending ? copy.app.settings.deleting : copy.app.settings.deleteConfirm}
      tone="danger"
      confirmText={app.displayName}
      onConfirm={() => mutation.mutate()}
      pending={mutation.isPending}
      disabled={confirmation.unconfirmed}
      error={busy || refusal || confirmation.unconfirmed ? undefined : mutation.error ?? undefined}
    />
  )
}
