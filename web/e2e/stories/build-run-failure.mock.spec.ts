import type { APIRequestContext } from '@playwright/test'
import { test, expect, seed, captureWrite, type MockControl } from '../support/fixtures'

// APT-1158: a stopped implementation run is worded and offered from Platform's `failure`. `retryable` decides whether
// 「もう一度試す」 is offered; a run an unchanged retry cannot fix says who acts and what changes, and keeps the skip and
// a change typed in the conversation (Platform still admits those runs). An older Platform sends no `failure` and the
// run reads as before (no change starts while its notice is shown). Only the mock's `implementation-run` control varies.
const root = `/api/v1/projects/${seed.projectId}`

/** A draft whose app is created, so opening its build page starts the implementation run. */
async function createdDraft(request: APIRequestContext, mock: MockControl): Promise<string> {
  const draft = (await (await request.post(`${root}/application-drafts`, { data: { intent: '見積の画面を作る' } })).json()).resource
  const path = `${root}/application-drafts/${draft.id}`
  await request.post(`${path}/creation-plan-generations`)
  for (let step = 0; step < 4; step++) await mock.advance()
  const validation = (await (await request.post(`${path}/creation-plan-validations`)).json()).resource
  const begun = (await (await request.post(`${path}/creation-executions`, { data: { clientRequestId: 'run-failure', creationPlanFingerprint: validation.creationPlanFingerprint } })).json()).resource
  await request.post(`${path}/creation-executions/${begun.creationExecutions[0].id}/run`)
  for (let step = 0; step < 6; step++) await mock.advance()
  return draft.id
}

const cases = [
  {
    name: 'retryable-unknown', story: 'a reason this console does not know follows retryable: retry, skip and a change, generic words',
    control: { failure: { reason: 'TaskStalled', retryable: true } },
    title: 'アプリを作る作業が止まりました', reason: ['仕様と計画は残っています。もう一度試してください。'], retry: true, skip: true, change: true, reference: false,
  },
  {
    name: 'blocked-known', story: 'a known reason a retry cannot fix: no retry; who acts and what changes, then a change or skip, with the reference',
    control: { failure: { reason: 'ConfigurationMissing', retryable: false } },
    title: '基盤の設定の問題で止まりました',
    reason: ['下の問い合わせ番号を基盤の担当者に伝えて、設定を直してもらってください。', 'そのあと、直してほしいことを会話で伝えるか、この作業を飛ばしてください。'],
    retry: false, skip: true, change: true, reference: true,
  },
  {
    name: 'legacy', story: 'an older Platform without failure keeps today\'s reading of failureReason',
    control: { failure: 'legacy' },
    title: 'アプリを作る作業が止まりました', reason: ['仕様と計画は残っています。もう一度試してください。'], retry: true, skip: true, change: false, reference: false,
  },
] as const

for (const item of cases) {
  test(`${item.story} @mock @story`, async ({ page, mock, request }, testInfo) => {
    test.setTimeout(90_000)
    const draftId = await createdDraft(request, mock)
    const runs = `${root}/application-drafts/${draftId}`
    await mock.platform('implementation-run', { outcome: 'failed', error: 'the task stopped', ...item.control })
    await page.goto(`/-/build/${draftId}`)
    await expect.poll(async () => (await (await request.get(runs)).json()).implementationRuns?.length ?? 0).toBe(1)
    const artifact = page.getByRole('region', { name: 'いま作っているもの', exact: true })
    const title = artifact.getByText(item.title, { exact: true })
    // Only the mock server advances the run; the browser reads the draft.
    for (let attempt = 0; attempt < 12; attempt++) {
      await mock.advance()
      try { await expect(title).toBeVisible({ timeout: 2_000 }); break } catch { /* not yet */ }
    }
    await expect(title).toBeVisible()
    const run = (await (await request.get(runs)).json()).implementationRuns.at(-1)
    expect(run.status).toBe('failed')
    if (item.control.failure === 'legacy') expect(run).not.toHaveProperty('failure')
    else expect(run.failure).toEqual(item.control.failure)
    for (const sentence of item.reason) await expect(artifact).toContainText(sentence)
    // The panel owns the run's actions; the conversation offers no retry of its own while the run's notice is shown.
    await expect(page.getByRole('button', { name: 'もう一度試す', exact: true })).toHaveCount(item.retry ? 1 : 0)
    await expect(page.getByRole('button', { name: 'この作業を飛ばす', exact: true })).toHaveCount(item.skip ? 1 : 0)
    await expect(artifact.getByText(/^問い合わせ番号: /)).toHaveCount(item.reference ? 1 : 0)
    // Platform's reason names never reach the screen.
    for (const word of ['TaskStalled', 'ConfigurationMissing', 'retryable']) await expect(page.getByText(word)).toHaveCount(0)
    // The artifact pane scrolls on its own: the whole notice is brought into view before each capture.
    const notice = artifact.getByRole('alert').filter({ hasText: item.title })
    await notice.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: testInfo.outputPath(`${item.name}-desktop.png`) })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#build-tab-artifact').click()
    await notice.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await expect(notice).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${item.name}-mobile.png`) })
    // What to change, typed in the conversation, starts a run with that instruction for the stopped task, unless
    // the notice comes without Platform's decision (as before: the reply waits until a run is started from the panel).
    await page.setViewportSize({ width: 1280, height: 900 })
    const message = '一覧の列を減らして'
    if (item.change) {
      await page.getByLabel('AI に伝えること', { exact: true }).fill(message)
      const changed = await captureWrite(page, 'POST', `${runs}/implementation-runs`, () => page.getByRole('button', { name: '送信', exact: true }).click())
      expect(changed.body).toEqual({ change: { taskId: run.currentTaskId, message } })
      await changed.request.response()
    } else {
      const starts: string[] = []
      page.on('request', (sent) => { if (sent.method() === 'POST' && new URL(sent.url()).pathname === `${runs}/implementation-runs`) starts.push(sent.url()) })
      await page.getByLabel('AI に伝えること', { exact: true }).fill(message)
      await page.getByRole('button', { name: '送信', exact: true }).click()
      await page.waitForTimeout(3_000)
      expect(starts).toEqual([])
    }
  })
}
