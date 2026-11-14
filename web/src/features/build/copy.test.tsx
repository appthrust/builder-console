import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isPlatformNotFound } from '../../api/platform-error'
import { draftOf, runOf, taskOf } from '../../api/testing/build-domain'
import { buildCopy } from '../../model/build/copy'
import { buildFailureReference, classifyBuildFailure, destinationFailure } from '../../model/build/failure'
import type { BuildProposal, BuildSpec } from '../../model/build/types'
import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
import { ArtifactPane, ProgressCard, PublishCard, SpecCard } from './artifact-pane'
import { ConversationPane } from './conversation-pane'
import { text } from './copy'
import { ImplementPanel } from './implement'
import { implementationCopy } from './implement/copy'
import { projectImplementation, type ImplementationState } from './implement/state'
import { NameChoice } from './name-choice'
import { ProposalBody } from './proposal'
import { stageLabels, titleFromIntent } from './session'
import { StageAction, StageRail, stateWord } from './session-header'

let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())

const spec: BuildSpec = {
  users: ['Alice', 'Bob'], screens: ['Contacts'], records: [{ name: 'Contact', fields: ['Name', 'Email'] }],
  rules: ['Keep names unique'], approval: 'one-step', importFrom: 'csv',
}
const proposal: BuildProposal = {
  ...spec, name: 'Contacts', screens: [{ name: 'Contacts', purpose: 'Find customers' }],
  tasks: [], moreTasks: 0, stale: false,
}
const noReset: ComponentProps<typeof ArtifactPane>['previewDatabaseReset'] = { busy: false, pending: false, reset: async () => false }

test('imported stage and state labels switch both ways without reloading modules', () => {
  setLanguage('ja')
  expect(stageLabels.ask).toBe('聞く')
  expect(stateWord.build).toBe('作っています')
  expect(implementationCopy.preview).toBe('アプリのプレビュー')
  setLanguage('en')
  expect(stageLabels.ask).toBe('Discuss')
  expect(stateWord.build).toBe('Building')
  expect(titleFromIntent('')).toBe('New app')
  expect(implementationCopy.preview).toBe('App preview')
  const rail = renderToStaticMarkup(<StageRail stage="build" />)
  for (const word of ['Discuss', 'Decide', 'Build', 'Publish']) expect(rail).toContain(word)
  expect(text.page.title('Contacts')).toBe('Contacts — Build with AI')
  expect(text.page.updatingPlan('1:02')).toBe('Updating the plan… 1:02')
  setLanguage('ja')
  expect(stageLabels.ask).toBe('聞く')
  expect(stateWord.build).toBe('作っています')
  expect(implementationCopy.preview).toBe('アプリのプレビュー')
})

test.each(['ja', 'en'] as const)('idle plan handoff shows a primary action, not a spinner, in %s', (language) => {
  setLanguage(language)
  const markup = renderToStaticMarkup(<StageAction stage="ask" primary={{ action: 'plan', label: buildCopy.questions.kickoffReply, enabled: true }} onPrimary={() => {}} />)
  expect(markup).toContain('<button')
  expect(markup).toContain(buildCopy.questions.kickoffReply)
  expect(markup).not.toContain('disabled=""')
  expect(markup).not.toContain('animate-spin')
})

test('spec and proposal preserve Japanese wording and use English labels and punctuation', () => {
  setLanguage('ja')
  const japanese = renderToStaticMarkup(<SpecCard spec={spec} title="Contacts" />)
  for (const word of ['aria-label="仕様"', '使う人', 'Alice・Bob', '承認・通知', '1 段', 'Excel・CSV がある', '含まれるもの']) expect(japanese).toContain(word)
  expect(text.proposal.record('Contact', ['Name', 'Email'])).toBe('Contact（Name・Email）')
  expect(text.nameChoice.useSuggestion('contacts')).toBe('contacts にする')
  expect(text.artifact.undecided(['画面', '記録'])).toBe('これから決めること: 画面・記録')
  setLanguage('en')
  const english = renderToStaticMarkup(<SpecCard spec={spec} title="Contacts" />)
  for (const word of ['aria-label="App details"', 'Who uses it', 'Alice, Bob', 'Approvals and notifications', '1 step', 'Excel or CSV available', 'Name, Email']) expect(english).toContain(word)
  const proposed = renderToStaticMarkup(<ProposalBody proposal={proposal} />)
  expect(proposed).toContain('aria-label="Proposal: Contacts"')
  expect(proposed).toContain('Contact (Name, Email)')
  expect(english + proposed).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
  const missing = renderToStaticMarkup(<SpecCard spec={{ users: [], screens: [], records: [], rules: [] }} title="Contacts" />)
  expect(missing).toContain('Still to decide: Who uses it, Rules, Approvals and notifications, Existing data, Screens, Records')
  const choice = renderToStaticMarkup(<NameChoice suggestion="contacts" onUse={() => {}} />)
  expect(choice).toContain('Use contacts')
  expect(choice).toContain('Another name')
  const published = renderToStaticMarkup(<PublishCard url="https://example.test" shareText="Only me" published />)
  expect(published).toContain('aria-label="Published app"')
  expect(published).toContain('Your app is published')
  expect(published).toContain('Copy URL')
})

test.each(['ja', 'en'] as const)('creation URL failure renders NameChoice instead of the generic retry in %s', (language) => {
  setLanguage(language)
  const failure = { ...classifyBuildFailure('Another publish already uses this URL.', undefined, 'prepare'), suggestedName: 'contacts-3' }
  const markup = renderToStaticMarkup(<ConversationPane
    messages={[{ role: 'notice', tone: 'error', title: failure.title, detail: failure.reason, retry: 'prepare', at: '2026-10-27T00:00:00Z' }]}
    stage="decide" answering={false} thinking={false} queued={false} failure={failure}
    onSend={() => {}} onRetry={() => {}} onUseName={() => {}}
  />)
  expect(markup).toContain(buildCopy.failure.urlNameTaken)
  expect(markup).toContain(text.nameChoice.useSuggestion('contacts-3'))
  expect(markup).toContain(text.nameChoice.alternative)
  expect(markup).not.toContain(`>${text.conversation.retry}</button>`)
})

test.each(['ja', 'en'] as const)('a moved destination is approved again with the proposal action’s words, an unset one is tried again (%s)', (language) => {
  setLanguage(language)
  const render = (rejection: 'changed' | 'blocked') => {
    const failure = destinationFailure(rejection)
    return renderToStaticMarkup(<ConversationPane
      messages={[{ role: 'notice', tone: 'warning', title: failure.title, detail: failure.reason, retry: 'prepare', at: '2026-10-27T00:00:00Z' }]}
      stage="decide" answering={false} thinking={false} queued={false} failure={failure}
      onSend={() => {}} onRetry={() => {}} onUseName={() => {}}
    />)
  }
  const changed = render('changed')
  expect(changed).toContain(`>${buildCopy.primary.prepare}</button>`)
  expect(changed).not.toContain(`>${text.conversation.retry}</button>`)
  expect(changed).toContain(buildCopy.failure.destination.changed.reason)
  expect(changed).toContain('role="status"')
  expect(render('blocked')).toContain(`>${text.conversation.retry}</button>`)
})

// The rendered state needs the router (LinkButton); app-build-ai.mock.spec.ts covers it. Here: the
// classifier that routes a 404 away from 「しばらくしてから再読み込み」, and the wording.
test('a 404 draft is an answer, not a transient failure, and the copy names the signed-in account', () => {
  const error = new ORPCError('NOT_FOUND', { status: 404, data: { body: { error: { code: 'not_found', message: 'application draft not found' } } } })
  expect(isPlatformNotFound(error)).toBe(true)
  expect(isPlatformNotFound(new ORPCError('INTERNAL', { status: 503 }))).toBe(false)
  expect(isPlatformNotFound(new ORPCError('FORBIDDEN', { status: 403 }))).toBe(false)
  setLanguage('ja')
  expect(text.page.notFound.signedInAs('someone@example.test')).toBe('いまは someone@example.test でサインインしています。作った本人のアカウントでサインインし直してください。')
  setLanguage('en')
  const english = [text.page.notFound.title, text.page.notFound.body, text.page.notFound.signedInAs('someone@example.test'), text.page.notFound.back].join(' ')
  expect(english).toContain('This draft can’t be opened')
  expect(english).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
})

test('English conversation and composer hide system prompts saved in either language', () => {
  setLanguage('ja')
  const japaneseFirst = buildCopy.questions.firstTurn
  const japanesePrepare = buildCopy.questions.prepareTurn
  setLanguage('en')
  const html = renderToStaticMarkup(<ConversationPane
    messages={[
      ...[japaneseFirst, japanesePrepare, buildCopy.questions.firstTurn, buildCopy.questions.prepareTurn].map((message, index) => ({ role: 'user' as const, text: message, at: String(index) })),
      { role: 'user', text: 'Add search', at: '4' },
      { role: 'assistant', text: 'Search added', summary: 'Search added', changed: ['Search field'], question: 'Anything else?', options: ['Add sorting'], at: '5' },
    ]}
    stage="build" answering={false} thinking={false} queued
    progress={{ kind: 'prepare', title: 'Preparing', elapsedLabel: '0:12', interrupted: false }}
    onSend={() => {}} onRetry={() => {}} onUseName={() => {}}
  />)
  for (const word of ['aria-label="Conversation"', 'aria-label="Conversation with AI"', 'You: ', 'What changed', 'Suggested replies', 'Message to AI', 'aria-label="Send"', 'Enter to send, Shift + Enter for a new line', 'placeholder="Describe what you’d like to change"', ' (0:12)']) expect(html).toContain(word)
  expect(html).not.toContain(japaneseFirst)
  expect(html).not.toContain(japanesePrepare)
  expect(html).not.toContain(buildCopy.questions.firstTurn)
  expect(html).not.toContain(buildCopy.questions.prepareTurn)
  expect(html).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
})

test('English progress and preview expose translated accessible labels', () => {
  setLanguage('en')
  const progress = renderToStaticMarkup(<ProgressCard progress={{ kind: 'prepare', title: 'Preparing', staged: true, interrupted: false, steps: [{ label: 'App', state: 'doing' }] }} />)
  expect(progress).toContain('aria-label="Progress"')
  expect(progress).toContain('aria-label="App preparation"')
  expect(progress).toContain('aria-label="In progress"')
  const preview = renderToStaticMarkup(<ImplementPanel
    state={{ phase: 'running', tasks: [taskOf({ id: 'one', title: 'Contacts', status: 'running' })], previewUrl: '/preview', previewStatus: 'ready', currentTaskId: 'one', step: { kind: 'known', value: 'working' } }}
    released={false} onOpenPreview={() => {}}
  />)
  expect(preview).toContain('title="App preview"')
  expect(preview).toContain('Open in new tab')
  expect(preview).toContain('aria-label="Steps to build your app"')
  expect(preview).toContain('aria-label="In progress"')
  expect(preview).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
})

test.each(['ja', 'en'] as const)('platform failure has a copyable support reference and no visible server text in %s', (language) => {
  setLanguage(language)
  const at = new Date(2026, 9, 17, 9, 9).toISOString()
  const draft: ApplicationDraft = {
    id: 'draft-ae97efbc', projectId: 'project-1', title: '備品管理', intent: '備品を管理したい', phase: 'planned',
    specMarkdown: '', architectureMarkdown: '', creationExecutions: [], ownerUserId: 'user-1', createdAt: at, updatedAt: at,
  }
  const raw = "Launch needs changes before resources can be created.\n'definitionRef' is required"
  const failure = classifyBuildFailure(raw, undefined, 'prepare', { draftId: draft.id, executionId: 'exec-123', at })
  const reference = buildFailureReference(failure.reference!)
  const conversation = renderToStaticMarkup(<ConversationPane
    messages={[{ role: 'notice', tone: 'error', title: failure.title, detail: failure.reason, retry: 'prepare', at, reference: failure.reference }]}
    failure={failure} stage="decide" answering={false} thinking={false} queued={false}
    onSend={() => {}} onRetry={() => {}} onUseName={() => {}}
  />)
  const artifact = renderToStaticMarkup(<ArtifactPane
    draft={draftOf(draft)} spec={{ users: [], screens: [], records: [], rules: [] }} stage="decide"
    implementation={{ phase: 'idle', tasks: [] }} failure={failure} shareText=""
    previewDatabaseReset={noReset} onOpenPreview={() => {}} onRetry={() => {}} onSkipTask={() => {}} onCollapse={() => {}}
  />)
  for (const html of [conversation, artifact]) {
    expect(html).toContain(failure.title)
    expect(html).toContain(failure.reason)
    expect(html).toContain(reference)
    expect(html).not.toContain('Launch needs changes')
    expect(html).not.toContain('definitionRef')
    expect(html).not.toContain('アプリを作れませんでした')
  }
  expect(conversation).toContain(buildCopy.failure.copyReference)
  expect(artifact).not.toContain(buildCopy.failure.copyReference)
  expect(artifact.match(/role="alert"/g)).toHaveLength(1)
  const progress = { kind: 'prepare' as const, title: failure.title, hint: failure.reason, interrupted: false, steps: [{ label: '最初の版', state: 'failed' as const, detail: failure.reason }] }
  const progressed = renderToStaticMarkup(<ArtifactPane
    draft={draftOf(draft)} spec={{ users: [], screens: [], records: [], rules: [] }} stage="decide" progress={progress}
    implementation={{ phase: 'idle', tasks: [] }} failure={failure} shareText=""
    previewDatabaseReset={noReset} onOpenPreview={() => {}} onRetry={() => {}} onSkipTask={() => {}} onCollapse={() => {}}
  />)
  // The artifact tab stays informative below md, without duplicating the conversation's actions.
  expect(progressed.match(/role="alert"/g)).toHaveLength(1)
  expect(progressed.split(failure.title)).toHaveLength(2)
  expect(progressed.split(failure.reason)).toHaveLength(2)
  expect(progressed).toContain(reference)
  expect(progressed).not.toContain(buildCopy.failure.copyReference)
  expect((progressed.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).join('')).not.toContain(text.conversation.retry)
  const alertSection = progressed.match(/<section\b[^>]*role="alert"[^>]*>/)?.[0]
  expect(alertSection).toContain(`aria-label="${text.artifact.progress}"`)
  expect(alertSection).not.toContain('hidden')
  const built = renderToStaticMarkup(<ArtifactPane
    draft={draftOf(draft)} spec={{ users: [], screens: [], records: [], rules: [] }} stage="build" progress={progress}
    implementation={{ phase: 'failed', tasks: [], failure }} failure={failure} shareText=""
    previewDatabaseReset={noReset} onOpenPreview={() => {}} onRetry={() => {}} onSkipTask={() => {}} onCollapse={() => {}}
  />)
  expect(built.match(/role="alert"/g)).toHaveLength(1)
  expect(built).toContain(reference)
  expect(failure.raw).toBe(raw)
  expect(artifact).toContain(text.artifact.advanced)
  if (language === 'ja') {
    expect(reference).toBe('問い合わせ番号: draft-ae97efbc / exec-123 09:09')
    expect(failure.title + failure.reason + buildCopy.failure.copyReference + reference.replace('draft-ae97efbc', '').replace('exec-123', '')).not.toMatch(/[a-z]/i)
  } else {
    expect(reference).toBe('Support reference: draft-ae97efbc / exec-123 09:09')
    expect(failure.reason).toContain('not a problem with your input or actions')
    expect(failure.title + failure.reason + reference).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
  }
})

test('platform name collisions still render the rename prompt instead of a generic retry', () => {
  const failure = classifyBuildFailure('gitops: policy rejected: name already exists: inventory', 409, 'prepare')
  const html = renderToStaticMarkup(<ConversationPane
    messages={[{ role: 'notice', tone: 'error', title: failure.title, detail: failure.reason, retry: 'prepare', at: '2026-10-17T09:09:00Z' }]}
    failure={failure} stage="decide" answering={false} thinking={false} queued={false}
    onSend={() => {}} onRetry={() => {}} onUseName={() => {}}
  />)
  expect(html).toContain('inventory-2 にする')
  expect(html).not.toContain(buildCopy.failure.platform.title)
  expect(html).not.toContain(text.conversation.retry)
})

test.each(['ja', 'en'] as const)('implementation platform failures render the failed run reference in %s', (language) => {
  setLanguage(language)
  const at = new Date(2026, 9, 17, 9, 9).toISOString()
  const state = projectImplementation({ id: 'draft-ae97efbc', updatedAt: at }, runOf({
    id: 'impl-123', status: 'failed', startedAt: at, finishedAt: at, devWorkspaceId: 'ws-1', taskIds: [], tasks: [],
    error: 'gitops: policy rejected: deployment preflight failed',
  }))
  const html = renderToStaticMarkup(<ImplementPanel state={state} released={false} onOpenPreview={() => {}} onRetry={() => {}} />)
  expect(html).toContain(buildCopy.failure.platform.title)
  expect(html).toContain(buildCopy.failure.platform.reason)
  expect(html).toContain(buildCopy.failure.reference('draft-ae97efbc / impl-123 09:09'))
  expect(html).toContain(buildCopy.failure.copyReference)
  expect(html).not.toContain('gitops')
  expect(html).not.toContain('deployment preflight')
})

test.each(['ja', 'en'] as const)('implementation account exhaustion offers retry but not task skipping in %s', (language) => {
  setLanguage(language)
  const at = '2026-10-27T00:00:00Z'
  const error = 'Codex task failed: insufficient_quota'
  const state = projectImplementation({ id: 'draft-quota', updatedAt: at }, runOf({
    id: 'impl-quota', status: 'failed', startedAt: at, finishedAt: at, devWorkspaceId: 'ws-1',
    taskIds: ['task-1'], currentTaskId: 'task-1', failureReason: 'TaskFailed', error,
    tasks: [{ id: 'task-1', title: '一覧を作る', status: 'failed', failureReason: 'TaskFailed', error }],
  }))
  const html = renderToStaticMarkup(<ImplementPanel state={state} released={false} onOpenPreview={() => {}} onRetry={() => {}} onSkipTask={() => {}} />)
  expect(html).toContain(buildCopy.failure.quota.title)
  expect(html).toContain(buildCopy.failure.quota.reason)
  expect(html).toContain(implementationCopy.retry)
  expect(html).not.toContain(implementationCopy.skip)
  expect(html).not.toContain(error)
})

test('implementation policy failure directs the user to an administrator without retry or skipping', () => {
  const failure = classifyBuildFailure('runtime unavailable', 412, 'implement', undefined, undefined, undefined, undefined, { reason: 'ai_approval_policy_denied', policy: 'default' })
  const state: ImplementationState = { phase: 'failed', tasks: [], failure }
  const html = renderToStaticMarkup(<ImplementPanel state={state} released={false} onOpenPreview={() => {}} onRetry={() => {}} onSkipTask={() => {}} />)
  expect(html).toContain(failure.title)
  expect(html).toContain(failure.reason)
  expect(html).not.toContain(implementationCopy.retry)
  expect(html).not.toContain(implementationCopy.skip)
})

test('preparation audience chips use the owner group vocabulary instead of historical department labels', () => {
  const html = renderToStaticMarkup(<ConversationPane
    messages={[
      { role: 'user', text: buildCopy.questions.prepareTurn, at: '1' },
      { role: 'assistant', text: '', options: ['自分だけ', '自分の課', '全社'], turnId: 'prepare', at: '2' },
    ]}
    stage="build" prepareOpen ownerGroupName="営業部" answering={false} thinking={false} queued={false}
    onSend={() => {}} onRetry={() => {}} onUseName={() => {}}
  />)
  expect(html).toContain('営業部')
  expect(html).not.toContain('自分の課')
})

function previewDraft(excel: boolean, database: boolean): ApplicationDraft {
  const at = '2026-10-27T00:00:00Z'
  return {
    id: 'preview-notice', projectId: 'project-1', title: '点検', intent: '点検を管理する', phase: 'created',
    specMarkdown: '', architectureMarkdown: '', creationExecutions: [], ownerUserId: 'owner', createdAt: at, updatedAt: at,
    ...(excel ? { source: { kind: 'excel', revision: at, workbooks: [{ id: 'wb-0123456789ab', fileName: '点検.xlsx', sheetCount: 1, rowCount: 2, truncated: false, bytes: 64, digest: 'a'.repeat(64), addedAt: at }] } } : {}),
    creationPlan: {
      summary: '点検を管理する', markdown: '# 点検', representation: ['ApplicationStack'],
      implementationHandoff: { summary: '点検一覧を作る', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'created-source-repository', tasks: [{ title: '点検一覧', description: '点検を表示する', acceptanceCriteria: ['点検が見える'] }] },
      ...(database ? { applicationStackRequest: {
        templateId: 'app-template', application: { name: 'inspections' },
        source: { kind: 'sample-image' as const, imageRef: 'example.test/inspections:latest' }, web: { componentName: 'web' },
        database: { componentName: 'database' }, connection: { connectionName: 'database' },
      } } : {}),
    },
  }
}

function renderPreview(draft: ApplicationDraft, stage: 'build' | 'publish', implementation: Partial<ImplementationState>, reset = noReset) {
  return renderToStaticMarkup(<ArtifactPane draft={draftOf(draft)} spec={{ users: [], screens: [], records: [], rules: [] }}
    stage={stage} implementation={{ phase: 'done', tasks: [taskOf({ id: 'list', title: '点検一覧', status: 'done' })], previewUrl: '/preview', previewStatus: 'ready', ...implementation }}
    shareText="" previewDatabaseReset={reset} onOpenPreview={() => {}} onRetry={() => {}} onSkipTask={() => {}} onCollapse={() => {}}
  />)
}

const databaseLines = (excel: boolean) => [
  implementationCopy.database.starting, implementationCopy.database.sleeping, implementationCopy.database.unavailable,
  implementationCopy.database.readyUnverified(excel), implementationCopy.database.readyVerified(excel),
]

test.each([
  ['ja', true, true, 'build', 'ready'],
  ['ja', false, true, 'build', 'ready'],
  ['en', true, true, 'build', 'ready'],
  ['en', false, true, 'build', 'ready'],
  ['ja', true, false, 'build', 'ready'],
  ['ja', true, true, 'publish', 'ready'],
  ['ja', true, true, 'build', 'preparing'],
  ['ja', true, true, 'build', 'timed-out'],
  ['ja', true, true, 'build', 'error'],
  ['en', true, true, 'build', 'preparing'],
  ['en', true, true, 'build', 'timed-out'],
  ['en', true, true, 'build', 'error'],
  ['en', true, false, 'build', 'error'],
  ['en', true, true, 'publish', 'error'],
] as const)('a workspace without its own database keeps the no-database notice: language=%s Excel=%s database=%s stage=%s preview=%s', (language, excel, database, stage, previewStatus) => {
  setLanguage(language)
  const html = renderPreview(previewDraft(excel, database), stage, { previewStatus, previewDatabaseStatus: 'none' })
  if (database && stage === 'build') {
    expect(html).toContain(implementationCopy.previewDatabase(excel))
    if (previewStatus === 'ready') expect(html.indexOf(implementationCopy.previewDatabase(excel))).toBeLessThan(html.indexOf('<iframe'))
  } else {
    expect(html).not.toContain(implementationCopy.previewDatabase(true))
    expect(html).not.toContain(implementationCopy.previewDatabase(false))
  }
  for (const line of databaseLines(excel)) expect(html).not.toContain(line)
  expect(html).not.toContain(implementationCopy.databaseReset)
})

test('nothing about the database is said before the workspace has been read', () => {
  const html = renderPreview(previewDraft(true, true), 'build', {})
  expect(html).not.toContain(implementationCopy.previewDatabase(true))
  for (const line of databaseLines(true)) expect(html).not.toContain(line)
  expect(html).not.toContain(implementationCopy.databaseReset)
})

test.each([
  ['ja', true, 'starting', 0],
  ['ja', true, 'sleeping', 1],
  ['ja', true, 'unavailable', 2],
  ['ja', true, 'ready-unverified', 3],
  ['ja', true, 'ready-verified', 4],
  ['en', true, 'starting', 0],
  ['en', true, 'sleeping', 1],
  ['en', true, 'unavailable', 2],
  ['en', true, 'ready-unverified', 3],
  ['en', true, 'ready-verified', 4],
  ['ja', false, 'ready-unverified', 3],
  ['ja', false, 'ready-verified', 4],
] as const)('a workspace database replaces the notice with one status line: language=%s Excel=%s status=%s', (language, excel, status, line) => {
  setLanguage(language)
  const html = renderPreview(previewDraft(excel, true), 'build', { previewDatabaseStatus: status })
  expect(html).not.toContain(implementationCopy.previewDatabase(true))
  expect(html).not.toContain(implementationCopy.previewDatabase(false))
  const lines = databaseLines(excel)
  expect(html).toContain(lines[line]!)
  for (const other of lines.filter((text) => text !== lines[line])) expect(html).not.toContain(other)
  if (!excel) expect(html).not.toContain('Excel')
  expect(html.indexOf(lines[line]!)).toBeLessThan(html.indexOf('<iframe'))
  const button = html.match(new RegExp(`<button\\b[^>]*>(?:(?!</button>)[\\s\\S])*${implementationCopy.databaseReset}</button>`))?.[0]
  expect(button).toBeDefined()
  expect(button!.includes('disabled=""')).toBe(status === 'starting' || status === 'sleeping')
  if (status === 'sleeping') expect(button).toContain(`title="${implementationCopy.database.sleeping}"`)
  expect(renderPreview(previewDraft(excel, true), 'publish', { previewDatabaseStatus: status })).not.toContain(lines[line]!)
})

test.each(['starting-workspace', 'running', 'pushing'] as const)('recreating the database waits for the AI (%s)', (phase) => {
  const html = renderPreview(previewDraft(true, true), 'build', { phase, tasks: [taskOf({ id: 'list', title: '点検一覧', status: 'running' })], previewDatabaseStatus: 'ready-verified' })
  const button = html.match(new RegExp(`<button\\b[^>]*>(?:(?!</button>)[\\s\\S])*${implementationCopy.databaseReset}</button>`))?.[0]
  expect(button).toContain('disabled=""')
  expect(button).toContain(`title="${implementationCopy.databaseResetRunning}"`)
})

test('a start or retry still being submitted keeps the reset disabled, whatever the stale phase says', () => {
  const html = renderPreview(previewDraft(true, true), 'build', { phase: 'failed', previewDatabaseStatus: 'ready-verified' }, { ...noReset, busy: true })
  const button = html.match(new RegExp(`<button\\b[^>]*>(?:(?!</button>)[\\s\\S])*${implementationCopy.databaseReset}</button>`))?.[0]
  expect(button).toContain('disabled=""')
  expect(button).toContain(`title="${implementationCopy.databaseResetRunning}"`)
})

test('a refused reset is one plain sentence under the status line', () => {
  const html = renderPreview(previewDraft(true, true), 'build', { previewDatabaseStatus: 'unavailable' }, { busy: false, pending: false, error: implementationCopy.databaseResetBusy, reset: async () => false })
  expect(html).toContain(`role="alert" class="text-bad-ink">${implementationCopy.databaseResetBusy}</p>`)
})
