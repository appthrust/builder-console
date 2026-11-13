import { expect, test } from 'bun:test'
import type { ApplicationDraftCreationExecution, ApplicationSourceRepository } from '@appthrust/api-schema/platform-api'
import type { AppView, ConsoleAppFacts } from '../app'
import { appPreparationProgress, buildProgress, implementationProgress, progressCard, sourceBuildFailureProgress } from './progress'
import { deriveStage, draftPublished } from './stage'
import { currentLanguage, setLanguage } from '../../shell/language'
import { buildCopy } from './copy'
import { classifyBuildFailure } from './failure'
import { executionOf, runOf, taskOf } from '../../api/testing/build-domain'

const since = '2026-10-10T00:00:00Z'
const start = Date.parse(since)
const execution: ApplicationDraftCreationExecution = { id: 'exec', attempt: 1, status: 'running', startedAt: since, steps: [{ id: 'observe', tool: 'appthrust.applicationStack.observe', status: 'running', title: '設計図を反映しています', phase: 'syncing', detail: { since, attempt: 1 } }] }
const repository: ApplicationSourceRepository = { id: 'src', projectId: 'pj', destination: { repositoryName: 'app' }, image: { imagePath: 'ghcr.io/acme/app' }, status: 'pending', repositoryUrl: 'https://github.com/acme/app', conditions: [{ type: 'RepositoryCreated', status: 'True' }] }
function view(facts: Partial<ConsoleAppFacts> = {}): AppView {
  return { status: 'deploying', label: '準備中', text: '', second: '', draft: false, platform: { id: 'app', name: 'app', status: 'deploying', statusText: '', branchId: 'production', facts: { webReady: false, everReleased: false, hasPublish: true, ...facts } } }
}

test('syncing uses the API title and phase clock, and older APIs get the same ladder', () => {
  const card = progressCard({ kind: 'prepare', execution: executionOf(execution), now: start + 67_000 })
  expect(card.steps?.map((step) => step.state)).toEqual(['done', 'doing', 'todo'])
  expect(card.steps?.[1]).toMatchObject({ label: '設計図を反映しています', elapsedLabel: '1:07', expectation: '目安 約 1 分' })
  expect(card.hint).toBeUndefined()
  const legacy = progressCard({ kind: 'prepare', now: start, execution: executionOf({ ...execution, steps: [{ id: 'observe', tool: 'appthrust.applicationStack.observe', status: 'running' }] }) })
  expect(legacy.steps?.map((step) => step.label)).toEqual(['置き場', '設計図を反映', '下地を起動'])
  expect(legacy.hint).toBe('通常 10 分ほどです')
})

test('the threshold is strictly twice the upper expectation and hides raw reasons and titles', () => {
  expect(progressCard({ kind: 'prepare', execution: executionOf(execution), now: start + 120_000 }).delayHint).toBeUndefined()
  const stalled = progressCard({ kind: 'prepare', execution: executionOf({ ...execution, steps: [{ ...execution.steps[0]!, title: 'GitOps image Release', detail: { since, reason: 'internal-secret' } }] }), now: start + 120_001 })
  expect(stalled.delayHint).toContain('いつもより時間がかかっています')
  expect(stalled.steps?.[1]?.label).toBe('設計図を反映')
  expect(JSON.stringify(stalled)).not.toMatch(/GitOps|image|Release|internal-secret/)
})

test('the app projection drives the template startup, never a URL rung', () => {
  const input = { view: view(), sourceRepository: repository, shareSentence: '' }
  const building = appPreparationProgress(input, start + 600_001, since)!
  expect(building.steps?.map((step) => step.state)).toEqual(['done', 'done', 'doing'])
  expect(building.buildUrl).toBe('https://github.com/acme/app/actions')
  expect(building.delayHint).toContain('いつもより時間がかかっています')
  const ready = { ...repository, status: 'ready' as const }
  const starting = appPreparationProgress({ ...input, sourceRepository: ready }, start + 67_000, since)!
  expect(starting.steps?.[2]).toMatchObject({ state: 'doing', elapsedLabel: '1:07' })
  expect(starting.steps?.map((step) => step.label)).not.toContain('URL')
  expect(appPreparationProgress({ ...input, sourceRepository: ready, view: view({ everReleased: true }) }, start)).toBeUndefined()
  expect(appPreparationProgress({ ...input, view: { ...view({ everReleased: true, publishPhase: 'succeeded' }), url: 'https://app.example' } }, start)).toBeUndefined()
  expect(deriveStage({ execution: executionOf({ ...execution, status: 'succeeded' }), now: start, published: draftPublished({ implementationRuns: [] }), appProgress: building }).progress).toBe(building)
})

test('build and startup failures show Japanese hints without leaking raw platform text', () => {
  const failedBuild = appPreparationProgress({ view: view(), shareSentence: '', sourceRepository: { ...repository, status: 'failed', conditions: [...repository.conditions, { type: 'ImageReady', status: 'False' }] } }, start)!
  expect(failedBuild.delayHint).toBe('下地の組み立てに失敗しました。基盤の担当者に確認してください。')
  const failedStart = appPreparationProgress({ view: view({ webReleasePhase: 'Failed' }), shareSentence: '', sourceRepository: { ...repository, status: 'ready' } }, start)!
  expect(failedStart.delayHint).toBe('下地を起動できませんでした。基盤の担当者に確認してください。')
})

test('one ladder retains preparation then screens and publication readiness', () => {
  const tasks = [{ id: 'one', title: '顧客一覧', status: 'done' }, { id: 'two', title: '見積', status: 'running' }, { id: 'three', title: 'PDF', status: 'pending' }]
  const wire = { id: 'run', status: 'running', devWorkspaceId: 'workspace', taskIds: tasks.map((task) => task.id), tasks, currentTaskId: 'two', step: 'working', activityTail: '画面を作っています\n', startedAt: since }
  const input = runOf(wire)
  const progress = buildProgress(undefined, input, start + 67_000, true)
  expect(progress.steps?.map((step) => step.label)).toEqual(['置き場', '設計図を反映', '下地を起動', '画面「顧客一覧」', '画面「見積」', '画面「PDF」', '公開準備'])
  expect(progress.steps?.[4]).toMatchObject({ state: 'doing', elapsedLabel: '1:07', activity: 'AI が作業しています（出力あり）' })
  expect(progress.steps?.at(-1)?.state).toBe('todo')
  expect(implementationProgress({ ...input, activityTail: '' }, start)[1]?.activity).toBe('AI が作業しています')
  expect(implementationProgress(runOf({ ...wire, step: 'request' }), start)[1]?.activity).toBe('AI に依頼を送っています')
  expect(implementationProgress(runOf({ ...wire, step: 'pushing' }), start)[1]?.activity).toBe('できたところを保存しています')
  const done = { tasks: tasks.map((task) => taskOf({ ...task, status: 'done' })) }
  expect(buildProgress(undefined, done, start, false).steps?.at(-1)?.state).toBe('doing')
  expect(buildProgress(undefined, done, start, true).steps?.at(-1)?.state).toBe('done')
  expect(buildProgress(undefined, { tasks: tasks.map((task) => taskOf({ ...task, status: 'skipped' })) }, start, false).steps?.at(-1)?.state).toBe('todo')
})

test('screen projection hides technical titles and handles failed tasks and invalid clocks', () => {
  const task = { id: 'one', title: 'Codex workspace', status: 'pending' }
  expect(implementationProgress({ tasks: [taskOf(task)] }, start)[0]).toMatchObject({ label: '画面「アプリ」', state: 'todo' })
  expect(implementationProgress({ tasks: [taskOf({ ...task, status: 'failed' })] }, start)[0]?.state).toBe('failed')
  expect(implementationProgress({ tasks: [taskOf({ ...task, status: 'running' })], currentTaskId: 'one', startedAt: 'invalid' }, start)[0]?.elapsedLabel).toBeUndefined()
})

test('source build failure survives an older released image and marks the startup rung', () => {
  const failed = { ...repository, status: 'ready' as const, build: { state: 'failed' as const, runUrl: 'https://github.com/acme/app/actions/runs/12', headSha: 'new-head' } }
  const input = { view: view({ everReleased: true, webReady: true }), sourceRepository: failed, shareSentence: '' }
  const preparation = appPreparationProgress(input, start)
  const card = buildProgress(preparation, { tasks: [taskOf({ id: 'screen', title: '一覧', status: 'done' })] }, start, true)
  expect(card.steps?.[2]).toMatchObject({ label: '下地を起動', state: 'failed', detail: 'アプリのビルドに失敗しています' })
  expect(card.steps?.at(-1)?.state).not.toBe('done')
  expect(card.buildUrl).toBe(failed.build.runUrl)
  expect(card.currentActivity).toBeUndefined()
  expect(deriveStage({ execution: executionOf({ ...execution, status: 'succeeded' }), now: start, published: draftPublished({ publishedAt: since, implementationRuns: [] }), appProgress: preparation }).progress).toBe(preparation)
  for (const state of ['healthy', 'running', 'unknown'] as const) {
    expect(appPreparationProgress({ ...input, sourceRepository: { ...failed, build: { state } } }, start)?.buildFailed).not.toBe(true)
  }
})

test('build failures are visible while creation is still waiting for the first stack', () => {
  const progress = sourceBuildFailureProgress({ state: 'failed', runUrl: 'https://github.com/acme/app/actions/runs/12' })
  expect(progress?.steps?.[2]?.state).toBe('failed')
  expect(deriveStage({ execution: executionOf(execution), now: start, published: draftPublished({ implementationRuns: [] }), appProgress: progress }).progress).toBe(progress)
  expect(sourceBuildFailureProgress({ state: 'running' })).toBeUndefined()
  expect(sourceBuildFailureProgress({ state: 'failed', runUrl: 'javascript:alert(1)' })?.buildUrl).toBeUndefined()
})

test('build labels and failure messages switch languages without reloading the model', () => {
  const originalLanguage = currentLanguage()
  try {
    setLanguage('en')
    const progress = buildProgress(undefined, { tasks: [taskOf({ id: 'screen', title: 'Sales', status: 'done' })] }, start, true)
    expect(progress.title).toBe('Building your app')
    expect(progress.steps?.map((step) => step.label)).toEqual(['Saved files', 'Apply design', 'Start app', 'Screen “Sales”', 'Ready to publish'])
    expect(progress.steps?.[3]?.status).toBe('Done')
    expect(sourceBuildFailureProgress({ state: 'failed' })?.steps?.[2]?.detail).toBe('The app could not be built')
    expect(classifyBuildFailure('PVCNotFound', undefined, 'prepare').reason).toBe('Storage for AI is not ready. Please wait or try again; contact your administrator if nothing changes for over 5 minutes.')
    expect(buildCopy.progress.task.working(false)).toBe('AI is working')
    expect(buildCopy.progress.task.working(true)).toBe('AI is working (updates available)')
    setLanguage('ja')
    expect(buildCopy.progress.task.working(false)).toBe('AI が作業しています')
    expect(buildCopy.progress.task.working(true)).toBe('AI が作業しています（出力あり）')
    expect(sourceBuildFailureProgress({ state: 'failed' })?.steps?.[2]?.detail).toBe('アプリのビルドに失敗しています')
  } finally {
    setLanguage(originalLanguage)
  }
})
