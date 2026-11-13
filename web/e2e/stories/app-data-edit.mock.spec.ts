import type { Page, Route } from '@playwright/test'
import { test, expect, seed, captureWrite, withExpectedFailures } from '../support/fixtures'

// データ tab writes on the 備品在庫 fixture (src/dev/mock-database-data.ts):
// 表 「商品」 (public.products), row 1 「ノートPC」 with 在庫 8. Every product is
// referenced by 入出庫, so the delete runs on a row the story adds itself.
const app = seed.apps.mitsumori
const dataPath = `/${app.groupPath}/${app.slug}/-/data?table=public.products`
const rowsPath = `/api/v1/projects/${seed.projectId}/databases/${app.slug}-db/tables/public/products/rows`

/** The grid cell of `column` in the row whose display value is `rowName`. */
async function gridCell(page: Page, rowName: string, column: string) {
  const headers = await page.getByRole('columnheader').allInnerTexts()
  const index = headers.findIndex((header) => header.trim().startsWith(column))
  expect(index, `column ${column}`).toBeGreaterThanOrEqual(0)
  return page.getByRole('row').filter({ has: page.getByRole('link', { name: rowName, exact: true }) }).getByRole('cell').nth(index)
}

async function openRow(page: Page, rowName: string) {
  await page.getByRole('link', { name: rowName, exact: true }).click()
  const sheet = page.getByRole('dialog', { name: `商品 › ${rowName}`, exact: true })
  await expect(sheet).toBeVisible()
  return sheet
}

test.describe('App data edit @app', () => {
  // A story that rewrites answers in the browser removes its routes before the next one starts.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('edits a value, adds a row and deletes it with confirmation @mock @story', async ({ page, mock }) => {
    void mock
    await page.goto(dataPath)
    await expect(page.getByRole('heading', { level: 2, name: '商品', exact: true })).toBeVisible()

    await test.step('Edit 在庫 of ノートPC and see it in the Sheet and the grid', async () => {
      const sheet = await openRow(page, 'ノートPC')
      await expect(sheet.locator('[data-field="stock"] dd')).toHaveText('8')
      await sheet.getByRole('button', { name: '編集', exact: true }).click()
      await sheet.getByLabel(/^在庫/).fill('7')
      const { body } = await captureWrite(page, 'PATCH', `${rowsPath}/1`, () => sheet.getByRole('button', { name: '保存', exact: true }).click())
      if (!body || typeof body !== 'object' || !('values' in body) || !('expected' in body) || !body.expected || typeof body.expected !== 'object') {
        throw new Error('Row update must send values and expected')
      }
      // Only the changed column, locked on what the user saw plus updated_at.
      expect(body.values).toEqual({ stock: 7 })
      expect(body.expected).toMatchObject({ stock: 8 })
      expect(Object.keys(body.expected).sort()).toEqual(['stock', 'updated_at'])
      await expect(sheet.getByText('保存しました。', { exact: true })).toBeVisible()
      await expect(sheet.locator('[data-field="stock"] dd')).toHaveText('7')
      await expect(sheet.getByRole('button', { name: '編集', exact: true })).toBeVisible()

      await sheet.getByRole('button', { name: '閉じる', exact: true }).click()
      await expect(sheet).not.toBeVisible()
      await expect(await gridCell(page, 'ノートPC', '在庫')).toHaveText('7')

      await page.reload()
      await expect(page.getByRole('link', { name: 'ノートPC', exact: true })).toBeVisible()
      await expect(await gridCell(page, 'ノートPC', '在庫')).toHaveText('7')
    })

    await test.step('Add a row; auto-filled columns are left to the database', async () => {
      await page.getByRole('button', { name: '行を追加', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: '商品 に行を追加', exact: true })
      await expect(sheet).toBeVisible()
      await expect(sheet.locator('[data-field="id"]')).toContainText('自動で入ります')
      await sheet.getByLabel(/^商品名/).fill('ヘッドセット')
      await sheet.getByLabel(/^単価/).fill('9,800')
      const { body } = await captureWrite(page, 'POST', rowsPath, () => sheet.getByRole('button', { name: '保存', exact: true }).click())
      expect(body).toEqual({ values: { name: 'ヘッドセット', unit_price: 9800, supplier_id: null, note: null } })

      const created = page.getByRole('dialog', { name: '商品 › ヘッドセット', exact: true })
      await expect(created.getByText('行を追加しました。', { exact: true })).toBeVisible()
      await expect(created.locator('[data-field="id"] dd')).toHaveText('13')
      await expect(created.locator('[data-field="unit_price"] dd')).toHaveText('9,800')
      await expect(created.getByTestId('row-audit')).toContainText('作成')
      // The grid sits behind the modal (aria-hidden) and renders table + mobile list.
      await expect(page.getByRole('link', { name: 'ヘッドセット', exact: true, includeHidden: true }).first()).toBeAttached()
    })

    await test.step('Delete the added row after a confirmation naming it', async () => {
      const sheet = page.getByRole('dialog', { name: '商品 › ヘッドセット', exact: true })
      await sheet.getByRole('button', { name: 'この行の操作', exact: true }).click()
      await page.getByRole('menuitem', { name: 'この行を削除', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '「ヘッドセット」の行を削除しますか？', exact: true })
      await expect(confirm).toContainText('この操作はアプリにすぐ反映されます')
      const { request } = await captureWrite(page, 'DELETE', `${rowsPath}/13`, () => confirm.getByRole('button', { name: '削除する', exact: true }).click())
      expect(request.method()).toBe('DELETE')
      await expect(confirm).not.toBeVisible()
      await expect(sheet).not.toBeVisible()
      await expect(page.getByRole('link', { name: 'ヘッドセット', exact: true })).toHaveCount(0)
    })

    await test.step('A row other 表 still use cannot be deleted', async () => {
      const sheet = await openRow(page, 'モニター')
      await sheet.getByRole('button', { name: 'この行の操作', exact: true }).click()
      await page.getByRole('menuitem', { name: 'この行を削除', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '「モニター」の行を削除しますか？', exact: true })
      await withExpectedFailures([{ method: 'DELETE', path: `${rowsPath}/{row}`, status: 409, count: 1, reason: 'another table still references the row' }], async () => {
        await confirm.getByRole('button', { name: '削除する', exact: true }).click()
        await expect(confirm.getByText('この行はほかの表から使われているため削除できません', { exact: true })).toBeVisible()
      })
      await confirm.getByRole('button', { name: 'キャンセル', exact: true }).click()
      // Cancelling the delete returns to the row, which is still there.
      await expect(sheet).toBeVisible()
      await sheet.getByRole('button', { name: '閉じる', exact: true }).click()
      await expect(page.getByRole('link', { name: 'モニター', exact: true })).toBeVisible()
    })
  })

  test('a save answered 2xx unreadably keeps the edit, offers only 「最新の状態を確認する」 and never resends @mock @story', async ({ page, mock }, testInfo) => {
    void mock
    const patches: number[] = []
    let reads = 0
    await page.route(`**${rowsPath}**`, async (route: Route) => {
      const method = route.request().method()
      if (method === 'GET') reads++
      if (method !== 'PATCH') return route.continue()
      const response = await route.fetch()
      patches.push(response.status())
      // The row was written; the answer names no written row.
      return route.fulfill({ response, json: { ...(await response.json()), rows: [] } })
    })
    await page.goto(dataPath)
    const sheet = await openRow(page, 'ノートPC')
    await sheet.getByRole('button', { name: '編集', exact: true }).click()
    const stock = sheet.getByLabel(/^在庫/)
    await stock.fill('6')
    const save = sheet.getByRole('button', { name: '保存', exact: true })
    await save.click()

    const warning = sheet.getByRole('status').filter({ hasText: '処理結果を確認できませんでした' })
    await expect(warning).toHaveCount(1)
    await expect(warning.getByRole('button')).toHaveCount(1)
    await expect(warning.getByRole('button', { name: '最新の状態を確認する', exact: true })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'もう一度試す', exact: true })).toHaveCount(0)
    await expect(sheet.getByText('保存しました。', { exact: true })).toHaveCount(0)
    await expect(sheet.getByText('保存できませんでした', { exact: false })).toHaveCount(0)
    await expect(save).toBeDisabled()
    await expect(stock).toHaveValue('6')
    // Enter in the field sends nothing either.
    await stock.press('Enter')
    await expect(stock).toHaveValue('6')
    expect(patches).toEqual([200])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('unreadable-row-save-confirm.png'), fullPage: true })

    const before = reads
    await warning.getByRole('button', { name: '最新の状態を確認する', exact: true }).click()
    await expect.poll(() => reads).toBeGreaterThan(before)
    await expect(warning).toHaveCount(0)
    // The write had happened: the read-back holds 6 under the kept edit, so saving sends nothing more.
    await expect(sheet.getByText('最新の内容を読み込みました。確認してから保存してください。', { exact: true })).toBeVisible()
    await expect(stock).toHaveValue('6')
    await expect(save).toBeEnabled()
    await save.click()
    await expect(sheet.locator('[data-field="stock"] dd')).toHaveText('6')
    expect(patches).toEqual([200])
    await sheet.getByRole('button', { name: '閉じる', exact: true }).click()
    await expect(await gridCell(page, 'ノートPC', '在庫')).toHaveText('6')
  })

  test('a conflicting save keeps the Sheet open, reloads the latest row and saves the draft @mock @story', async ({ page, mock }) => {
    await page.goto(dataPath)
    const sheet = await openRow(page, 'ノートPC')
    await sheet.getByRole('button', { name: '編集', exact: true }).click()
    await sheet.getByLabel(/^単価/).fill('118000')

    await mock.platform('data-write', { mode: 'conflict' })
    await withExpectedFailures([{ method: 'PATCH', path: `${rowsPath}/1`, status: 409, count: 1, reason: 'someone else changed the row first' }], async () => {
      await captureWrite(page, 'PATCH', `${rowsPath}/1`, () => sheet.getByRole('button', { name: '保存', exact: true }).click())
      await expect(sheet.getByText('ほかの人が先に変更しました。最新の内容を確認してから保存してください。', { exact: true })).toBeVisible()
    })
    await expect(sheet.getByLabel(/^単価/)).toHaveValue('118000')

    await sheet.getByRole('button', { name: '最新の内容を読み込む', exact: true }).click()
    await expect(sheet.getByText('ほかの人が変えた内容を読み込みました（更新日時）。確認してから保存してください。', { exact: true })).toBeVisible()
    await expect(sheet.getByLabel(/^単価/)).toHaveValue('118000')

    const { body } = await captureWrite(page, 'PATCH', `${rowsPath}/1`, () => sheet.getByRole('button', { name: '保存', exact: true }).click())
    expect(body).toMatchObject({ values: { unit_price: 118000 }, expected: { unit_price: 120000 } })
    await expect(sheet.getByText('保存しました。', { exact: true })).toBeVisible()
    await expect(sheet.locator('[data-field="unit_price"] dd')).toHaveText('118,000')
  })

  test('a constraint violation lands on its field @mock @story', async ({ page, mock }) => {
    await page.goto(dataPath)
    const sheet = await openRow(page, 'ノートPC')
    await sheet.getByRole('button', { name: '編集', exact: true }).click()
    const stock = sheet.getByLabel(/^在庫/)
    await stock.fill('-1')

    await mock.platform('data-write', { mode: 'constraint' })
    await withExpectedFailures([{ method: 'PATCH', path: `${rowsPath}/1`, status: 400, count: 1, reason: 'the database rejects a negative stock (check constraint)' }], async () => {
      await sheet.getByRole('button', { name: '保存', exact: true }).click()
      await expect(sheet.getByText('在庫 の値が条件を満たしていません', { exact: true })).toBeVisible()
    })
    await expect(stock).toHaveAttribute('aria-invalid', 'true')
    await expect(stock).toBeFocused()
    await expect(sheet.getByText('入力内容を確認してください。', { exact: true })).toBeVisible()

    await test.step('Client-side checks name the field before anything is sent', async () => {
      await stock.fill('たくさん')
      await sheet.getByRole('button', { name: '保存', exact: true }).click()
      await expect(sheet.getByText('在庫 は整数で入力してください', { exact: true })).toBeVisible()
      await sheet.getByLabel(/^商品名/).fill('')
      await sheet.getByRole('button', { name: '保存', exact: true }).click()
      await expect(sheet.getByText('商品名 は必須です', { exact: true })).toBeVisible()
    })

    await test.step('Closing with unsaved input asks first', async () => {
      await page.keyboard.press('Escape')
      const discard = page.getByRole('dialog', { name: '保存せずに閉じますか？', exact: true })
      await discard.getByRole('button', { name: '入力を続ける', exact: true }).click()
      await expect(sheet).toBeVisible()
      await sheet.getByRole('button', { name: '閉じる', exact: true }).click()
      await page.getByRole('dialog', { name: '保存せずに閉じますか？', exact: true }).getByRole('button', { name: '保存せずに閉じる', exact: true }).click()
      await expect(sheet).not.toBeVisible()
    })
  })

  test('writes refused by the platform explain why and stop offering edits @mock @story', async ({ page, mock }) => {
    await test.step('No write permission', async () => {
      await page.goto(dataPath)
      const sheet = await openRow(page, 'ノートPC')
      await sheet.getByRole('button', { name: '編集', exact: true }).click()
      await sheet.getByLabel(/^在庫/).fill('9')
      // Only the Platform API refuses: the console already showed the tab to this app's editor.
      await mock.platform('role', { role: 'Viewer' })
      await withExpectedFailures([{ method: 'PATCH', path: `${rowsPath}/1`, status: 403, count: 1, reason: 'the Platform API refuses a Viewer write' }], async () => {
        await sheet.getByRole('button', { name: '保存', exact: true }).click()
        await expect(sheet.getByText('データを編集する権限がまだありません', { exact: true })).toBeVisible()
      })
      await sheet.getByRole('button', { name: 'キャンセル', exact: true }).click()
      await sheet.getByRole('button', { name: '閉じる', exact: true }).click()
      await mock.platform('role', { role: 'Editor' })
    })

    await test.step('Row editing not enabled for this database yet', async () => {
      await mock.platform('data-write', { mode: 'unavailable' })
      const sheet = await openRow(page, 'ノートPC')
      await sheet.getByRole('button', { name: '編集', exact: true }).click()
      await sheet.getByLabel(/^在庫/).fill('9')
      await withExpectedFailures([{ method: 'PATCH', path: `${rowsPath}/1`, status: 412, count: 1, reason: 'row editing is not enabled for this database' }], async () => {
        await sheet.getByRole('button', { name: '保存', exact: true }).click()
        await expect(sheet.getByText('行の編集はまだ有効になっていません。基盤の担当者に「データの編集」を依頼してください。', { exact: true })).toBeVisible()
      })
      await expect(sheet.getByRole('button', { name: '編集', exact: true })).toHaveCount(0)
      await expect(sheet.getByRole('button', { name: 'この行の操作', exact: true })).toHaveCount(0)
      await expect(sheet.locator('[data-field="stock"] dd')).toHaveText('8')
    })
  })
})
