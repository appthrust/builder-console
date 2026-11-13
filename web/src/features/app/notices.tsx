import { RotateCw } from 'lucide-react'
import { useState } from 'react'
import { isResponseContractError } from '../../api/boundary'
import { copy, relativeTime } from '../../copy'
import { Button, Notice } from '../../ui'
import { text } from './copy'

/** Shown data could not be refreshed: the last good answer stays, with when it was read and a retry. */
export function StaleNotice({ updatedAt, refetching, onRetry }: { updatedAt: number; refetching: boolean; onRetry(): void }) {
  return (
    <Notice tone="warning" actions={<Button size="sm" icon={<RotateCw />} loading={refetching} onClick={onRetry}>{copy.common.retry}</Button>}>
      {copy.common.refreshFailed(relativeTime(new Date(updatedAt).toISOString()) ?? '')}
    </Notice>
  )
}

/** A write answered 2xx with an answer this console cannot read: it may have happened. */
export function isUnconfirmedWrite(error: unknown): boolean {
  return isResponseContractError(error)
}

/**
 * Gate for writes whose answer could not be read. While any of `errors` is an
 * unconfirmed write, the panel's write actions stay disabled; `confirm` reads
 * the state back and only then clears the failed mutations (`reset`).
 */
export function useWriteConfirmation(errors: readonly unknown[], reset: () => void, readBack: () => Promise<unknown>) {
  const [confirming, setConfirming] = useState(false)
  return {
    unconfirmed: errors.some(isUnconfirmedWrite),
    confirming,
    confirm: async () => {
      setConfirming(true)
      try {
        await readBack()
        reset()
      } finally {
        setConfirming(false)
      }
    },
  }
}

/**
 * The only action after an unconfirmed write reads the latest state back
 * (design §6: never a generic retry, never a resend). The write's own action
 * stays disabled until this confirmation has run.
 */
export function UnconfirmedNotice({ onConfirm, confirming = false }: { onConfirm(): void; confirming?: boolean }) {
  return (
    <Notice tone="warning" title={text.unconfirmed.title} actions={<Button size="sm" loading={confirming} onClick={onConfirm}>{text.unconfirmed.confirm}</Button>}>
      {text.unconfirmed.reason}
    </Notice>
  )
}
