// 「やめる」 for an AI build session: remove what 用意する created (cleanup), delete
// the draft, forget the browser-side session, and drop it from 作りかけ.
import { isResponseContractError } from '../../api/boundary'
import type { BuildDraft } from '../../model/contracts/build'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { cleanupCreation, deleteDraft } from '../../api/build'
import { buildKeys } from '../../api/queries/build'
import { buildCopy } from '../../model/build/copy'
import { hasCreationResources, isDraftBusy } from '../../model/build/discard'
import { parseSpec } from '../../model/build/spec'
import { useShell } from '../../shell/use-shell'
import { Button, ConfirmDialog } from '../../ui'
import { forgetBuildSession } from './session'
import { UnconfirmedNotice } from './unconfirmed-notice'

export function useDiscardBuildDraft(draft: BuildDraft) {
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
    // Cleanup or delete answered 2xx but unreadably: it may have happened. Read both lists back; never resend.
    onError: (error) => {
      if (!isResponseContractError(error)) return
      void queryClient.invalidateQueries({ queryKey: buildKeys.draft(me.projectId, draft.id) })
      void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(me.projectId) })
    },
  })
}

/** The 作りかけ row action: a ghost button and its confirmation. Disabled, with the reason, while the AI works. */
export function DiscardBuildButton({ draft }: { draft: BuildDraft }) {
  const [open, setOpen] = useState(false)
  const { me } = useShell()
  const queryClient = useQueryClient()
  const discard = useDiscardBuildDraft(draft)
  const name = parseSpec(draft.specMarkdown).spec.name ?? draft.title
  const busy = isDraftBusy(draft)
  // Deleted or not is unknown: the list read back shows it (a deleted draft leaves the list, and this row with it).
  const unconfirmed = isResponseContractError(discard.error)
  const confirmLatest = () => {
    discard.reset()
    void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(me.projectId) })
  }
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
        body={<>
          {hasCreationResources(draft) ? buildCopy.discard.bodyWithResources : buildCopy.discard.body}
          {unconfirmed ? <div className="mt-4"><UnconfirmedNotice onConfirm={confirmLatest} /></div> : null}
        </>}
        confirmLabel={discard.isPending ? buildCopy.discard.pending : buildCopy.discard.confirm}
        tone="danger"
        onConfirm={() => discard.mutate(undefined, { onSuccess: () => setOpen(false) })}
        pending={discard.isPending}
        disabled={unconfirmed}
        error={unconfirmed ? undefined : discard.error ?? undefined}
      />
    </>
  )
}
