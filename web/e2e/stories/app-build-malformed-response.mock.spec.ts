import type { Page, Route } from '@playwright/test'
import { test, expect, seed, type MockControl } from '../support/fixtures'
import { textJa } from '../../src/model/build/copy'
import { textJa as uiTextJa } from '../../src/features/build/copy'

// The build screen against a Platform answer it cannot read (console wire-boundary
// design §6): a malformed draft poll keeps the last good session and the user's
// unsent text under one fixed notice (also while 用意する runs and the page sends
// its hidden preparation turn); an unknown draft phase keeps the known content and
// offers no write; a turn answered 2xx unreadably offers only 「最新の状態を確認する」.
// Only the answer under test is rewritten, in the browser; the mock stays well-formed.
const root = `/api/v1/projects/${seed.projectId}`
const REFRESH_FAILED = /^更新できませんでした。/

/**
 * A draft whose opening turn the AI is still answering: the page polls it every 3 s and starts no write of its own
 * (nothing advances the turn). `answered` lets the AI answer it first: then no job runs.
 */
async function openingDraft(request: Page['request'], mock: MockControl, answered: boolean) {
  await mock.platform('codex', { available: true })
  await mock.platform('plan-generation', { autoAdvance: false })
  const draft = (await (await request.post(`${root}/application-drafts`, { data: { intent: '営業が見積書を作って PDF で出せるアプリ。顧客と品目を登録したい。' } })).json()).resource
  const path = `${root}/application-drafts/${draft.id}`
  expect((await request.post(`${path}/conversation-turns`, { data: { message: textJa.questions.firstTurn } })).status()).toBe(202)
  if (answered) await mock.advance()
  const read = await (await request.get(path)).json()
  expect(read.conversationTurns.at(-1).status).toBe(answered ? 'succeeded' : 'pending')
  return { id: draft.id as string, path }
}

/**
 * A draft whose 用意する execution has begun and runs (nothing advances it): the page asks its hidden preparation
 * question on its own, then polls every 3 s while that turn and the execution run.
 */
async function preparingDraft(request: Page['request'], mock: MockControl) {
  await mock.platform('codex', { available: true })
  await mock.platform('plan-generation', { autoAdvance: false })
  const draft = (await (await request.post(`${root}/application-drafts`, { data: { intent: '見積を管理するアプリ', title: '見積を管理' } })).json()).resource
  const path = `${root}/application-drafts/${draft.id}`
  await request.post(`${path}/creation-plan-generations`, { data: {} })
  for (let step = 0; step < 4; step++) await mock.advance()
  const validation = (await (await request.post(`${path}/creation-plan-validations`, { data: {} })).json()).resource
  const begun = (await (await request.post(`${path}/creation-executions`, { data: { clientRequestId: 'malformed-preparing', creationPlanFingerprint: validation.creationPlanFingerprint } })).json()).resource
  expect((await request.post(`${path}/creation-executions/${begun.creationExecutions[0].id}/run`, { data: {} })).ok()).toBe(true)
  const read = await (await request.get(path)).json()
  expect(read.creationExecutions.at(-1).status).toBe('running')
  expect(read.conversationTurns ?? []).toEqual([])
  return { id: draft.id as string, path }
}

/** Statuses of every `POST …/conversation-turns` the page sends. */
function turnPosts(page: Page, path: string) {
  const statuses: number[] = []
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === `${path}/conversation-turns`) statuses.push(response.status())
  })
  return statuses
}

/** Serves the draft GET through `rewrite` (route.fetch keeps the mock answering). */
async function rewriteDraftGets(page: Page, path: string, rewrite: (body: Record<string, unknown>) => Record<string, unknown> | undefined) {
  await page.route(`**${path}`, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = rewrite(await response.json())
    if (!body) return route.fulfill({ response })
    return route.fulfill({ response, json: body })
  })
}

test.describe('build session with an unreadable Platform answer @app-build-malformed-response', () => {
  // The page keeps polling the draft through the rewriting route; a poll still inside
  // `route.fetch` when the test body returns would fail the test as "Test ended".
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('one malformed draft poll keeps the last good session and the unsent text, then clears on the next good poll @mock @story', async ({ page, mock }, testInfo) => {
    const draft = await openingDraft(page.request, mock, false)
    let corrupt = false
    let corrupted = 0
    let goodReads = 0
    await rewriteDraftGets(page, draft.path, (body) => {
      if (!corrupt) {
        goodReads++
        return undefined
      }
      corrupt = false
      corrupted++
      return { ...body, conversationTurns: 'the turns of this draft' }
    })
    await page.goto(`/-/build/${draft.id}`)
    const session = page.getByTestId('build-session')
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    const spec = page.getByRole('region', { name: '仕様', exact: true })
    await expect(conversation).toContainText('AI の準備をしています')
    const stage = await session.getAttribute('data-stage')
    const specText = await spec.textContent()
    const composer = page.getByLabel('AI に伝えること', { exact: true })
    const unsent = 'PDF には会社ロゴも入れたいです'
    await composer.fill(unsent)
    const notice = page.getByText(REFRESH_FAILED)
    await expect(notice).toHaveCount(0)

    // The next poll (every 3 s while the turn runs) answers 200 with the draft's turns as a string.
    const before = goodReads
    corrupt = true
    await expect.poll(() => corrupted, { timeout: 10_000 }).toBe(1)
    await expect(notice).toHaveCount(1)
    await expect(notice).toBeVisible()
    await expect(session).toHaveAttribute('data-stage', stage!)
    await expect(conversation).toContainText('営業が見積書を作って PDF で出せるアプリ。')
    await expect(conversation).toContainText('AI の準備をしています')
    expect(await spec.textContent()).toBe(specText)
    await expect(composer).toHaveValue(unsent)
    await expect(composer).toBeEnabled()
    await expect(page.getByRole('button', { name: '送信', exact: true })).toBeEnabled()
    await expect(page.getByText('the turns of this draft')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('malformed-tick-notice.png'), fullPage: true })

    // The following poll reads a good draft again: the notice leaves, the text stays.
    await expect.poll(() => goodReads, { timeout: 10_000 }).toBeGreaterThan(before)
    await expect(notice).toHaveCount(0)
    expect(corrupted).toBe(1)
    await expect(conversation).toContainText('AI の準備をしています')
    expect(await spec.textContent()).toBe(specText)
    await expect(composer).toHaveValue(unsent)
    await page.screenshot({ path: testInfo.outputPath('malformed-tick-recovered.png'), fullPage: true })
  })

  test('while 用意する runs, one malformed draft poll keeps the session and the hidden preparation turn is sent once @mock @story', async ({ page, mock }, testInfo) => {
    const draft = await preparingDraft(page.request, mock)
    const turns = turnPosts(page, draft.path)
    let corrupt = false
    let corrupted = 0
    let goodReads = 0
    await rewriteDraftGets(page, draft.path, (body) => {
      if (!corrupt) {
        goodReads++
        return undefined
      }
      corrupt = false
      corrupted++
      return { ...body, creationExecutions: 'the executions of this draft' }
    })
    await page.goto(`/-/build/${draft.id}`)
    const session = page.getByTestId('build-session')
    // The page asks its hidden preparation question on its own, exactly once, while polls keep running.
    await expect.poll(() => turns.length, { timeout: 10_000 }).toBe(1)
    const stage = await session.getAttribute('data-stage')
    const composer = page.getByLabel('AI に伝えること', { exact: true })
    const unsent = 'PDF には会社ロゴも入れたいです'
    await composer.fill(unsent)
    const notice = page.getByText(REFRESH_FAILED)

    const before = goodReads
    corrupt = true
    await expect.poll(() => corrupted, { timeout: 10_000 }).toBe(1)
    await expect(notice).toHaveCount(1)
    await expect(session).toHaveAttribute('data-stage', stage!)
    await expect(composer).toHaveValue(unsent)
    await expect(page.getByText('the executions of this draft')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('malformed-tick-preparing.png'), fullPage: true })

    await expect.poll(() => goodReads, { timeout: 10_000 }).toBeGreaterThan(before)
    await expect(notice).toHaveCount(0)
    await expect(composer).toHaveValue(unsent)
    // No poll that started before the turn's answer put back a draft without it: the turn was never sent again.
    expect(turns).toEqual([202])
  })

  test('a turn answered 2xx unreadably offers only 「最新の状態を確認する」, which re-reads and never resends @mock @story', async ({ page, mock }, testInfo) => {
    const draft = await openingDraft(page.request, mock, true)
    const turns = turnPosts(page, draft.path)
    let reads = 0
    await rewriteDraftGets(page, draft.path, () => { reads++; return undefined })
    await page.route(`**${draft.path}/conversation-turns`, async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      return route.fulfill({ response, json: { ...(await response.json()), resource: { id: 'unreadable-turn' } } })
    })
    await page.goto(`/-/build/${draft.id}`)
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    await expect(conversation).toContainText('見積の PDF には何を載せますか？')
    await page.getByLabel('AI に伝えること', { exact: true }).fill('PDF に会社ロゴも入れたい')
    await page.getByRole('button', { name: '送信', exact: true }).click()
    const warning = page.getByRole('status').filter({ hasText: textJa.failure.unconfirmed.title }).filter({ has: page.getByRole('button') })
    await expect(warning).toHaveCount(1)
    await expect(warning.getByRole('button', { name: textJa.failure.confirm, exact: true })).toBeVisible()
    await expect(warning.getByRole('button', { name: 'もう一度試す', exact: true })).toHaveCount(0)
    expect(turns).toEqual([202])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('unreadable-write-confirm.png'), fullPage: true })

    const before = reads
    await warning.getByRole('button', { name: textJa.failure.confirm, exact: true }).click()
    await expect.poll(() => reads).toBeGreaterThan(before)
    await expect(warning).toHaveCount(0)
    await expect(conversation).toContainText('PDF に会社ロゴも入れたい')
    expect(turns).toEqual([202])
  })

  test('an unknown draft phase keeps the conversation and the spec, pauses the stage action and writes nothing @mock @story', async ({ page, mock }, testInfo) => {
    const { id, path } = await openingDraft(page.request, mock, true)
    let reads = 0
    await rewriteDraftGets(page, path, (body) => {
      reads++
      return { ...body, phase: 'Archived' }
    })
    const writes: string[] = []
    page.on('request', (sent) => {
      if (sent.method() !== 'GET' && new URL(sent.url()).pathname.startsWith('/api/')) writes.push(`${sent.method()} ${new URL(sent.url()).pathname}`)
    })
    await page.goto(`/-/build/${id}`)
    const unsupported = page.getByText(textJa.unsupported.title, { exact: true })
    await expect(unsupported).toHaveCount(1)
    // The notice and the composer give the same fixed explanation; no write is offered, reading stays.
    await expect(page.getByText(textJa.unsupported.detail, { exact: true })).toHaveCount(2)
    await expect(page.getByRole('log', { name: 'AI との会話' })).toContainText('見積の PDF には何を載せますか？')
    await expect(page.getByRole('region', { name: '仕様', exact: true })).toBeVisible()
    await expect(page.getByLabel('AI に伝えること', { exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '送信', exact: true })).toBeDisabled()
    const chips = page.getByRole('group', { name: uiTextJa.composer.suggestions }).getByRole('button')
    await expect(chips.first()).toBeVisible()
    for (const chip of await chips.all()) await expect(chip).toBeDisabled()
    await expect(page.locator('header [aria-current="step"]')).toHaveCount(0)
    // Nothing starts on its own from a state this console does not know (no kickoff, no plan, no preparation),
    // also after the next read (an unknown phase is re-read at the normal 5 s interval).
    const loaded = reads
    await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThan(loaded)
    await expect(unsupported).toHaveCount(1)
    expect(writes).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('unknown-draft-phase.png'), fullPage: true })
  })
})
