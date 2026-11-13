// The build screen for a console-v1 session (APT-753). This frame owns what
// S4-U1 owns: reading the session through `useConsoleBuildSession`, the
// load/refresh boundary, and the write notices (unconfirmed → re-read only,
// interrupted → resend the same intent, 412 → the newer state with the
// server's message). The typed reply, confirmation, progress and publish
// presentation is the conversation pane of S4-U2, rendered from `view`.
import { useEffect, type ReactNode } from 'react'
import { copy } from '../../copy'
import { buildCopy } from '../../model/build/copy'
import { parseSpec } from '../../model/build/spec'
import { Button, Loading, Notice, ResourceBoundary, focusHeading, useDocumentTitle } from '../../ui'
import { Composer } from './composer'
import type { ConsoleBuildView } from './console-view'
import { useConsoleBuildSession, type ConsoleBuildActions } from './use-console-build-session'
import { text } from './copy'

export function ConsoleBuildPage({ sessionId }: { sessionId: string }) {
  const build = useConsoleBuildSession(sessionId)
  return <ResourceBoundary query={build.query} resetKey={sessionId} loading={<Loading className="px-5" />}>
    {(_session, stale) => build.view ? <ConsoleSession view={build.view} actions={build.actions} stale={stale} /> : null}
  </ResourceBoundary>
}

function ConsoleSession({ view, actions, stale }: { view: ConsoleBuildView; actions: ConsoleBuildActions; stale: ReactNode }) {
  const name = parseSpec(view.session.specification.markdown).spec.name || text.session.newApp
  useDocumentTitle(text.page.title(name))
  useEffect(() => { focusHeading('build-title') }, [view.session.id])
  const { write, failure, conflict, progress } = view
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="build-session" data-engine="console-v1">
    <header className="border-b border-line px-5 py-3">
      <h1 id="build-title" className="truncate text-base font-semibold text-stone-900">{name}</h1>
    </header>
    {stale || write?.status === 'unconfirmed' || failure || conflict ? <div className="mx-5 mt-3 space-y-3">
      {stale}
      {write?.status === 'unconfirmed' ? <Notice tone="warning" title={buildCopy.failure.unconfirmed.title} actions={<Button size="sm" onClick={() => void actions.confirm()}>{buildCopy.failure.confirm}</Button>}>
        {buildCopy.failure.unconfirmed.reason}
      </Notice> : null}
      {failure ? <Notice tone="error" title={failure.message} actions={failure.retryable && write?.status === 'interrupted' ? <Button size="sm" onClick={actions.retry}>{text.conversation.retry}</Button> : undefined} /> : null}
      {conflict ? <Notice tone="info" title={conflict.message} actions={<Button size="sm" tone="ghost" onClick={actions.dismissConflict}>{copy.common.close}</Button>} /> : null}
    </div> : null}
    {!failure && write?.status === 'interrupted' ? <div className="mx-5 mt-3"><Button size="sm" onClick={actions.retry}>{text.conversation.retry}</Button></div> : null}
    <div className="flex min-h-0 flex-1 flex-col px-5 pb-3">
      <ol role="log" aria-label={text.conversation.log} className="min-h-0 flex-1 space-y-3 overflow-y-auto py-4 text-sm">
        {view.turns.map((turn) => turn.kind === 'conversation'
          ? <li key={turn.id} className="space-y-2">
              <p className="whitespace-pre-wrap text-stone-900">{text.conversation.you}{turn.request.message}</p>
              {turn.reply ? <p className="whitespace-pre-wrap text-stone-700">{turn.reply.answer}</p> : null}
            </li>
          : <li key={turn.id}><p className="text-stone-900">{text.conversation.you}{buildCopy.questions.kickoffReply}</p></li>)}
      </ol>
      {progress && view.activeTurn ? <p role="status" className="py-2 text-xs text-stone-500">
        {view.activeTurn.kind === 'request_plan' ? buildCopy.progress.plan.title : buildCopy.progress.turn.title}
      </p> : null}
      {view.session.capabilities.canRequestPlan ? <div className="flex justify-end py-2">
        <Button tone="primary" disabled={!view.canRequestPlan} onClick={() => actions.requestPlan()}>{buildCopy.questions.kickoffReply}</Button>
      </div> : null}
      <Composer disabled={!view.canSend} placeholder={text.conversation.replyPlaceholder} onSubmit={(message) => { actions.send(message) }} onChip={(value) => { actions.send(value) }} />
    </div>
  </div>
}
