// Why a NEW-APP start stopped (APT-753), in specific words with the next step
// that helps. A console-v1 start that may have happened or is still running is
// checked with the same create key (the server replays; no second session). A
// session the server stopped is not retried as itself: 「新しく作り直す」 forgets
// the kept start so the next one is a new session, by the user's choice.
import { failureKind } from '../../model/build/replies'
import { Button, Notice } from '../../ui'
import { text as createText } from '../create/copy'
import { saveConsoleStart } from './console-session-state'
import { text } from './copy'
import { BuildStartError } from './entry'

export function BuildStartFailure({ error, busy, onRetry, className }: { error: unknown; busy: boolean; onRetry(): void; className?: string }) {
  const start = text.console.start
  if (!(error instanceof BuildStartError)) {
    return <Notice tone="error" className={className} title={createText.buildFailed} actions={<Button loading={busy} onClick={onRetry}>{createText.retryBuild}</Button>}>{createText.inputKept}</Notice>
  }
  if (error.reason === 'unconfirmed' || error.reason === 'timeout') {
    return <Notice tone="warning" className={className} title={start[error.reason].title} actions={<Button loading={busy} onClick={onRetry}>{start.check}</Button>}>{start[error.reason].reason}</Notice>
  }
  const failure = error.failure ? text.console.failure[failureKind(error.failure.error, error.failure.details)] : undefined
  return <Notice tone="error" className={className} title={failure?.title ?? start[error.reason].title} actions={<Button loading={busy} onClick={() => { saveConsoleStart(undefined); onRetry() }}>{start.restart}</Button>}>
    {failure ? `${failure.reason} ${start[error.reason].reason}` : start[error.reason].reason}
  </Notice>
}
