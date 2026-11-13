import type { APIRequestContext, Page, Route } from '@playwright/test'
import { textJa } from '../../src/features/excel2app/copy'
import { toDraftWorkbook } from '../../src/features/excel2app/model'
import { previewTextJa } from '../../src/features/excel2app/preview-copy'
import { SAMPLE_SETS } from '../../src/features/excel2app/samples'
import { textJa as buildTextJa } from '../../src/model/build/copy'
import { expect, seed, test, type MockControl } from '../support/fixtures'

// The Excel → app page against Platform answers it cannot read (console
// wire-boundary design §6, APT-832 W4): a malformed draft or workbook-list
// re-read keeps the last good content and the unsent chat text under one fixed
// notice that leaves on the next good read; a design with a card of a kind this
// console does not know (or an unreadable dashboard) shows the rest with a fixed
// note in place and keeps the step to implementation closed; a workbook add
// answered 201 unreadably offers only 「最新の状態を確認する」.
// Only the answer under test is rewritten, in the browser; the mock stays well-formed.
const drafts = `/api/v1/projects/${seed.projectId}/application-drafts`
const SAMPLE = SAMPLE_SETS.find((sample) => sample.id === 'defects')!
const REFRESH_FAILED = /^更新できませんでした。/

type Json = Record<string, unknown>

/** A draft holding the defect-ledger sample, analysed by the AI and given its default design. */
async function designedDraft(request: APIRequestContext, mock: MockControl) {
  await mock.platform('codex', { available: true })
  await mock.platform('plan-generation', { autoAdvance: false })
  const id: string = (await (await request.post(drafts, { data: { title: '不具合管理台帳', intent: textJa.pick.draftIntent(SAMPLE.title) } })).json()).resource.id
  const path = `${drafts}/${id}`
  expect((await request.post(`${path}/workbooks`, { data: toDraftWorkbook(SAMPLE.workbooks[0]!), headers: { 'Idempotency-Key': 'malformed-story' } })).status()).toBe(201)
  for (const kind of ['excel-analysis', 'ui-design'] as const) {
    expect((await request.post(`${path}/conversation-turns`, { data: { kind, message: kind === 'ui-design' ? '__init__' : '' } })).status()).toBe(202)
    await mock.advance()
  }
  const read = await (await request.get(path)).json()
  expect(read.uiDesign.dashboard.cards.length).toBeGreaterThan(1)
  return { id, path }
}

/** Serves GETs of `path` through `rewrite` (`undefined` keeps the answer; route.fetch keeps the mock answering). */
async function rewriteGets(page: Page, path: string, rewrite: (body: Json) => Json | undefined) {
  await page.route(`**${path}`, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = rewrite(await response.json())
    if (!body) return route.fulfill({ response })
    return route.fulfill({ response, json: body })
  })
}

/** A good read, then one malformed answer when `corrupt` is set, then good reads again. */
function oneMalformed(malform: (body: Json) => Json) {
  const state = { corrupt: false, corrupted: 0, good: 0 }
  const rewrite = (body: Json) => {
    if (!state.corrupt) {
      state.good++
      return undefined
    }
    state.corrupt = false
    state.corrupted++
    return malform(body)
  }
  return { state, rewrite }
}

test.describe('Excel → app with an unreadable Platform answer @excel2app @app-create-excel2app-malformed-response', () => {
  // The page keeps polling through the rewriting routes; a read still inside
  // `route.fetch` when the test body returns would fail the test as "Test ended".
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('one malformed draft read while the AI redesigns keeps the preview and the unsent instruction, then clears on the next good read @mock @story', async ({ page, request, mock }, testInfo) => {
    const draft = await designedDraft(request, mock)
    const { state, rewrite } = oneMalformed((body) => ({ ...body, conversationTurns: 'the turns of this draft' }))
    await rewriteGets(page, draft.path, rewrite)
    await page.goto(`/-/excel2app?draft=${draft.id}`)
    const preview = page.getByTestId('excel2app-ui-preview')
    await expect(preview).toBeVisible({ timeout: 15_000 })
    // An instruction the AI is working on (nothing advances it): the draft is re-read every 3 s.
    await page.getByTestId('excel2app-chat-input').fill('一覧をカード表示に')
    await page.getByTestId('excel2app-chat-send').click()
    await expect(page.getByTestId('excel2app-chat-thinking')).toBeVisible()
    const unsent = '期限切れを赤くしてほしい'
    const input = page.getByTestId('excel2app-chat-input')
    await input.fill(unsent)
    const shown = await preview.textContent()
    const notice = page.getByText(REFRESH_FAILED)
    await expect(notice).toHaveCount(0)

    const before = state.good
    state.corrupt = true
    await expect.poll(() => state.corrupted, { timeout: 10_000 }).toBe(1)
    await expect(notice).toHaveCount(1)
    await expect(notice).toBeVisible()
    expect(await preview.textContent()).toBe(shown)
    await expect(page.locator('[data-testid="excel2app-chat-message"][data-role="user"]').last()).toContainText('一覧をカード表示に')
    await expect(input).toHaveValue(unsent)
    await expect(input).toBeEnabled()
    await expect(page.getByText('the turns of this draft')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('malformed-draft-read.png'), fullPage: true })

    await expect.poll(() => state.good, { timeout: 10_000 }).toBeGreaterThan(before)
    await expect(notice).toHaveCount(0)
    expect(state.corrupted).toBe(1)
    expect(await preview.textContent()).toBe(shown)
    await expect(input).toHaveValue(unsent)
  })

  test('one malformed workbook-list read keeps the readings shown under one notice, then clears on the next good read @mock @story', async ({ page, request, mock }, testInfo) => {
    const draft = await designedDraft(request, mock)
    const { state, rewrite } = oneMalformed((body) => ({ ...body, data: [{ workbook: 'this workbook' }] }))
    await rewriteGets(page, `${draft.path}/workbooks`, rewrite)
    await page.goto(`/-/excel2app?draft=${draft.id}`)
    await expect(page.getByTestId('excel2app-ui-preview')).toBeVisible({ timeout: 15_000 })
    // Back to the analysis, where the set's readings are re-read every 5 s.
    await page.getByRole('button', { name: textJa.back, exact: true }).click()
    await page.getByRole('button', { name: textJa.back, exact: true }).click()
    await expect(page.getByRole('heading', { name: textJa.analysis.setTitle, exact: true })).toBeVisible()
    const readings = page.getByTestId('excel2app-reading')
    await expect(readings).toHaveCount(1)
    const shown = await readings.first().textContent()
    const notice = page.getByText(REFRESH_FAILED)
    await expect(notice).toHaveCount(0)

    const before = state.good
    state.corrupt = true
    await expect.poll(() => state.corrupted, { timeout: 15_000 }).toBe(1)
    await expect(notice).toHaveCount(1)
    await expect(readings).toHaveCount(1)
    expect(await readings.first().textContent()).toBe(shown)
    await expect(page.getByText('this workbook')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('malformed-workbook-list.png'), fullPage: true })

    await expect.poll(() => state.good, { timeout: 15_000 }).toBeGreaterThan(before)
    await expect(notice).toHaveCount(0)
    expect(await readings.first().textContent()).toBe(shown)
  })

  test('a dashboard card of a kind this console does not know shows the other cards, a fixed note in its place, and keeps implementation closed @mock @story', async ({ page, request, mock }, testInfo) => {
    const draft = await designedDraft(request, mock)
    const writes: string[] = []
    page.on('request', (sent) => {
      if (sent.method() !== 'GET' && new URL(sent.url()).pathname.startsWith('/api/')) writes.push(`${sent.method()} ${new URL(sent.url()).pathname}`)
    })
    let unknownTitle = ''
    await rewriteGets(page, draft.path, (body) => {
      const design = body.uiDesign as { dashboard: { cards: { title: string; kind: string }[] } }
      const [first, ...rest] = design.dashboard.cards
      unknownTitle = first!.title
      return { ...body, uiDesign: { ...design, dashboard: { cards: [{ ...first, kind: 'heatmap' }, ...rest] } } }
    })
    await page.goto(`/-/excel2app?draft=${draft.id}`)
    await expect(page.getByTestId('excel2app-ui-preview')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('excel2app-ui-preview-nav-dashboard').first().click()
    const dashboard = page.getByTestId('excel2app-ui-preview-screen-dashboard')
    const unknown = dashboard.locator('[data-card="unsupported"]')
    await expect(unknown).toHaveCount(1)
    await expect(unknown).toContainText(unknownTitle)
    await expect(unknown.getByTestId('excel2app-ui-preview-unsupported')).toHaveText(previewTextJa.unsupported)
    // The other cards render as usual.
    await expect(dashboard.locator('[data-card]:not([data-card="unsupported"])').first()).toBeVisible()
    const incomplete = page.getByTestId('excel2app-design-incomplete')
    await expect(incomplete).toContainText(textJa.preview.incomplete.title)
    await expect(incomplete).toContainText(textJa.preview.incomplete.body)
    await expect(page.getByTestId('excel2app-to-implement')).toBeDisabled()
    // Undo would send back a design that drops the card; it is not offered either.
    await expect(page.getByTestId('excel2app-chat-undo')).toBeDisabled()
    expect(writes).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('unknown-card-kind.png'), fullPage: true })
  })

  test('an unreadable dashboard shows the fixed error in its place, the other screens stay usable, and implementation stays closed @mock @story', async ({ page, request, mock }, testInfo) => {
    const draft = await designedDraft(request, mock)
    await rewriteGets(page, draft.path, (body) => {
      const design = body.uiDesign as Json
      return { ...body, uiDesign: { ...design, dashboard: { cards: 'the cards of this design' } } }
    })
    await page.goto(`/-/excel2app?draft=${draft.id}`)
    await expect(page.getByTestId('excel2app-ui-preview')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('excel2app-ui-preview-nav-dashboard').first().click()
    const dashboard = page.getByTestId('excel2app-ui-preview-screen-dashboard')
    await expect(dashboard.getByTestId('excel2app-ui-preview-broken')).toHaveCount(1)
    await expect(page.getByText('the cards of this design')).toHaveCount(0)
    await expect(page.getByTestId('excel2app-to-implement')).toBeDisabled()
    await expect(page.getByTestId('excel2app-design-incomplete')).toContainText(textJa.preview.incomplete.title)
    await page.screenshot({ path: testInfo.outputPath('broken-dashboard.png'), fullPage: true })
    await page.getByTestId('excel2app-ui-preview-nav-list').first().click()
    await expect(page.getByTestId('excel2app-ui-preview-screen-list').getByRole('table')).toBeVisible()
  })

  test('a workbook add answered 201 unreadably offers only 「最新の状態を確認する」, which re-reads and never adds again @mock @story', async ({ page, mock }, testInfo) => {
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { autoAdvance: false })
    const adds: { status: number; key: string }[] = []
    const turns: number[] = []
    page.on('response', (response) => {
      const sent = response.request()
      if (sent.method() !== 'POST') return
      const pathname = new URL(response.url()).pathname
      if (/\/workbooks$/.test(pathname)) adds.push({ status: response.status(), key: sent.headers()['idempotency-key'] ?? '' })
      if (/\/conversation-turns$/.test(pathname)) turns.push(response.status())
    })
    await page.route('**/application-drafts/*/workbooks', async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      return route.fulfill({ response, json: { ...body, workbook: { ...body.workbook, id: 'not-a-workbook-id' } } })
    })
    await page.goto('/-/excel2app')
    await page.getByTestId(`excel2app-sample-${SAMPLE.id}`).click()
    const warning = page.getByTestId('excel2app-unconfirmed')
    await expect(warning).toContainText(buildTextJa.failure.unconfirmed.title)
    await expect(warning.getByRole('button')).toHaveText([buildTextJa.failure.confirm])
    await expect(page).toHaveURL(/\/-\/excel2app\?draft=/)
    // No retry for the file, no analysis started, nothing more to pick until the re-read.
    await expect(page.getByRole('button', { name: textJa.pick.retry, exact: true })).toHaveCount(0)
    await expect(page.getByTestId(`excel2app-sample-${SAMPLE.id}`)).toBeDisabled()
    await expect(page.getByRole('button', { name: textJa.pick.choose, exact: true })).toBeDisabled()
    // Closed is not working: the drop zone shows no progress indicator while it waits for the user's re-read.
    await expect(page.getByTestId('excel2app-drop').locator('.animate-spin')).toHaveCount(0)
    await expect(page.locator('[data-testid="excel2app-file"][data-state="failed"]')).toContainText(textJa.pick.unconfirmed)
    expect(adds.map((add) => add.status)).toEqual([201])
    expect(turns).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('unreadable-workbook-add.png'), fullPage: true })

    await page.unroute('**/application-drafts/*/workbooks')
    await warning.getByRole('button', { name: buildTextJa.failure.confirm, exact: true }).click()
    await expect(warning).toHaveCount(0)
    await expect(page.locator('[data-testid="excel2app-file"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="excel2app-file"][data-state="stored"]')).toHaveCount(1)
    expect(adds.map((add) => add.status)).toEqual([201])
    expect(turns).toEqual([])
  })
})
