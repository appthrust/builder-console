import { useSelector } from '@tanstack/react-store'
import type { ReactNode } from 'react'
import { sessionExpiryStore, signInAgain } from '../api/session-expiry'
import { copy } from '../copy'
import { Button } from './button'
import { Notice } from './feedback'

/** Remove query observers while signed out, rather than showing stale progress or polling IAM. */
export function SessionExpiryBoundary({ children }: { children: ReactNode }) {
  const expired = useSelector(sessionExpiryStore, (state) => state)
  if (!expired) return children
  return <main className="mx-auto w-full max-w-xl p-6">
    <Notice tone="error" title={copy.common.sessionExpired} actions={<Button tone="primary" onClick={signInAgain}>{copy.common.signInAgain}</Button>} />
  </main>
}
