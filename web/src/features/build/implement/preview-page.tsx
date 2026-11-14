import { useQuery } from '@tanstack/react-query'
import type { JSX } from 'react'
import { BUILD_POLL_MS } from '../../../api/queries/build'
import { POLL_INTERVAL_MS } from '../../../api/queries/shared'
import { isPlatformNotFound } from '../../../api/platform-error'
import { workspaceOptions } from '../../../api/workspace'
import { useShell } from '../../../shell/use-shell'
import { Card, Loading, LoadFailed, useDocumentTitle } from '../../../ui'
import { implementationCopy as copy } from './copy'
import { LegacyPreviewFrame, useLegacyPreview } from './legacy-preview'
import { previewAvailability } from './preview'
import { PreviewViewer } from './preview-viewer'
import { usePreviewSession } from './use-preview-session'

/**
 * The new-tab preview (`/-/workspaces/{id}/preview`, design §7): the Console's own page shows the same viewer
 * across the content area. It holds its own session, renewed while this tab is in the foreground, so several
 * tabs can show the preview side by side. The raw preview origin is never opened as a page.
 */
export function WorkspacePreviewPage({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { me } = useShell()
  const workspace = useQuery({
    ...workspaceOptions(me.projectId, workspaceId),
    // A preview still being published, a legacy workspace not yet Ready, or a state this console does not know is read until it settles.
    refetchInterval: (query) => {
      const availability = query.state.data && previewAvailability(query.state.data)
      if (availability?.kind === 'preparing') return BUILD_POLL_MS
      return availability?.kind === 'unknown' || (availability?.kind === 'legacy' && !availability.url) ? POLL_INTERVAL_MS : false
    },
  })
  const readBack = () => { void workspace.refetch() }
  const availability = workspace.data ? previewAvailability(workspace.data) : undefined
  // Legacy same-origin preview (remove at migration stage 5; ./legacy-preview.tsx): a never-moved workspace.
  const legacy = useLegacyPreview(availability)
  const session = usePreviewSession(
    workspace.data && availability ? { projectId: me.projectId, workspaceId, availability } : undefined,
    { enabled: !legacy, onEndpointChanged: readBack },
  )
  const name = workspace.data?.displayName
  useDocumentTitle(name ? copy.viewer.pageTitle(name) : copy.preview)

  if (!workspace.data) {
    if (workspace.isPending) return <Loading label={copy.viewer.pageLoading} />
    if (isPlatformNotFound(workspace.error)) return <p role="alert" className="py-12 text-center text-sm text-stone-600">{copy.viewer.notFound}</p>
    return <LoadFailed error={workspace.error} onRetry={readBack} />
  }
  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="break-words text-lg font-semibold text-stone-900">{copy.viewer.pageTitle(workspace.data.displayName)}</h1>
        {legacy ? null : <p className="mt-1 text-xs leading-relaxed text-stone-500">{copy.viewer.pageNote}</p>}
      </header>
      {/* A failed re-read keeps the last good workspace on screen; the session keeps following it. */}
      {workspace.isRefetchError ? <p role="status" className="text-xs text-amber-800">{copy.viewer.refreshFailed}</p> : null}
      {legacy ? <Card>
        <LegacyPreviewFrame legacy={legacy} title={copy.preview} frameClassName="h-[calc(100dvh-13rem)] min-h-80 w-full rounded-lg border-0 bg-white" />
      </Card> : <PreviewViewer
        session={session}
        workspaceId={workspaceId}
        title={copy.preview}
        onReadBack={readBack}
        frameClassName="h-[calc(100dvh-13rem)] min-h-80 w-full rounded-lg border border-line bg-white"
        statusClassName="rounded-lg border border-dashed border-stone-300 bg-white py-16"
      />}
    </div>
  )
}
