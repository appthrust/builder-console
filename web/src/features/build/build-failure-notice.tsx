import type { DraftBuildFailure } from '../../model/contracts/build'
import { Notice } from '../../ui'
import { ImproveButton } from '../improve/entry'

/** The same current-build cause and one-click repair entry on app and build pages. */
export function BuildFailureNotice({ failure, projectId, stackId, title, canEdit }: {
  failure: Pick<DraftBuildFailure, 'lines'> | undefined
  projectId: string
  stackId: string | undefined
  title: string
  canEdit: boolean
}) {
  if (!failure) return null
  return <Notice tone="error">
    <p className="whitespace-pre-wrap break-words" data-testid="build-failure-cause">ビルドが失敗しました。原因: {failure.lines.join('\n')}</p>
    {canEdit && stackId ? <div className="mt-3">
      <ImproveButton app={{ displayName: title }} projectId={projectId} stackId={stackId} initialMessage={failure.lines.join('\n')} actionLabel="AI に直させる" />
    </div> : null}
  </Notice>
}
