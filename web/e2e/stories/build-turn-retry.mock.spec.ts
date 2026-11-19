import type { APIRequestContext } from '@playwright/test'
import { test, expect, seed, captureWrite, type MockControl } from '../support/fixtures'
import { textJa as buildText } from '../../src/model/build/copy'
import { textJa as text } from '../../src/features/build/copy'

// APT-1365: only the last failed conversation turn offers 「もう一度試す」. A failed turn a later turn followed reads
// as one past, information-only line; it never keeps a red card whose retry does nothing.
const root = `/api/v1/projects/${seed.projectId}`
const TIMED_OUT = 'application draft conversation turn timed out'
const MESSAGE = 'test'

/** A draft whose turns settle, in order, as failed (`true`, with TIMED_OUT) or succeeded (`false`). */
async function draftWithTurns(request: APIRequestContext, mock: MockControl, failures: boolean[]): Promise<string> {
  const created = await request.post(`${root}/application-drafts`, { data: { title: '見積作成', intent: '見積を管理する' } })
  expect(created.ok()).toBe(true)
  const draftId: string = (await created.json()).resource.id
  for (const failed of failures) {
    await mock.platform('turn-failure', failed ? { error: TIMED_OUT } : {})
    expect((await request.post(`${root}/application-drafts/${draftId}/conversation-turns`, { data: { message: MESSAGE } })).ok()).toBe(true)
    await mock.advance()
  }
  const turns: { status: string; error?: string }[] = (await (await request.get(`${root}/application-drafts/${draftId}`)).json()).conversationTurns
  expect(turns.map((turn) => turn.status)).toEqual(failures.map((failed) => failed ? 'failed' : 'succeeded'))
  return draftId
}

test.describe('build conversation turn retry @build-turn-retry', () => {
  test('a timed-out turn the user already sent again reads as one past line, without 「もう一度試す」 @mock @story', async ({ page, mock, request }, testInfo) => {
    await mock.platform('codex', { available: true })
    const draftId = await draftWithTurns(request, mock, [true, false])
    await page.goto(`/-/build/${draftId}`)
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    await expect(conversation).toContainText('ご希望を仕様に反映しました。')
    // Both requests stay as the user's own words; the first one's failure is collapsed between them.
    // A user bubble is an article labelled 「あなた:」 followed by the request text.
    await expect(conversation.getByRole('article').filter({ hasText: new RegExp(`^あなた:\\s*${MESSAGE}$`) })).toHaveCount(2)
    const collapsed = conversation.getByRole('status').filter({ hasText: buildText.failure.superseded })
    await expect(collapsed).toHaveCount(1)
    await expect(collapsed).toHaveText(buildText.failure.superseded)
    await expect(conversation.getByRole('alert')).toHaveCount(0)
    await expect(conversation).not.toContainText(buildText.failure.timeout.title)
    await expect(conversation).not.toContainText(buildText.failure.timeout.reason)
    await expect(page.getByRole('button', { name: text.conversation.retry, exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('superseded-failure.png'), fullPage: true })
  })

  test('the last timed-out turn keeps 「もう一度試す」, which sends the same request again and continues @mock @story', async ({ page, mock, request }, testInfo) => {
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { autoAdvance: true })
    const draftId = await draftWithTurns(request, mock, [true])
    await page.goto(`/-/build/${draftId}`)
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    const card = conversation.getByRole('alert').filter({ hasText: buildText.failure.timeout.title })
    await expect(card).toHaveCount(1)
    await expect(card).toContainText(buildText.failure.timeout.reason)
    const retry = card.getByRole('button', { name: text.conversation.retry, exact: true })
    await expect(retry).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('last-failure.png'), fullPage: true })
    const resent = await captureWrite(page, 'POST', `${root}/application-drafts/${draftId}/conversation-turns`, () => retry.click())
    expect(resent.body).toEqual({ message: MESSAGE })
    // The mock answers the new turn; the stopped one is now behind it and reads as the past line.
    await expect(conversation).toContainText('ご希望を仕様に反映しました。', { timeout: 20_000 })
    await expect(conversation.getByRole('status').filter({ hasText: buildText.failure.superseded })).toHaveCount(1)
    await expect(conversation.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('button', { name: text.conversation.retry, exact: true })).toHaveCount(0)
    const turns: { status: string }[] = (await (await request.get(`${root}/application-drafts/${draftId}`)).json()).conversationTurns
    expect(turns.map((turn) => turn.status)).toEqual(['failed', 'succeeded'])
  })
})
