import type { JSX, Ref } from 'react'
import { buildCopy } from '../../../model/build/copy'
import { paths } from '../../../routes/paths'
import { Button, cn, LinkButton } from '../../../ui'
import { implementationCopy as copy } from './copy'
import { canReconnect, type PreviewStatusKind } from './preview'
import type { PreviewSessionHandle } from './use-preview-session'

/** The one sentence each state shows; `preparing` is the build page's existing wording. */
function message(kind: PreviewStatusKind): string {
  switch (kind) {
    case 'preparing': return copy.preparing
    case 'connecting': return copy.viewer.connecting
    case 'resuming': return copy.viewer.resuming
    case 'asleep': return copy.viewer.asleep
    case 'unpublished': return copy.viewer.unpublished
    case 'conflict': return copy.viewer.conflict
    case 'unavailable': return copy.viewer.unavailable
    case 'unknown': return copy.viewer.unknown
    case 'cookie-refused': return copy.viewer.cookieRefused
    case 'renew-failed': return copy.viewer.renewFailed
    case 'failed': case 'endpoint-changed': return copy.viewer.failed
    case 'revoked': return copy.viewer.revoked
    case 'denied': return copy.viewer.denied
    case 'credential-not-allowed': return copy.viewer.credentialNotAllowed
    case 'verifier-unavailable': return copy.viewer.verifierUnavailable
    case 'not-found': return copy.viewer.notFound
    case 'unconfirmed': return copy.viewer.unconfirmed
  }
}

/** Waiting states say so politely; states that stopped or refused the preview are announced at once. */
const WAITING: Record<string, true> = { preparing: true, connecting: true, resuming: true, asleep: true }

/**
 * The preview frame, or the sentence that replaces it. The frame loads the workspace's own origin with the
 * design's attributes (§7): sandboxed to scripts, same-origin and forms, no permission delegation, no referrer.
 * The page never reads the frame's document or talks to it.
 */
export function PreviewViewer({ session, workspaceId, title, revision = 0, newTab = false, onReadBack, frameRef, frameClassName, statusClassName }: {
  session: PreviewSessionHandle
  workspaceId: string
  title: string
  /** Bumped to reload the frame (「見てみる」); the session is not renewed for it. */
  revision?: number
  /** Offer the new-tab viewer where the browser refused the session Cookie. */
  newTab?: boolean
  /** Reads the workspace back (after an answer that could not be read). */
  onReadBack?: () => void
  frameRef?: Ref<HTMLIFrameElement>
  frameClassName?: string
  statusClassName?: string
}): JSX.Element {
  const { view } = session
  if (view.kind === 'ready') {
    return (
      <iframe
        key={`${view.frame}:${revision}`}
        ref={frameRef}
        title={title}
        src={view.src}
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
        className={frameClassName}
      />
    )
  }
  const reconnect = canReconnect(view)
  const confirm = view.kind === 'unconfirmed' && onReadBack
  return (
    <div className={cn('flex flex-col items-center gap-3 px-4 text-center', statusClassName)}>
      <p role={WAITING[view.kind] ? 'status' : 'alert'} className="max-w-md text-sm leading-relaxed text-stone-600">{message(view.kind)}</p>
      {reconnect || confirm || (newTab && view.kind === 'cookie-refused') ? (
        <div className="flex flex-wrap justify-center gap-2">
          {reconnect ? <Button size="sm" onClick={session.reconnect}>{copy.viewer.reconnect}</Button> : null}
          {confirm ? <Button size="sm" onClick={() => { onReadBack(); session.reconnect() }}>{buildCopy.failure.confirm}</Button> : null}
          {newTab && view.kind === 'cookie-refused' ? <LinkButton href={paths.workspacePreview(workspaceId)} external size="sm" tone="ghost">{copy.newTab}</LinkButton> : null}
        </div>
      ) : null}
    </div>
  )
}
