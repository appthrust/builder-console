import type { APIRequestContext, Route } from '@playwright/test'
import { test, expect, seed, type MockControl } from '../support/fixtures'

// An owner reviews an improvement proposal (console wire-boundary design §5,
// §6, X5): the proposal opens with its tasks, proposer and reviewers; a
// revision kind this console does not know keeps the known parts but disables
// every decision with the fixed explanation; an approval answered 2xx
// unreadably offers only 「最新の状態を確認する」, is sent exactly once, and the
// read-back shows it accepted. Only the answer under test is rewritten, in the
// browser; the mock stays well-formed.
const project = `/api/v1/projects/${seed.projectId}`
const UNSUPPORTED = 'この提案には、この画面ではまだ扱えない内容があります。ここでは反映・やり直し・見送りはできません。'

/** 佐藤 improves 見積作成 until the proposal awaits review; then 山田 (owner, the default caller) reviews it. */
async function propose(request: APIRequestContext, mock: MockControl): Promise<{ id: string; title: string }> {
  await mock.console('caller', { personId: 'p-sato', role: 'Editor' })
  const created = await (await request.post(`${project}/application-drafts`, { data: { kind: 'improvement', applicationStackId: seed.apps.mitsumori.slug, title: seed.apps.mitsumori.name, intent: '一覧に絞り込みを足したい' } })).json()
  const draftPath = `${project}/application-drafts/${created.id as string}`
  for (const message of ['一覧に絞り込みを足したい', '状態で絞り込みたい']) {
    expect((await request.post(`${draftPath}/conversation-turns`, { data: { message } })).ok()).toBe(true)
    await mock.advance()
  }
  expect((await request.post(`${draftPath}/implementation-runs`, { data: {} })).ok()).toBe(true)
  for (let i = 0; i < 12; i++) await mock.advance()
  const id = (await (await request.get(draftPath)).json()).proposalId as string
  const proposal = await (await request.get(`${project}/source-change-proposals/${id}`)).json()
  expect(proposal.phase).toBe('Proposed')
  await mock.console('caller', { personId: seed.me.id, role: 'Admin' })
  return { id, title: proposal.title as string }
}

test.describe('proposal review @proposal-review', () => {
  // The page keeps polling through the rewriting routes; a poll still inside
  // `route.fetch` when the test body returns would fail the test as "Test ended".
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('an owner opens the proposal; a revision kind this console does not know disables every decision with the fixed explanation @mock @story', async ({ page, request, mock }, testInfo) => {
    const proposal = await propose(request, mock)
    const detailPath = `${project}/source-change-proposals/${proposal.id}`
    let unknownRevision = false
    const decisions: number[] = []
    await page.route(`**${detailPath}`, async (route: Route) => {
      if (route.request().method() !== 'GET' || !unknownRevision) return route.continue()
      const response = await route.fetch()
      return route.fulfill({ response, json: { ...(await response.json()), base: { kind: 'Snapshot', snapshot: { id: 'the snapshot of this proposal' } } } })
    })
    await page.route(`**${detailPath}/decisions`, (route: Route) => {
      decisions.push(1)
      return route.continue()
    })

    await page.goto(`/-/proposals/${proposal.id}`)
    const detail = page.getByTestId('proposal-detail')
    await expect(page.getByRole('heading', { level: 1, name: proposal.title, exact: true })).toBeVisible()
    await expect(detail.getByText('佐藤 花子 さんの提案')).toBeVisible()
    await expect(detail.getByText('確認する人: 山田 太郎', { exact: true })).toBeVisible()
    await expect(detail.getByText('確認待ち', { exact: true })).toBeVisible()
    const actions = page.getByTestId('proposal-actions')
    for (const name of ['反映する', 'やり直してもらう', '見送る']) await expect(actions.getByRole('button', { name, exact: true })).toBeEnabled()
    await expect(page.getByText(UNSUPPORTED)).toHaveCount(0)

    unknownRevision = true
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: proposal.title, exact: true })).toBeVisible()
    await expect(detail.getByText('確認する人: 山田 太郎', { exact: true })).toBeVisible()
    await expect(detail.getByRole('heading', { name: '直すところ', exact: true })).toBeVisible()
    await expect(actions.getByText(UNSUPPORTED)).toBeVisible()
    for (const name of ['反映する', 'やり直してもらう', '見送る']) await expect(actions.getByRole('button', { name, exact: true })).toBeDisabled()
    await expect(page.getByText('the snapshot of this proposal')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('unknown-revision-disabled.png'), fullPage: true })
    expect(decisions).toEqual([])
  })

  test('an approval answered 2xx unreadably offers only 「最新の状態を確認する」, is sent once, and the read-back shows it accepted @mock @story', async ({ page, request, mock }, testInfo) => {
    const proposal = await propose(request, mock)
    const detailPath = `${project}/source-change-proposals/${proposal.id}`
    const decisions: number[] = []
    let reads = 0
    await page.route(`**${detailPath}`, (route: Route) => {
      if (route.request().method() === 'GET') reads++
      return route.continue()
    })
    await page.route(`**${detailPath}/decisions`, async (route: Route) => {
      const response = await route.fetch()
      decisions.push(response.status())
      return route.fulfill({ response, json: { ...(await response.json()), resource: { phase: 'the phase of this proposal' } } })
    })

    await page.goto(`/-/proposals/${proposal.id}`)
    await expect(page.getByRole('heading', { level: 1, name: proposal.title, exact: true })).toBeVisible()
    await expect(page.getByTestId('proposal-detail').getByText('確認する人: 山田 太郎', { exact: true })).toBeVisible()
    const actions = page.getByTestId('proposal-actions')
    const accept = actions.getByRole('button', { name: '反映する', exact: true })
    await expect(accept).toBeEnabled()
    await accept.click()

    const warning = actions.getByRole('status').filter({ hasText: '処理結果を確認できませんでした' })
    await expect(warning).toHaveCount(1)
    await expect(warning.getByRole('button')).toHaveCount(1)
    await expect(warning.getByRole('button', { name: '最新の状態を確認する', exact: true })).toBeVisible()
    await expect(actions.getByRole('button', { name: 'もう一度試す', exact: true })).toHaveCount(0)
    for (const name of ['反映する', 'やり直してもらう', '見送る']) await expect(actions.getByRole('button', { name, exact: true })).toBeDisabled()
    await expect(page.getByTestId('proposal-detail').getByText('確認待ち', { exact: true })).toBeVisible()
    await expect(page.getByText('the phase of this proposal')).toHaveCount(0)
    expect(decisions).toEqual([200])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('unreadable-approve-confirm.png'), fullPage: true })

    const before = reads
    await warning.getByRole('button', { name: '最新の状態を確認する', exact: true }).click()
    await expect.poll(() => reads).toBeGreaterThan(before)
    // The decision had been recorded: the read-back shows it accepted, and nothing is offered to send again.
    await expect(page.getByTestId('proposal-detail').getByText('確認待ち', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('proposal-actions')).toHaveCount(0)
    await expect(warning).toHaveCount(0)
    expect(decisions).toEqual([200])
  })
})
