import { useEffect, useState } from 'react'
import { previewStatus } from '../../../api/workspace'

export const PREVIEW_POLL_MS = 4_000
export const PREVIEW_SLOW_POLL_MS = 15_000
export const PREVIEW_TIMEOUT_MS = 10 * 60_000
export type PreviewReadiness = 'preparing' | 'ready' | 'error' | 'timed-out'

export function previewReadiness(status: number | undefined, elapsedMs: number): PreviewReadiness {
  if (status !== undefined && status >= 200 && status < 400) return 'ready'
  if (status === 500) return 'error'
  return elapsedMs >= PREVIEW_TIMEOUT_MS ? 'timed-out' : 'preparing'
}

/** Container readiness does not prove the app is listening. Read the same URL the iframe will use. */
export function usePreviewReadiness(url: string | undefined): PreviewReadiness {
  const [result, setResult] = useState({ url, status: 'preparing' as PreviewReadiness })
  // A previous URL's success must never flash an unprobed iframe, including after a workspace restart.
  if (result.url !== url) setResult({ url, status: 'preparing' })

  useEffect(() => {
    if (!url) return
    const startedAt = Date.now()
    let stopped = false
    let request: AbortController | undefined
    let retryTimer: number | undefined
    let requestTimer: number | undefined

    function stop() {
      stopped = true
      window.clearTimeout(deadline)
      window.clearTimeout(retryTimer)
      window.clearTimeout(requestTimer)
      request?.abort()
    }
    // The deadline changes the message, not the lifetime of the reader.
    const deadline = window.setTimeout(() => {
      setResult((current) => ({ url, status: current.status === 'error' ? 'error' : 'timed-out' }))
    }, PREVIEW_TIMEOUT_MS)

    async function poll() {
      const attemptAt = Date.now()
      request = new AbortController()
      // Bound individual requests too: a hung response must not stall readiness or its deadline.
      requestTimer = window.setTimeout(() => request?.abort(), PREVIEW_POLL_MS)
      const status = await previewStatus(url!, request.signal)
      window.clearTimeout(requestTimer)
      if (stopped) return
      const elapsedMs = Date.now() - startedAt
      const next = previewReadiness(status, elapsedMs)
      setResult({ url, status: next })
      if (next === 'ready') stop()
      else {
        const interval = elapsedMs >= PREVIEW_TIMEOUT_MS ? PREVIEW_SLOW_POLL_MS : PREVIEW_POLL_MS
        retryTimer = window.setTimeout(() => { void poll() }, Math.max(0, interval - (Date.now() - attemptAt)))
      }
    }
    void poll()
    return stop
  }, [url])

  return result.url === url ? result.status : 'preparing'
}
