// 「やめる」 for an AI build session: remove what 用意する created (cleanup), delete
// the draft, forget the browser-side session, and drop it from 作りかけ.
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { cleanupCreation, deleteDraft } from '../../api/build'
import { buildKeys } from '../../api/build-queries'
import { buildCopy } from '../../model/build/copy'
import { hasCreationResources, isDraftBusy } from '../../model/build/discard'
import { parseSpec } from '../../model/build/spec'
import { useShell } from '../../shell/use-shell'
import { Button, ConfirmDialog } from '../../ui'
import { forgetBuildSession } from './session'

export function useDiscardBuildDraft(draft: ApplicationDraft) {
  const { me } = useShell()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      if (hasCreationResources(draft)) await cleanupCreation(me.projectId, draft.id)
      await deleteDraft(me.projectId, draft.id)
      forgetBuildSession(draft.id)
    },
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: buildKeys.draft(me.projectId, draft.id) })
      await queryClient.invalidateQueries({ queryKey: buildKeys.drafts(me.projectId) })
    },
  })
}

/** The 作りかけ row action: a ghost button and its confirmation. Disabled, with the reason, while the AI works. */
export function DiscardBuildButton({ draft }: { draft: ApplicationDraft }) {
  const [open, setOpen] = useState(false)
  const discard = useDiscardBuildDraft(draft)
  const name = parseSpec(draft.specMarkdown).spec.name ?? draft.title
  const busy = isDraftBusy(draft)
  return (
    <>
      <Button tone="ghost" size="sm" aria-label={buildCopy.discard.label(name)} title={busy ? buildCopy.discard.running : undefined} disabled={busy} onClick={() => setOpen(true)}>
        {buildCopy.discard.action}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) discard.reset()
          setOpen(next)
        }}
        title={buildCopy.discard.title(name)}
        body={hasCreationResources(draft) ? buildCopy.discard.bodyWithResources : buildCopy.discard.body}
        confirmLabel={discard.isPending ? buildCopy.discard.pending : buildCopy.discard.confirm}
        tone="danger"
        onConfirm={() => discard.mutate(undefined, { onSuccess: () => setOpen(false) })}
        pending={discard.isPending}
        error={discard.error ?? undefined}
      />
    </>
  )
}
