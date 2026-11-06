import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { fileURLToPath } from 'node:url'
import { textJa } from '../../src/features/excel2app/copy'
import { captureWrite, expect, seed, test } from '../support/fixtures'

const fixtures = ['april', 'may', 'customers'].map((name) => fileURLToPath(new URL(`./fixtures/excel2app-set-${name}.xlsx`, import.meta.url)))
const draftsPath = `/api/v1/projects/${seed.projectId}/application-drafts`

test('three Excel files become one ledger plus a cross-file master, preview both months, and hand off the same draft @excel2app @mock @story', async ({ page, mock, request }, testInfo) => {
  await mock.platform('codex', { available: true })
  await mock.platform('plan-generation', { autoAdvance: false })
  const analysisPosts: string[] = []
  const workbookKeys: string[] = []
  page.on('request', (write) => {
    if (write.method() !== 'POST') return
    if (write.url().endsWith('/conversation-turns') && write.postDataJSON().kind === 'excel-analysis') analysisPosts.push(write.url())
    if (write.url().endsWith('/workbooks')) workbookKeys.push(write.headers()['idempotency-key'] ?? '')
  })
  await page.goto('/-/excel2app')
  await page.getByTestId('excel2app-files-input').setInputFiles(fixtures)
  await expect(page.locator('[data-testid="excel2app-file"][data-state="stored"]')).toHaveCount(3)
  await expect(page.getByTestId('excel2app-analyse')).toBeEnabled()
  expect(analysisPosts).toEqual([])
  expect(workbookKeys).toHaveLength(3)
  expect(workbookKeys.every(Boolean)).toBe(true)
  expect(new Set(workbookKeys).size).toBe(3)
  await expect(page).toHaveURL(/\/-\/excel2app\?draft=/)
  const draftId = new URL(page.url()).searchParams.get('draft')!
  const draftPath = `${draftsPath}/${draftId}`
  await page.reload()
  await expect(page.getByTestId('excel2app-files')).toBeVisible()
  await expect(page.locator('[data-testid="excel2app-file"][data-state="stored"]')).toHaveCount(3)
  expect(analysisPosts).toEqual([])
  const hint = '4月と5月は同じ台帳です。得意先を共通で管理します。'
  await page.getByLabel(textJa.pick.hint).fill(hint)
  const started = await captureWrite(page, 'POST', `${draftPath}/conversation-turns`, () => page.getByTestId('excel2app-analyse').click())
  expect(started.body).toEqual({ kind: 'excel-analysis', message: hint })
  expect((await started.request.response())?.status()).toBe(202)
  await expect(page.getByTestId('excel2app-progress-file')).toHaveCount(3)
  await mock.advance()
  const ledger = page.locator('[data-testid="excel2app-entity"][data-entity="受注一覧"]')
  await expect(ledger).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('excel2app-entity')).toHaveCount(2)
  await expect(ledger.getByTestId('excel2app-entity-source')).toHaveCount(2)
  await expect(ledger).toContainText('excel2app-set-april.xlsx')
  await expect(ledger).toContainText('excel2app-set-may.xlsx')
  await expect(ledger).toContainText('得意先コード · 参照 → 得意先マスタ')
  await expect(page.getByTestId('excel2app-findings')).toBeVisible()
  await expect(page.getByTestId('excel2app-reading')).toHaveCount(3)
  for (const reading of await page.getByTestId('excel2app-reading').all()) await expect(reading).not.toHaveAttribute('open')
  const analysed: ApplicationDraft = await (await request.get(draftPath)).json()
  expect(analysed.source?.workbooks).toHaveLength(3)
  const entity = analysed.excelAnalysis!.entities.find((entity) => entity.name === '受注一覧')!
  expect(entity.importRows).toBe(4)
  expect(entity.sources.map((source) => source.workbookId)).toEqual(analysed.source!.workbooks.slice(0, 2).map((workbook) => workbook.id))
  expect(entity.fields.find((field) => field.name === '得意先コード')).toMatchObject({ kind: 'reference', referenceEntity: '得意先マスタ' })
  await testInfo.attach('integrated-workbook-set', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  await page.getByTestId('excel2app-next').click()
  const initialization = await captureWrite(page, 'POST', `${draftPath}/conversation-turns`, () => page.getByTestId('excel2app-next').click())
  expect((await initialization.request.response())?.status()).toBe(202)
  await mock.advance()
  await expect(page.getByTestId('excel2app-ui-preview')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('excel2app-ui-preview-nav-list').first().click()
  const preview = page.getByTestId('excel2app-ui-preview-screen-list')
  for (const item of ['4月の歯車', '4月の軸', '5月の歯車', '5月の軸']) await expect(preview).toContainText(item)
  await page.getByTestId('excel2app-ui-preview-nav-form').first().click()
  await expect(page.getByTestId('excel2app-ui-preview-screen-form').locator('option[value="C-001"]')).toHaveText('C-001 — 青空工業')
  await page.getByTestId('excel2app-to-implement').click()
  await page.getByTestId('excel2app-publish-name').fill('受注管理')
  const handoff = await captureWrite(page, 'PATCH', draftPath, () => page.getByTestId('excel2app-start-build').click())
  expect(handoff.body).toMatchObject({ publishPreferences: { name: '受注管理', shareScope: 'group' } })
  await expect(page).toHaveURL(new RegExp(`/-/build/${draftId}$`))
  await expect(page.getByTestId('build-spec')).toContainText('excel2app-set-april.xlsx ほか 2 ファイル（3 シート）から 6 行を取り込む')
  expect(analysisPosts).toHaveLength(1)
})
