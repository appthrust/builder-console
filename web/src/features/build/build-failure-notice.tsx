import { buildCopy } from '../../model/build/copy'
import type { DraftBuildFailure } from '../../model/contracts/build'
import { Notice } from '../../ui'
import { ImproveButton } from '../improve/entry'

/**
 * The same current-build cause and one-click repair entry on app and build pages. `behind`: the app runs a release
 * (`AppView.latestBuildFailed`), so the reported failure is secondary and possibly false: a warning that says only what
 * is known, with the build run when its link is an http(s) URL. 「AI に直させる」 appears in both forms under the 0.5.9
 * condition only: the server extracted a cause (`failure`), the caller may edit, and the app has a stack.
 */
export function BuildFailureNotice({ failure, projectId, stackId, title, canEdit, behind }: {
  failure: Pick<DraftBuildFailure, 'lines'> | undefined
  projectId: string
  stackId: string | undefined
  title: string
  canEdit: boolean
  behind?: { runUrl?: string }
}) {
  const repair = canEdit && stackId && failure
    ? <ImproveButton app={{ displayName: title }} projectId={projectId} stackId={stackId} initialMessage={failure.lines.join('\n')} actionLabel="AI に直させる" />
    : null
  if (behind) {
    const runUrl = behind.runUrl && /^https?:\/\//i.test(behind.runUrl) ? behind.runUrl : undefined
    const copy = buildCopy.sourceBuild.behind
    return <div className="mt-4" data-testid="latest-build-failed"><Notice tone="warning" title={copy.title} actions={runUrl || repair ? <>
      {runUrl ? <a href={runUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center text-sm font-medium text-accent-strong underline underline-offset-2">{buildCopy.sourceBuild.run}</a> : null}
      {repair}
    </> : undefined}>
      <p>{copy.detail}</p>
      {failure ? <p className="mt-1 whitespace-pre-wrap break-words" data-testid="build-failure-cause">{copy.cause(failure.lines.join('\n'))}</p> : null}
    </Notice></div>
  }
  if (!failure) return null
  return <Notice tone="error">
    <p className="whitespace-pre-wrap break-words" data-testid="build-failure-cause">ビルドが失敗しました。原因: {failure.lines.join('\n')}</p>
    {repair ? <div className="mt-3">{repair}</div> : null}
  </Notice>
}
