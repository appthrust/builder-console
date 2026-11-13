import { useState, type JSX } from 'react'
import { buildCopy } from '../../../model/build/copy'
import { Button, ConfirmDialog, cn } from '../../../ui'
import { implementationCopy as copy } from './copy'
import type { PreviewDatabaseStatus } from './runtime'

/** What the preview card needs to tell about the workspace's own database and recreate it. */
export interface PreviewDatabaseControl {
  status: Exclude<PreviewDatabaseStatus, 'none'>
  /** The draft has an uploaded workbook: the ready lines talk about its rows. */
  excel: boolean
  /** An implementation is running; recreating would pull the database from under the AI. */
  busy: boolean
  pending: boolean
  /** The last refusal as one plain sentence. */
  error?: string
  /** Resolves true once the restart was accepted. */
  onReset(): Promise<boolean>
  /** Present after a restart whose answer could not be read: reads the workspace back (the only action then offered). */
  onConfirm?(): void
}

function statusText({ status, excel }: Pick<PreviewDatabaseControl, 'status' | 'excel'>): string {
  if (status === 'unsupported') return buildCopy.unsupported.title
  if (status === 'starting') return copy.database.starting
  if (status === 'sleeping') return copy.database.sleeping
  if (status === 'unavailable') return copy.database.unavailable
  return status === 'ready-verified' ? copy.database.readyVerified(excel) : copy.database.readyUnverified(excel)
}

/** One status line under the preview header, with 「データベースを作り直す」 and its confirmation. */
export function PreviewDatabaseLine({ control }: { control: PreviewDatabaseControl }): JSX.Element {
  const [open, setOpen] = useState(false)
  // A sleeping workspace keeps its data and the next implementation task wakes it: recreating would only lose that data.
  // After a restart whose answer could not be read, only the re-read is offered until it is done.
  // A database this console does not know is never recreated from here.
  const resettable = control.status !== 'starting' && control.status !== 'sleeping' && control.status !== 'unsupported' && !control.busy && !control.pending && !control.onConfirm
  const confirm = () => { void control.onReset().then(() => setOpen(false)) }
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t px-4 py-3 text-xs leading-relaxed', control.status === 'unavailable' || control.status === 'unsupported' ? 'border-amber-100 bg-amber-50 text-amber-900' : 'border-stone-100 text-stone-600')}>
      <div className="min-w-0 flex-1 space-y-1">
        <p role="status">{statusText(control)}</p>
        {control.status === 'unsupported' ? <p>{buildCopy.unsupported.detail}</p> : null}
        {control.error ? <p role="alert" className="text-bad-ink">{control.error}</p> : null}
        {control.onConfirm ? <Button size="sm" tone="ghost" onClick={control.onConfirm}>{buildCopy.failure.confirm}</Button> : null}
      </div>
      <Button size="sm" tone="secondary" disabled={!resettable} loading={control.pending} title={control.status === 'sleeping' ? copy.database.sleeping : control.status === 'unsupported' ? buildCopy.unsupported.detail : control.busy ? copy.databaseResetRunning : undefined} onClick={() => setOpen(true)}>
        {copy.databaseReset}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={copy.databaseReset}
        body={copy.databaseResetBody}
        confirmLabel={copy.databaseResetConfirm}
        tone="danger"
        onConfirm={confirm}
        pending={control.pending}
        disabled={!resettable && !control.pending}
      />
    </div>
  )
}
