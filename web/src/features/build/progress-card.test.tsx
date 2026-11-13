import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProgressCard } from './artifact-pane'
import { ImplementPanel, type ImplementationState } from './implement'
import { buildCopy } from '../../model/build/copy'
import { StageRail, stateWord } from './session-header'
import { implementationCopy } from './implement/copy'
import { runOf, taskOf } from '../../api/testing/build-domain'

test('staged preparation renders an accessible ladder, elapsed time, activity and safe external build link', () => {
  const html = renderToStaticMarkup(<ProgressCard progress={{ kind: 'prepare', title: 'アプリを用意しています', interrupted: false, staged: true, steps: [{ label: '置き場', state: 'done' }, { label: '設計図を反映', state: 'done' }, { label: '最初の版をビルド', state: 'doing', elapsedLabel: '3:02', expectation: '目安 3–5 分' }, { label: '起動', state: 'todo' }, { label: 'URL', state: 'todo' }], currentActivity: 'GitHub で最初のビルドを実行中', buildUrl: 'https://github.com/acme/app/actions', delayHint: 'いつもより時間がかかっています（基盤の担当者に確認してください）' }} />)
  expect(html.match(/<li /g)).toHaveLength(5)
  expect(html).toContain('aria-label="アプリの準備"')
  expect(html).toContain('aria-current="step"')
  expect(html).toContain('3:02')
  expect(html).toContain('目安 3–5 分')
  expect(html).toContain('いまの動き: ')
  expect(html).toContain('ビルドの様子を見る')
  expect(html).toContain('rel="noopener noreferrer"')
  expect(html).toContain('いつもより時間がかかっています')
})

test('legacy preparation keeps its generic steps and hint', () => {
  const html = renderToStaticMarkup(<ProgressCard progress={{ kind: 'prepare', title: 'アプリを用意しています', interrupted: false, hint: '通常 10 分ほどです', steps: [{ label: '最初の版', state: 'doing' }] }} />)
  expect(html).toContain('通常 10 分ほどです')
  expect(html).toContain('進行中')
  expect(html).not.toContain('いまの動き')
})

test('the merged build renders one ladder, and a ready preview starts with the first task', () => {
  const state = { phase: 'idle' as const, tasks: [taskOf({ id: 'one', title: '顧客一覧', status: 'pending' })], previewUrl: '/preview', previewStatus: 'ready' as const }
  const pending = renderToStaticMarkup(<ImplementPanel state={state} released={false} onOpenPreview={() => {}} />)
  expect(pending.match(/<ol /g)).toHaveLength(1)
  expect(pending).toContain('アプリを作っています')
  expect(pending).not.toContain('<iframe')
  const running = renderToStaticMarkup(<ImplementPanel state={{ ...state, phase: 'running', currentTaskId: 'one', step: runOf({ id: 'r', status: 'running', startedAt: '2026-10-27T00:00:00Z', devWorkspaceId: 'ws', taskIds: [], tasks: [], step: 'working' }).step, activityTail: '画面を作っています\n', tasks: [taskOf({ id: 'one', title: '顧客一覧', status: 'running' })] }} released={false} onOpenPreview={() => {}} />)
  expect(running).toContain('<iframe')
  expect(running.indexOf('<iframe')).toBeLessThan(running.indexOf('<ol'))
  expect(running.match(/<ol /g)).toHaveLength(1)
  expect(running).toContain('画面「顧客一覧」')
  expect(running).not.toContain('前回の続きから進めています')
  expect(running).toContain('AI が作業しています（出力あり）')
  expect(running).not.toContain('URL をコピー')
})

test('the rail has four stages and uses one building state word', () => {
  const header = renderToStaticMarkup(<StageRail stage="build" />)
  for (const word of ['聞く', '決める', '作る', '公開']) expect(header).toContain(word)
  expect(stateWord.build).toBe('作っています')
  for (const word of ['用意する', '作り込む', '作り込み中']) expect(header).not.toContain(word)
  expect(buildCopy.proposal.tasks).toBe('作る内容')
  expect(buildCopy.prepareConversation.ready).toBe('下地ができました。ここから画面を作ります。')
})

test('failed source builds render a cross and product wording, not an endless active step', () => {
  const html = renderToStaticMarkup(<ImplementPanel
    state={{ phase: 'done', tasks: [taskOf({ id: 'one', title: '一覧', status: 'done' })] }}
    preparation={{ kind: 'prepare', title: buildCopy.progress.prepare.title, interrupted: false, buildFailed: true, buildUrl: 'https://github.com/acme/app/actions/runs/12', steps: [{ label: '下地を起動', state: 'failed', detail: 'アプリのビルドに失敗しています' }] }}
    released={false} onOpenPreview={() => {}}
  />)
  expect(html).toContain('aria-label="失敗"')
  expect(html).toContain('✖')
  expect(html).toContain('アプリのビルドに失敗しています')
  expect(html).not.toContain('aria-current="step"')
  expect(html).not.toContain('https://github.com/acme/app/actions/runs/12')
})

test('only unmet verification criteria appear under their task, including repair notes', () => {
  const state: ImplementationState = {
    phase: 'done',
    tasks: [taskOf({ id: 'dashboard', title: '月次集計', status: 'done', verification: {
      reportedAt: '2026-10-27T00:00:00Z', repairAttempts: 1,
      criteria: [{ criterion: '件数が見える', met: true }, { criterion: '担当者別の金額が見える', met: false, note: '集計カードをまだ表示できません' }],
    } })],
  }
  const render = (value: ImplementationState) => renderToStaticMarkup(<ImplementPanel state={value} released={false} onOpenPreview={() => {}} />)
  const html = render(state)
  expect(html).toContain(implementationCopy.unmetCriteria(1))
  expect(html).toContain('担当者別の金額が見える')
  expect(html).toContain('集計カードをまだ表示できません')
  expect(html).not.toContain('件数が見える')
  const task = state.tasks[0]!
  expect(render({ ...state, tasks: [{ ...task, verification: { ...task.verification!, criteria: task.verification!.criteria.map((criterion) => ({ ...criterion, met: true })) } }] })).not.toContain('<details')
})

test('a retry waiting for its inputs or response is visibly pending and disabled', () => {
  const html = renderToStaticMarkup(<ImplementPanel state={{
    phase: 'failed', tasks: [taskOf({ id: 'one', title: '一覧', status: 'failed' })], retryPending: true,
    failure: { kind: 'interrupted', ...buildCopy.failure.resumable },
  }} released={false} onOpenPreview={() => {}} onRetry={() => {}} />)
  const container = document.createElement('div')
  container.innerHTML = html
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(implementationCopy.retryPending))
  expect(retry?.disabled).toBe(true)
})
