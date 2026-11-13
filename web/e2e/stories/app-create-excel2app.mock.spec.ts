import type { APIRequestContext, Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { textJa } from '../../src/features/excel2app/copy'
import { SAMPLE_SETS } from '../../src/features/excel2app/samples'
import { toDraftWorkbook } from '../../src/features/excel2app/model'
import { buildCopy } from '../../src/model/build/copy'
import { isPrepareTurn } from '../../src/model/build/questions'
import { openCreateWizard } from '../support/create-wizard'
import { captureWrite, expect, seed, test, withExpectedFailures, type MockControl } from '../support/fixtures'

const ordersWorkbook = fileURLToPath(new URL('./fixtures/excel2app-orders.xlsx', import.meta.url))
const sparseWorkbook = fileURLToPath(new URL('./fixtures/excel2app-ledger.xlsx', import.meta.url))
const draftsPath = `/api/v1/projects/${seed.projectId}/application-drafts`

/** Observe both server writes before advancing the mock's asynchronous turn. */
async function analyseWorkbook(page: Page, mock: MockControl, choose: () => Promise<void>, sample = false) {
  const analysisResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && /\/conversation-turns$/.test(new URL(response.url()).pathname)
    && response.request().postDataJSON().kind === 'excel-analysis')
  const workbook = await captureWrite(page, 'POST', /\/application-drafts\/[^/]+\/workbooks$/, choose)
  expect((await workbook.request.response())?.status()).toBe(201)
  if (!sample) {
    await expect(page.getByTestId('excel2app-file')).toHaveAttribute('data-state', 'stored')
    await expect(page.getByTestId('excel2app-analyse')).toBeEnabled()
    await page.getByTestId('excel2app-analyse').click()
  }
  expect(workbook.body).toMatchObject({ fileName: expect.any(String), sheets: expect.any(Array) })
  expect((await analysisResponse).status()).toBe(202)
  // No browser-local analysis is displayed before the server finishes the turn.
  await expect(page.getByRole('heading', { name: textJa.analysis.capabilities, exact: true })).not.toBeVisible()
  await mock.advance()
  await expect(page.getByRole('heading', { name: textJa.analysis.capabilities, exact: true })).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('excel2app-reading').locator('summary').click()
  return new URL(workbook.request.url()).pathname.replace(/\/workbooks$/, '')
}

async function prepareDraft(request: APIRequestContext, mock: MockControl) {
  const created = await request.post(draftsPath, { data: { title: '不具合管理台帳', intent: textJa.pick.draftIntent('不具合管理台帳.xlsx') } })
  expect(created.status()).toBe(201)
  const draftId: string = (await created.json()).resource.id
  const draftPath = `${draftsPath}/${draftId}`
  expect((await request.post(`${draftPath}/workbooks`, { data: toDraftWorkbook(SAMPLE_SETS[0]!.workbooks[0]!), headers: { 'Idempotency-Key': 'prepare-workbook' } })).status()).toBe(201)
  for (const kind of ['excel-analysis', 'ui-design'] as const) {
    expect((await request.post(`${draftPath}/conversation-turns`, { data: { kind, message: kind === 'ui-design' ? '__init__' : '' } })).status()).toBe(202)
    await mock.advance()
  }
  return { draftId, draftPath }
}

test.describe('Excel ledger to AI build @excel2app', () => {
  test.beforeEach(async ({ mock }) => {
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { autoAdvance: false })
  })

  test('saves a ledger analysis, resumes its edited specification, and hands the designed screens to the same AI build @mock @story', async ({ page, mock, request }, testInfo) => {
    test.setTimeout(120_000)
    const createdDrafts: string[] = []
    const designInstructions: string[] = []
    page.on('request', (write) => {
      if (write.method() !== 'POST') return
      const pathname = new URL(write.url()).pathname
      if (pathname === draftsPath) createdDrafts.push(pathname)
      if (/\/conversation-turns$/.test(pathname) && write.postDataJSON().kind === 'ui-design') {
        designInstructions.push(write.postDataJSON().message)
      }
    })
    await openCreateWizard(page)
    await page.getByTestId('create-excel2app').click()
    await expect(page).toHaveURL(/\/-\/excel2app$/)
    const draftPath = await analyseWorkbook(page, mock, () => page.getByTestId('excel2app-sample-defects').click(), true)
    const draftId = draftPath.split('/').at(-1)!
    expect(new URL(page.url()).searchParams.get('draft')).toBe(draftId)
    const analysed = await request.get(draftPath)
    expect(analysed.ok()).toBe(true)
    const analysedDraft = await analysed.json()
    expect(analysedDraft).toMatchObject({
      source: { kind: 'excel', workbooks: [expect.objectContaining({ fileName: '不具合管理台帳.xlsx' })] },
      excelAnalysis: { capabilities: expect.arrayContaining(['calculation', 'workflow', 'lookup']) },
    })
    const capabilities = page.getByRole('region', { name: textJa.analysis.capabilities, exact: true })
    for (const capability of ['calculation', 'workflow', 'lookup'] as const) {
      await expect(capabilities.getByText(textJa.capability[capability].title, { exact: true })).toBeVisible()
    }

    const ledger = page.locator('[data-testid="excel2app-sheet"][data-sheet="不具合一覧"]')
    await expect(ledger.getByText(textJa.analysis.workflow('状態'), { exact: true })).toBeVisible()
    await expect(ledger.getByTestId('excel2app-workflow').getByRole('listitem')).toHaveText([
      '未着手', '対策中', '対策完了', '完了確認済',
    ])
    const elapsedDays = ledger.getByRole('row').filter({ has: page.getByRole('cell', { name: '経過日数', exact: true }) })
    await expect(elapsedDays).toBeVisible()
    await expect(elapsedDays.locator('code')).toHaveText('= もし(状態="完了確認済","",今日()-発生日)')
    await testInfo.attach('defect-ledger-analysis', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })

    await page.getByRole('button', { name: textJa.next, exact: true }).click()
    const specTitle = textJa.document.title('不具合管理台帳')
    await expect(page.getByRole('heading', { name: specTitle, exact: true })).toBeVisible()
    await page.getByRole('button', { name: textJa.spec.edit, exact: true }).click()
    const editor = page.getByRole('textbox', { name: textJa.spec.title, exact: true })
    const original = await editor.inputValue()
    const editedLine = '部署のメンバーは記録の登録・編集・閲覧ができ、品質責任者が完了を確認する。'
    expect(original).toContain(textJa.document.accessBody[0])
    const edited = original.replace(textJa.document.accessBody[0], editedLine)
    await editor.fill(edited)
    await testInfo.attach('defect-ledger-specification', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    const initialization = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === `${draftPath}/conversation-turns`)
    const saved = await captureWrite(page, 'PATCH', draftPath, () => page.getByRole('button', { name: textJa.next, exact: true }).click())
    // The editor shows only the body; the PATCH must preserve server front-matter.
    expect(saved.body).toMatchObject({
      specMarkdown: analysedDraft.specMarkdown.replace(textJa.document.accessBody[0], editedLine),
    })
    expect((await saved.request.response())?.status()).toBe(200)
    const initialized = await initialization
    expect(initialized.status()).toBe(202)
    expect(initialized.request().postDataJSON()).toEqual({ message: '__init__', kind: 'ui-design' })
    await mock.advance()
    await expect(page.getByTestId('excel2app-ui-preview')).toBeVisible({ timeout: 15_000 })

    await page.reload()
    expect(new URL(page.url()).searchParams.get('draft')).toBe(draftId)
    await expect(page.getByRole('heading', { name: textJa.preview.title, exact: true })).toBeVisible()
    await expect(page.getByTestId('excel2app-ui-preview')).toBeVisible()
    // Resume keeps the edited server specification and does not replay __init__.
    await page.getByRole('button', { name: textJa.back, exact: true }).click()
    await expect(page.getByRole('region', { name: textJa.spec.title, exact: true })).toContainText(editedLine)
    await page.getByRole('button', { name: textJa.next, exact: true }).click()
    const list = page.getByTestId('excel2app-ui-preview-screen-list')
    await page.getByTestId('excel2app-ui-preview-nav-list').first().click()
    await expect(list.getByRole('table')).toBeVisible()
    await expect(list.locator('[data-layout="table"]')).toBeVisible()
    expect(designInstructions).toEqual(['__init__'])
    const instruction = '一覧をカード表示に'
    await page.getByTestId('excel2app-chat-input').fill(instruction)
    const chat = await captureWrite(page, 'POST', `${draftPath}/conversation-turns`, () => page.getByTestId('excel2app-chat-send').click())
    expect(chat.body).toEqual({ message: instruction, kind: 'ui-design' })
    expect((await chat.request.response())?.status()).toBe(202)
    await expect(page.locator('[data-testid="excel2app-chat-message"][data-role="user"]').last()).toContainText(instruction)
    await mock.advance()
    await expect(page.getByTestId('excel2app-chat-thinking')).not.toBeVisible({ timeout: 15_000 })
    const assistantReply = page.locator('[data-testid="excel2app-chat-message"][data-role="assistant"]').last()
    await expect(assistantReply).toContainText('カード')
    await expect(assistantReply).toBeVisible()
    await expect(list.getByRole('table')).toHaveCount(0)
    await expect(list.locator('[data-layout="cards"]')).toBeVisible()
    await expect(list.getByRole('listitem').first()).toBeVisible()
    await testInfo.attach('defect-ledger-ui-preview', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    await page.getByTestId('excel2app-to-implement').click()
    await expect(page.getByRole('heading', { name: textJa.implement.title, exact: true })).toBeVisible()
    await expect(page.locator('dl > div').filter({ has: page.getByText(textJa.implement.stats.rows, { exact: true }) }).locator('dd')).toHaveText('20')
    const publishPreferences = { name: '品質改善アプリ', shareScope: 'company' as const }
    await page.getByTestId('excel2app-publish-name').fill(publishPreferences.name)
    await page.getByRole('radio', { name: /全社/ }).check()
    const handoff = await captureWrite(page, 'PATCH', draftPath, () => page.getByRole('button', { name: textJa.implement.start, exact: true }).click())
    expect(handoff.body).toMatchObject({ title: publishPreferences.name, publishPreferences })
    expect((await handoff.request.response())?.status()).toBe(200)

    await expect(page).toHaveURL(new RegExp(`/-/build/${draftId}$`))
    expect(createdDrafts).toHaveLength(1)
    expect(designInstructions).toEqual(['__init__', instruction])
    const persisted = await request.get(draftPath)
    expect(persisted.ok()).toBe(true)
    const draft = await persisted.json()
    expect(draft).toMatchObject({
      specMarkdown: expect.stringContaining('## 9. 画面の決定'),
      uiDesign: { lists: { 不具合一覧: { layout: 'cards' } } },
      publishPreferences,
    })
    expect(draft.specMarkdown).toContain(editedLine)
    expect(draft.specMarkdown).toContain('未着手 → 対策中 → 対策完了 → 完了確認済')
    expect(draft.specMarkdown).toContain('経過日数 = ')
    expect(draft.specMarkdown).toContain('カード表示')
    await expect(page.getByTestId('build-session')).toBeVisible()
    // A genuinely new tab has no preparation answers in sessionStorage.
    const newTab = await page.context().newPage()
    await page.goto('about:blank')
    await newTab.goto(`/-/build/${draftId}`)
    await expect(newTab.getByTestId('build-session')).toBeVisible()
    await expect(newTab.getByRole('log')).not.toContainText('公開するときのアプリの名前はどれにしますか？')
    await expect(newTab.getByRole('log')).not.toContainText('誰に見せますか？')
    await mock.platform('plan-generation', { autoAdvance: true })
    await mock.platform('implementation-run', { autoAdvance: true })
    // The proposal action and the AI's reply chip carry the same words; answer with the chip.
    await newTab.getByRole('region', { name: '会話', exact: true }).getByRole('button', { name: buildCopy.questions.kickoffReply, exact: true }).click()
    await expect(newTab.getByRole('button', { name: 'この内容で作る', exact: true })).toBeEnabled({ timeout: 20_000 })
    const creation = await captureWrite(newTab, 'POST', /\/creation-executions\/[^/]+\/run$/, () => newTab.getByRole('button', { name: 'この内容で作る', exact: true }).click())
    expect((await creation.request.response())?.status()).toBe(202)
    // Stack/repository readiness is manual even when draft and task polling auto-advance.
    for (let step = 0; step < 6; step++) await mock.advance()
    await expect(newTab.getByRole('button', { name: '公開する', exact: true })).toBeEnabled({ timeout: 45_000 })
    await expect(newTab.getByRole('log')).not.toContainText('公開するときのアプリの名前はどれにしますか？')
    await expect(newTab.getByRole('log')).not.toContainText('誰に見せますか？')
    const built = await (await request.get(draftPath)).json()
    expect(built.conversationTurns.some((turn: { userMessage: string }) => isPrepareTurn(turn.userMessage))).toBe(false)
    await newTab.getByRole('button', { name: '公開する', exact: true }).click()
    await expect(newTab.getByRole('heading', { name: '誰に見せますか？', exact: true })).toBeVisible()
    await expect(newTab.getByRole('radio', { name: /全社/ })).toBeChecked()
    await testInfo.attach('new-tab-publish-preferences', { body: await newTab.screenshot({ fullPage: true }), contentType: 'image/png' })
    await newTab.close()
  })

  test('a created draft opens with its analysis, specification and preview read-only @mock @story', async ({ page, mock, request }, testInfo) => {
    const { draftId, draftPath } = await prepareDraft(request, mock)
    expect((await request.post(`${draftPath}/creation-plan-generations`, { data: {} })).status()).toBe(202)
    for (let step = 0; step < 4; step++) await mock.advance()
    const validation = (await (await request.post(`${draftPath}/creation-plan-validations`, { data: {} })).json()).resource
    const begun = (await (await request.post(`${draftPath}/creation-executions`, { data: { clientRequestId: 'excel-read-only', creationPlanFingerprint: validation.creationPlanFingerprint } })).json()).resource
    await request.post(`${draftPath}/creation-executions/${begun.creationExecutions[0].id}/run`, { data: {} })
    for (let step = 0; step < 6; step++) await mock.advance()
    expect((await (await request.get(draftPath)).json()).createdApplicationId).toBeTruthy()
    const writes: string[] = []
    page.on('request', (write) => {
      if (write.method() !== 'GET' && new URL(write.url()).pathname.startsWith(draftPath)) writes.push(write.url())
    })
    await page.goto(`/-/excel2app?draft=${draftId}`)
    const notice = page.getByTestId('excel2app-created')
    await expect(notice).toContainText(textJa.created.title)
    await expect(notice.getByRole('link', { name: textJa.created.openBuild })).toHaveAttribute('href', `/-/build/${draftId}`)
    await expect(page.getByTestId('excel2app-ui-preview')).toBeVisible()
    for (const control of ['input', 'send', 'undo']) await expect(page.getByTestId(`excel2app-chat-${control}`)).toBeDisabled()
    await expect(page.getByTestId('excel2app-to-implement')).toHaveCount(0)
    await testInfo.attach('created-draft-preview-read-only', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    await page.getByRole('button', { name: textJa.back, exact: true }).click()
    await expect(page.getByRole('region', { name: textJa.spec.title, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: textJa.spec.edit, exact: true })).toBeDisabled()
    await expect(page.getByTestId('excel2app-spec-input')).toHaveCount(0)
    await page.getByRole('button', { name: textJa.back, exact: true }).click()
    await expect(page.getByRole('heading', { name: textJa.analysis.capabilities, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: textJa.back, exact: true })).toBeDisabled()
    await page.getByTestId('excel2app-next').click()
    await page.getByTestId('excel2app-next').click()
    await expect(page.getByTestId('excel2app-chat-input')).toBeDisabled()
    expect(writes).toEqual([])
  })

  test('a creation conflict during design chat shows the same read-only notice even before the draft read catches up @mock @story', async ({ page, mock, request }, testInfo) => {
    const { draftId, draftPath } = await prepareDraft(request, mock)
    await page.goto(`/-/excel2app?draft=${draftId}`)
    await expect(page.getByTestId('excel2app-chat-input')).toBeEnabled()
    await page.route(`**${draftPath}/conversation-turns`, (route) => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'conflict', message: 'application already created', details: { reason: 'ApplicationCreated' } } }),
    }))
    await withExpectedFailures([{ method: 'POST', path: `${draftPath}/conversation-turns`, status: 409, count: 1, reason: 'another tab created the application first (ApplicationCreated)' }], async () => {
      await page.getByTestId('excel2app-chat-input').fill('一覧をカード表示に')
      await page.getByTestId('excel2app-chat-send').click()
      await expect(page.getByTestId('excel2app-created')).toContainText(textJa.created.title)
      await expect(page.getByTestId('excel2app-chat-input')).toBeDisabled()
    })
    await expect(page.getByTestId('excel2app-chat-retry')).toHaveCount(0)
    await page.getByRole('button', { name: textJa.back, exact: true }).click()
    await expect(page.getByRole('button', { name: textJa.spec.edit, exact: true })).toBeDisabled()
    await testInfo.attach('creation-race-read-only', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  })

  test('a creation conflict during sample analysis disables retries and set changes @mock @story', async ({ page }) => {
    await page.route('**/conversation-turns', (route) => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'conflict', message: 'application already created', details: { reason: 'ApplicationCreated' } } }),
    }))
    await page.goto('/-/excel2app')
    await withExpectedFailures([{ method: 'POST', path: '/api/v1/projects/{projectId}/application-drafts/{draftId}/conversation-turns', status: 409, count: 1, reason: 'the application was created before the analysis turn (ApplicationCreated)' }], async () => {
      await page.getByTestId('excel2app-sample-defects').click()
      await expect(page.getByTestId('excel2app-created')).toContainText(textJa.created.title)
    })
    await expect(page.getByTestId('excel2app-analysis-retry')).toHaveCount(0)
    await expect(page.getByTestId('excel2app-offline')).toHaveCount(0)
    await expect(page.getByRole('button', { name: textJa.back, exact: true })).toBeDisabled()
  })

  test('uploads a workbook and receives calculated and master-reference columns from server analysis @mock @story', async ({ page, mock, request }, testInfo) => {
    // The generated ZIP_DEFLATED fixture has two orders, C*D amount formulas,
    // and a customer validation range backed by the 得意先マスタ sheet.
    await page.goto('/-/excel2app')
    const draftPath = await analyseWorkbook(page, mock, () => page.locator('input[type="file"]').setInputFiles(ordersWorkbook))
    await expect(page.getByRole('heading', { name: textJa.analysis.setTitle, exact: true })).toBeVisible()
    const persisted = await request.get(draftPath)
    expect(persisted.ok()).toBe(true)
    expect(await persisted.json()).toMatchObject({
      excelAnalysis: {
        entities: expect.arrayContaining([expect.objectContaining({
          name: '受注一覧',
          fields: expect.arrayContaining([
            expect.objectContaining({ name: '金額', kind: 'formula' }),
            expect.objectContaining({ name: '得意先', kind: 'reference', referenceEntity: '得意先マスタ' }),
          ]),
        })]),
      },
    })

    const ledger = page.locator('[data-testid="excel2app-sheet"][data-sheet="受注一覧"]')
    const amount = ledger.getByRole('row').filter({ has: page.getByRole('cell', { name: '金額', exact: true }) })
    await expect(amount.getByRole('cell', { name: textJa.kind.formula, exact: true })).toBeVisible()
    const customer = ledger.getByRole('row').filter({ has: page.getByRole('cell', { name: '得意先', exact: true }) })
    await expect(customer.getByRole('cell').nth(1)).toContainText(textJa.kind.reference)
    await expect(customer.getByRole('cell').nth(1)).toContainText('得意先マスタ')
    await expect(amount.locator('code')).toHaveText('= 数量 × 単価')
    await testInfo.attach('uploaded-workbook-analysis', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  })

  test('uploads a ledger with title and section gaps without losing Excel row positions @mock @story', async ({ page, mock, request }) => {
    await page.goto('/-/excel2app')
    // Chromium's native DOMParser reads the real XLSX; the mock validates the saved
    // workbook with the shared API schema before analysis can begin.
    const draftPath = await analyseWorkbook(page, mock, () => page.locator('input[type="file"]').setInputFiles(sparseWorkbook))
    await expect(page.getByRole('heading', { name: textJa.analysis.setTitle, exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).not.toBeVisible()
    const members = (await (await request.get(`${draftPath}/workbooks`)).json()).data
    const saved = await request.get(`${draftPath}/workbooks/${members[0].workbook.id}`)
    expect(saved.ok()).toBe(true)
    const workbook = await saved.json()
    expect(workbook.sheets).toHaveLength(1)
    expect(workbook.sheets[0].name).toBe('台帳')
    expect(workbook.sheets[0].rows).toEqual([
      ['部品管理台帳'], [], ['管理', null, '見積'],
      ['管理No', '状態', '数量', '単価', '金額'],
      ['P-001', '未着手', 3, 400, 1200], [], [], ['次の区分'],
      ['P-002', '完了', null, 250],
    ])
  })

  test('shows a 412 notice and retries when AI becomes unavailable after the workbook is saved @mock @story', async ({ page, mock }, testInfo) => {
    await page.goto('/-/excel2app')
    // WorkbookMissing itself is not reachable from the UI: a POST must succeed
    // before the turn starts. Use the real mock Codex precondition instead.
    await page.route('**/conversation-turns', async (route) => {
      if (route.request().method() === 'POST') await mock.platform('codex', { available: false })
      await route.continue()
    }, { times: 1 })
    const rejectedTurn = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && /\/conversation-turns$/.test(new URL(response.url()).pathname))
    const notice = page.getByTestId('excel2app-analysis-unavailable')
    await withExpectedFailures([{ method: 'POST', path: '/api/v1/projects/{projectId}/application-drafts/{draftId}/conversation-turns', status: 412, count: 1, reason: 'AI became unavailable after the workbook was saved' }], async () => {
      const workbook = await captureWrite(page, 'POST', /\/application-drafts\/[^/]+\/workbooks$/, () => page.getByTestId('excel2app-sample-defects').click())
      expect((await workbook.request.response())?.status()).toBe(201)
      expect((await rejectedTurn).status()).toBe(412)
      await expect(notice).toContainText(textJa.analysis.unavailableTitle)
      await expect(notice).toContainText(textJa.analysis.unavailableBody)
      await expect(page.getByTestId('excel2app-analysis-retry')).toBeVisible()
    })
    await expect(page.getByRole('heading', { name: textJa.analysis.capabilities, exact: true })).not.toBeVisible()
    await expect(page.getByTestId('excel2app-offline')).toHaveCount(0)
    await testInfo.attach('analysis-precondition-notice', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })

    await mock.platform('codex', { available: true })
    const retry = await captureWrite(page, 'POST', /\/conversation-turns$/, () => page.getByTestId('excel2app-analysis-retry').click())
    expect(retry.body).toMatchObject({ kind: 'excel-analysis' })
    expect((await retry.request.response())?.status()).toBe(202)
    await mock.advance()
    await expect(page.getByRole('heading', { name: textJa.analysis.capabilities, exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(notice).not.toBeVisible()
  })

  test('keeps failed file rows when collection binds its new draft URL @mock @story', async ({ page }) => {
    await page.route('**/workbooks', async (route) => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().fileName === 'excel2app-ledger.xlsx') {
        await route.fulfill({
          status: 400, contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'invalid_argument', message: 'Invalid row', details: { reason: 'WorkbookRowInvalid', sheet: '台帳', row: 5 } } }),
        })
      } else await route.continue()
    })
    await page.goto('/-/excel2app')
    const failed = page.locator('[data-testid="excel2app-file"][data-state="invalid"]')
    await withExpectedFailures([{ method: 'POST', path: '/api/v1/projects/{projectId}/application-drafts/{draftId}/workbooks', status: 400, count: 1, reason: 'the Platform rejects one workbook row (WorkbookRowInvalid)' }], async () => {
      await page.getByTestId('excel2app-files-input').setInputFiles([sparseWorkbook, ordersWorkbook])
      await expect(page).toHaveURL(/\/-\/excel2app\?draft=/)
      await expect(page.getByTestId('excel2app-analyse')).toBeEnabled()
      await expect(page.getByTestId('excel2app-file')).toHaveCount(2)
      await expect(failed).toContainText('excel2app-ledger.xlsx')
    })
    await expect(failed).toContainText(textJa.pick.invalid({ sheet: '台帳', row: 5 }))
    await expect(page.locator('[data-testid="excel2app-file"][data-state="stored"]')).toContainText('excel2app-orders.xlsx')
    await failed.getByRole('button', { name: textJa.pick.remove, exact: true }).click()
    await expect(page.getByTestId('excel2app-file')).toHaveCount(1)
  })
})
