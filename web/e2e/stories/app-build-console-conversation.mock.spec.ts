import type { APIRequestContext } from '@playwright/test'
import { test, expect, seed, captureWrite, withExpectedFailures, type MockControl } from '../support/fixtures'
import { textJa as buildText } from '../../src/model/build/copy'
import { textJa as text } from '../../src/features/build/copy'
import { numberedUrlName } from '../../src/model/create'

const BASE = '/api/console/v1/build-sessions'
const DRAFTS = `/api/v1/projects/${seed.projectId}/application-drafts`
const c = text.console

// The NEW-APP conversation on the console-v1 engine (APT-753 S4). `/new` starts a
// console-v1 session once the server's `/config` turns `newAppConversation` on (the
// mock's `__mock/new-app-conversation` switch). The mock stands in for the model and
// the server; cases that are about a later stage set the session up through the v1
// API the way another client would, then open it.

interface SessionWire { id: string; version: number; draftId?: string; activeTurnId?: string; specification: { revision: number } }
const json = { connection: 'close' }
const writeHeaders = (key: string, version?: number) => ({ ...json, 'Idempotency-Key': key, ...(version === undefined ? {} : { 'If-Match': `"bs-${version}"` }) })

async function readSession(request: APIRequestContext, id: string): Promise<SessionWire> {
  return await (await request.get(`${BASE}/${id}`, { headers: json })).json() as SessionWire
}

/** A session whose draft exists and whose opening turn the server finished. */
async function startViaApi(request: APIRequestContext, intent: string): Promise<SessionWire> {
  const created = await request.post(BASE, { headers: writeHeaders(`story-${crypto.randomUUID()}`), data: { kind: 'new-app', groupId: seed.groups.teamA.id, intent, locale: 'ja' } })
  expect(created.status()).toBe(202)
  let session = await created.json() as SessionWire
  while (!session.draftId) {
    const advanced = await request.post(`${BASE}/${session.id}/advance`, { headers: writeHeaders(`bs/${session.id}/advance/${session.version}`, session.version), data: {} })
    expect(advanced.status()).toBe(202)
    session = await advanced.json() as SessionWire
  }
  return settle(request, session.id)
}

/** Observes the active turn (each read is one server step) until it no longer asks to be observed. */
async function settle(request: APIRequestContext, id: string): Promise<SessionWire> {
  for (let step = 0; step < 20; step++) {
    const session = await readSession(request, id)
    if (!session.activeTurnId) return session
    const turn = await (await request.get(`${BASE}/${id}/turns/${session.activeTurnId}`, { headers: json })).json() as { nextAction: string }
    if (turn.nextAction !== 'observe') return readSession(request, id)
  }
  throw new Error('the active turn did not settle')
}

async function planViaApi(request: APIRequestContext, id: string): Promise<SessionWire> {
  const session = await readSession(request, id)
  expect((await request.post(`${BASE}/${id}/turns`, { headers: writeHeaders(`story-${crypto.randomUUID()}`, session.version), data: { kind: 'request_plan', specRevision: session.specification.revision } })).status()).toBe(202)
  return settle(request, id)
}

/** A spec change confirmed after the plan: the plan becomes stale. */
async function changeSpecViaApi(request: APIRequestContext, id: string, message: string) {
  let session = await readSession(request, id)
  await request.post(`${BASE}/${id}/turns`, { headers: writeHeaders(`story-${crypto.randomUUID()}`, session.version), data: { kind: 'conversation', message, intent: 'change', baseSpecRevision: session.specification.revision } })
  session = await settle(request, id)
  const resolved = await request.post(`${BASE}/${id}/turns/${session.activeTurnId}/resolution`, { headers: writeHeaders(`story-${crypto.randomUUID()}`, session.version), data: { decision: 'accept_spec' } })
  expect(resolved.status()).toBe(200)
}

/** The creation another client started and ran on the session's draft, settled by the mock's lifecycle. */
async function createViaApi(request: APIRequestContext, mock: MockControl, draftId: string) {
  const path = `${DRAFTS}/${draftId}`
  const validation = (await (await request.post(`${path}/creation-plan-validations`, { headers: json, data: {} })).json()).resource
  const begun = (await (await request.post(`${path}/creation-executions`, { headers: json, data: { clientRequestId: `story-${crypto.randomUUID()}`, creationPlanFingerprint: validation.creationPlanFingerprint } })).json()).resource
  await request.post(`${path}/creation-executions/${begun.creationExecutions.at(-1).id}/run`, { headers: json, data: {} })
  await expect.poll(async () => { await mock.advance(); return (await (await request.get(path, { headers: json })).json()).creationExecutions.at(-1).status }, { timeout: 20_000 }).toBe('succeeded')
}

/** Only the mock server advances implementation tasks; the browser reads the draft. */
async function advanceUntil(mock: MockControl, visible: () => Promise<void>, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await mock.advance()
    try { await visible(); return } catch { /* not yet */ }
  }
  await visible()
}

test.describe('console-v1 build conversation @app-build-console-conversation', () => {
  test('starts from /new, answers, offers candidates, confirms a spec change, plans and creates; nothing asks for a publish name before creation @mock @story', async ({ page, mock }, testInfo) => {
    test.setTimeout(120_000)
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { autoAdvance: true })
    await mock.console('new-app-conversation', { on: true })
    const legacyDrafts: string[] = []
    page.on('request', (sent) => { if (sent.method() === 'POST' && new URL(sent.url()).pathname === DRAFTS) legacyDrafts.push(sent.url()) })

    const intent = '設備の点検を記録するアプリ。点検した人と日時を残したい。'
    await page.goto('/new')
    await page.getByLabel('やりたいことを書く', { exact: true }).fill(intent)
    const advances: string[] = []
    page.on('request', (sent) => { if (sent.method() === 'POST' && /\/build-sessions\/[^/]+\/advance$/.test(new URL(sent.url()).pathname)) advances.push(sent.headers()['idempotency-key'] ?? '') })
    // The start creates one console session and follows its `advance` until the server names the draft (bounded wait).
    const start = await captureWrite(page, 'POST', BASE, () => page.getByRole('button', { name: 'AI と作る', exact: true }).click())
    expect(start.body).toEqual({ kind: 'new-app', groupId: seed.groups.teamA.id, intent, locale: 'ja' })
    expect(start.request.headers()['idempotency-key']).toMatch(/^bc-/)
    await expect(page).toHaveURL(/\/-\/build\/[^/?]+$/, { timeout: 20_000 })
    expect(advances).toHaveLength(1)
    expect(legacyDrafts).toEqual([])
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-engine', 'console-v1')
    const sessionId = (await (await page.request.get(`${BASE}?limit=50`, { headers: json })).json()).items[0].id as string
    const turnsPath = `${BASE}/${sessionId}/turns`

    const conversation = page.getByRole('log', { name: 'AI との会話' })
    const turns = conversation.getByTestId('console-turn')
    const spec = page.getByRole('region', { name: '仕様', exact: true })
    const revision = page.getByTestId('spec-revision')
    // The opening turn: the user's own words, then the server's answer in its own block.
    await expect(turns.first()).toContainText(intent)
    await expect(turns.first().getByTestId('reply-answer')).toHaveText('ご質問の点を確認しました。', { timeout: 20_000 })
    await expect(page.getByLabel(c.publish.name, { exact: true })).toHaveCount(0)

    // A question gets its answer as its own block.
    const composer = page.getByLabel('AI に伝えること', { exact: true })
    await composer.fill('Rust で作れますか？')
    const question = await captureWrite(page, 'POST', turnsPath, () => page.getByRole('button', { name: '送信', exact: true }).click())
    expect(question.body).toEqual({ kind: 'conversation', message: 'Rust で作れますか？', intent: 'auto', baseSpecRevision: 0 })
    await expect(turns.nth(1).getByTestId('reply-answer')).toHaveText('ご質問の点を確認しました。', { timeout: 20_000 })

    // Asking for candidates gets concrete ones; nothing is written to the specification by asking.
    await expect(composer).toBeEnabled()
    await composer.fill('おすすめの名前の候補を出して')
    await captureWrite(page, 'POST', turnsPath, () => page.getByRole('button', { name: '送信', exact: true }).click())
    await expect(turns.nth(2)).toContainText('申請ノート', { timeout: 20_000 })
    await expect(revision).toHaveText(c.spec.revision(0))
    await page.screenshot({ path: testInfo.outputPath('specifying-candidates.png'), fullPage: true })

    // A change is a proposal: the specification stays at its revision until 反映する.
    await expect(composer).toBeEnabled()
    await composer.fill('承認を二段階にして')
    await captureWrite(page, 'POST', turnsPath, () => page.getByRole('button', { name: '送信', exact: true }).click())
    const proposal = turns.nth(3).getByTestId('reply-proposal')
    await expect(proposal).toContainText('依頼の内容を仕様に加えます', { timeout: 20_000 })
    await expect(revision).toHaveText(c.spec.revision(0))
    await expect(spec).not.toContainText('承認を二段階にして')
    await expect(page.getByRole('button', { name: buildText.questions.kickoffReply, exact: true })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('spec-proposal.png'), fullPage: true })
    const resolution = await captureWrite(page, 'POST', /\/resolution$/, () => proposal.getByRole('button', { name: c.proposal.accept, exact: true }).click())
    expect(resolution.body).toEqual({ decision: 'accept_spec' })
    await expect(revision).toHaveText(c.spec.revision(1))
    await expect(spec).toContainText('承認を二段階にして')

    // The plan comes from the typed action, on the confirmed revision.
    const plan = await captureWrite(page, 'POST', turnsPath, () => page.getByRole('button', { name: buildText.questions.kickoffReply, exact: true }).click())
    expect(plan.body).toEqual({ kind: 'request_plan', specRevision: 1 })
    await expect(conversation.getByTestId('console-plan-turn')).toContainText(c.plan.planned(1), { timeout: 20_000 })

    // A current plan offers 「この内容で作る」 on its own: no publish name or audience is asked before creation.
    const create = page.getByTestId('build-proposal').getByRole('button', { name: buildText.primary.prepare, exact: true })
    await expect(create).toBeEnabled({ timeout: 20_000 })
    await expect(page.getByLabel(c.publish.name, { exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('planned.png'), fullPage: true })
    const execution = await captureWrite(page, 'POST', `${DRAFTS}/${page.url().split('/').at(-1)}/creation-executions`, () => create.click())
    expect(execution.body).toMatchObject({ creationPlanFingerprint: expect.any(String), clientRequestId: expect.any(String) })
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-stage', 'build', { timeout: 20_000 })
    // A created session takes no more spec turns: the composer gives way to the reason.
    await expect(page.getByLabel('AI に伝えること', { exact: true })).toHaveCount(0)
    await expect(page.getByText(c.created)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('creating.png'), fullPage: true })
  })

  test('a start the server stops shows its typed failure; 「新しく作り直す」 starts a new session @mock @story', async ({ page, mock }) => {
    test.setTimeout(60_000)
    await mock.platform('codex', { available: true })
    await mock.console('new-app-conversation', { on: true })
    await mock.console('build-session-start-failure')
    await page.goto('/new')
    await page.getByLabel('やりたいことを書く', { exact: true }).fill('備品の貸し出しを記録するアプリ')
    const first = await captureWrite(page, 'POST', BASE, () => page.getByRole('button', { name: 'AI と作る', exact: true }).click())
    // The recorded `service_unavailable` in the product's words, and only the explicit restart.
    const notice = page.getByRole('alert').filter({ hasText: c.failure.unavailable.title })
    await expect(notice).toContainText(c.start.failed.reason, { timeout: 20_000 })
    await expect(page).toHaveURL(/\/new/)
    const second = await captureWrite(page, 'POST', BASE, () => notice.getByRole('button', { name: c.start.restart, exact: true }).click())
    expect(second.request.headers()['idempotency-key']).not.toBe(first.request.headers()['idempotency-key'])
    await expect(page).toHaveURL(/\/-\/build\/[^/?]+$/, { timeout: 20_000 })
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-engine', 'console-v1')
  })

  test('after creation the typed publish name and audience are asked, survive a reload, gate 公開する, and a published app offers 「AIで直す」 @mock @story', async ({ page, request, mock }, testInfo) => {
    test.setTimeout(120_000)
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { autoAdvance: true })
    const session = await startViaApi(request, '設備の点検を記録するアプリ')
    await planViaApi(request, session.id)
    await createViaApi(request, mock, session.draftId!)
    await page.goto(`/-/build/${session.draftId}`)
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-engine', 'console-v1')

    const form = page.getByTestId('console-publish')
    await expect(form).toBeVisible({ timeout: 20_000 })
    await expect(form.getByTestId('console-publish-required')).toHaveText(c.publish.required)
    const name = form.getByLabel(c.publish.name, { exact: true })
    await expect(name).toHaveValue('')
    await expect(form.getByRole('button', { name: c.publish.save, exact: true })).toBeDisabled()
    await name.fill('点検ノート')
    await form.getByRole('radio', { name: /自分だけ/ }).click()
    const saved = await captureWrite(page, 'PATCH', `${BASE}/${session.id}/publish-preferences`, () => form.getByRole('button', { name: c.publish.save, exact: true }).click())
    expect(saved.body).toEqual({ name: '点検ノート', shareScope: 'private' })
    await expect(form.getByTestId('console-publish-saved')).toContainText(c.publish.sync.applied, { timeout: 20_000 })
    await expect(form.getByTestId('console-publish-required')).toHaveCount(0)

    // The session carries them: a reload shows the saved values and their sync state.
    await page.reload()
    await expect(form.getByLabel(c.publish.name, { exact: true })).toHaveValue('点検ノート', { timeout: 20_000 })
    await expect(form.getByRole('radio', { name: /自分だけ/ })).toBeChecked()
    await expect(form.getByTestId('console-publish-saved')).toContainText(c.publish.saved('点検ノート'))
    await expect(form.getByTestId('console-publish-saved')).toContainText(c.publish.sync.applied)

    // The publish step starts from them.
    const publish = page.getByRole('button', { name: buildText.primary.publish, exact: true })
    await advanceUntil(mock, () => expect(publish).toBeEnabled({ timeout: 2_000 }))
    await page.screenshot({ path: testInfo.outputPath('publish-ready.png'), fullPage: true })
    await publish.click()
    await expect(page.getByRole('heading', { name: '誰に見せますか？', exact: true })).toBeVisible()
    await expect(page.locator('#publish-name')).toHaveValue('点検ノート')
    await expect(form).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('publish-step.png'), fullPage: true })
    await page.getByRole('button', { name: 'この範囲で公開する', exact: true }).click()
    await expect(page.getByRole('heading', { name: '公開しました', exact: true })).toBeVisible({ timeout: 20_000 })
    // A created session takes no more spec turns: further changes go through 「AIで直す」.
    await expect(page.getByTestId('improve-with-ai')).toBeVisible()
    await expect(page.getByRole('button', { name: buildText.primary.continue, exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('published-improve.png'), fullPage: true })
  })

  test('a spec change after planning withholds the creation and offers re-planning @mock @story', async ({ page, request, mock }) => {
    test.setTimeout(90_000)
    await mock.platform('plan-generation', { autoAdvance: true })
    const session = await startViaApi(request, '備品の貸し出しを記録するアプリ')
    await planViaApi(request, session.id)
    await page.goto(`/-/build/${session.draftId}`)
    await expect(page.getByTestId('build-proposal').getByRole('button', { name: buildText.primary.prepare, exact: true })).toBeVisible({ timeout: 20_000 })
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    await page.getByLabel('AI に伝えること', { exact: true }).fill('貸し出しは 2 週間までにして')
    await page.getByRole('button', { name: '送信', exact: true }).click()
    await conversation.getByTestId('reply-proposal').getByRole('button', { name: c.proposal.accept, exact: true }).click({ timeout: 20_000 })
    await expect(page.getByTestId('spec-revision')).toHaveText(c.spec.revision(1))
    const stale = page.getByTestId('console-plan-stale')
    await expect(stale).toContainText(c.plan.stale)
    await expect(page.getByRole('button', { name: buildText.primary.prepare, exact: true })).toHaveCount(0)
    const replan = await captureWrite(page, 'POST', `${BASE}/${session.id}/turns`, () => stale.getByRole('button', { name: c.plan.replan, exact: true }).click())
    expect(replan.body).toEqual({ kind: 'request_plan', specRevision: 1 })
  })

  test('an app created from an earlier specification than the last confirmed one says so once, with 「AIで直す」 as the next step @mock @story', async ({ page, request, mock }, testInfo) => {
    test.setTimeout(120_000)
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { autoAdvance: true })
    const session = await startViaApi(request, '備品の貸し出しを記録するアプリ')
    await planViaApi(request, session.id)
    await changeSpecViaApi(request, session.id, '貸し出しは 2 週間までにして')
    // Another client created the app from the earlier plan.
    await createViaApi(request, mock, session.draftId!)
    expect(await (await request.get(`${BASE}/${session.id}`, { headers: json })).json()).toMatchObject({ lifecycle: 'created', plan: { specRevision: 0, stale: true } })
    await page.goto(`/-/build/${session.draftId}`)
    const notice = page.getByRole('status').filter({ hasText: c.createdFromEarlier.title })
    await expect(notice).toHaveCount(1, { timeout: 20_000 })
    await expect(page.getByText(c.createdFromEarlier.title, { exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: c.plan.replan, exact: true })).toHaveCount(0)
    await expect(page.getByTestId('console-plan-stale')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('created-from-earlier-spec.png'), fullPage: true })
    await advanceUntil(mock, () => expect(notice.getByTestId('improve-with-ai')).toBeVisible({ timeout: 2_000 }))
    await expect(notice).toContainText(c.createdFromEarlier.reason)
  })

  test('a URL name another app took offers a checked name; choosing it renames the plan and creates the app @mock @story', async ({ page, request, mock }, testInfo) => {
    test.setTimeout(120_000)
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { autoAdvance: true })
    const session = await startViaApi(request, '顧客を管理するアプリ')
    await planViaApi(request, session.id)
    const path = `${DRAFTS}/${session.draftId}`
    await page.goto(`/-/build/${session.draftId}`)
    const create = page.getByTestId('build-proposal').getByRole('button', { name: buildText.primary.prepare, exact: true })
    await expect(create).toBeEnabled({ timeout: 20_000 })
    // The default publish address is on the stored plan before the creation validates it.
    await expect.poll(async () => (await (await request.get(path, { headers: json })).json()).creationPlan?.applicationStackRequest?.publish?.subdomain, { timeout: 20_000 }).toBeTruthy()
    const urlName = (await (await request.get(path, { headers: json })).json()).creationPlan.applicationStackRequest.publish.subdomain as string
    const suggested = numberedUrlName(urlName, 2)
    await mock.platform('creation-publish-conflict')
    const choice = page.getByRole('button', { name: `${suggested} にする`, exact: true })
    await withExpectedFailures([{ method: 'GET', path: '/api/console/resolve', status: 404, count: 1, reason: `the suggested ${suggested} is checked free` }], async () => {
      await create.click()
      await expect(page.getByRole('alert').getByText(buildText.failure.urlNameTaken, { exact: true })).toBeVisible({ timeout: 20_000 })
      await expect(choice).toBeVisible({ timeout: 20_000 })
    })
    await page.screenshot({ path: testInfo.outputPath('url-conflict-choice.png'), fullPage: true })
    const cleanups: string[] = []
    page.on('request', (sent) => { if (sent.method() === 'POST' && new URL(sent.url()).pathname === `${path}/creation-cleanups`) cleanups.push(sent.url()) })
    const rename = await captureWrite(page, 'PATCH', path, () => choice.click())
    expect(rename.body).toEqual({ renameApplication: { name: suggested } })
    await expect.poll(async () => (await (await request.get(path, { headers: json })).json()).creationExecutions.at(-1)?.status, { timeout: 20_000 }).toBe('succeeded')
    const created = await (await request.get(path, { headers: json })).json()
    expect(created.creationPlan.applicationStackRequest.publish.subdomain).toBe(suggested)
    expect(created.creationExecutions).toHaveLength(2)
    expect(cleanups).toEqual([])
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-stage', 'build', { timeout: 20_000 })
    await expect(page.getByRole('alert').getByText(buildText.failure.urlNameTaken, { exact: true })).toHaveCount(0)
  })
})
