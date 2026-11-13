import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { directoryLinks } from '../../api/console'
import { consoleKeys, migrateDirectory } from '../../api/queries/console'
import type { DirectoryMigrationResult, Me } from '../../model/contracts/console'
import { isUnconfirmedWrite, UnconfirmedNotice, useWriteConfirmation } from '../app/notices'
import { Button, ConfirmDialog, LinkButton, Notice } from '../../ui'
import { text } from './copy'

/**
 * Release-N banner for console admins: the console still holds people, groups
 * and memberships that belong in the Directory. One confirmed action pushes
 * them (`POST /admin/directory-migrate`); the result stays on screen and the
 * banner goes away once `me.migration.pending` turns false.
 */
export function DirectoryMigrationBanner({ me }: { me: Me }) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<DirectoryMigrationResult>()
  const migrate = useMutation({
    mutationFn: migrateDirectory,
    // An unreadable answer closes the dialog: the banner offers the read-back instead of a resend.
    onError: (error) => {
      if (isUnconfirmedWrite(error)) setConfirming(false)
    },
    onSuccess: async (answer) => {
      setConfirming(false)
      setResult(answer)
      await queryClient.invalidateQueries({ queryKey: ['console'] })
    },
  })
  // A migration whose answer could not be read may have run: read `me` (its pending counts) back before offering it again.
  const confirmation = useWriteConfirmation([migrate.error], migrate.reset, () => queryClient.refetchQueries({ queryKey: consoleKeys.me, exact: true }))
  const words = text.migration
  const directoryButton = me.directoryPublicURL ? (
    <LinkButton href={directoryLinks.groups(me.directoryPublicURL)} external size="sm">{words.openDirectory}</LinkButton>
  ) : null

  if (result) {
    const { imported, conflicts } = result
    return (
      <Notice tone={conflicts.length > 0 ? 'warning' : 'success'} title={words.doneTitle} actions={directoryButton}>
        <p>{words.imported(imported.people, imported.groups, imported.memberships)}</p>
        {conflicts.length > 0 ? (
          <>
            <p className="mt-1">{words.conflicts(conflicts.length)}</p>
            <ul aria-label={words.conflictsLabel} className="mt-2 list-disc space-y-0.5 pl-5 font-mono text-xs">
              {conflicts.map((conflict) => (
                <li key={`${conflict.entity}-${conflict.id}-${conflict.reason}`}>
                  {words.entity[conflict.entity] ?? conflict.entity} {conflict.id}: {conflict.reason}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Notice>
    )
  }
  if (!me.isConsoleAdmin || !me.migration.pending) return null
  const { people, groups, memberships } = me.migration
  return (
    <>
      <Notice
        tone="warning"
        title={words.title}
        actions={<Button tone="primary" size="sm" disabled={confirmation.unconfirmed} onClick={() => setConfirming(true)}>{words.start}</Button>}
      >
        <p>{words.body}</p>
        <p className="mt-1 font-medium">{words.counts(people, groups, memberships)}</p>
      </Notice>
      {confirmation.unconfirmed ? <div className="mt-3"><UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} /></div> : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (migrate.isPending) return
          setConfirming(open)
          if (!open && !confirmation.unconfirmed) migrate.reset()
        }}
        title={words.confirmTitle}
        body={<div className="space-y-2"><p>{words.confirmBody}</p><p className="font-medium">{words.counts(people, groups, memberships)}</p></div>}
        confirmLabel={words.confirm}
        pending={migrate.isPending}
        error={migrate.isError ? migrate.error : undefined}
        onConfirm={() => { if (!migrate.isPending) migrate.mutate() }}
      />
    </>
  )
}
