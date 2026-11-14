import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../test/language'
import { draftOf, taskOf } from '../../api/testing/build-domain'
import { deriveImprove } from '../../model/improve'
import { setLanguage } from '../../shell/language'
import type { ImplementationState } from '../build/implement'
import { implementationTodoId } from '../build/implement/state'
import { text } from './copy'
import { ImproveSidePane } from './side-pane'

let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())

const at = '2026-10-26T00:00:00Z'
const title = '一覧に絞り込みを足す'
const id = implementationTodoId(title, 0)
const running: ApplicationDraft = {
  id: 'draft-1', projectId: 'project-1', kind: 'improvement', title: '見積作成', intent: '一覧に絞り込みを足したい', phase: 'created',
  specMarkdown: '', architectureMarkdown: '', creationPlanGenerations: [], creationExecutions: [], ownerUserId: 'user-1', createdAt: at, updatedAt: at,
  createdApplicationId: 'mitsumori', createdApplicationStackId: 'mitsumori', conversationTurns: [],
  implementationRuns: [{ id: 'r1', status: 'running', startedAt: at, devWorkspaceId: 'ws-1', taskIds: [id], currentTaskId: id, tasks: [{ id, title, status: 'running' }] }],
}
const LEGACY_URL = '/api/v1/projects/project-1/dev-workspaces/ws-1/proxy/preview/'

function render(preview: Pick<ImplementationState, 'preview' | 'legacyPreview'>): string {
  const draft = draftOf(running)
  const implementation: ImplementationState = { phase: 'running', tasks: [taskOf({ id, title, status: 'running' })], ...preview }
  return renderToStaticMarkup(<ImproveSidePane state={deriveImprove(draft)} implementation={implementation} versions={[]} onCollapse={() => {}} />)
}
const target = (availability: NonNullable<ImplementationState['preview']>['availability']) => ({ projectId: 'project-1', workspaceId: 'ws-1', availability, readBack: () => {} })

test('a running improvement links its work in progress to the Console viewer; a preview still being published says so', () => {
  const ready = render({ preview: target({ kind: 'ready', publishUID: '7d0f3c52-9a41-4f7e-8b52-3c1f0e6a9b10', origin: 'https://pv-0123456789abcdef0123456789abcdef.project-1.appthrust.test' }) })
  expect(ready).toContain('href="/-/workspaces/ws-1/preview"')
  expect(ready).toContain(text.run.preview)
  const preparing = render({ preview: target({ kind: 'preparing' }) })
  expect(preparing).toContain(text.run.previewPreparing)
  expect(preparing).not.toContain('/-/workspaces/')
})

// Legacy same-origin preview (remove at migration stage 5).
test('an unmigrated workspace links its legacy URL once it answers, says it is preparing until then, and shows nothing before Ready', () => {
  const legacy = target({ kind: 'legacy', url: LEGACY_URL })
  const ready = render({ preview: legacy, legacyPreview: { url: LEGACY_URL, status: 'ready' } })
  expect(ready).toContain(`href="${LEGACY_URL}"`)
  expect(ready).not.toContain('/-/workspaces/')
  for (const status of ['preparing', 'error', 'timed-out'] as const) {
    const waiting = render({ preview: legacy, legacyPreview: { url: LEGACY_URL, status } })
    expect(waiting).toContain(text.run.previewPreparing)
    expect(waiting).not.toContain('href="/api/')
  }
  const notReady = render({ preview: target({ kind: 'legacy' }), legacyPreview: { status: 'preparing' } })
  expect(notReady).not.toContain(text.run.previewPreparing)
  expect(notReady).not.toContain(text.run.preview)
})
