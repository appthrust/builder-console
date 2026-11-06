import type { RefObject } from 'react'
import { ConfirmDialog, Notice } from '../../../ui'
import { writeText } from './copy-write'

/**
 * 「この行を削除」 confirmation, naming the row by its display value
 * (design, States: 「「ノートPC」の行を削除しますか？ この操作はアプリにすぐ反映されます」).
 */
export function DeleteRowDialog({
  open,
  onOpenChange,
  rowName,
  onConfirm,
  pending,
  error,
  returnFocusRef,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rowName: string
  onConfirm: () => void
  pending: boolean
  /** Localized message of the failed delete (`mapSaveError(…, 'delete')`). */
  error?: string
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={writeText.deleteDialog.title(rowName)}
      body={
        <div className="space-y-3">
          <p>{writeText.deleteDialog.body}</p>
          {error ? <Notice tone="error">{error}</Notice> : null}
        </div>
      }
      confirmLabel={writeText.deleteDialog.confirm}
      tone="danger"
      onConfirm={onConfirm}
      pending={pending}
      returnFocusRef={returnFocusRef}
    />
  )
}
