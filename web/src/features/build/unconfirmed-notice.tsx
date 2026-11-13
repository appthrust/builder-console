import { buildCopy } from '../../model/build/copy'
import { Button, Notice } from '../../ui'

/**
 * A build/improve write answered 2xx with an answer this console cannot read: it may have happened.
 * The only action reads the latest state back (design §6: never a generic retry, never a resend).
 */
export function UnconfirmedNotice({ onConfirm }: { onConfirm(): void }) {
  return <Notice tone="warning" title={buildCopy.failure.unconfirmed.title} actions={<Button size="sm" onClick={onConfirm}>{buildCopy.failure.confirm}</Button>}>
    {buildCopy.failure.unconfirmed.reason}
  </Notice>
}
