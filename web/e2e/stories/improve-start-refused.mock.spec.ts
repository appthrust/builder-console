import type { APIRequestContext, Route } from '@playwright/test'
import { test, expect, seed, withExpectedFailures, type MockControl } from '../support/fixtures'

// APT-1232: Platform refuses a new improvement run while the session's proposal awaits the owner's review or is
// closed (409 `source_change_proposal_run_blocked`). A start the page still offered (its last read of the proposal
// was older than the refusal) is answered on screen in the user's words, once, with no retry; and while the
// proposal awaits review or is closed, the change card explains why instead of offering 「この内容で直す」. Only the
// proposal read is rewritten in the browser (an older phase, as an earlier read showed it); the mock answers the start.
const project = `/api/v1/projects/${seed.projectId}`
const PENDING = { title: '提案の確認を待っています', reason: '所有者が提案を確認しているあいだは、作業を進められません。やり直しを求められたら、そこから続けられます。' }
const CLOSED = { title: 'この提案は締め切られています', reason: '反映・見送り・取り下げ・期限切れのどれかで終わっていて、この提案では続けられません。続けて直すときは、アプリの画面の「AIで直す」から始めてください。' }

/**
 * 山田 (an owner of 見積作成, so also its reviewer) improves it until the proposal awaits review, asks for changes,
 * talks a new change through (the conversation shows it with 「この内容で直す」), and sends the proposal back for review.
 */
async function changeAwaitingReview(request: APIRequestContext, mock: MockControl): Promise<{ draftId: string; proposalPath: string }> {
  const created = await (await request.post(`${project}/application-drafts`, { data: { kind: 'improvement', applicationStackId: seed.apps.mitsumori.slug, title: seed.apps.mitsumori.name, intent: '一覧に絞り込みを足したい' } })).json()
  const draftPath = `${project}/application-drafts/${created.id as string}`
  const talk = async (messages: string[]) => {
    for (const message of messages) {
      expect((await request.post(`${draftPath}/conversation-turns`, { data: { message } })).ok()).toBe(true)
      await mock.advance()
    }
  }
  await talk(['一覧に絞り込みを足したい', '状態で絞り込みたい'])
  expect((await request.post(`${draftPath}/implementation-runs`, { data: {} })).ok()).toBe(true)
  for (let i = 0; i < 12; i++) await mock.advance()
  const proposalPath = `${project}/source-change-proposals/${(await (await request.get(draftPath)).json()).proposalId as string}`
  expect((await (await request.get(proposalPath)).json()).phase).toBe('Proposed')
  expect((await request.post(`${proposalPath}/decisions`, { data: { decision: 'RequestChanges', comment: '今月の分も表示してください' } })).ok()).toBe(true)
  await talk(['CSV で書き出したい', '今月の分だけ'])
  expect((await request.post(`${proposalPath}/submit`)).ok()).toBe(true)
  expect((await (await request.get(proposalPath)).json()).phase).toBe('Proposed')
  return { draftId: created.id as string, proposalPath }
}

test.describe('improvement start refused @improve', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('a refused start is said once in the user\'s words with no retry; a waiting or closed proposal explains instead of offering 「この内容で直す」 @mock @story', async ({ page, request, mock }, testInfo) => {
    test.setTimeout(90_000)
    const { draftId, proposalPath } = await changeAwaitingReview(request, mock)
    // The page's last read of the proposal still shows it sent back for changes.
    let stale = true
    await page.route(`**${proposalPath}`, async (route: Route) => {
      if (route.request().method() !== 'GET' || !stale) return route.continue()
      const response = await route.fetch()
      return route.fulfill({ response, json: { ...(await response.json()), phase: 'ChangesRequested' } })
    })
    const starts: number[] = []
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === `${project}/application-drafts/${draftId}/implementation-runs`) starts.push(response.status())
    })

    await page.goto(`/-/improve/${draftId}`)
    const card = page.getByTestId('improve-proposal')
    const start = card.getByRole('button', { name: 'この内容で直す', exact: true })
    await expect(start).toBeEnabled()

    await withExpectedFailures([{ method: 'POST', path: `${project}/application-drafts/{draftId}/implementation-runs`, status: 409, count: 1, reason: 'Platform refuses a new run while the proposal awaits review' }], async () => {
      await start.click()
      const refusal = card.getByRole('alert')
      await expect(refusal).toContainText(PENDING.title)
      await expect(refusal).toContainText(PENDING.reason)
    })
    await expect(card.getByRole('button', { name: 'もう一度試す', exact: true })).toHaveCount(0)
    await expect(start).toBeDisabled()
    await expect(page.getByText('source change proposal')).toHaveCount(0)
    expect(starts).toEqual([409])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('start-refused.png'), fullPage: true })

    // The next read shows the proposal awaiting review: the card explains, and 「この内容で直す」 is not offered.
    stale = false
    await expect(card.getByRole('status').filter({ hasText: PENDING.title })).toContainText(PENDING.reason, { timeout: 15_000 })
    await expect(card.getByRole('button')).toHaveCount(0)
    await expect(card.getByRole('alert')).toHaveCount(0)

    // The owner declines: the card says the proposal is closed and where to start again; nothing is sent.
    expect((await request.post(`${proposalPath}/decisions`, { data: { decision: 'Reject' } })).ok()).toBe(true)
    await expect(card.getByRole('status').filter({ hasText: CLOSED.title })).toContainText(CLOSED.reason, { timeout: 15_000 })
    await expect(card.getByRole('button')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('proposal-closed.png'), fullPage: true })
    expect(starts).toEqual([409])
  })
})
