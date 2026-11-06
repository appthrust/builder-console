import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { consoleApi, directoryLinks, type DirectoryMigrationResult, type Me } from '../../api/console'
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
    mutationFn: () => consoleApi.admin.directoryMigrate(),
    onSuccess: async (answer) => {
      setConfirming(false)
      setResult(answer)
      await queryClient.invalidateQueries({ queryKey: ['console'] })
    },
  })
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
        actions={<Button tone="primary" size="sm" onClick={() => setConfirming(true)}>{words.start}</Button>}
      >
        <p>{words.body}</p>
        <p className="mt-1 font-medium">{words.counts(people, groups, memberships)}</p>
      </Notice>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (migrate.isPending) return
          setConfirming(open)
          if (!open) migrate.reset()
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
