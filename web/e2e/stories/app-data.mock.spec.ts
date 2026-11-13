import type { Page, Route } from '@playwright/test'
import { test, expect, seed, withExpectedFailures, type ExpectedFailure } from '../support/fixtures'

// データ tab, read side (design/platform/builder-console-app-data.md). The mock
// serves one 備品在庫 catalog for every app database (src/dev/mock-database-data.ts).
const app = seed.apps.mitsumori
const dataUrl = `/${app.groupPath}/${app.slug}/-/data`
const productsRowsPath = `/api/v1/projects/${seed.projectId}/databases/${app.slug}-db/tables/public/products/rows`
const REFRESH_FAILED = /^更新できませんでした。/

/** The data tab's first read: the Platform API answers why the database cannot be listed. */
const tablesRefused = (status: number, reason: string): ExpectedFailure =>
  ({ method: 'GET', path: '/api/v1/projects/{projectId}/databases/{database}/schema/tables', status, count: 1, reason })

/** The 表 Select above the grid. */
const tableSelect = (page: Page) => page.getByRole('combobox', { name: '表', exact: true })
async function switchTable(page: Page, label: RegExp) {
  await tableSelect(page).click()
  await page.getByRole('option', { name: label }).click()
}

test.describe('App data @app-data', () => {
  // A story that rewrites answers in the browser removes its routes before the next one starts.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('lists the visible 表, switches between them, searches, sorts, pages and opens a row @mock @story', async ({ page, mock }) => {
    void mock
    await page.goto(dataUrl)
    const tabs = page.getByRole('navigation', { name: 'アプリのページ' })
    await expect(tabs.getByRole('link')).toHaveText(['概要', 'つかいかた', 'データ', '更新履歴', '設定', 'ログ'])

    // 表 list: comment labels, hidden tables left out, estimates shown; the selected 表 shows its estimate.
    await expect(tableSelect(page)).toHaveText('商品（約 12 行）')
    await tableSelect(page).click()
    const options = page.getByRole('option')
    await expect(options).toHaveText([/^商品/, /^取引先/, /^入出庫/, /^担当者/, /^在庫サマリー/, /^旧システムの取込データ/])
    await expect(page.getByRole('listbox')).not.toContainText('Audit log')
    await page.keyboard.press('Escape')
    await expect(options).toHaveCount(0)

    // First 表 by default: label, column labels from comments, @hidden column absent.
    await expect(page.getByRole('heading', { name: '商品', exact: true })).toBeVisible()
    const products = page.getByRole('table', { name: '商品の行' })
    await expect(products.getByRole('row')).toHaveCount(13)
    for (const header of ['番号', '商品名', '分類', '単価', '在庫', '取扱中', '取引先', 'メモ', '作成日時', '更新日時']) {
      await expect(products.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
    }
    await expect(products.getByRole('columnheader', { name: '社内コード' })).toHaveCount(0)
    const laptop = products.getByRole('row', { name: /ノートPC/ })
    await expect(laptop).toContainText('120,000')
    await expect(laptop).toContainText('はい')
    await expect(products.getByRole('row', { name: /モニター/ })).toContainText('（なし）')
    await expect(page.getByRole('button', { name: '行を追加' })).toBeVisible()
    await expect(page.getByText('この表は見るだけです')).toHaveCount(0)

    // Sort: one column at a time, server-side; ascending then descending.
    const priceHeader = products.getByRole('columnheader', { name: '単価', exact: true })
    await priceHeader.getByRole('button').click()
    await expect(priceHeader).toHaveAttribute('aria-sort', 'ascending')
    await expect(products.getByRole('row').nth(1)).toContainText('ボールペン（黒）')
    await priceHeader.getByRole('button').click()
    await expect(priceHeader).toHaveAttribute('aria-sort', 'descending')
    await expect(products.getByRole('row').nth(1)).toContainText('ノートPC')

    // Search: debounced into the URL, server-side; no match has its own empty state.
    const searchBox = page.getByRole('searchbox', { name: '検索' })
    await searchBox.fill('マウス')
    await expect(page).toHaveURL(/[?&]q=%E3%83%9E%E3%82%A6%E3%82%B9/)
    await expect(products.getByRole('row')).toHaveCount(2)
    await expect(products.getByRole('row').nth(1)).toContainText('マウス')
    await searchBox.fill('存在しない備品')
    await expect(page.getByText('「存在しない備品」に合う行はありません')).toBeVisible()
    await page.getByRole('button', { name: '検索をやめる' }).click()
    await expect(searchBox).toHaveValue('')
    await expect(products.getByRole('row')).toHaveCount(13)
    await expect(page).not.toHaveURL(/[?&]q=/)

    // Row click opens the row sheet through ?row=, titled with the row's display value.
    await products.getByRole('link', { name: 'ノートPC', exact: true }).click()
    await expect(page).toHaveURL(/[?&]row=1(&|$)/)
    const sheet = page.getByRole('dialog', { name: /ノートPC/ })
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(page).not.toHaveURL(/[?&]row=/)

    // Table switch keeps the URL in step and starts a fresh grid.
    await switchTable(page, /^取引先/)
    await expect(page).toHaveURL(/[?&]table=public\.suppliers/)
    await expect(page.getByRole('heading', { name: '取引先', exact: true })).toBeVisible()
    const suppliers = page.getByRole('table', { name: '取引先の行' })
    await expect(suppliers.getByRole('row')).toHaveCount(6)
    await expect(suppliers.getByRole('columnheader', { name: '会社名', exact: true })).toBeVisible()

    // Paging: 50 rows per page over the estimate.
    await switchTable(page, /^入出庫/)
    await expect(tableSelect(page)).toHaveText('入出庫（約 120 行）')
    const pager = page.getByRole('navigation', { name: 'ページ', exact: true })
    await expect(pager.getByRole('button', { name: '前の 50 行' })).toBeDisabled()
    await expect(pager).toContainText('1〜50 行目')
    await pager.getByRole('button', { name: '次の 50 行' }).click()
    await expect(pager).toContainText('51〜100 行目')
    await pager.getByRole('button', { name: '次の 50 行' }).click()
    await expect(pager).toContainText('101〜120 行目')
    await expect(pager.getByRole('button', { name: '次の 50 行' })).toBeDisabled()
    await pager.getByRole('button', { name: '前の 50 行' }).click()
    await expect(pager).toContainText('51〜100 行目')
  })

  test('a view and a 表 without a key are read-only @mock @story', async ({ page, mock }) => {
    void mock
    await page.goto(`${dataUrl}?table=public.inventory_summary`)
    await expect(page.getByRole('heading', { name: '在庫サマリー', exact: true })).toBeVisible()
    await expect(page.getByText('この表は見るだけです')).toBeVisible()
    await expect(page.getByRole('button', { name: '行を追加' })).toHaveCount(0)
    await expect(page.getByRole('table', { name: '在庫サマリーの行' }).getByRole('row')).toHaveCount(13)
    await expect(page.getByRole('table', { name: '在庫サマリーの行' }).getByRole('link')).toHaveCount(0)

    await switchTable(page, /^旧システムの取込データ/)
    await expect(page.getByText('この表は見るだけです')).toBeVisible()
    await expect(page.getByRole('button', { name: '行を追加' })).toHaveCount(0)
  })

  test('a refresh answered with unreadable rows keeps the grid under one notice, and the next good read clears it @mock @story', async ({ page, mock }, testInfo) => {
    void mock
    let corrupt = false
    let corrupted = 0
    let goodReads = 0
    await page.route(`**${productsRowsPath}?*`, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      if (!corrupt) {
        goodReads++
        return route.fulfill({ response })
      }
      corrupt = false
      corrupted++
      return route.fulfill({ response, json: { ...(await response.json()), rows: 'the rows of this table' } })
    })
    await page.goto(`${dataUrl}?table=public.products`)
    const products = page.getByRole('table', { name: '商品の行' })
    await expect(products.getByRole('row')).toHaveCount(13)
    await expect(products.getByRole('row', { name: /ノートPC/ })).toContainText('120,000')
    const rows = await products.getByRole('row').allTextContents()
    const notice = page.getByText(REFRESH_FAILED)
    await expect(notice).toHaveCount(0)

    // 「↻」 reads the rows again and gets 200 with the rows as a string.
    const before = goodReads
    corrupt = true
    await page.getByRole('button', { name: '読み込み直す', exact: true }).click()
    await expect.poll(() => corrupted).toBe(1)
    await expect(notice).toHaveCount(1)
    expect(await products.getByRole('row').allTextContents()).toEqual(rows)
    await expect(page.getByText('the rows of this table')).toHaveCount(0)
    await expect(page.getByText('情報を読み込めませんでした')).toHaveCount(0)
    await expect(page.getByText(/まだ行がありません/)).toHaveCount(0)
    // The toolbar, the rows and the row Sheet stay usable.
    await expect(page.getByRole('searchbox', { name: '検索' })).toBeEnabled()
    await expect(page.getByRole('button', { name: '行を追加' })).toBeEnabled()
    await products.getByRole('link', { name: 'ノートPC', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: /ノートPC/ })
    await expect(sheet.locator('[data-field="stock"] dd')).toHaveText('8')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(notice).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('malformed-rows-notice.png'), fullPage: true })

    // The notice's retry reads good rows again: it leaves, the rows stay.
    await page.getByRole('status').filter({ hasText: REFRESH_FAILED }).getByRole('button').click()
    await expect.poll(() => goodReads).toBeGreaterThan(before)
    await expect(notice).toHaveCount(0)
    expect(corrupted).toBe(1)
    expect(await products.getByRole('row').allTextContents()).toEqual(rows)
  })

  test('forbidden, suspended, unsupported and empty databases are explained, never a grid @mock @story', async ({ page, mock }) => {
    await mock.platform('data', { mode: 'forbidden' })
    await withExpectedFailures([tablesRefused(403, 'no data read permission')], async () => {
      await page.goto(dataUrl)
      await expect(page.getByText('データを見る権限がまだありません', { exact: true })).toBeVisible()
    })
    await expect(page.getByText('基盤の担当者に「データの閲覧」を依頼してください')).toBeVisible()
    await expect(page.getByRole('link', { name: /担当者に聞く/ })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'アプリのページ' }).getByLabel('データを見る権限がまだありません')).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)

    await mock.platform('data', { mode: 'suspended' })
    await withExpectedFailures([tablesRefused(412, 'the database is suspended')], async () => {
      await page.reload()
      await expect(page.getByText('データベースは停止中です。アプリを開くと起動し、データが見られます。')).toBeVisible()
    })
    await expect(page.getByRole('link', { name: '開く ↗' })).toHaveAttribute('href', /^https:\/\/mitsumori\./)
    await expect(page.getByRole('table')).toHaveCount(0)

    await mock.platform('data', { mode: 'unsupported' })
    await withExpectedFailures([tablesRefused(412, 'the database engine is not supported')], async () => {
      await page.reload()
      await expect(page.getByText('この種類のデータベースはまだ対応していません')).toBeVisible()
    })
    await expect(page.getByRole('table')).toHaveCount(0)

    await mock.platform('data', { mode: 'empty' })
    await page.reload()
    await expect(page.getByText('まだ表がありません。アプリが最初のデータを作ると表示されます。')).toBeVisible()
    await expect(tableSelect(page)).toHaveCount(0)
  })

  test('a Team membership that grants no database access names the cause and links to team settings @mock @story', async ({ page, mock }) => {
    // Production /config names the Dashboard's Team settings (cmd/server); the Vite dev config does not.
    const settingsUrl = 'https://dashboard.appthrust.test/dashboard/settings'
    const config = (url: URL) => url.pathname === '/config'
    await page.route(config, (route) => route.fulfill({ json: { projectId: 'commerce', dashboardUrl: settingsUrl, newAppConversation: false } }))
    await mock.platform('data', { mode: 'subject-unbound' })
    const notice = page.getByRole('status').filter({ hasText: 'いまのチームメンバー登録では、データへのアクセスが許可されていません' })
    await withExpectedFailures([tablesRefused(412, 'the signed-in subject is not bound to a Team member')], async () => {
      await page.goto(dataUrl)
      await expect(notice).toContainText('まだサインインしていません。このメールアドレスで最初にサインインすると、データベースと実行環境へのアクセスが許可されます。')
    })
    await expect(notice.getByRole('link', { name: 'チームの設定を開く' })).toHaveAttribute('href', settingsUrl)
    // Not the generic 403: the Data tab carries the lock named after this cause, and no grid renders.
    await expect(page.getByText('データを見る権限がまだありません', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: 'アプリのページ' }).getByLabel('いまのチームメンバー登録では、データへのアクセスが許可されていません')).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)

    // The overview's データベースの変更 card gets the same notice from the change list's 412.
    const changes = page.getByRole('region', { name: 'データベースの変更' })
    await withExpectedFailures([{ method: 'GET', path: '/api/v1/projects/{projectId}/databases/{database}/changes', status: 412, count: 1, reason: 'the change list is refused for the same unbound subject' }], async () => {
      await page.goto(`/${app.groupPath}/${app.slug}`)
      await expect(changes.getByRole('status')).toContainText('いまのチームメンバー登録では、データへのアクセスが許可されていません')
    })
    await expect(changes.getByRole('link', { name: 'チームの設定を開く' })).toHaveAttribute('href', settingsUrl)
    // Wait for the data tab before switching the cause, so the reload does not cut its reads off.
    await withExpectedFailures([tablesRefused(412, 'the signed-in subject is not bound to a Team member')], async () => {
      await page.goto(dataUrl)
      await expect(notice).toContainText('まだサインインしていません。')
    })

    await mock.platform('data', { mode: 'not-persisted' })
    await page.unroute(config)
    await page.route(config, (route) => route.fulfill({ json: { projectId: 'commerce' } }))
    await withExpectedFailures([tablesRefused(412, 'the role comes from an administrator or group, not a Team member')], async () => {
      await page.reload()
      await expect(notice).toContainText('役割は基盤の管理者またはグループから来ています。このユーザーをチームメンバーとして追加すると、データベースと実行環境へのアクセスが許可されます。')
    })
    // Without a Dashboard URL in the config the link is left out rather than guessed.
    await expect(notice.getByRole('link')).toHaveCount(0)
  })
})
