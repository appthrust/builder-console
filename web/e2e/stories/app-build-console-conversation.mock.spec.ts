import { test, expect, seed, captureWrite } from '../support/fixtures'
import { textJa as buildText } from '../../src/model/build/copy'
import { textJa as text } from '../../src/features/build/copy'

const BASE = '/api/console/v1/build-sessions'
const c = text.console

// The NEW-APP conversation on the console-v1 engine (APT-753 S4-U2). The session
// is started through the v1 API, as `/new` does once the server's
// `newAppConversation` flag is on (S4-3 adds that flag; the integration adds the
// `/new` step here). The mock stands in for the model and the server.
test.describe('console-v1 build conversation @app-build-console-conversation', () => {
  test('answers a question, confirms a spec proposal, saves publish settings, plans and starts the creation @mock @story', async ({ page, request, mock }, testInfo) => {
    test.setTimeout(120_000)
    await mock.platform('plan-generation', { autoAdvance: true })
    const intent = '設備の点検を記録するアプリ。点検した人と日時を残したい。'
    const created = await request.post(BASE, { headers: { 'Idempotency-Key': `story-${Date.now()}`, connection: 'close' }, data: { kind: 'new-app', groupId: seed.groups.teamA.id, intent, locale: 'ja' } })
    expect(created.status()).toBe(202)
    let session = await created.json() as { id: string; version: number; draftId?: string }
    while (!session.draftId) {
      const advanced = await request.post(`${BASE}/${session.id}/advance`, { headers: { 'Idempotency-Key': `bs/${session.id}/advance/${session.version}`, 'If-Match': `"bs-${session.version}"`, connection: 'close' }, data: {} })
      expect(advanced.status()).toBe(202)
      session = await advanced.json() as typeof session
    }
    const turnsPath = `${BASE}/${session.id}/turns`

    await page.goto(`/-/build/${session.draftId}`)
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-engine', 'console-v1')
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    const turns = conversation.getByTestId('console-turn')
    const spec = page.getByRole('region', { name: '仕様', exact: true })
    const revision = page.getByTestId('spec-revision')
    // The opening turn: the user's own words, then the server's answer in its own block.
    await expect(turns.first()).toContainText(intent)
    await expect(turns.first().getByTestId('reply-answer')).toHaveText('ご質問の点を確認しました。', { timeout: 20_000 })

    // A question gets its answer as its own block.
    const composer = page.getByLabel('AI に伝えること', { exact: true })
    await composer.fill('Rust で作れますか？')
    const question = await captureWrite(page, 'POST', turnsPath, () => page.getByRole('button', { name: '送信', exact: true }).click())
    expect(question.body).toEqual({ kind: 'conversation', message: 'Rust で作れますか？', intent: 'auto', baseSpecRevision: 0 })
    await expect(turns.nth(1)).toContainText('Rust で作れますか？')
    await expect(turns.nth(1).getByTestId('reply-answer')).toHaveText('ご質問の点を確認しました。', { timeout: 20_000 })

    // A change is a proposal: the specification stays at its revision until 反映する.
    await expect(composer).toBeEnabled()
    await composer.fill('承認を二段階にして')
    await captureWrite(page, 'POST', turnsPath, () => page.getByRole('button', { name: '送信', exact: true }).click())
    const proposal = turns.nth(2).getByTestId('reply-proposal')
    await expect(proposal).toContainText('依頼の内容を仕様に加えます', { timeout: 20_000 })
    await expect(proposal).toContainText('承認を二段階にして')
    await expect(revision).toHaveText(c.spec.revision(0))
    await expect(spec).not.toContainText('承認を二段階にして')
    await expect(page.getByRole('button', { name: buildText.questions.kickoffReply, exact: true })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('spec-proposal.png'), fullPage: true })
    const resolution = await captureWrite(page, 'POST', /\/resolution$/, () => proposal.getByRole('button', { name: c.proposal.accept, exact: true }).click())
    expect(resolution.body).toEqual({ decision: 'accept_spec' })
    await expect(revision).toHaveText(c.spec.revision(1))
    await expect(spec).toContainText('承認を二段階にして')
    await expect(proposal).toContainText(c.proposal.accepted)

    // Publish name and audience come only from the typed inputs.
    const name = page.getByLabel(c.publish.name, { exact: true })
    await expect(name).toHaveValue('')
    await name.fill('点検ノート')
    await page.getByRole('radio', { name: /全社/ }).click()
    const publish = await captureWrite(page, 'PATCH', `${BASE}/${session.id}/publish-preferences`, () => page.getByRole('button', { name: c.publish.save, exact: true }).click())
    expect(publish.body).toEqual({ name: '点検ノート', shareScope: 'company' })
    await expect(page.getByTestId('console-publish-saved')).toContainText(c.publish.saved('点検ノート'))

    // The plan comes from the typed action, on the confirmed revision.
    const plan = await captureWrite(page, 'POST', turnsPath, () => page.getByRole('button', { name: buildText.questions.kickoffReply, exact: true }).click())
    expect(plan.body).toEqual({ kind: 'request_plan', specRevision: 1 })
    await expect(conversation.getByTestId('console-plan-turn')).toContainText(c.plan.planned(1), { timeout: 20_000 })
    await page.screenshot({ path: testInfo.outputPath('planned.png'), fullPage: true })

    // A current plan offers 「この内容で作る」: the existing creation execution on the Platform draft.
    const create = page.getByTestId('build-proposal').getByRole('button', { name: buildText.primary.prepare, exact: true })
    await expect(create).toBeEnabled({ timeout: 20_000 })
    const execution = await captureWrite(page, 'POST', `/api/v1/projects/${seed.projectId}/application-drafts/${session.draftId}/creation-executions`, () => create.click())
    expect(execution.body).toMatchObject({ creationPlanFingerprint: expect.any(String), clientRequestId: expect.any(String) })
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-stage', 'build', { timeout: 20_000 })
    await expect(page.getByLabel('AI に伝えること', { exact: true })).toBeDisabled()
    await expect(page.getByText(c.created)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('creating.png'), fullPage: true })
  })

  test('a spec change after planning withholds the creation and offers re-planning @mock @story', async ({ page, request, mock }) => {
    test.setTimeout(90_000)
    await mock.platform('plan-generation', { autoAdvance: true })
    const created = await request.post(BASE, { headers: { 'Idempotency-Key': `story-stale-${Date.now()}`, connection: 'close' }, data: { kind: 'new-app', groupId: seed.groups.teamA.id, intent: '備品の貸し出しを記録するアプリ', locale: 'ja' } })
    let session = await created.json() as { id: string; version: number; draftId?: string }
    while (!session.draftId) {
      session = await (await request.post(`${BASE}/${session.id}/advance`, { headers: { 'Idempotency-Key': `bs/${session.id}/advance/${session.version}`, 'If-Match': `"bs-${session.version}"`, connection: 'close' }, data: {} })).json() as typeof session
    }
    await page.goto(`/-/build/${session.draftId}`)
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    await expect(conversation.getByTestId('reply-answer').first()).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: buildText.questions.kickoffReply, exact: true }).click()
    await expect(page.getByTestId('build-proposal').getByRole('button', { name: buildText.primary.prepare, exact: true })).toBeVisible({ timeout: 20_000 })
    const composer = page.getByLabel('AI に伝えること', { exact: true })
    await composer.fill('貸し出しは 2 週間までにして')
    await page.getByRole('button', { name: '送信', exact: true }).click()
    await conversation.getByTestId('reply-proposal').getByRole('button', { name: c.proposal.accept, exact: true }).click({ timeout: 20_000 })
    await expect(page.getByTestId('spec-revision')).toHaveText(c.spec.revision(1))
    const stale = page.getByTestId('console-plan-stale')
    await expect(stale).toContainText(c.plan.stale)
    await expect(page.getByRole('button', { name: buildText.primary.prepare, exact: true })).toHaveCount(0)
    const replan = await captureWrite(page, 'POST', `${BASE}/${session.id}/turns`, () => stale.getByRole('button', { name: c.plan.replan, exact: true }).click())
    expect(replan.body).toEqual({ kind: 'request_plan', specRevision: 1 })
  })
})
