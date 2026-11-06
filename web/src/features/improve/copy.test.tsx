import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../test/language'
import { isProductLanguage } from '../../model/build/wording'
import { deriveImprove } from '../../model/improve'
import { setLanguage } from '../../shell/language'
import { buildCopy } from '../../model/build/copy'
import { implementationTodoId } from '../build/implement/state'
import { ImproveConversation } from './conversation'
import { improveStateWord, text, textJa } from './copy'
import { textEn } from './copy.en'

let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())

function leaves(tree: unknown, args: string[] = ['見積作成']): string[] {
  if (typeof tree === 'string') return [tree]
  if (typeof tree === 'function') return [String(tree(...args)), String(tree())]
  return Object.values(tree as Record<string, unknown>).flatMap((value) => leaves(value, args))
}

test('wording is product language, ends sentences consistently, and switches language at access time', () => {
  for (const value of leaves(textJa)) {
    expect(isProductLanguage(value)).toBe(true)
    if (value.slice(0, -1).includes('。')) expect(value.endsWith('。')).toBe(true)
  }
  for (const value of leaves(textEn, ['Quotes'])) {
    expect(isProductLanguage(value)).toBe(true)
    expect(value).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
  }
  expect(text.entry.action).toBe('AIで直す')
  expect(text.proposal.apply).toBe('この内容で直す')
  expect(improveStateWord('done', 'v4')).toBe('v4 に更新しました')
  expect(improveStateWord('running')).toBe('直しています')
  expect(text.drafts.resume).toBe('続きから直す')
  setLanguage('en')
  expect(text.entry.action).toBe('Improve with AI')
  expect(improveStateWord('done', 'v4')).toBe('Updated to v4')
  setLanguage('ja')
  expect(text.stageLabels).toEqual({ ask: '聞く', fix: '直す', check: '確認' })
})

const at = '2026-10-26T00:00:00Z'
const tasks = [{ title: '一覧に絞り込みを足す', description: '状態で絞り込めるようにする。', acceptanceCriteria: ['絞り込める'] }]
const draft: ApplicationDraft = {
  id: 'draft-1', projectId: 'project-1', kind: 'improvement', title: '見積作成', intent: '一覧に絞り込みを足したい', phase: 'created',
  specMarkdown: '', architectureMarkdown: '', creationPlanGenerations: [], creationExecutions: [], ownerUserId: 'user-1', createdAt: at, updatedAt: at,
  createdApplicationId: 'mitsumori', createdApplicationStackId: 'mitsumori',
  creationPlan: { summary: '絞り込み', markdown: '# 絞り込み', representation: ['ApplicationStack'], implementationHandoff: { summary: '絞り込み', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'existing-source-repository', tasks } },
  conversationTurns: [{ id: 't1', kind: 'conversation', status: 'succeeded', startedAt: at, finishedAt: at, devWorkspaceId: 'ws', userMessage: '状態で絞り込みたい', assistantMessage: '## 要約\nまとめました。\n## 次の質問\nこの内容で直せます。', suggestedReplies: ['この内容で直して'] }],
}

function render(value: ApplicationDraft, appUrl?: string) {
  return renderToStaticMarkup(<ImproveConversation draft={value} state={deriveImprove(value)} appUrl={appUrl} locked={deriveImprove(value).busy} starting={false} onSend={() => {}} onRetrySend={() => {}} onStart={() => {}} />)
}

test('the proposal carries 「この内容で直す」 and the reply chips; a finished run shows its version and the app', () => {
  const proposed = render(draft)
  for (const word of ['変更案', '一覧に絞り込みを足す', '状態で絞り込めるようにする。', 'この内容で直す</button>', 'この内容で直して</button>']) expect(proposed).toContain(word)
  const id = implementationTodoId(tasks[0]!.title, 0)
  const done = render({ ...draft, implementationRuns: [{ id: 'r1', status: 'succeeded', startedAt: '2026-10-26T00:01:00Z', finishedAt: '2026-10-26T00:02:00Z', devWorkspaceId: 'ws', taskIds: [id], tasks: [{ id, title: tasks[0]!.title, status: 'done', versionLabel: 'v4' }] }] }, 'https://mitsumori.example.test')
  for (const word of ['v4 に更新しました', '直したところ', 'href="https://mitsumori.example.test"', 'アプリを開く']) expect(done).toContain(word)
  expect(done).not.toContain('この内容で直す</button>')
})

test('improvement failures honor run and task reasons before diagnostic wording', () => {
  const id = implementationTodoId(tasks[0]!.title, 0)
  const run: NonNullable<ApplicationDraft['implementationRuns']>[number] = {
    id: 'r1', status: 'failed', startedAt: at, finishedAt: at, devWorkspaceId: 'ws',
    taskIds: [id], currentTaskId: id, error: 'AI task stream failed',
    tasks: [{ id, title: tasks[0]!.title, status: 'failed', failureReason: 'TaskFailed' }],
  }
  const failed = render({ ...draft, implementationRuns: [run] })
  expect(failed).toContain(buildCopy.failure.failed.implement)
  expect(failed).not.toContain(buildCopy.failure.resumable.reason)
  const interrupted = render({ ...draft, implementationRuns: [{ ...run, failureReason: 'StreamInterrupted' }] })
  expect(interrupted).toContain(buildCopy.failure.resumable.reason)
})
