// Legacy same-origin preview — MIGRATION ONLY. Remove this module at migration stage 5 (with the Platform's
// legacy `/proxy/preview/` route, `devWorkspaceProxyUrl`/`previewStatus` in api/workspace.ts, the reader's
// `legacyPreviewUrl` and the `legacy` kind of `PreviewAvailability`).
//
// A workspace the Platform has never moved to its own origin (no `httpEndpoints` preview entry and no
// `DirectPreviewActivated=True`) still shows its preview exactly as before APT-798: an iframe of the
// Console-proxied `previewUrl`, a readiness probe of that same URL, and a new-tab link to it. The decision is
// made in one place only, `previewAvailability` (./preview.ts), from each Platform answer; nothing here decides
// it, and nothing is kept in the browser, so a moved workspace can never come back here.
import { useEffect, useState, type JSX, type Ref } from 'react'
import { previewStatus } from '../../../api/workspace'
import { Button, Card, CardBody, CardHeader } from '../../../ui'
import { implementationCopy as copy } from './copy'
import type { PreviewAvailability } from './preview'
import { PreviewDatabaseLine, type PreviewDatabaseControl } from './preview-database'

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

/** A legacy workspace's preview: `url` (Console-proxied) only once the workspace is Ready, and its probed readiness. */
export interface LegacyPreview {
  url?: string
  status: PreviewReadiness
}

/** The legacy preview of `availability`, probing its URL; undefined for every workspace that is not legacy. */
export function useLegacyPreview(availability: PreviewAvailability | undefined): LegacyPreview | undefined {
  const url = availability?.kind === 'legacy' ? availability.url : undefined
  const status = usePreviewReadiness(url)
  return availability?.kind === 'legacy' ? { ...(url ? { url } : {}), status } : undefined
}

export function legacyPreviewReady(legacy: LegacyPreview): boolean {
  return Boolean(legacy.url) && legacy.status === 'ready'
}

/** The iframe once the URL answers, else the waiting / error sentence (the pre-APT-798 build card body). */
export function LegacyPreviewFrame({ legacy, title, revision = 0, frameRef, frameClassName }: {
  legacy: LegacyPreview
  title: string
  revision?: number
  frameRef?: Ref<HTMLIFrameElement>
  frameClassName?: string
}): JSX.Element {
  if (legacyPreviewReady(legacy)) {
    return (
      <iframe
        key={`${legacy.url}:${revision}`}
        ref={frameRef}
        title={title}
        src={legacy.url}
        sandbox="allow-same-origin allow-scripts allow-forms"
        className={frameClassName}
      />
    )
  }
  const message = legacy.status === 'error' ? copy.previewError : legacy.status === 'timed-out' ? copy.previewTimedOut : copy.preparing
  return <CardBody><p role="status" className="py-16 text-center text-sm text-stone-500">{message}</p></CardBody>
}

/** The new tab opens the legacy URL itself once it answered, or as the escape hatch after an error or the deadline. */
export function legacyNewTabUrl(legacy: LegacyPreview): string | undefined {
  return legacy.url && legacy.status !== 'preparing' ? legacy.url : undefined
}

/** The build page's preview card for a legacy workspace, as it was before APT-798. */
export function LegacyPreviewCard({ legacy, previewNotice, previewDatabase, revision, frameRef, onOpen }: {
  legacy: LegacyPreview
  previewNotice?: string
  previewDatabase?: PreviewDatabaseControl
  revision: number
  frameRef: Ref<HTMLIFrameElement>
  onOpen(): void
}): JSX.Element {
  const newTab = legacyNewTabUrl(legacy)
  return (
    <Card>
      <CardHeader title={copy.title} actions={(
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!legacyPreviewReady(legacy)} onClick={onOpen}>{copy.open}</Button>
          {newTab ? <Button asChild tone="ghost" size="sm">
            <a href={newTab} target="_blank" rel="noopener noreferrer">{copy.newTab}</a>
          </Button> : <Button tone="ghost" size="sm" disabled>{copy.newTab}</Button>}
        </div>
      )} />
      {previewNotice ? <p role="note" className="border-t border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">{previewNotice}</p> : null}
      {previewDatabase ? <PreviewDatabaseLine control={previewDatabase} /> : null}
      <LegacyPreviewFrame legacy={legacy} title={copy.preview} revision={revision} frameRef={frameRef} frameClassName="h-48 w-full rounded-b-lg border-0 bg-white sm:h-56" />
    </Card>
  )
}
