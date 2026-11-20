import { afterEach, beforeEach, expect, test } from 'bun:test'
import { draftOf } from '../../api/testing/build-domain'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../test/language'
import { isProductLanguage } from '../../model/build/wording'
import { deriveImprove } from '../../model/improve'
import { setLanguage } from '../../shell/language'
import { buildCopy } from '../../model/build/copy'
import { startConflictFailure, unconfirmedFailure } from '../../model/build/failure'
import { text as buildText } from '../build/copy'
import { implementationCopy } from '../build/implement/copy'
import { implementationTodoId } from '../build/implement/state'
import { ImproveConversation, type ImproveConversationProps } from './conversation'
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
  specMarkdown: '', architectureMarkdown: '', creationPlanGenerations: [], creationExecutions: [], implementationRuns: [], createdSourceRepositories: [], ownerUserId: 'user-1', createdAt: at, updatedAt: at,
  createdApplicationId: 'mitsumori', createdApplicationStackId: 'mitsumori',
  creationPlan: { summary: '絞り込み', markdown: '# 絞り込み', representation: ['ApplicationStack'], implementationHandoff: { summary: '絞り込み', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'existing-source-repository', tasks } },
  conversationTurns: [{ id: 't1', kind: 'conversation', status: 'succeeded', startedAt: at, finishedAt: at, devWorkspaceId: 'ws', userMessage: '状態で絞り込みたい', assistantMessage: '## 要約\nまとめました。\n## 次の質問\nこの内容で直せます。', suggestedReplies: ['この内容で直して'] }],
}

function render(wire: ApplicationDraft, appUrl?: string, failures: Partial<Pick<ImproveConversationProps, 'sendFailure' | 'startFailure' | 'review' | 'locked'>> = {}) {
  const value = draftOf(wire)
  return renderToStaticMarkup(<ImproveConversation draft={value} state={deriveImprove(value)} appUrl={appUrl} locked={deriveImprove(value).busy} starting={false} onSend={() => {}} onRetrySend={() => {}} onStart={() => {}} onConfirmSend={() => {}} onConfirmStart={() => {}} {...failures} />)
}

test('an unreadable send or start answer offers only 「最新の状態を確認する」, never a resend', () => {
  const failure = unconfirmedFailure({ draftId: draft.id, at })
  const html = render(draft, undefined, { sendFailure: failure, startFailure: failure })
  expect(html.split(`${buildCopy.failure.confirm}</button>`)).toHaveLength(3)
  expect(html).not.toContain(`${buildText.conversation.retry}</button>`)
  // The proposal's own start stays closed until the read-back shows what happened.
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*この内容で直す<\/button>/)
})

// APT-1232: Platform starts no run while the proposal awaits review or is closed.
test.each(['ja', 'en'] as const)('a refused start is said once with no retry, and a waiting or closed proposal explains instead of offering 「この内容で直す」, in %s', (language) => {
  setLanguage(language)
  const apply = `${text.proposal.apply}</button>`
  const retryButton = `${buildText.conversation.retry}</button>`
  const refused = render(draft, undefined, { startFailure: startConflictFailure('source_change_proposal_run_blocked', 'source change proposal is awaiting review, applying, or closed', { draftId: draft.id, at }) })
  expect(refused).toContain(buildCopy.failure.run.proposalPending.title)
  expect(refused).toContain(buildCopy.failure.run.proposalPending.reason)
  expect(refused).not.toContain(retryButton)
  expect(refused).not.toContain('source change proposal')
  expect(refused).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>[^<]*${text.proposal.apply}</button>`))
  for (const [review, held] of [['waiting', buildCopy.failure.run.proposalPending], ['closed', buildCopy.failure.run.proposalClosed], ['applyFailed', buildCopy.failure.run.proposalApplyFailed]] as const) {
    const html = render(draft, undefined, { review, locked: true })
    expect(html).toContain(held.title)
    expect(html).toContain(held.reason)
    expect(html).not.toContain(apply)
    expect(html).not.toContain(retryButton)
    expect(html).not.toContain('role="alert"')
  }
  // While the proposal is open again, the change is offered as before.
  expect(render(draft)).toContain(apply)
})

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

test.each(['ja', 'en'] as const)('a turn that replaced a retired workspace tells it once, between its request and its answer, as information (APT-1264, %s)', (language) => {
  setLanguage(language)
  const first = draft.conversationTurns![0]!
  const replacing = { ...first, id: 't2', startedAt: '2026-10-26T00:01:00Z', finishedAt: '2026-10-26T00:01:10Z', userMessage: '並び順も変えたい', assistantMessage: '## 要約\n並び順を変えます。', replacedDevWorkspaceId: 'ws-old' }
  const later = { ...first, id: 't3', startedAt: '2026-10-26T00:02:00Z', finishedAt: '2026-10-26T00:02:10Z', userMessage: '色も変えたい', assistantMessage: '## 要約\n色を変えます。' }
  const html = render({ ...draft, conversationTurns: [first, replacing, later] })
  const notice = buildCopy.workspaceRecreated
  expect(notice).toBe(language === 'ja' ? '作業環境を作り直しました。会話と計画は引き継いでいます' : 'Your workspace was recreated. The conversation and plan are kept.')
  expect(html.split(notice)).toHaveLength(2)
  expect(html.indexOf('並び順も変えたい')).toBeLessThan(html.indexOf(notice))
  expect(html.indexOf(notice)).toBeLessThan(html.indexOf('並び順を変えます。'))
  expect(html.indexOf(notice)).toBeLessThan(html.indexOf('色も変えたい'))
  // An older Platform sends no field: nothing is shown.
  expect(render(draft)).not.toContain(notice)
})

test.each(['ja', 'en'] as const)('a stopped run names no way on this page lacks: no skip, and a reply here is a new turn, not a change run, in %s', (language) => {
  setLanguage(language)
  const id = implementationTodoId(tasks[0]!.title, 0)
  const stopped = (failure: { reason: 'WorkspaceBranchDiverged' | 'ProposalPending'; retryable: boolean }, atTask: boolean): ApplicationDraft => ({ ...draft, implementationRuns: [{
    id: 'r1', status: 'failed', startedAt: at, finishedAt: at, devWorkspaceId: 'ws', taskIds: [id], error: 'stopped', failure,
    ...(atTask ? { currentTaskId: id } : {}), tasks: [{ id, title: tasks[0]!.title, status: atTask ? 'failed' : 'pending' }],
  }] })
  const retryButton = `${buildText.conversation.retry}</button>`
  const ways = Object.values(buildCopy.failure.run.then)
  // Stopped at a task or before any task started: the same plain reason, with nothing after it.
  for (const atTask of [true, false]) {
    const blocked = render(stopped({ reason: 'WorkspaceBranchDiverged', retryable: false }, atTask))
    expect(blocked).toContain(buildCopy.failure.run.blocked)
    for (const way of ways) expect(blocked).not.toContain(way.trim())
    expect(blocked).not.toContain(implementationCopy.skip)
    expect(blocked).not.toContain(retryButton)
  }
  // A pending proposal admits no run at all: no retry either, and nothing promised after an apply or decline.
  const pending = render(stopped({ reason: 'ProposalPending', retryable: true }, true))
  expect(pending).toContain(buildCopy.failure.run.proposalPending.reason)
  for (const way of ways) expect(pending).not.toContain(way.trim())
  expect(pending).not.toContain(retryButton)
})
