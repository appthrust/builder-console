import type { APIRequestContext, BrowserContext, Frame, Page, TestInfo } from '@playwright/test'
import { test, expect, seed, withExpectedFailures, type MockControl } from '../support/fixtures'
import { CONSOLE_ORIGIN, consoleUrl, previewHosts, startConsoleFront } from './preview-hosts'

// The development preview on the workspace's own origin (APT-798, design §4/§7, N14/N20):
// the Console (https://console.commerce.appthrust.test) embeds and opens the
// preview (https://pv-<hex>.commerce.appthrust.test), two real hosts in the
// browser. The mock issues grants and plays the preview origin's exchange,
// ready check and app (src/dev/mock-workspace-http.ts).
test.use(previewHosts)

let stopFront: (() => Promise<void>) | undefined
test.beforeAll(async () => { stopFront = await startConsoleFront() })
test.afterAll(async () => { await stopFront?.() })

const SESSIONS = '/api/v1/projects/{projectId}/dev-workspaces/{workspaceId}/http-sessions'
const READY = /^\/__appthrust\/session\/[0-9a-f-]{36}\/ready$/

/** A created app whose first implementation task is running (the preview card shows from the first task). */
async function implementing(request: APIRequestContext, mock: MockControl): Promise<{ draftId: string; workspaceId: string }> {
  await mock.platform('codex', { available: true })
  await mock.platform('plan-generation', { autoAdvance: false })
  const root = `/api/v1/projects/${seed.projectId}`
  const draft = (await (await request.post(`${root}/application-drafts`, { data: { intent: '見積を管理するアプリ', title: '見積を管理' } })).json()).resource
  const path = `${root}/application-drafts/${draft.id}`
  await request.post(`${path}/creation-plan-generations`, { data: {} })
  for (let step = 0; step < 4; step++) await mock.advance()
  const validation = (await (await request.post(`${path}/creation-plan-validations`, { data: {} })).json()).resource
  const begun = (await (await request.post(`${path}/creation-executions`, { data: { clientRequestId: 'preview-origin', creationPlanFingerprint: validation.creationPlanFingerprint } })).json()).resource
  await request.post(`${path}/creation-executions/${begun.creationExecutions[0].id}/run`, { data: {} })
  for (let step = 0; step < 4; step++) await mock.advance()
  expect((await (await request.get(path)).json()).phase).toBe('created')
  await request.post(`${path}/implementation-runs`, { data: {} })
  for (let step = 0; step < 12; step++) {
    const run = (await (await request.get(path)).json()).implementationRuns.at(-1)
    if (run.tasks.some((task: { status: string }) => task.status === 'running')) return { draftId: draft.id, workspaceId: run.devWorkspaceId }
    await mock.advance()
  }
  throw new Error('the implementation run did not start a task')
}

/** Every grant the Platform answered, every URL any frame navigated to and every console line of the context. */
function watch(context: BrowserContext) {
  const grants: string[] = []
  const urls: string[] = []
  const logs: string[] = []
  const follow = (page: Page) => {
    page.on('framenavigated', (frame) => urls.push(frame.url()))
    page.on('console', (message) => logs.push(message.text()))
  }
  context.pages().forEach(follow)
  context.on('page', follow)
  context.on('response', async (response) => {
    if (response.request().method() !== 'POST' || !/\/http-sessions$/.test(new URL(response.url()).pathname) || !response.ok()) return
    const body = await response.json().catch(() => undefined) as { resource?: { grant?: string } } | undefined
    if (body?.resource?.grant) grants.push(body.resource.grant)
  })
  return { grants, urls, logs }
}

async function storageOf(target: Page | Frame): Promise<string> {
  return target.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie, url: location.href, history: history.length }))
}

const previewFrame = (page: Page) => page.frames().find((frame) => frame.url().startsWith('https://pv-'))

async function shoot(page: Page, testInfo: TestInfo, name: string) {
  for (const [label, size] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size)
    // On a phone the build page shows the conversation first; the preview card is in the 「作っているもの」 tab.
    const artifactTab = page.getByRole('tab', { name: /^作っているもの/ })
    if (label === 'mobile' && await artifactTab.isVisible()) await artifactTab.click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${name}-${label}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}

test.describe('preview on the workspace origin @workspace-preview-origin', () => {
  test('shows the preview on its own origin in the build page and in a Console tab; the Console cannot read it and the grant stays in memory @mock @story', async ({ page, mock, request }, testInfo) => {
    test.setTimeout(120_000)
    const { draftId, workspaceId } = await implementing(request, mock)
    const seen = watch(page.context())
    await page.goto(consoleUrl(`/-/build/${draftId}`))
    const app = page.frameLocator('iframe[title="アプリのプレビュー"]')
    await expect(app.getByRole('heading', { name: /^プレビュー:/ })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: '見てみる', exact: true })).toBeEnabled()

    // The frame is the workspace's own origin, with the design's attributes.
    const frame = page.locator('iframe[title="アプリのプレビュー"]')
    const src = new URL((await frame.getAttribute('src'))!)
    expect(src.protocol).toBe('https:')
    expect(src.hostname).toMatch(/^pv-[0-9a-f]{32}\.commerce\.appthrust\.test$/)
    expect(src.origin).not.toBe(CONSOLE_ORIGIN)
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms')
    expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(await frame.getAttribute('allow')).toBeNull()
    // The app's own development socket (HMR) works inside the sandbox.
    await expect(app.locator('#hmr')).toHaveAttribute('data-state', 'open')

    // The Console cannot read the preview's document or storage, nor the preview the Console's, even after
    // both relax document.domain (Origin-Agent-Cluster keeps the agent cluster origin-keyed).
    const preview = previewFrame(page)!
    await preview.evaluate(() => { try { document.domain = 'commerce.appthrust.test' } catch { /* refused */ } })
    await page.evaluate(() => { try { document.domain = 'commerce.appthrust.test' } catch { /* refused */ } })
    expect(await page.evaluate(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="アプリのプレビュー"]')!
      const attempt = (read: () => unknown) => { try { return read() === null ? 'null' : 'read' } catch (error) { return (error as Error).name } }
      return { document: attempt(() => element.contentDocument), body: attempt(() => element.contentWindow!.document.body), storage: attempt(() => element.contentWindow!.localStorage) }
    })).toEqual({ document: 'null', body: 'SecurityError', storage: 'SecurityError' })
    expect(await preview.evaluate(() => {
      const attempt = (read: () => unknown) => { try { read(); return 'read' } catch (error) { return (error as Error).name } }
      return { document: attempt(() => window.parent.document.title), storage: attempt(() => window.parent.localStorage) }
    })).toEqual({ document: 'SecurityError', storage: 'SecurityError' })
    expect(await preview.evaluate(() => localStorage.getItem('preview-note'))).toBe('written by the preview origin')
    expect(await page.evaluate(() => localStorage.getItem('preview-note'))).toBeNull()
    // The session Cookie is HttpOnly on the preview host: the app's scripts cannot read it either.
    expect(await preview.evaluate(() => document.cookie)).not.toContain('apth-workspace-session')
    await shoot(page, testInfo, 'build-ready')

    // The new tab is the Console's own viewer page, opened without an opener; it holds its own session.
    const [tab] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('link', { name: '新しいタブで開く', exact: true }).first().click()])
    await expect(tab).toHaveURL(consoleUrl(`/-/workspaces/${workspaceId}/preview`))
    expect(await tab.evaluate(() => window.opener)).toBeNull()
    await expect(tab.getByRole('heading', { name: '見積を管理 のプレビュー', exact: true })).toBeVisible()
    await expect(tab.frameLocator('iframe').getByRole('heading', { name: /^プレビュー:/ })).toBeVisible({ timeout: 15_000 })
    // Both tabs show the preview at once.
    await expect(app.getByRole('heading', { name: /^プレビュー:/ })).toBeVisible()
    await shoot(tab, testInfo, 'viewer-ready')

    // The grant was answered to the page, and is in no URL, history entry, storage, Cookie or log line of either origin.
    expect(seen.grants.length).toBeGreaterThanOrEqual(2)
    const traces = [
      ...seen.urls, ...seen.logs, page.url(), tab.url(),
      await storageOf(page), await storageOf(tab), await storageOf(preview), await storageOf(previewFrame(tab)!),
      JSON.stringify(await page.context().cookies(CONSOLE_ORIGIN)),
    ]
    for (const grant of seen.grants) for (const trace of traces) expect(trace).not.toContain(grant)

    // R3/N20 residual: a page on the Console's host name that is not the Console can still show the preview while
    // the session Cookie lasts, and can lay a decoy over it (clickjacking) — but it cannot read the preview.
    const fake = await page.context().newPage()
    await fake.goto(consoleUrl(`/__fake-console?src=${encodeURIComponent(src.origin)}`))
    const embedded = fake.frameLocator('iframe')
    await expect(embedded.getByRole('heading', { name: /^プレビュー:/ })).toBeVisible()
    expect(await fake.evaluate(() => document.querySelector('iframe')!.contentDocument)).toBeNull()
    const decoy = (await fake.locator('#decoy').boundingBox())!
    const save = (await embedded.getByRole('button', { name: '保存する' }).boundingBox())!
    // The decoy sits over the app's own button and lets the click through.
    expect(decoy.y).toBeLessThan(save.y + save.height)
    expect(decoy.y + decoy.height).toBeGreaterThan(save.y)
    await fake.mouse.click(save.x + 4, save.y + save.height / 2)
    await expect(embedded.getByText('保存しました')).toBeVisible()
    await fake.screenshot({ path: testInfo.outputPath('fake-console-residual.png') })
    await fake.close()
    await tab.close()
  })

  test('renews every 30 seconds in the foreground only, and stops the preview when renewal fails or permission is lost @mock @story', async ({ page, mock, request }, testInfo) => {
    test.setTimeout(120_000)
    const { draftId } = await implementing(request, mock)
    await page.clock.install()
    const sessions: string[] = []
    page.on('request', (sent) => { if (sent.method() === 'POST' && /\/http-sessions$/.test(new URL(sent.url()).pathname)) sessions.push(sent.url()) })
    await page.goto(consoleUrl(`/-/build/${draftId}`))
    const app = page.frameLocator('iframe[title="アプリのプレビュー"]')
    await expect(app.getByRole('heading', { name: /^プレビュー:/ })).toBeVisible({ timeout: 20_000 })
    const issued = sessions.length

    // In the foreground a fresh grant comes every 30 seconds, without reloading the frame.
    // The app's script has run (its socket is open) before its button is used, so the click is handled.
    await expect(app.locator('#hmr')).toHaveAttribute('data-state', 'open')
    await app.locator('#save').click()
    await expect(app.getByText('保存しました')).toBeVisible()
    await page.clock.fastForward(31_000)
    await expect.poll(() => sessions.length).toBe(issued + 1)
    await expect(app.getByText('保存しました')).toBeVisible()

    // Hidden, nothing is renewed; back in the foreground after the renewal time, it authorizes again before showing.
    const visibility = (state: 'hidden' | 'visible') => page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
      document.dispatchEvent(new Event('visibilitychange'))
    }, state)
    await visibility('hidden')
    await page.clock.fastForward(95_000)
    expect(sessions.length).toBe(issued + 1)
    await visibility('visible')
    await expect.poll(() => sessions.length).toBe(issued + 2)
    await expect(app.getByRole('heading', { name: /^プレビュー:/ })).toBeVisible()
    await expect(app.getByText('保存しました')).toBeHidden()

    // A failed renewal removes the frame at once; nothing retries until asked, and asking gets a new grant.
    await mock.platform('workspace-http', { sessions: 'unavailable' })
    await withExpectedFailures([{ method: 'POST', path: SESSIONS, status: 503, count: 1, reason: 'the Platform cannot issue a renewal grant' }], async () => {
      await page.clock.fastForward(31_000)
      await expect(page.getByText('プレビューとの接続が切れたため、表示を止めました。もう一度つなぐと再開します。')).toBeVisible()
    })
    await expect(page.locator('iframe[title="アプリのプレビュー"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '見てみる', exact: true })).toBeDisabled()
    await shoot(page, testInfo, 'renew-failed')
    await page.clock.fastForward(120_000)
    expect(sessions.length).toBe(issued + 3)
    await mock.platform('workspace-http', { sessions: 'ok' })
    await page.getByRole('button', { name: 'もう一度つなぐ', exact: true }).click()
    await expect(app.getByRole('heading', { name: /^プレビュー:/ })).toBeVisible()

    // Losing the permission stops the preview and says why; there is nothing to retry.
    await mock.platform('workspace-http', { sessions: 'revoked' })
    await withExpectedFailures([{ method: 'POST', path: SESSIONS, status: 403, count: 1, reason: 'the viewer lost project.compute access' }], async () => {
      await page.clock.fastForward(31_000)
      await expect(page.getByText('このプレビューを見る権限がなくなったため、表示を止めました。')).toBeVisible()
    })
    await expect(page.locator('iframe[title="アプリのプレビュー"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'もう一度つなぐ', exact: true })).toHaveCount(0)
    await shoot(page, testInfo, 'revoked')
  })

  test('a browser that refuses the session Cookie gets the reason, a reconnect and the Console tab @mock @story', async ({ page, mock, request }, testInfo) => {
    const { draftId, workspaceId } = await implementing(request, mock)
    // Stands in for a browser whose settings block the preview's Cookie: the exchange is answered, but the
    // browser never receives (so never stores or sends) the session Cookie; the ready check then finds none.
    await page.route(/^https:\/\/pv-[0-9a-f]{32}\.commerce\.appthrust\.test\/__appthrust\/session\/[0-9a-f-]{36}$/, (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': CONSOLE_ORIGIN, 'Access-Control-Allow-Credentials': 'true', 'Cache-Control': 'no-store', Vary: 'Origin' } })
      : route.continue())
    await withExpectedFailures([{ method: 'GET', path: READY, status: 401, count: 1, reason: 'the browser did not send back the refused session Cookie' }], async () => {
      await page.goto(consoleUrl(`/-/build/${draftId}`))
      await expect(page.getByText('このブラウザが、プレビューに必要な Cookie を受け付けませんでした。', { exact: false })).toBeVisible({ timeout: 20_000 })
    })
    await expect(page.locator('iframe[title="アプリのプレビュー"]')).toHaveCount(0)
    const card = page.getByRole('alert').filter({ hasText: 'Cookie' }).locator('..')
    await expect(card.getByRole('button', { name: 'もう一度つなぐ', exact: true })).toBeVisible()
    await expect(card.getByRole('link', { name: '新しいタブで開く', exact: true })).toHaveAttribute('href', `/-/workspaces/${workspaceId}/preview`)
    await shoot(page, testInfo, 'cookie-refused')
  })

  test('says what is happening when there is no session to ask for, and on a typed refusal @mock @story', async ({ page, mock, request }, testInfo) => {
    test.setTimeout(90_000)
    const { workspaceId } = await implementing(request, mock)
    const viewer = consoleUrl(`/-/workspaces/${workspaceId}/preview`)
    const states = [
      ['pending', 'preparing', '画面の準備をしています'],
      ['sleeping', 'asleep', '作業環境が休止中です。AI が作業を始めると、プレビューも再開します。'],
      ['conflict', 'hostname-conflict', 'プレビュー用のアドレスがほかと重なっているため、表示できません。管理者に連絡してください。'],
      // A workspace with neither a preview endpoint nor the legacy URL.
      ['absent', 'cannot-display-yet', 'この作業環境では、まだプレビューを表示できません。'],
    ] as const
    for (const [endpoint, name, sentence] of states) {
      await mock.platform('workspace-http', { endpoint })
      await page.goto(viewer)
      await expect(page.getByText(sentence, { exact: true })).toBeVisible()
      await expect(page.locator('iframe')).toHaveCount(0)
      await shoot(page, testInfo, name)
    }
    // The Platform guard still observing (not enforcing): the grant is refused as "not published".
    await mock.platform('workspace-http', { endpoint: 'auto', sessions: 'origin-unavailable' })
    await withExpectedFailures([{ method: 'POST', path: SESSIONS, status: 412, count: 1, reason: 'the Platform does not publish preview origins yet' }], async () => {
      await page.goto(viewer)
      await expect(page.getByText('この作業環境では、まだプレビューを表示できません。', { exact: true })).toBeVisible()
    })
    await expect(page.locator('iframe')).toHaveCount(0)
    await shoot(page, testInfo, 'not-published')

    await mock.platform('workspace-http', { endpoint: 'auto', sessions: 'credential-not-allowed' })
    await withExpectedFailures([{ method: 'POST', path: SESSIONS, status: 403, count: 1, reason: 'the signed-in credential may not receive preview grants' }], async () => {
      await page.goto(viewer)
      await expect(page.getByText('いまのサインイン方法では、プレビューを開けません。管理者に連絡してください。', { exact: true })).toBeVisible()
    })
    await expect(page.locator('iframe')).toHaveCount(0)
    await shoot(page, testInfo, 'credential-not-allowed')

    // A runtime that cannot offer the separate-origin preview: a permanent, plain explanation and nothing to retry.
    await mock.platform('workspace-http', { sessions: 'verifier-unavailable' })
    await withExpectedFailures([{ method: 'POST', path: SESSIONS, status: 412, count: 1, reason: 'this workspace runtime has no preview verifier' }], async () => {
      await page.goto(viewer)
      await expect(page.getByText('この種類の作業環境では、プレビューを表示できません。', { exact: true })).toBeVisible()
    })
    await expect(page.locator('iframe')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'もう一度つなぐ', exact: true })).toHaveCount(0)
    await shoot(page, testInfo, 'verifier-unavailable')

    // An endpoint on a sibling app of the Project or on another domain is refused before anything is asked:
    // no grant request, no frame, the plain refusal.
    await mock.platform('workspace-http', { sessions: 'ok' })
    const sessions: string[] = []
    page.on('request', (sent) => { if (/\/http-sessions$/.test(new URL(sent.url()).pathname)) sessions.push(sent.url()) })
    for (const host of ['sibling', 'other-domain'] as const) {
      await mock.platform('workspace-http', { host })
      await page.goto(viewer)
      await expect(page.getByText('プレビューの状態を読み取れなかったため、表示していません。', { exact: true })).toBeVisible()
      await expect(page.locator('iframe')).toHaveCount(0)
      await shoot(page, testInfo, `refused-${host}`)
    }
    expect(sessions).toEqual([])
  })

  test('an unmigrated workspace keeps today\'s same-origin preview until the Platform moves it, and never goes back @mock @story', async ({ page, mock, request }, testInfo) => {
    test.setTimeout(120_000)
    // The Platform has not moved this workspace: no endpoint, no DirectPreviewActivated, the legacy relative previewUrl.
    await mock.platform('workspace-http', { endpoint: 'none' })
    const { draftId, workspaceId } = await implementing(request, mock)
    const sessions: string[] = []
    page.on('request', (sent) => { if (/\/http-sessions$/.test(new URL(sent.url()).pathname)) sessions.push(sent.url()) })
    await page.goto(consoleUrl(`/-/build/${draftId}`))
    const frame = page.locator('iframe[title="アプリのプレビュー"]')
    const app = page.frameLocator('iframe[title="アプリのプレビュー"]')
    const legacy = `/api/v1/projects/${seed.projectId}/dev-workspaces/${workspaceId}/proxy/preview/`
    // Exactly as before APT-798: the proxied URL in the frame with its old attributes, and in the new tab.
    await expect(app.getByRole('heading', { name: /^プレビュー:/ })).toBeVisible({ timeout: 20_000 })
    expect(await frame.getAttribute('src')).toBe(legacy)
    expect(await frame.getAttribute('sandbox')).toBe('allow-same-origin allow-scripts allow-forms')
    await expect(page.getByRole('button', { name: '見てみる', exact: true })).toBeEnabled()
    await expect(page.getByRole('link', { name: '新しいタブで開く', exact: true })).toHaveAttribute('href', legacy)
    expect(sessions).toEqual([])
    await shoot(page, testInfo, 'legacy')

    // The Platform moves the workspace: the next read shows it on its own origin.
    await mock.platform('workspace-http', { endpoint: 'auto' })
    await expect.poll(async () => frame.getAttribute('src'), { timeout: 20_000 }).toMatch(/^https:\/\/pv-[0-9a-f]{32}\.commerce\.appthrust\.test\/$/)
    await expect(app.getByRole('heading', { name: /^プレビュー:/ })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('link', { name: '新しいタブで開く', exact: true })).toHaveAttribute('href', `/-/workspaces/${workspaceId}/preview`)

    // Its endpoint then disappears: unavailable, never back to the legacy display — also after a reload.
    const unavailable = page.getByText('いまはプレビューを表示できません。しばらくしてから開き直してください。', { exact: true })
    await mock.platform('workspace-http', { endpoint: 'none' })
    await expect(unavailable).toBeVisible({ timeout: 20_000 })
    await expect(frame).toHaveCount(0)
    await page.reload()
    await expect(unavailable).toBeVisible({ timeout: 20_000 })
    await expect(frame).toHaveCount(0)
    await expect(page.locator(`a[href="${legacy}"]`)).toHaveCount(0)
    await shoot(page, testInfo, 'moved-endpoint-gone')
  })
})
