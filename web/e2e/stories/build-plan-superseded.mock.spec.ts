import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect, seed, withExpectedFailures, type MockControl } from '../support/fixtures'
import { textJa as buildText } from '../../src/model/build/copy'
import { textJa as sessionText } from '../../src/features/build/copy'

const root = `/api/v1/projects/${seed.projectId}`
const RUNTIME_DOWN = 'Codex workspace runtime is unavailable'

/** A draft whose kickoff was answered and whose first plan failed while the AI runtime was down (an operator rollout). */
async function failedPlanDraft(request: APIRequestContext, mock: MockControl): Promise<string> {
  await mock.platform('codex', { available: true })
  await mock.platform('plan-generation', { outcome: 'failed', error: RUNTIME_DOWN, autoAdvance: false })
  const draft = (await (await request.post(`${root}/application-drafts`, { data: { intent: '見積を管理するアプリ', title: '見積を管理' } })).json()).resource
  const path = `${root}/application-drafts/${draft.id}`
  for (const message of [buildText.questions.firstTurn, buildText.questions.kickoffReply]) {
    expect((await request.post(`${path}/conversation-turns`, { data: { message } })).status()).toBe(202)
    await mock.advance()
  }
  expect((await request.post(`${path}/creation-plan-generations`, { data: {} })).status()).toBe(202)
  for (let step = 0; step < 4; step++) await mock.advance()
  return draft.id as string
}

/** Another tab, Platform or the user makes the plan again; it succeeds. Nothing in this page is touched. */
async function planElsewhere(request: APIRequestContext, mock: MockControl, draftId: string) {
  await mock.platform('codex', { available: true })
  await mock.platform('plan-generation', { outcome: 'succeeded' })
  expect((await request.post(`${root}/application-drafts/${draftId}/creation-plan-generations`, { data: {} })).status()).toBe(202)
  for (let step = 0; step < 4; step++) await mock.advance()
}

function countPlanRequests(page: Page): () => number {
  let count = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/creation-plan-generations$/.test(new URL(request.url()).pathname)) count++
  })
  return () => count
}

/** The plan made elsewhere is read by the page's own draft reads: the failure goes without a reload and the plan is shown. */
async function expectSuperseded(page: Page, title: string) {
  const conversation = page.getByRole('log', { name: 'AI との会話' })
  await expect(page.getByTestId('build-proposal')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('#build-artifact').getByRole('alert')).toHaveCount(0)
  await expect(conversation.getByRole('alert')).toHaveCount(0)
  await expect(conversation.getByRole('button', { name: 'もう一度試す', exact: true })).toHaveCount(0)
  // The conversation keeps what happened, as history only.
  await expect(conversation.getByRole('status').filter({ hasText: title })).toContainText(sessionText.session.planResumed)
  await expect(page.getByTestId('build-session')).toHaveAttribute('data-stage', 'decide')
  await expect(page.getByRole('button', { name: 'この内容で作る', exact: true })).toBeEnabled()
}

test.describe('APT-1207: a plan made after this page\'s plan failure supersedes it @build-plan-superseded', () => {
  test('the automatic retry is refused while the runtime is down; a plan made elsewhere clears the failure without a reload @mock @story', async ({ page, mock, request }) => {
    const draftId = await failedPlanDraft(request, mock)
    await mock.platform('codex', { available: false })
    const planRequests = countPlanRequests(page)
    const title = buildText.failure.unavailable.title
    await withExpectedFailures([{ method: 'POST', path: `${root}/application-drafts/${draftId}/creation-plan-generations`, status: 412, count: 1, reason: 'the automatic retry of the failed plan meets the AI runtime still down' }], async () => {
      await page.goto(`/-/build/${draftId}`)
      await expect(page.locator('#build-artifact').getByRole('alert')).toContainText(title)
    })
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    await expect(conversation).toContainText(sessionText.session.retryPlan)
    await expect(conversation.getByRole('alert').filter({ hasText: title }).getByRole('button', { name: 'もう一度試す', exact: true })).toBeVisible()
    expect(planRequests()).toBe(1)
    await planElsewhere(request, mock, draftId)
    await expectSuperseded(page, title)
    expect(planRequests()).toBe(1)
  })

  test('the automatic retry made a plan that failed too; a plan made elsewhere clears the failure without a reload @mock @story', async ({ page, mock, request }) => {
    const draftId = await failedPlanDraft(request, mock)
    const planRequests = countPlanRequests(page)
    const retried = page.waitForResponse((response) => response.request().method() === 'POST' && /\/creation-plan-generations$/.test(new URL(response.url()).pathname))
    await page.goto(`/-/build/${draftId}`)
    expect((await retried).status()).toBe(202)
    for (let step = 0; step < 4; step++) await mock.advance()
    const title = buildText.failure.unavailable.title
    await expect(page.locator('#build-artifact').getByRole('alert')).toContainText(title, { timeout: 15_000 })
    await expect(page.getByRole('log', { name: 'AI との会話' }).getByRole('alert').filter({ hasText: title }).getByRole('button', { name: 'もう一度試す', exact: true })).toBeVisible()
    expect(planRequests()).toBe(1)
    await planElsewhere(request, mock, draftId)
    await expectSuperseded(page, title)
    expect(planRequests()).toBe(1)
  })
})
