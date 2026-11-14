import { test, expect, seed, captureWrite, withExpectedFailures } from '../support/fixtures'
import { textJa } from '../../src/model/build/copy'
import { consoleUrl, previewHosts, startConsoleFront } from './preview-hosts'

const FIRST_TURN = textJa.questions.firstTurn
const KICKOFF_REPLY = textJa.questions.kickoffReply

// The preview runs on the workspace's own origin: the stories that show it open
// the Console on its real host (./preview-hosts.ts). The others keep the plain
// base URL, where the Console trusts no preview origin and asks for nothing.
test.use(previewHosts)
let stopFront: (() => Promise<void>) | undefined
test.beforeAll(async () => { stopFront = await startConsoleFront() })
test.afterAll(async () => { await stopFront?.() })

// Build Session replaces the former AI-dialog/wizard story. Mock lifecycle is
// advanced only after each asynchronous write has been acknowledged.
test.describe('AI build session @app-build-ai', () => {
  test('answers, refines, prepares, previews and publishes one persistent session @mock @story', async ({ page, mock, request }, testInfo) => {
    const intent = '営業が見積書を作って PDF で出せるアプリ。顧客と品目を登録したい。'
    test.setTimeout(120_000)
    const draftsPath = `/api/v1/projects/${seed.projectId}/application-drafts`
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { outcome: 'succeeded', autoAdvance: false, publish: false })
    await page.goto(consoleUrl('/new'))
    await page.getByLabel('やりたいことを書く', { exact: true }).fill(intent)
    const turnMessages: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/conversation-turns$/.test(new URL(request.url()).pathname)) turnMessages.push(request.postDataJSON().message)
    })
    const firstTurn = page.waitForResponse((response) => response.request().method() === 'POST' && /\/conversation-turns$/.test(new URL(response.url()).pathname))
    const draftWrite = await captureWrite(page, 'POST', draftsPath, () => page.getByRole('button', { name: 'AI と作る', exact: true }).click())
    expect(draftWrite.body).toMatchObject({ intent })
    await expect(page).toHaveURL(/\/-\/build\/[^/?]+$/)
    const sessionUrl = page.url()
    const draftId = new URL(sessionUrl).pathname.split('/').at(-1)!
    const draftPath = `${draftsPath}/${draftId}`
    const rail = page.getByRole('navigation', { name: '作成の手順' })
    for (const label of ['聞く', '決める', '作る', '公開']) await expect(rail).toContainText(label)
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    expect((await firstTurn).request().postDataJSON()).toEqual({ message: FIRST_TURN })
    await expect(conversation).toContainText('AI の準備をしています')
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-stage', 'ask')
    await page.reload()
    await expect(conversation).toContainText('AI の準備をしています')
    expect(turnMessages).toEqual([FIRST_TURN])
    await mock.platform('plan-generation', { autoAdvance: true })
    await mock.advance()
    await expect(conversation).toContainText('見積の PDF には何を載せますか？', { timeout: 20_000 })
    await expect(page.getByRole('button', { name: '会社ロゴと連絡先', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '支払期限と振込先', exact: true })).toBeVisible()
    // The proposal action is offered, but the AI's reply chips do not yet include it.
    await expect(page.getByRole('region', { name: '会話', exact: true }).getByRole('button', { name: KICKOFF_REPLY, exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '仕様', exact: true })).toContainText('品目')
    for (const [answer, question] of [
      ['会社ロゴと連絡先', '見積の承認はどうしますか？'],
      ['上長が確認して確定する', 'ここまでで最初の版を用意できます。'],
    ]) {
      const turn = await captureWrite(page, 'POST', `${draftPath}/conversation-turns`, () => page.getByRole('button', { name: answer, exact: true }).click())
      expect(turn.body).toEqual({ message: answer })
      await expect(conversation).toContainText(question, { timeout: 20_000 })
      await expect(page.getByTestId('build-session')).toHaveAttribute('data-stage', 'ask')
    }
    const kickoff = await captureWrite(page, 'POST', `${draftPath}/conversation-turns`, () => page.getByRole('region', { name: '会話', exact: true }).getByRole('button', { name: KICKOFF_REPLY, exact: true }).click())
    expect(kickoff.body).toEqual({ message: KICKOFF_REPLY })
    await expect(page.getByRole('button', { name: 'この内容で作る', exact: true })).toBeEnabled({ timeout: 20_000 })
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-stage', 'decide')
    await expect(page.getByTestId('build-proposal')).toContainText('公開先（予定）')
    await expect(page.getByTestId('build-proposal')).toContainText(`ai-app-${draftId.slice(-4)}.commerce.appthrust.test`)
    await expect.poll(async () => (await (await request.get(draftPath)).json()).creationPlan?.applicationStackRequest?.publish).toEqual({
      enabled: true, customDomain: 'commerce.appthrust.test', hostnamePattern: 'wildcard', subdomain: `ai-app-${draftId.slice(-4)}`,
    })
    await page.screenshot({ path: testInfo.outputPath('default-publish-proposal.png'), fullPage: true })
    await expect(page.getByRole('button', { name: KICKOFF_REPLY, exact: true })).toHaveCount(0)
    const reply = 'PDF に会社ロゴを入れてください'
    await page.getByLabel('AI に伝えること', { exact: true }).fill(reply)
    const turn = await captureWrite(page, 'POST', `${draftPath}/conversation-turns`, () => page.getByRole('button', { name: '送信', exact: true }).click())
    expect(turn.body).toEqual({ message: reply })
    await expect(page.getByRole('region', { name: '仕様', exact: true })).toContainText(reply, { timeout: 20_000 })
    await page.reload()
    await expect(page).toHaveURL(sessionUrl)
    await expect(conversation).toContainText(reply)
    // Only the mock server advances implementation tasks; the browser reads the draft.
    const advanceUntil = async (visible: () => Promise<void>) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        await mock.advance()
        try { await visible(); return } catch { /* not yet */ }
      }
      await visible()
    }
    // The workspace's preview origin is published once the app listens; until then the card says it is preparing.
    await mock.platform('workspace-http', { endpoint: 'pending' })
    // The prepare action sits on the AI's proposal; after the reply changed the spec it regenerates the plan first.
    const run = await captureWrite(page, 'POST', /\/creation-executions\/[^/]+\/run$/, () => page.getByRole('button', { name: /^(この内容で作る|計画を更新して作る)$/ }).click())
    expect((await run.request.response())?.status()).toBe(202)
    // The mock settles the execution on polls; the session binds the app and submits a server run.
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-stage', 'build', { timeout: 20_000 })
    await advanceUntil(() => expect(page.getByText('画面の準備をしています', { exact: true })).toBeVisible({ timeout: 2_000 }))
    await expect(page.locator('iframe')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '見てみる', exact: true })).toBeDisabled()
    await mock.platform('workspace-http', { endpoint: 'auto' })
    await advanceUntil(() => expect(page.frameLocator('iframe').getByRole('heading', { name: /^プレビュー:/ })).toBeVisible({ timeout: 4_000 }))
    await expect(page.getByRole('button', { name: '見てみる', exact: true })).toBeEnabled()
    // The new tab is the Console's own viewer page, never the preview origin itself.
    await expect(page.getByRole('link', { name: '新しいタブで開く', exact: true })).toHaveAttribute('href', /^\/-\/workspaces\/[^/]+\/preview$/)
    await advanceUntil(() => expect(page.getByRole('list', { name: 'アプリを作る手順', exact: true }).getByText('画面「見積の画面」', { exact: true })).toBeVisible({ timeout: 2_000 }))
    await advanceUntil(() => expect(page.getByRole('button', { name: '公開する', exact: true })).toBeEnabled({ timeout: 2_000 }))
    // The preparation rungs stay in the one ladder after startup.
    await expect(page.getByRole('list', { name: 'アプリを作る手順', exact: true })).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('default-publish-url-ready.png'), fullPage: true })
    await page.getByRole('button', { name: '公開する', exact: true }).click()
    await expect(page.getByRole('heading', { name: '誰に見せますか？', exact: true })).toBeVisible()
    await page.getByRole('radio', { name: /自分だけ/ }).check()
    await page.getByRole('button', { name: 'この範囲で公開する', exact: true }).click()
    await expect(page.getByRole('heading', { name: '公開しました', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: '開く', exact: true })).toHaveAttribute('href', /https:\/\/ai-app-.*\.commerce\.appthrust\.test/)
    await expect(page.getByRole('button', { name: '続けて直す', exact: true })).toBeVisible()
    // Publication is draft state on the server: a fresh tab without this tab's session still shows it.
    const fresh = await page.context().newPage()
    await fresh.goto(page.url())
    await expect(fresh.getByRole('button', { name: '続けて直す', exact: true })).toBeVisible()
    await expect(fresh.getByRole('button', { name: '公開する', exact: true })).toHaveCount(0)
    await fresh.screenshot({ path: testInfo.outputPath('published-fresh-tab.png'), fullPage: true })
    await fresh.close()
  })

  test('keeps running with the build tab closed and links app pages back to the persisted run @mock @story', async ({ page, mock, request }, testInfo) => {
    test.setTimeout(120_000)
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { autoAdvance: false })
    await mock.platform('prepare', { stall: 'starting' })
    const root = `/api/v1/projects/${seed.projectId}`
    const draft = (await (await request.post(`${root}/application-drafts`, { data: { intent: '見積を管理するアプリ', title: '見積を管理' } })).json()).resource
    const path = `${root}/application-drafts/${draft.id}`
    await request.post(`${path}/creation-plan-generations`, { data: {} })
    for (let step = 0; step < 4; step++) await mock.advance()
    const planned = await (await request.get(path)).json()
    const titles = ['顧客一覧', '見積の編集', 'PDF 出力']
    planned.creationPlan.implementationHandoff.tasks = titles.map((title) => ({ title, description: `${title}を作る`, acceptanceCriteria: [`${title}が使える`] }))
    expect((await request.patch(path, { data: { creationPlan: planned.creationPlan } })).ok()).toBe(true)
    const validation = (await (await request.post(`${path}/creation-plan-validations`, { data: {} })).json()).resource
    const begun = (await (await request.post(`${path}/creation-executions`, { data: { clientRequestId: 'merged-stage', creationPlanFingerprint: validation.creationPlanFingerprint } })).json()).resource
    await request.post(`${path}/creation-executions/${begun.creationExecutions[0].id}/run`, { data: {} })
    for (let step = 0; step < 4; step++) await mock.advance()
    expect((await (await request.get(path)).json()).phase).toBe('created')
    const context = page.context()
    let builder = page
    const runtimeWrites: string[] = []
    const starts: string[] = []
    context.on('request', (write) => {
      if (write.method() !== 'POST' && write.method() !== 'PUT') return
      const pathname = new URL(write.url()).pathname
      if (/\/dev-workspaces(?:$|\/.*(?:commit|api\/tasks|api\/appthrust))/.test(pathname)) runtimeWrites.push(pathname)
      if (/\/implementation-runs$/.test(pathname)) starts.push(write.postData() ?? '')
    })
    const currentRun = async () => (await (await request.get(path)).json()).implementationRuns?.at(-1)
    const advanceUntil = async (assertion: () => Promise<void>) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        await mock.advance()
        try { await assertion(); return } catch { /* advance the deterministic server lifecycle */ }
      }
      await assertion()
    }
    await builder.goto(consoleUrl(`/-/build/${draft.id}`))
    const ladder = () => builder.getByRole('list', { name: 'アプリを作る手順', exact: true })
    await expect(ladder().getByRole('listitem')).toHaveCount(7)
    await expect(ladder().getByRole('listitem').filter({ hasText: '下地を起動' })).toHaveAttribute('aria-current', 'step')
    await expect(builder.locator('iframe')).toHaveCount(0)
    await expect(builder.getByRole('region', { name: '公開したアプリ', exact: true })).toHaveCount(0)
    await mock.platform('prepare', {})
    await expect.poll(async () => (await currentRun())?.status).toBe('pending')
    await advanceUntil(() => expect.poll(async () => (await currentRun())?.step, { timeout: 1000 }).toBe('request'))
    await mock.advance()
    await expect(ladder().getByRole('listitem').filter({ hasText: '画面「顧客一覧」' }).getByLabel('いまの動き', { exact: true })).toHaveText('AI が作業しています（出力あり）', { timeout: 15_000 })
    await expect(ladder().getByRole('listitem').filter({ hasText: '下地を起動' }).getByLabel('完了', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(builder.frameLocator('iframe').getByRole('heading', { name: /^プレビュー:/ })).toBeVisible()
    const original = await currentRun()
    expect(starts).toEqual([''])
    for (const width of [1280, 390]) {
      await builder.setViewportSize({ width, height: 1100 })
      if (width === 390) await builder.getByRole('tab', { name: '作っているもの' }).click()
      await expect(ladder()).toBeVisible()
      expect(await builder.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await builder.screenshot({ path: testInfo.outputPath(`run-ladder-${width}.png`), fullPage: true })
    }
    const mine = await context.newPage()
    await mine.goto(consoleUrl('/mine'))
    const row = mine.getByRole('row').filter({ hasText: '見積を管理' })
    await expect(row).toContainText('画面「顧客一覧」を作っています', { timeout: 15_000 })
    await expect(row.getByRole('link', { name: '続きから作る', exact: true })).toHaveAttribute('href', `/-/build/${draft.id}`)
    await expect(row.getByRole('link', { name: '開く ↗', exact: true })).toHaveCount(0)
    await row.getByRole('link', { name: '見積を管理', exact: true }).click()
    const continueLink = mine.getByRole('link', { name: '続きから作る', exact: true })
    await expect(continueLink).toHaveAttribute('href', `/-/build/${draft.id}`)
    await expect(mine.getByTestId('status-text')).toHaveText('画面「顧客一覧」を作っています')
    await mine.setViewportSize({ width: 1280, height: 900 })
    await mine.screenshot({ path: testInfo.outputPath('app-continue-build-1280.png'), fullPage: true })
    await builder.close()
    await mock.advance()
    await expect(mine.getByTestId('status-text')).toHaveText('保存しています', { timeout: 15_000 })
    await mock.advance()
    await mock.advance()
    await expect(mine.getByTestId('status-text')).toHaveText('画面「見積の編集」を作っています', { timeout: 15_000 })
    // Following the product link in a fresh tab observes progress; it never allocates another workspace.
    builder = await context.newPage()
    await builder.goto(consoleUrl(await continueLink.getAttribute('href') as string))
    await expect(ladder().getByRole('listitem').filter({ hasText: '画面「顧客一覧」' })).toContainText('できました')
    await expect(ladder().getByRole('listitem').filter({ hasText: '画面「見積の編集」' })).toHaveAttribute('aria-current', 'step')
    // The reopened tab asks for its own preview grant; reload once it is shown, not while that request is in flight.
    await expect(builder.frameLocator('iframe').getByRole('heading', { name: /^プレビュー:/ })).toBeVisible()
    await builder.reload()
    await expect(ladder().getByRole('listitem').filter({ hasText: '画面「見積の編集」' })).toHaveAttribute('aria-current', 'step')
    expect(await currentRun()).toMatchObject({ id: original.id, devWorkspaceId: original.devWorkspaceId, status: 'running' })
    expect(starts).toHaveLength(1)
    expect(runtimeWrites).toEqual([])
    await advanceUntil(() => expect(builder.getByRole('button', { name: '公開する', exact: true })).toBeEnabled({ timeout: 1000 }))
    await expect(ladder().getByRole('listitem').filter({ hasText: '公開準備' }).getByLabel('完了')).toBeVisible({ timeout: 20_000 })
    await expect(continueLink).toHaveCount(0, { timeout: 15_000 })
    await builder.close()
    await mine.close()
  })

  test('retries the failed opening explicitly after reload and accepts a typed proposal request @mock @story', async ({ page, mock }) => {
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { outcome: 'succeeded', autoAdvance: true })
    const turnMessages: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/conversation-turns$/.test(new URL(request.url()).pathname)) turnMessages.push(request.postDataJSON().message)
    })
    await page.route('**/conversation-turns', async (route) => {
      if (route.request().method() === 'POST' && turnMessages.length === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'temporary failure' } }) })
      } else await route.continue()
    })
    await page.goto('/new')
    await page.getByLabel('やりたいことを書く', { exact: true }).fill('いいかんじに人事情報管理したい')
    const retry = page.getByRole('button', { name: 'もう一度試す', exact: true })
    await withExpectedFailures([{ method: 'POST', path: '/api/v1/projects/{projectId}/application-drafts/{draftId}/conversation-turns', status: 503, count: 1, reason: 'the opening turn meets a temporary Platform failure' }], async () => {
      await page.getByRole('button', { name: 'AI と作る', exact: true }).click()
      await expect(retry).toBeVisible()
    })
    expect(turnMessages).toEqual([FIRST_TURN])
    await page.reload()
    await expect(retry).toBeVisible()
    expect(turnMessages).toEqual([FIRST_TURN])
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    const retried = await captureWrite(page, 'POST', /\/conversation-turns$/, () => retry.click())
    expect(retried.body).toEqual({ message: FIRST_TURN })
    await expect(conversation).toContainText('社員情報を管理するのは誰ですか？', { timeout: 20_000 })
    await expect(page.getByRole('button', { name: '人事担当者のみ', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '人事と各部署の責任者', exact: true })).toBeVisible()
    await expect(conversation).not.toContainText('顧客')
    await expect(page.getByRole('region', { name: '仕様', exact: true })).toContainText('入社日')
    await page.getByLabel('AI に伝えること', { exact: true }).fill(KICKOFF_REPLY)
    const kickoff = await captureWrite(page, 'POST', /\/conversation-turns$/, () => page.getByRole('button', { name: '送信', exact: true }).click())
    expect(kickoff.body).toEqual({ message: KICKOFF_REPLY })
    await expect(page.getByRole('button', { name: 'この内容で作る', exact: true })).toBeEnabled({ timeout: 20_000 })
    expect(turnMessages).toEqual([FIRST_TURN, FIRST_TURN, KICKOFF_REPLY])
  })

  test('observes a concurrent run, cancels before a change, and retries or skips through the API @mock @story', async ({ page, mock, request }) => {
    test.setTimeout(120_000)
    const root = `/api/v1/projects/${seed.projectId}`
    const draft = (await (await request.post(`${root}/application-drafts`, { data: { intent: '見積の画面を作る' } })).json()).resource
    const path = `${root}/application-drafts/${draft.id}`
    const runsPath = `${path}/implementation-runs`
    await request.post(`${path}/creation-plan-generations`)
    for (let step = 0; step < 4; step++) await mock.advance()
    const validation = (await (await request.post(`${path}/creation-plan-validations`)).json()).resource
    const begun = (await (await request.post(`${path}/creation-executions`, { data: { clientRequestId: 'run-actions', creationPlanFingerprint: validation.creationPlanFingerprint } })).json()).resource
    await request.post(`${path}/creation-executions/${begun.creationExecutions[0].id}/run`)
    for (let step = 0; step < 6; step++) await mock.advance()
    // Another tab wins between our GET and POST. A conflict must attach to its run.
    let conflict = true
    const writes: string[] = []
    page.on('request', (write) => {
      if (write.method() === 'POST' && write.url().includes('/implementation-runs')) writes.push(new URL(write.url()).pathname)
    })
    await page.route(`**${runsPath}`, async (route) => {
      if (!conflict) { await route.continue(); return }
      conflict = false
      const response = await route.fetch()
      expect(response.status()).toBe(202)
      await route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'implementation run is running' } } })
    })
    const latest = async () => (await (await request.get(path)).json()).implementationRuns?.at(-1)
    const ladder = page.getByRole('list', { name: 'アプリを作る手順', exact: true })
    await withExpectedFailures([{ method: 'POST', path: runsPath, status: 409, count: 1, reason: 'another tab started the implementation run first' }], async () => {
      await page.goto(`/-/build/${draft.id}`)
      await expect.poll(async () => (await latest())?.status).toBe('pending')
      await mock.advance()
      await expect(ladder.getByLabel('いまの動き', { exact: true })).toHaveText('AI に依頼を送っています', { timeout: 15_000 })
    })
    expect(writes).toEqual([runsPath])
    const original = await latest()
    const taskId = original.currentTaskId
    await page.getByLabel('AI に伝えること', { exact: true }).fill('色を変えて')
    const changed = await captureWrite(page, 'POST', runsPath, () => page.getByRole('button', { name: '送信', exact: true }).click())
    expect(changed.body).toEqual({ change: { taskId, message: '色を変えて' } })
    expect(writes.slice(-2)).toEqual([`${runsPath}/${original.id}/cancel`, runsPath])
    await expect.poll(async () => (await latest())?.id).not.toBe(original.id)
    expect((await latest()).devWorkspaceId).toBe(original.devWorkspaceId)
    await mock.platform('implementation-run', { outcome: 'failed', error: 'task failed' })
    for (let step = 0; step < 3; step++) await mock.advance()
    const retry = page.getByRole('button', { name: 'もう一度試す', exact: true })
    const skip = page.getByRole('button', { name: 'この作業を飛ばす', exact: true })
    await expect(skip).toBeVisible({ timeout: 15_000 })
    await page.reload()
    await expect(skip).toBeVisible()
    const retried = await captureWrite(page, 'POST', runsPath, () => retry.click())
    expect(retried.request.postData()).toBeNull()
    await retried.request.response()
    for (let step = 0; step < 3; step++) await mock.advance()
    await expect(skip).toBeVisible({ timeout: 15_000 })
    const skipped = await captureWrite(page, 'POST', runsPath, () => skip.click())
    expect(skipped.body).toEqual({ skipTaskIds: [taskId] })
    await skipped.request.response()
    await mock.advance()
    await expect(page.getByRole('status').filter({ hasText: 'まだ画面は作られていません' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: '公開する', exact: true })).toBeDisabled()
    await mock.platform('implementation-run', { outcome: 'succeeded' })
    const reopened = await captureWrite(page, 'POST', runsPath, () => retry.click())
    expect(reopened.body).toEqual({ taskIds: [taskId] })
    await reopened.request.response()
    for (let step = 0; step < 4; step++) await mock.advance()
    await expect(ladder.getByText(/^できました/)).toHaveCount(1, { timeout: 15_000 })
    expect((await latest()).devWorkspaceId).toBe(original.devWorkspaceId)
  })


  test('reopening a created build session repairs the production web publish once @mock @story', async ({ page, mock, request }, testInfo) => {
    await mock.platform('plan-generation', { publish: false })
    const root = `/api/v1/projects/${seed.projectId}`
    const draft = (await (await request.post(`${root}/application-drafts`, { data: { intent: '旅程を管理する' } })).json()).resource
    const path = `${root}/application-drafts/${draft.id}`
    await request.post(`${path}/creation-plan-generations`, { data: {} })
    for (let step = 0; step < 4; step++) await mock.advance()
    const validation = (await (await request.post(`${path}/creation-plan-validations`, { data: {} })).json()).resource
    const begun = (await (await request.post(`${path}/creation-executions`, { data: { clientRequestId: 'repair-smoke', creationPlanFingerprint: validation.creationPlanFingerprint } })).json()).resource
    await request.post(`${path}/creation-executions/${begun.creationExecutions[0].id}/run`, { data: {} })
    for (let step = 0; step < 6; step++) await mock.advance()
    const created = await (await request.get(path)).json()
    expect(created.phase).toBe('created')
    const repairs: unknown[] = []
    page.on('request', (write) => {
      if (write.method() === 'POST' && new URL(write.url()).pathname === `${root}/publishes`) repairs.push(write.postDataJSON())
    })
    // After the repaired publish appears the session applies its access; reload only once that write has answered.
    const accessWrite = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === `${root}/publishes/${created.createdApplicationId}-web/access`)
    await page.goto(`/-/build/${draft.id}`)
    await expect.poll(() => repairs).toEqual([{
      applicationId: created.createdApplicationId, branchId: 'production', componentId: `${created.createdApplicationId}-web`,
      destination: { type: 'gateway' }, customDomain: 'commerce.appthrust.test', hostnamePattern: 'wildcard', subdomain: created.createdApplicationId,
      idempotencyKey: `build-publish-${draft.id}-${created.createdApplicationId}`,
    }])
    await expect.poll(async () => (await (await request.get(`${root}/publishes`)).json()).data.find((publish: { applicationId: string }) => publish.applicationId === created.createdApplicationId)?.publicUrl).toBe(`https://${created.createdApplicationId}.commerce.appthrust.test/`)
    expect((await accessWrite).ok()).toBe(true)
    await page.reload()
    await expect(page.getByTestId('build-session')).toBeVisible()
    expect(repairs).toHaveLength(1)
    await page.screenshot({ path: testInfo.outputPath('publish-repair-session.png'), fullPage: true })
  })

  test('a draft another account started (404) explains ownership instead of asking to reload @mock @story', async ({ page }, testInfo) => {
    // appthrust.ink 2026-10-16: a build link opened under another account showed
    // 「しばらくしてから再読み込み」 with a retry that could never succeed.
    const state = page.getByRole('heading', { level: 1, name: 'この作りかけは開けません' })
    await withExpectedFailures([{ method: 'GET', path: '/api/v1/projects/{projectId}/application-drafts/draft-someone-elses', status: 404, count: 1, reason: 'the Platform API hides another account\'s draft' }], async () => {
      await page.goto('/-/build/draft-someone-elses')
      await expect(state).toBeVisible()
    })
    await expect(page.getByText(/いまは .+ でサインインしています/)).toBeVisible()
    await expect(page.getByRole('button', { name: '再読み込み' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('draft-not-found.png'), fullPage: true })
    await page.getByRole('link', { name: '作りかけ一覧へ' }).click()
    await expect(page).toHaveURL(/\/-\/drafts$/)
  })
})
