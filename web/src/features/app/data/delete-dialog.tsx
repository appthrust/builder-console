import type { RefObject } from 'react'
import { ConfirmDialog, Notice } from '../../../ui'
import { UnconfirmedNotice } from '../notices'
import { writeText } from './copy-write'

/**
 * 「この行を削除」 confirmation, naming the row by its display value
 * (design, States: 「「ノートPC」の行を削除しますか？ この操作はアプリにすぐ反映されます」).
 * While a write of the 表 is unconfirmed, 削除する stays off and the only
 * action is 「最新の状態を確認する」.
 */
export function DeleteRowDialog({
  open,
  onOpenChange,
  rowName,
  onConfirm,
  pending,
  error,
  unconfirmed,
  returnFocusRef,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rowName: string
  onConfirm: () => void
  pending: boolean
  /** Localized message of the failed delete (`mapSaveError(…, 'delete')`). */
  error?: string
  /** A write of the 表 may have happened unseen: its read-back, and whether it is running. */
  unconfirmed?: { confirming: boolean; onConfirm: () => void }
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
          {unconfirmed ? <UnconfirmedNotice confirming={unconfirmed.confirming} onConfirm={unconfirmed.onConfirm} /> : null}
          {error && !unconfirmed ? <Notice tone="error">{error}</Notice> : null}
        </div>
      }
      confirmLabel={writeText.deleteDialog.confirm}
      tone="danger"
      onConfirm={onConfirm}
      pending={pending}
      disabled={unconfirmed !== undefined}
      returnFocusRef={returnFocusRef}
    />
  )
}
