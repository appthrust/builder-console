import { describe, expect, test } from 'bun:test'
import type { ApplicationDraft, ApplicationDraftConversationTurn, ApplicationDraftCreationPlan } from '@appthrust/api-schema/platform-api'
import { draftOf, readEachFirst, readFirst, turnOf } from '../../api/testing/build-domain'
import * as model from './messages'
import * as questions from './questions'

const { assistantParts, parseAssistantMessage } = model
const assistantMessage = readFirst(turnOf, model.assistantMessage)
const messagesFromDraft = readFirst(draftOf, model.messagesFromDraft)
const planProposal = readFirst(draftOf, model.planProposal)
const prepareAnswers = readEachFirst(turnOf, questions.prepareAnswers)
const { replyOptions } = questions
import { buildCopy, textJa } from './copy'
import { textEn } from './copy.en'
import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
import { buildFailureReference, classifyBuildFailure } from './failure'
import { serializeSpec } from './spec'
import type { BuildMessage } from './types'

const turn: ApplicationDraftConversationTurn = {
  kind: 'conversation',
  id: 'turn-1', status: 'succeeded', startedAt: '2026-10-08T00:01:00Z', finishedAt: '2026-10-08T00:01:10Z', devWorkspaceId: 'ws-1',
  userMessage: 'PDF を出して', assistantMessage: 'PDF を追加しました。会社ロゴも入れますか？', changed: ['ルール 1 件追加'], suggestedReplies: ['入れる', '入れない'],
}
const draft: ApplicationDraft = {
  id: 'draft-1', projectId: 'project-1', title: '見積', intent: '見積を作る', phase: 'specifying', specMarkdown: '', architectureMarkdown: '',
  creationPlanGenerations: [], conversationTurns: [], creationExecutions: [], implementationRuns: [], createdSourceRepositories: [], ownerUserId: 'user-1', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:01:10Z',
}

describe('conversation history', () => {
  test('uses actual turn contents, changes and suggested reply cards', () => {
    expect(assistantMessage(turn, draft.id)).toEqual({ role: 'assistant', text: turn.assistantMessage!, summary: turn.assistantMessage!, changed: turn.changed!, options: turn.suggestedReplies!, at: turn.finishedAt!, turnId: turn.id })
  })
  test('splits the three-section reply and prefers the API change list', () => {
    const markdown = '## 要約\n管理する業務を在庫管理として反映しました。\n## 変えたところ\n- アプリ名を「在庫管理」にしました。\n## 次の質問\n在庫数は直接入力で更新しますか？'
    expect(assistantMessage({ ...turn, assistantMessage: markdown, changed: ['API の変更'] }, draft.id)).toMatchObject({
      summary: '管理する業務を在庫管理として反映しました。', changed: ['API の変更'], question: '在庫数は直接入力で更新しますか？',
    })
    expect(assistantMessage({ ...turn, assistantMessage: markdown, changed: [] }, draft.id)).toMatchObject({ changed: ['アプリ名を「在庫管理」にしました。'] })
  })
  test('orders server pairs and local notices chronologically and deduplicates resumed assistants', () => {
    const later = { ...turn, id: 'turn-2', startedAt: '2026-10-08T00:02:00Z', finishedAt: '2026-10-08T00:02:10Z', userMessage: '入れる' }
    const extra: BuildMessage[] = [{ role: 'notice', tone: 'info', title: '始めます', at: draft.createdAt }, assistantMessage(turn, draft.id)]
    const messages = messagesFromDraft({ ...draft, conversationTurns: [later, turn] }, extra)
    expect(messages.map((message) => message.role)).toEqual(['notice', 'user', 'assistant', 'user', 'assistant'])
    expect(messages[1]).toEqual({ role: 'user', text: turn.userMessage, at: turn.startedAt })
    expect(extra).toHaveLength(2)
  })
  test('retains failed user requests and gives a sanitized retry notice, not a fabricated assistant answer', () => {
    const failed = { ...turn, status: 'failed' as const, error: 'workspace secret-ws-id PodUnschedulable' }
    const messages = messagesFromDraft({ ...draft, conversationTurns: [failed] }, [])
    expect(messages[1]).toMatchObject({ role: 'notice', tone: 'error', retry: 'turn' })
    expect(JSON.stringify(messages)).not.toContain('secret-ws-id')
    expect(messagesFromDraft({ ...draft, conversationTurns: [{ ...turn, status: 'running' }] }, [])).toHaveLength(1)
    expect(messagesFromDraft(draft, [])).toEqual([])
  })
  test('provider quota failures restore an administrator notice with a manual retry action', () => {
    const failed = { ...turn, status: 'failed' as const, error: 'Codex task failed: insufficient_quota' }
    const messages = messagesFromDraft({ ...draft, conversationTurns: [failed] }, [])
    expect(messages[1]).toMatchObject({ role: 'notice', title: buildCopy.failure.quota.title, detail: buildCopy.failure.quota.reason })
    expect(messages[1]).toHaveProperty('retry', 'turn')
    expect(JSON.stringify(messages)).not.toContain(failed.error)
  })
  test('deduplicated platform turn failures keep their support reference after reload', () => {
    const failed = { ...turn, status: 'failed' as const, error: 'server contract validation failed' }
    const notice = assistantMessage(failed, draft.id)
    const messages = messagesFromDraft({ ...draft, conversationTurns: [failed] }, [notice])
    expect(messages).toEqual([{ role: 'user', text: failed.userMessage, at: failed.startedAt }, notice])
    expect(notice).toMatchObject({ role: 'notice', reference: { draftId: draft.id, at: turn.finishedAt } })
    expect(JSON.stringify(messages)).not.toContain(failed.error)
  })
  test('says 「下地ができました」 only after observed startup, as a derived AI line', () => {
    const execution = { id: 'exec-1', attempt: 1, status: 'running' as const, startedAt: '2026-10-08T00:03:00Z', steps: [] }
    expect(messagesFromDraft({ ...draft, conversationTurns: [turn], creationExecutions: [execution] }, []).some((message) => message.role === 'assistant' && message.turnId?.startsWith('prepared:'))).toBe(false)
    const created = { ...draft, conversationTurns: [turn], creationExecutions: [{ ...execution, status: 'succeeded' as const, finishedAt: '2026-10-08T00:13:00Z' }] }
    expect(messagesFromDraft(created, []).some((message) => message.role === 'assistant' && message.turnId?.startsWith('prepared:'))).toBe(false)
    const messages = messagesFromDraft(created, [], { preparationDone: true })
    expect(messages.at(-1)).toEqual({ role: 'assistant', text: buildCopy.prepareConversation.ready, summary: buildCopy.prepareConversation.ready, at: '2026-10-08T00:13:00Z', turnId: 'prepared:exec-1' })
    // The AI's own 用意する questions are not interrupted; the line follows its last answer.
    const succeeded = { ...execution, status: 'succeeded' as const, finishedAt: '2026-10-08T00:13:00Z' }
    const asking = { ...turn, id: 'turn-prepare', userMessage: buildCopy.questions.prepareTurn, startedAt: '2026-10-08T00:04:00Z', finishedAt: '2026-10-08T00:04:10Z' }
    const named = { ...turn, id: 'turn-name', userMessage: '見積作成', startedAt: '2026-10-08T00:12:00Z', finishedAt: '2026-10-08T00:12:10Z' }
    expect(messagesFromDraft({ ...draft, conversationTurns: [asking, named], creationExecutions: [succeeded] }, [], { preparationDone: true }).at(-1)).toMatchObject({ role: 'assistant', turnId: 'turn-name' })
    const shared = { ...turn, id: 'turn-share', userMessage: '全社', startedAt: '2026-10-08T00:14:00Z', finishedAt: '2026-10-08T00:14:10Z' }
    expect(messagesFromDraft({ ...draft, conversationTurns: [asking, named, shared], creationExecutions: [succeeded] }, [], { preparationDone: true }).at(-1)).toMatchObject({ turnId: 'prepared:exec-1', at: '2026-10-08T00:14:10Z' })
  })
  test('APT-792 never announces readiness while the user is still asking for name suggestions', () => {
    const preparing = { ...turn, id: 'prepare', userMessage: buildCopy.questions.prepareTurn, suggestedReplies: ['入退室・開閉管理でよい', '入退室・金庫管理にしたい', 'セキュリティ記録管理にしたい', 'ほかの名前にしたい'] }
    const another = { ...turn, id: 'another', userMessage: 'ほかの名前にしたい', startedAt: '2026-10-08T00:02:00Z', finishedAt: '2026-10-08T00:02:10Z', assistantMessage: '公開するときの名前は何にしますか？', suggestedReplies: ['入退室・金庫管理にしたい', 'セキュリティ記録管理にしたい', 'ISMS記録管理にしたい', 'ほかの名前にしたい'] }
    const suggest = { ...turn, id: 'suggest', userMessage: '提案して', startedAt: '2026-10-08T00:03:00Z', finishedAt: '2026-10-08T00:03:10Z', assistantMessage: 'ISMS記録管理はいかがですか？', suggestedReplies: ['ISMS記録管理にしたい'] }
    const created = { ...draft, conversationTurns: [preparing, another, suggest], creationExecutions: [{ id: 'exec-1', attempt: 1, status: 'succeeded' as const, startedAt: draft.createdAt, finishedAt: turn.finishedAt, steps: [] }] }
    expect(prepareAnswers(created.conversationTurns)).toEqual({ turnIds: ['prepare', 'another', 'suggest'], open: true })
    const messages = messagesFromDraft(created, [], { preparationDone: true })
    expect(messages.some((message) => message.role === 'assistant' && message.turnId?.startsWith('prepared:'))).toBe(false)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', turnId: 'suggest' })
    expect(replyOptions(messages)).toEqual(suggest.suggestedReplies)
  })
  test.each(['succeeded', 'running', 'failed'] as const)('the ready line follows the closing request, its %s turn, and later local messages', (status) => {
    const preparing = { ...turn, id: 'prepare', userMessage: buildCopy.questions.prepareTurn }
    const another = { ...turn, id: 'another', userMessage: 'ほかの名前にしたい', startedAt: '2026-10-08T00:02:00Z', finishedAt: '2026-10-08T00:02:10Z' }
    const request = { ...turn, id: 'request', userMessage: '一覧に検索をつけてください。', startedAt: '2026-10-08T00:03:00Z', finishedAt: '2026-10-08T00:03:10Z' }
    const later = { ...turn, id: 'later', userMessage: '検索対象は担当者です。', startedAt: '2026-10-08T00:04:00Z', finishedAt: status === 'running' ? undefined : '2026-10-08T00:04:10Z', status }
    const created = { ...draft, conversationTurns: [preparing, another, request, later], creationExecutions: [{ id: 'exec-1', attempt: 1, status: 'succeeded' as const, startedAt: draft.createdAt, finishedAt: turn.finishedAt, steps: [] }] }
    expect(prepareAnswers(created.conversationTurns).open).toBe(false)
    const messages = messagesFromDraft(created, [], { preparationDone: true })
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', turnId: 'prepared:exec-1', at: later.finishedAt ?? later.startedAt })
    const extra: BuildMessage[] = [{ role: 'user', text: 'もう一つ変更があります。', at: '2026-10-08T00:05:00Z' }]
    const withLocal = messagesFromDraft(created, extra, { preparationDone: true })
    expect(withLocal.at(-2)).toEqual(extra[0]!)
    expect(withLocal.at(-1)).toMatchObject({ role: 'assistant', turnId: 'prepared:exec-1', at: extra[0]!.at })
  })
  test('collapses Excel → app turns into one ready line at the top that offers the proposal', () => {
    const analysis = { ...turn, kind: 'excel-analysis' as const, id: 'turn-excel', userMessage: 'この Excel を読み取ってください', startedAt: '2026-10-08T00:00:10Z', finishedAt: '2026-10-08T00:00:40Z' }
    const init = { ...turn, kind: 'ui-design' as const, id: 'turn-ui-1', userMessage: '__init__', startedAt: '2026-10-08T00:00:50Z', finishedAt: '2026-10-08T00:00:55Z' }
    const undo = { ...turn, kind: 'ui-design' as const, id: 'turn-ui-2', userMessage: 'ひとつ前の設計に戻してください\n```json\n{}\n```', startedAt: '2026-10-08T00:00:56Z', finishedAt: '2026-10-08T00:00:58Z' }
    const messages = messagesFromDraft({ ...draft, conversationTurns: [turn, undo, init, analysis] }, [])
    const ready = buildCopy.questions.excelReady
    expect(messages[0]).toEqual({ role: 'assistant', text: ready, summary: ready, at: analysis.startedAt, turnId: `excel:${draft.id}`, options: [buildCopy.questions.kickoffReply], link: { kind: 'excel2app', draftId: draft.id } })
    expect(messages.slice(1).map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(messages)).not.toContain('__init__')
    expect(JSON.stringify(messages)).not.toContain('```json')
    expect(replyOptions(messagesFromDraft({ ...draft, conversationTurns: [analysis, init] }, []))).toEqual([buildCopy.questions.kickoffReply])
    // Nothing is called done until an Excel turn succeeded; a failed one says where to continue (below).
    expect(messagesFromDraft({ ...draft, conversationTurns: [{ ...analysis, status: 'running', finishedAt: undefined }] }, [])).toEqual([])
  })
  describe('a stopped Excel → app step', () => {
    const analysis = { ...turn, kind: 'excel-analysis' as const, id: 'turn-excel', userMessage: 'この Excel を読み取ってください', startedAt: '2026-10-08T00:00:10Z', finishedAt: '2026-10-08T00:00:40Z' }
    const design = { ...turn, kind: 'ui-design' as const, id: 'turn-ui-1', userMessage: '__init__', startedAt: '2026-10-08T00:00:50Z', finishedAt: '2026-10-08T00:00:55Z' }
    const stopped = (at: string) => {
      const text = buildCopy.questions.excelStopped
      return { role: 'assistant', text, summary: text, at, turnId: `excel:${draft.id}`, link: { kind: 'excel2app', draftId: draft.id, resume: true } } satisfies BuildMessage
    }
    test('the latest analysis failed: one line that sends the user back to Excel → app, no ready line and no retry', () => {
      const messages = messagesFromDraft({ ...draft, conversationTurns: [{ ...analysis, status: 'failed', error: 'codex exited' }] }, [])
      expect(messages).toEqual([stopped(analysis.finishedAt)])
      expect(replyOptions(messages)).toEqual([])
      expect(JSON.stringify(messages)).not.toContain(buildCopy.questions.excelReady)
    })
    test('the analysis succeeded and the screen design failed after it: the stop line, not the ready line', () => {
      const messages = messagesFromDraft({ ...draft, conversationTurns: [{ ...design, status: 'failed', error: 'codex exited' }, analysis] }, [])
      expect(messages).toEqual([stopped(design.finishedAt)])
      expect(JSON.stringify(messages)).not.toContain('__init__')
    })
    test('a failure followed by a succeeded Excel → app step, or both succeeded: the ready line as before', () => {
      const ready = buildCopy.questions.excelReady
      const line = { role: 'assistant', text: ready, summary: ready, at: analysis.startedAt, turnId: `excel:${draft.id}`, options: [buildCopy.questions.kickoffReply], link: { kind: 'excel2app', draftId: draft.id } } satisfies BuildMessage
      expect(messagesFromDraft({ ...draft, conversationTurns: [analysis, design] }, [])).toEqual([line])
      expect(messagesFromDraft({ ...draft, conversationTurns: [{ ...analysis, status: 'failed', error: 'codex exited' }, { ...analysis, id: 'turn-excel-2', startedAt: '2026-10-08T00:00:45Z', finishedAt: '2026-10-08T00:00:48Z' }, design] }, [])).toEqual([line])
    })
    test('the line is in the language in use', () => {
      const restore = preserveLanguage()
      try {
        setLanguage('en')
        expect(messagesFromDraft({ ...draft, conversationTurns: [{ ...analysis, status: 'failed', error: 'codex exited' }] }, [])).toEqual([{ ...stopped(analysis.finishedAt), text: textEn.questions.excelStopped, summary: textEn.questions.excelStopped }])
      } finally {
        restore()
      }
    })
    test('offers no reply chips, and is not counted as a reply toward 「この内容で提案して」', () => {
      const second = { ...turn, id: 'turn-2', userMessage: '入れる', startedAt: '2026-10-08T00:02:00Z', finishedAt: '2026-10-08T00:02:10Z' }
      const stoppedLater = { ...design, status: 'failed' as const, error: 'codex exited', startedAt: '2026-10-08T00:03:00Z', finishedAt: '2026-10-08T00:03:10Z' }
      // Two replies, then the stopped step as the latest line: nothing to answer here, no proposal chip.
      const afterTwo = messagesFromDraft({ ...draft, conversationTurns: [turn, second, stoppedLater] }, [])
      expect(afterTwo.at(-1)).toEqual(stopped(stoppedLater.finishedAt))
      expect(replyOptions(afterTwo)).toEqual([])
      // One reply before it and one after: two replies, so the proposal chip is not offered yet.
      const third = { ...second, id: 'turn-3', userMessage: '入れない', startedAt: '2026-10-08T00:04:00Z', finishedAt: '2026-10-08T00:04:10Z' }
      const around = messagesFromDraft({ ...draft, conversationTurns: [turn, stoppedLater, third] }, [])
      expect(around.at(-1)).toMatchObject({ role: 'assistant', turnId: third.id })
      expect(replyOptions(around)).toEqual(turn.suggestedReplies!)
    })
  })
})

describe('superseded turn failure (APT-1365)', () => {
  const timedOut = { ...turn, id: 'turn-1', status: 'failed' as const, error: 'application draft conversation turn timed out', userMessage: 'test', assistantMessage: undefined, changed: undefined, suggestedReplies: undefined }
  const resent = { ...turn, id: 'turn-2', userMessage: 'test', startedAt: '2026-10-08T01:00:00Z', finishedAt: '2026-10-08T01:00:30Z' }
  const collapsed = { role: 'notice', tone: 'info', title: textJa.failure.superseded, at: timedOut.finishedAt ?? timedOut.startedAt } satisfies BuildMessage
  const roles = (messages: BuildMessage[]) => messages.map((message) => message.role === 'notice' ? `notice:${message.tone}` : message.role)

  test('a failed turn a later turn followed reads as one past line: no retry, not an error, the later turn as it is', () => {
    const messages = messagesFromDraft({ ...draft, conversationTurns: [resent, timedOut] }, [])
    expect(roles(messages)).toEqual(['user', 'notice:info', 'user', 'assistant'])
    expect(messages[0]).toEqual({ role: 'user', text: 'test', at: timedOut.startedAt })
    expect(messages[1]).toEqual(collapsed)
    expect(messages[1]).not.toHaveProperty('retry')
    expect(messages[1]).not.toHaveProperty('detail')
    expect(messages[1]).not.toHaveProperty('reference')
    expect(messages.slice(2)).toEqual([{ role: 'user', text: 'test', at: resent.startedAt }, assistantMessage(resent, draft.id)])
    expect(messages.some((message) => message.role === 'notice' && message.retry)).toBe(false)
  })
  test('the last failed turn keeps its error notice with 「もう一度試す」', () => {
    const messages = messagesFromDraft({ ...draft, conversationTurns: [timedOut] }, [])
    expect(messages[1]).toMatchObject({ role: 'notice', tone: 'error', title: textJa.failure.timeout.title, detail: textJa.failure.timeout.reason, retry: 'turn' })
  })
  test('of failures in a row only the last offers retry', () => {
    const again = { ...timedOut, id: 'turn-2', startedAt: resent.startedAt, finishedAt: resent.finishedAt }
    const messages = messagesFromDraft({ ...draft, conversationTurns: [again, timedOut] }, [])
    const notices = messages.filter((message) => message.role === 'notice')
    expect(notices).toEqual([collapsed, expect.objectContaining({ tone: 'error', at: again.finishedAt, retry: 'turn' })])
    expect(notices.filter((message) => message.retry)).toHaveLength(1)
  })
  test('a later turn still running or in an unknown state supersedes it too', () => {
    for (const status of ['running', 'future-state']) {
      const notices = messagesFromDraft({ ...draft, conversationTurns: [timedOut, { ...resent, status, finishedAt: undefined }] }, []).filter((message) => message.role === 'notice')
      expect(notices[0]).toEqual(collapsed)
    }
  })
  test('a superseded policy refusal keeps its reason (it never offered a retry); as the last turn it stays without retry', () => {
    const denied = { ...timedOut, error: 'workspace: ai_policy_denied' }
    expect(classifyBuildFailure(denied.error, undefined, 'turn').kind).toBe('policy')
    const refusal = assistantMessage(denied, draft.id)
    expect(refusal).toMatchObject({ role: 'notice', tone: 'error' })
    expect(refusal).not.toHaveProperty('retry')
    const messages = messagesFromDraft({ ...draft, conversationTurns: [denied, resent] }, [])
    expect(messages[1]).toEqual(refusal)
    expect(roles(messages)).toEqual(['user', 'notice:error', 'user', 'assistant'])
    // The tab's own notice of that refusal does not add a second one.
    const kept = { ...refusal, turnId: denied.id } as BuildMessage
    expect(messagesFromDraft({ ...draft, conversationTurns: [denied, resent] }, [kept]).filter((message) => message.role === 'notice')).toEqual<BuildMessage[]>([refusal])
    expect(messagesFromDraft({ ...draft, conversationTurns: [denied] }, [])[1]).toEqual(refusal)
  })

  /** The notice use-build-session `fail` saves for an observed turn failure (`turnId`), or for a failed send (none). */
  const saved = (turnId?: string): BuildMessage => ({
    role: 'notice', tone: 'error', title: textJa.failure.timeout.title, detail: textJa.failure.timeout.reason, retry: 'turn', at: collapsed.at, ...(turnId ? { turnId } : {}),
  })
  const read = { ...draft, conversationTurns: [timedOut, resent] }

  test('the notice this tab saved when it saw that turn fail is not shown once a later turn followed', () => {
    const messages = messagesFromDraft(read, [saved(timedOut.id)])
    expect(roles(messages)).toEqual(['user', 'notice:info', 'user', 'assistant'])
    expect(messages[1]).toEqual(collapsed)
    // A reload hands the transcript back as local messages: nothing is added twice.
    expect(messagesFromDraft(read, messages)).toEqual(messages)
  })
  test('a notice of the same title and time that names another turn, or none (a failed send), is still shown', () => {
    for (const notice of [saved('turn-other'), saved()]) {
      const messages = messagesFromDraft(read, [notice])
      expect(messages.filter((message) => message.role === 'notice')).toEqual<BuildMessage[]>([collapsed, notice])
    }
  })
  test('switching the language does not bring back the saved notice of a superseded turn', () => {
    const restore = preserveLanguage()
    try {
      setLanguage('en')
      const messages = messagesFromDraft(read, [saved(timedOut.id)])
      expect(messages.filter((message) => message.role === 'notice')).toEqual([{ ...collapsed, title: textEn.failure.superseded }])
      expect(JSON.stringify(messages)).not.toContain(textJa.failure.timeout.title)
    } finally {
      restore()
    }
  })
  test('the copy says only that the request was interrupted, in Japanese and English', () => {
    expect(textJa.failure.superseded).toBe('この依頼は途中で止まりました')
    expect(textEn.failure.superseded).toBe('This request was interrupted.')
  })

  const design = { ...turn, kind: 'ui-design' as const, id: 'turn-ui', userMessage: '__init__', status: 'failed' as const, error: 'codex exited', startedAt: '2026-10-08T02:00:00Z', finishedAt: '2026-10-08T02:00:10Z' }
  test('display and retry read the same turns: the last conversation turn, never an Excel → app turn after it', () => {
    expect(model.shownConversationTurns([design, resent, timedOut].map(turnOf)).map((item) => item.id)).toEqual([timedOut.id, resent.id])
    expect(model.shownConversationTurns([design, timedOut].map(turnOf)).at(-1)?.id).toBe(timedOut.id)
    expect([...model.supersededFailures([design, resent, timedOut].map(turnOf))]).toEqual([timedOut.id])
    expect([...model.supersededFailures([design, timedOut].map(turnOf))]).toEqual([])
    // The design turn is not a later conversation turn: the conversation failure stays the one to retry.
    expect(messagesFromDraft({ ...draft, conversationTurns: [timedOut, design] }, []).filter((message) => message.role === 'notice')).toEqual([expect.objectContaining({ tone: 'error', retry: 'turn' })])
  })

  const stale = (messages: BuildMessage[], wires: readonly unknown[], pending: boolean) => model.withoutStaleTurnFailures(messages, wires.map(turnOf), pending)
  const typed: BuildMessage = { role: 'user', text: '担当者も記録したい', at: '2026-10-08T00:01:05Z' }
  const planNotice: BuildMessage = { role: 'notice', tone: 'error', title: textJa.failure.timeout.title, at: collapsed.at, retry: 'plan' }
  const pruning: [string, BuildMessage[], unknown[], boolean, BuildMessage[]][] = [
    ['a notice naming a superseded turn, with a reply pending', [saved(timedOut.id), typed], [timedOut, resent], true, [typed]],
    ['a notice naming a superseded turn, nothing pending', [saved(timedOut.id)], [timedOut, resent], false, []],
    ['a notice naming the last failed turn', [typed, saved(timedOut.id)], [timedOut], true, [typed, saved(timedOut.id)]],
    ['a notice naming the last turn while an Excel → app turn follows', [saved(timedOut.id)], [timedOut, design], false, [saved(timedOut.id)]],
    ['an old saved notice (no turnId), nothing pending, the last turn not failed', [saved()], [timedOut, resent], false, []],
    ['an old saved notice, the last turn still running', [saved()], [timedOut, { ...resent, status: 'running', finishedAt: undefined }], false, []],
    ['an old saved notice, the last turn failed', [saved()], [timedOut], false, [saved()]],
    ['a failed send (no turnId) keeps its pending reply and notice', [typed, saved()], [timedOut, resent], true, [typed, saved()]],
    ['a failed send before any turn', [typed, saved()], [], true, [typed, saved()]],
    ['a notice of another context', [planNotice], [timedOut, resent], false, [planNotice]],
  ]
  test.each(pruning)('withoutStaleTurnFailures: %s', (_, messages, wires, pending, expected) => {
    expect(stale(messages, wires, pending)).toEqual(expected)
  })
  test('withoutStaleTurnFailures answers the same list when nothing is stale', () => {
    const messages = [typed, saved(timedOut.id)]
    expect(stale(messages, [timedOut], true)).toBe(messages)
  })
})

describe('recreated workspace notice (APT-1264)', () => {
  const recreated = { role: 'notice', kind: 'workspace-recreated', tone: 'info', title: textJa.workspaceRecreated, at: '2026-10-08T00:02:00Z' } satisfies BuildMessage
  const earlier = { ...turn, devWorkspaceId: 'ws-old' }
  const switched = { ...turn, id: 'turn-2', startedAt: '2026-10-08T00:02:00Z', finishedAt: '2026-10-08T00:02:10Z', userMessage: '入れる', replacedDevWorkspaceId: 'ws-old' }
  const later = { ...turn, id: 'turn-3', startedAt: '2026-10-08T00:03:00Z', finishedAt: '2026-10-08T00:03:10Z', userMessage: 'ありがとう' }
  const generation = { id: 'gen-1', status: 'succeeded', startedAt: '2026-10-08T00:04:00Z', finishedAt: '2026-10-08T00:04:30Z', devWorkspaceId: 'ws-1' }
  const notices = (wire: unknown) => messagesFromDraft(wire, []).filter((message) => message.role === 'notice')
  const shape = (messages: BuildMessage[]) => messages.map((message) => message.role === 'notice' ? message.title : message.role)

  test('appears once, on the turn that replaced the workspace: below its request, above its answer', () => {
    const messages = messagesFromDraft({ ...draft, conversationTurns: [later, switched, earlier], creationPlanGenerations: [generation] }, [])
    expect(shape(messages)).toEqual(['user', 'assistant', 'user', textJa.workspaceRecreated, 'assistant', 'user', 'assistant'])
    expect(messages.filter((message) => message.role === 'notice')).toEqual([recreated])
  })
  test('is information only: no retry and no reference', () => {
    const [notice] = notices({ ...draft, conversationTurns: [switched] })
    expect(notice).toEqual(recreated)
    expect(notice).not.toHaveProperty('retry')
    expect(notice).not.toHaveProperty('reference')
  })
  test('stays one notice on every read and reload, also while the replacing turn runs', () => {
    const read = { ...draft, conversationTurns: [earlier, switched, later] }
    const first = messagesFromDraft(read, [])
    // A reload hands the earlier transcript back as local messages: the derived notice is not added twice.
    expect(messagesFromDraft(read, first).filter((message) => message.role === 'notice')).toEqual([recreated])
    const running = messagesFromDraft({ ...draft, conversationTurns: [earlier, { ...switched, status: 'running', finishedAt: undefined }] }, [])
    expect(running.slice(-2)).toEqual([{ role: 'user', text: switched.userMessage, at: switched.startedAt }, recreated])
  })
  test('sits right below the request, before an answer of the same time (no finishedAt, or finished at its start)', () => {
    const user = { role: 'user', text: switched.userMessage, at: switched.startedAt } satisfies BuildMessage
    const failed = messagesFromDraft({ ...draft, conversationTurns: [{ ...switched, status: 'failed', finishedAt: undefined, error: 'codex exited' }] }, [])
    expect(failed.slice(0, 2)).toEqual([user, recreated])
    expect(failed[2]).toMatchObject({ role: 'notice', tone: 'error', at: switched.startedAt, retry: 'turn' })
    const unknown = messagesFromDraft({ ...draft, conversationTurns: [{ ...switched, status: 'future-state', finishedAt: undefined }] }, [])
    expect(shape(unknown)).toEqual(['user', textJa.workspaceRecreated, buildCopy.unsupported.title])
    const instant = messagesFromDraft({ ...draft, conversationTurns: [{ ...switched, finishedAt: switched.startedAt }] }, [])
    expect(shape(instant)).toEqual(['user', textJa.workspaceRecreated, 'assistant'])
  })
  test('appears on a plan generation that replaced the workspace, at its start', () => {
    const replacing = { ...generation, replacedDevWorkspaceId: 'ws-old' }
    const messages = messagesFromDraft({ ...draft, conversationTurns: [earlier], creationPlanGenerations: [replacing] }, [])
    expect(messages.filter((message) => message.role === 'notice')).toEqual([{ ...recreated, at: replacing.startedAt }])
    expect(messages.at(-1)).toEqual({ ...recreated, at: replacing.startedAt })
  })
  test('a switch an Excel → app turn made stays after the collapsed Excel line', () => {
    const analysis = { ...turn, kind: 'excel-analysis' as const, id: 'turn-excel', userMessage: 'この Excel を読み取ってください', startedAt: '2026-10-08T00:00:10Z', finishedAt: '2026-10-08T00:00:40Z' }
    const design = { ...turn, kind: 'ui-design' as const, id: 'turn-ui-1', userMessage: '__init__', startedAt: '2026-10-08T00:00:50Z', finishedAt: '2026-10-08T00:00:55Z', replacedDevWorkspaceId: 'ws-old' }
    const messages = messagesFromDraft({ ...draft, conversationTurns: [switched, design, analysis] }, [])
    // The design turn named ws-old first: the later conversation turn naming it again adds nothing.
    expect(shape(messages)).toEqual(['assistant', textJa.workspaceRecreated, 'user', 'assistant'])
    expect(messages[0]).toMatchObject({ turnId: `excel:${draft.id}` })
    expect(messages[1]).toEqual({ ...recreated, at: design.startedAt })
  })
  test('a retired workspace named by more than one record is announced at the first; another retirement is announced again', () => {
    const replacing = { ...generation, replacedDevWorkspaceId: 'ws-old' }
    expect(notices({ ...draft, conversationTurns: [switched], creationPlanGenerations: [replacing] })).toEqual([recreated])
    const again = { ...later, replacedDevWorkspaceId: 'ws-1' }
    expect(notices({ ...draft, conversationTurns: [again, switched] }).map((notice) => notice.at)).toEqual([switched.startedAt, again.startedAt])
    const read = draftOf({ ...draft, conversationTurns: [again, switched], creationPlanGenerations: [replacing] })
    expect([...model.recreatingRecords([...read.conversationTurns, ...read.creationPlanGenerations])].map((record) => record.id)).toEqual(['turn-2', 'turn-3'])
  })
  test('nothing is shown without the field (an older Platform) or for an empty one', () => {
    expect(notices({ ...draft, conversationTurns: [earlier, later], creationPlanGenerations: [generation] })).toEqual([])
    expect(notices({ ...draft, conversationTurns: [{ ...switched, replacedDevWorkspaceId: '' }] })).toEqual([])
  })
  test('decisions read past it: the newest actionable message is the one before it', () => {
    // A device clock behind the server's sorts the server-timed notice after the local generation-limit notice.
    const limit = { role: 'notice', tone: 'warning', title: buildCopy.failure.limit.title, detail: buildCopy.failure.limitRejected, at: '2026-10-08T00:01:30Z' } satisfies BuildMessage
    const messages = messagesFromDraft({ ...draft, conversationTurns: [earlier], creationPlanGenerations: [{ ...generation, replacedDevWorkspaceId: 'ws-old' }] }, [limit])
    expect(messages.at(-1)).toMatchObject({ kind: 'workspace-recreated' })
    expect(model.lastActionable(messages)).toEqual(limit)
    expect(model.lastActionable([{ ...recreated }])).toBeUndefined()
  })
  test('the copy is calm and exact in Japanese and English, switched at use time', () => {
    expect(textJa.workspaceRecreated).toBe('作業環境を作り直しました。会話と計画は引き継いでいます')
    expect(textEn.workspaceRecreated).toBe('Your workspace was recreated. The conversation and plan are kept.')
    const restore = preserveLanguage()
    try {
      setLanguage('en')
      expect(messagesFromDraft({ ...draft, conversationTurns: [switched] }, []).find((message) => message.role === 'notice')).toEqual({ ...recreated, title: textEn.workspaceRecreated })
      setLanguage('ja')
      expect(buildCopy.workspaceRecreated).toBe(textJa.workspaceRecreated)
    } finally {
      restore()
    }
  })
})

describe('plan proposal', () => {
  const specMarkdown = serializeSpec({ name: '在庫管理', oneLine: '在庫を数えて一覧にする', users: ['自分だけ'], screens: ['在庫一覧', '入出庫の記録'], records: [{ name: '在庫', fields: ['品目', '数量', '保管場所'] }], rules: ['数量は 0 以上'] }, '')
  const tasks = Array.from({ length: 8 }, (_, index) => ({ title: `作業 ${index + 1}`, description: '一覧を作る。並べ替えもできる。', acceptanceCriteria: ['できる'] }))
  const plan: ApplicationDraftCreationPlan = {
    summary: '在庫を品目ごとに管理するアプリです。', representation: ['ApplicationStack', 'Publish'], markdown: '# zaiko\n- web: Next.js',
    applicationStackRequest: {
      templateId: 'nextjs-postgres', application: { name: 'zaiko' }, source: { kind: 'application-source-repository', sourceRepositoryId: 'zaiko-src' },
      web: { componentName: 'web' }, database: { componentName: 'db' }, connection: { connectionName: 'database' },
      publish: { enabled: true, customDomain: 'apps.example.test', hostnamePattern: 'wildcard', subdomain: 'zaiko' },
    },
    implementationHandoff: {
      summary: '在庫アプリを作る', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'created-source-repository',
      tasks: [{ title: '在庫一覧の画面', description: '品目と数量を一覧で見る。保管場所で絞り込む。', acceptanceCriteria: ['一覧が出る'] }, { title: 'repository を整える', description: 'branch を作る', acceptanceCriteria: ['x'] }, ...tasks],
    },
  }
  const planned: ApplicationDraft = {
    ...draft, title: '在庫', phase: 'planned', specMarkdown, creationPlan: plan, intent: '在庫を管理したい',
    creationPlanGenerations: [{ id: 'gen-1', status: 'succeeded', startedAt: '2026-10-08T00:02:00Z', finishedAt: '2026-10-08T00:03:00Z', devWorkspaceId: 'ws-1' }],
  }

  test('states what will be prepared from the spec and the plan, with handoff tasks capped and infrastructure left out', () => {
    expect(planProposal(planned, planned.intent)).toEqual({
      lead: '在庫を品目ごとに管理するアプリです。', name: '在庫管理', oneLine: '在庫を数えて一覧にする', users: ['自分だけ'],
      screens: [{ name: '在庫一覧', purpose: '品目と数量を一覧で見る。' }, { name: '入出庫の記録' }],
      records: [{ name: '在庫', fields: ['品目', '数量', '保管場所'] }], rules: ['数量は 0 以上'],
      url: 'https://zaiko.apps.example.test',
      tasks: [{ title: '在庫一覧の画面', detail: '品目と数量を一覧で見る。' }, ...tasks.slice(0, 5).map((task) => ({ title: task.title, detail: '一覧を作る。' }))],
      moreTasks: 4, stale: false,
    })
  })
  test('task details keep the first English sentence without splitting decimals or unspaced punctuation', () => {
    const descriptions = [
      ['View 1.5 months of stock. Filter by location.', 'View 1.5 months of stock.'],
      ['View stock! Filter by location.', 'View stock!'],
      ['View stock? Filter by location.', 'View stock?'],
      ['View stock.', 'View stock.'],
      ['View stock!Filter by location.', 'View stock!Filter by location.'],
      ['品目と数量を一覧で見る。保管場所で絞り込む。', '品目と数量を一覧で見る。'],
      ['在庫は十分？保管場所で絞り込む。', '在庫は十分？'],
      ['在庫を確認！保管場所で絞り込む。', '在庫を確認！'],
    ] as const
    for (const [description, detail] of descriptions) {
      const proposal = planProposal({
        ...planned,
        creationPlan: { ...plan, implementationHandoff: { ...plan.implementationHandoff!, tasks: [{ title: '在庫一覧', description, acceptanceCriteria: ['できる'] }] } },
      })
      expect(proposal?.tasks).toEqual([{ title: '在庫一覧', detail }])
      expect(proposal?.screens[0]?.purpose).toBe(detail)
    }
  })
  test('without handoff tasks or publish it lists no tasks and leaves the URL for later; a later spec change marks it stale', () => {
    const bare: ApplicationDraft = { ...planned, creationPlan: { summary: 'workspace で stack を作ります', representation: ['Application'], markdown: '# x' } }
    const proposal = planProposal(bare, bare.intent)!
    expect(proposal).toMatchObject({ tasks: [], moreTasks: 0, stale: false })
    expect(proposal.url).toBeUndefined()
    expect(proposal.lead).toBeUndefined()
    expect(planProposal(bare, '前の内容')!.stale).toBe(true)
    expect(planProposal(draft)).toBeUndefined()
  })
  test('appears once in the conversation where the plan finished', () => {
    const messages = messagesFromDraft({ ...planned, conversationTurns: [turn, { ...turn, id: 'turn-2', startedAt: '2026-10-08T00:04:00Z', finishedAt: '2026-10-08T00:04:10Z' }] }, [], { lastPlannedIntent: planned.intent })
    const index = messages.findIndex((message) => message.role === 'assistant' && message.proposal)
    expect(messages.filter((message) => message.role === 'assistant' && message.proposal)).toHaveLength(1)
    expect(messages[index]).toMatchObject({ at: '2026-10-08T00:03:00Z', turnId: 'proposal:gen-1' })
    expect(messages.slice(index + 1).map((message) => message.role)).toEqual(['user', 'assistant'])
  })
})

// Replies as the real model wrote them on appthrust.ink (2026-10-09).
const LIVE_FIRST = `## 要約
現在は「自分だけが使うアプリ」という前提まで決まっているため、最初に扱う業務を決める提案にしました。
## 変えたところ
## 次の質問
まずは、どの業務を管理するアプリにしますか？`
const LIVE_SECOND = `## 要約
管理する業務を在庫管理として反映しました。
## 変えたところ
- アプリ名を「在庫管理」にしました。
- 在庫一覧画面を追加しました。
- 在庫記録に品目、数量、保管場所を追加しました。
## 次の質問
在庫数は、直接入力で更新しますか、それとも入庫・出庫の履歴から自動計算しますか？`

describe('assistant reply parsing', () => {
  test('live reply with three changes', () => {
    expect(parseAssistantMessage(LIVE_SECOND)).toEqual({
      summary: '管理する業務を在庫管理として反映しました。',
      changed: ['アプリ名を「在庫管理」にしました。', '在庫一覧画面を追加しました。', '在庫記録に品目、数量、保管場所を追加しました。'],
      question: '在庫数は、直接入力で更新しますか、それとも入庫・出庫の履歴から自動計算しますか？',
    })
  })
  test('live reply with an empty 変えたところ yields no changes', () => {
    expect(parseAssistantMessage(LIVE_FIRST)).toEqual({
      summary: '現在は「自分だけが使うアプリ」という前提まで決まっているため、最初に扱う業務を決める提案にしました。',
      changed: [],
      question: 'まずは、どの業務を管理するアプリにしますか？',
    })
  })
  test('tolerates heading levels, trailing colons, bold headings, ・ bullets, CRLF and 「なし」', () => {
    expect(parseAssistantMessage('### 要約：\r\n**承認**を 1 段にしました。\r\n**変えたところ**\r\n・ルール 1 件追加\r\n・画面「承認待ち」追加\r\n# 次の質問:\r\n`PDF` にロゴを入れますか？')).toEqual({
      summary: '承認を 1 段にしました。', changed: ['ルール 1 件追加', '画面「承認待ち」追加'], question: 'PDF にロゴを入れますか？',
    })
    expect(parseAssistantMessage('## 要約\n変更はありません。\n## 変えたところ\n（なし）\n## 次の質問\n')).toEqual({ summary: '変更はありません。', changed: [] })
    expect(parseAssistantMessage('## 次の質問\n誰が承認しますか？')).toEqual({ summary: '', changed: [], question: '誰が承認しますか？' })
  })
  test('text without known sections falls back to plain text with markers stripped', () => {
    expect(parseAssistantMessage('## お知らせ\n- **PDF** を追加しました。\n次の点を確認しました：')).toEqual({ summary: 'お知らせ\nPDF を追加しました。\n次の点を確認しました：', changed: [] })
    expect(parseAssistantMessage('')).toEqual({ summary: '', changed: [] })
  })
  test('stored messages without parsed parts are parsed at render time; AI question-only replies stay questions', () => {
    expect(assistantParts({ role: 'assistant', text: LIVE_SECOND, at: 'now' }).changed).toHaveLength(3)
    expect(assistantParts({ role: 'assistant', text: '社員情報を管理するのは誰ですか？', question: '社員情報を管理するのは誰ですか？', at: 'now' })).toEqual({ summary: '', changed: [], question: '社員情報を管理するのは誰ですか？' })
    expect(assistantParts({ role: 'assistant', text: LIVE_SECOND, summary: 's', changed: ['api'], at: 'now' })).toEqual({ summary: 's', changed: ['api'] })
  })
})

describe('AI reply chips', () => {
  const history = (count: number, options?: string[]) => messagesFromDraft({
    ...draft, conversationTurns: Array.from({ length: count }, (_, index) => ({
      ...turn, id: `turn-${index}`, startedAt: `2026-10-08T00:0${index}:00Z`, finishedAt: `2026-10-08T00:0${index}:10Z`,
      userMessage: index === 0 ? buildCopy.questions.firstTurn : '人事担当者のみ', suggestedReplies: options,
    })),
  }, [])
  test('uses AI options verbatim before the third successful turn', () => {
    expect(replyOptions(history(1, ['人事担当者のみ', '人事と各部署の責任者']))).toEqual(['人事担当者のみ', '人事と各部署の責任者'])
    expect(replyOptions(history(2, []))).toEqual([])
    expect(replyOptions(history(1, [buildCopy.questions.kickoffReply, '役職も追加する']))).toEqual([buildCopy.questions.kickoffReply, '役職も追加する'])
  })
  test('appends kickoff from the third success without mutating or duplicating AI options', () => {
    const options = ['役職と雇用形態', '連絡先と緊急連絡先']
    expect(replyOptions(history(3, options))).toEqual([...options, buildCopy.questions.kickoffReply])
    expect(replyOptions(history(4, [buildCopy.questions.kickoffReply, ...options]))).toEqual([buildCopy.questions.kickoffReply, ...options])
    expect(replyOptions(history(3))).toEqual([buildCopy.questions.kickoffReply])
    expect(options).toHaveLength(2)
  })
  test('failed turns, proposals and queued user replies are not successful answers', () => {
    const messages = history(2, ['部署も記録する'])
    messages.push(assistantMessage({ ...turn, status: 'failed' }, draft.id))
    expect(replyOptions(messages)).toEqual(['部署も記録する'])
    messages.push({ role: 'assistant', text: '', at: 'later', proposal: { name: '人事', users: [], screens: [], records: [], rules: [], tasks: [], moreTasks: 0, stale: false } })
    expect(replyOptions(messages)).toEqual(['部署も記録する'])
    messages.push({ role: 'user', text: '部署も記録する', at: 'later' })
    expect(replyOptions(messages)).toEqual([])
  })
  test('the kickoff acknowledgement has no further chips', () => {
    const messages = history(3)
    messages.push({ role: 'user', text: buildCopy.questions.kickoffReply, at: 'later' }, assistantMessage({ ...turn, id: 'kickoff', suggestedReplies: [] }, draft.id))
    expect(replyOptions(messages)).toEqual([])
  })
})

describe('actionable build failure', () => {
  test.each([
    ['PVCPending', '保存場所'], ['PVCNotFound', '保存場所'], ['PodUnschedulable', '空きが足りません'],
    ['ImagePullBackOff', 'ファイルを読み込めません'], ['ErrImagePull', 'ファイルを読み込めません'],
    ['InitContainerFailed', '初期設定に失敗'], ['PodNotCreated', '起動を待っています'], ['RuntimeStarting', '起動を待っています'], ['Unknown', 'まだ確認できません'],
  ])('ports workspace failure %s without leaking diagnostics into copy', (reason, expected) => {
    const raw = `timed out waiting for workspace secret-ws-id RuntimeReady reason=${reason}`
    const failure = classifyBuildFailure(raw, undefined, 'plan')
    expect(failure.kind).toBe('workspace')
    expect(failure.reason).toContain(expected)
    expect(failure.title + failure.reason).not.toContain('secret-ws-id')
    expect(failure.raw).toBe(raw)
  })
  test.each([
    ['name already exists: foo', 'foo-2'], ['name already exists: foo; foo-2 is also taken', 'foo-3'],
    ['repository acme/foo already exists', 'foo-2'], ['repository "acme/foo" already exists; foo-2, foo-3', 'foo-4'],
    ['name already exists: foo-2', 'foo-3'], ['name already exists: ai-app-0001', 'ai-app-0001-2'], ['name already exists: report-2024', 'report-2024-2'],
  ])('suggests an unused name for %s', (text, suggestedName) => {
    expect(classifyBuildFailure(text, 409, 'prepare')).toMatchObject({ kind: 'name-taken', suggestedName })
  })
  test('suggests another name for an orphaned container package', () => {
    const raw = 'name already exists: equipment-reservation: GitHub container package appthrust/equipment-reservation already exists. Choose a different repository name. The package is not linked to a repository.'
    expect(classifyBuildFailure(raw, undefined, 'prepare')).toEqual({
      kind: 'name-taken', title: '置き場の名前がすでに使われています',
      reason: '「equipment-reservation-2」に変えて、もう一度作りますか？', suggestedName: 'equipment-reservation-2', raw,
    })
  })
  test('distinguishes permission, limits, unavailable, busy, lease interruption and timeout', () => {
    expect(classifyBuildFailure('denied', 403, 'turn').kind).toBe('forbidden')
    expect(classifyBuildFailure('application draft has reached 20 plan generation attempts', 412, 'plan').kind).toBe('limit')
    expect(classifyBuildFailure('application draft has reached 50 conversation turns', 412, 'turn').kind).toBe('limit')
    expect(classifyBuildFailure('application draft conversation is not available', 412, 'turn').kind).toBe('unavailable')
    expect(classifyBuildFailure('codex runtime is not available', undefined, 'plan').kind).toBe('unavailable')
    expect(classifyBuildFailure('run lease expired', undefined, 'prepare').kind).toBe('interrupted')
    expect(classifyBuildFailure('deadline exceeded', undefined, 'implement').kind).toBe('timeout')
    expect(classifyBuildFailure('unexpected', undefined, 'prepare').kind).toBe('platform')
    expect(classifyBuildFailure('application draft conversation turn or plan generation is running', 409, 'turn').reason).toContain('終わったら続けます')
  })
  test('a runtime path still regenerating is temporary, and a dropped task stream resumes rather than blames the platform', () => {
    // The access plane answers 503 while ClusterAccess regenerates; nobody needs to be contacted yet.
    const unavailable = classifyBuildFailure('dev workspace runtime is temporarily unavailable', 503, 'implement')
    expect(unavailable.kind).toBe('unavailable')
    expect(unavailable.reason).toContain('少し待ってから')
    expect(classifyBuildFailure('ClusterAccess is not ready for its current generation', undefined, 'implement').reason)
      .toContain('そのまま待つか、もう一度試してください')
    const dropped = classifyBuildFailure('AI task stream ended before task.completed', undefined, 'implement')
    expect(dropped.kind).toBe('interrupted')
    expect(dropped.reason).toContain('続きから')
    expect(classifyBuildFailure('Failed to fetch', undefined, 'implement').kind).toBe('interrupted')
    // Outside implementation a dropped fetch is still a plain failure.
    expect(classifyBuildFailure('Failed to fetch', undefined, 'turn').kind).toBe('failed')
  })
  test.each([
    'gitops: policy rejected: deployment preflight: target is not ready',
    'policy rejected the generated plan',
    'deployment preflight failed',
    'delivery failed to apply the release',
    "'definitionRef' is required",
    "'existing.repository' is not allowed by the selected source connection",
    'Launch needs changes before resources can be created.',
    'application draft changed while validating the creation plan; validate the latest plan again',
    'creation plan validation failed',
    "applicationStackRequest: 'application.name' is required",
    'invalid request: unknown field in server contract',
  ])('classifies server-owned failure as platform: %s', (raw) => {
    // Test outside prepare too: these patterns, not just its fallback, identify a platform failure.
    for (const context of ['prepare', 'plan'] as const) {
      const failure = classifyBuildFailure(raw, undefined, context)
      expect(failure).toMatchObject({ kind: 'platform', ...buildCopy.failure.platform, raw })
      expect(failure.title + failure.reason).not.toMatch(/[a-z]/i)
    }
  })
  test('keeps specific failures ahead of platform patterns and other generic copy unchanged', () => {
    for (const [raw, status, kind] of [
      ['gitops: forbidden: name already exists: inventory', 403, 'forbidden'],
      ['gitops: policy rejected: name already exists: inventory', 409, 'name-taken'],
      ['validation: application draft has reached 20 plan generation attempts', 412, 'limit'],
      ['delivery unavailable', 503, 'unavailable'],
      ['gitops: workspace PVCPending', undefined, 'workspace'],
      ['deployment preflight timed out', undefined, 'timeout'],
      ['delivery run lease expired', undefined, 'interrupted'],
    ] as const) {
      expect(classifyBuildFailure(raw, status, 'prepare').kind).toBe(kind)
    }
    const busy = classifyBuildFailure('validation: application draft conversation turn or plan generation is running', 409, 'prepare')
    expect(busy).toMatchObject({ kind: 'failed', ...buildCopy.failure.busy })
    for (const context of ['turn', 'plan', 'implement'] as const) {
      expect(classifyBuildFailure('unexpected', undefined, context)).toMatchObject({ kind: 'failed', title: buildCopy.failure.failed[context], reason: buildCopy.failure.retry })
    }
  })
  test('formats a stable support reference from the draft, failed execution and failure time', () => {
    const reference = { draftId: 'draft-ae97efbc', executionId: 'exec-123', at: new Date(2026, 9, 17, 9, 9).toISOString() }
    const failure = classifyBuildFailure("'definitionRef' is required", undefined, 'prepare', reference)
    expect(failure.reference).toEqual(reference)
    expect(buildFailureReference(failure.reference!)).toBe('問い合わせ番号: draft-ae97efbc / exec-123 09:09')
    expect(buildFailureReference({ draftId: reference.draftId, at: reference.at })).toBe('問い合わせ番号: draft-ae97efbc 09:09')
    expect(classifyBuildFailure('forbidden', 403, 'prepare', reference).reference).toBeUndefined()
  })
})
