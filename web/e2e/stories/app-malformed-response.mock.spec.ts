import type { Route } from '@playwright/test'
import { test, expect, seed } from '../support/fixtures'

// The app screens against an answer they cannot read (console wire-boundary
// design §6, X3/X5): a malformed release-history poll keeps that panel's last
// rows under one fixed notice while the header, tabs and the URL card stay
// usable, and the notice leaves with the next good poll; a settings save
// answered 2xx unreadably offers only 「最新の状態を確認する」 and is never sent
// again. Only the answer under test is rewritten, in the browser; the mock stays well-formed.
const app = seed.apps.mitsumori
const appPath = `/${app.groupPath}/${app.slug}`
const releasesPath = `/api/v1/projects/${seed.projectId}/applications/${app.slug}/releases`
const consolePath = `/api/console/apps/${app.id}`
const REFRESH_FAILED = /^更新できませんでした。/

test.describe('app screens with an unreadable answer @app-malformed-response', () => {
  // The page keeps polling through the rewriting routes; a poll still inside
  // `route.fetch` when the test body returns would fail the test as "Test ended".
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('one malformed release-history poll keeps the rows under one notice, the rest stays usable, and it clears on the next good poll @mock @story', async ({ page, mock }, testInfo) => {
    void mock
    let corrupt = false
    let corrupted = 0
    let goodReads = 0
    await page.route(`**${releasesPath}*`, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      if (!corrupt) {
        goodReads++
        return route.fulfill({ response })
      }
      corrupt = false
      corrupted++
      return route.fulfill({ response, json: { ...(await response.json()), components: [{ id: `${app.slug}-web`, releases: 'the releases of this app' }] } })
    })
    await page.goto(`${appPath}/-/releases`)
    const heading = page.getByRole('heading', { level: 1, name: app.name, exact: true })
    await expect(heading).toBeVisible()
    const history = page.getByTestId('release-history')
    const table = history.getByRole('table', { name: '更新履歴（新しい順）' })
    await expect(table.getByRole('row')).toHaveCount(5)
    // The rollback actions come from a second read (release state); the rows are settled once they are offered.
    await expect(table.getByRole('button', { name: 'この版に戻す' })).toHaveCount(2)
    const rows = await table.getByRole('row').allTextContents()
    const notice = page.getByText(REFRESH_FAILED)
    await expect(notice).toHaveCount(0)

    // The next poll (every 5 s) answers 200 with the releases as a string.
    const before = goodReads
    corrupt = true
    await expect.poll(() => corrupted, { timeout: 12_000 }).toBe(1)
    await expect(notice).toHaveCount(1)
    await expect(history.getByText(REFRESH_FAILED)).toBeVisible()
    expect(await table.getByRole('row').allTextContents()).toEqual(rows)
    await expect(page.getByTestId('current-version')).toHaveText('v3')
    await expect(page.getByText('the releases of this app')).toHaveCount(0)
    await expect(page.getByText('情報を読み込めませんでした')).toHaveCount(0)
    // The header, the tabs and the URL card are untouched and usable.
    await expect(heading).toBeVisible()
    await expect(page.getByTestId('app-url')).toBeVisible()
    await expect(page.getByRole('button', { name: 'URL をコピー', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '共有', exact: true })).toBeEnabled()
    await expect(table.getByRole('button', { name: 'v2 この版に戻す', exact: true })).toBeEnabled()
    await page.getByRole('link', { name: '設定', exact: true }).click()
    await expect(page.getByRole('region', { name: '名前と説明', exact: true })).toBeVisible()
    await page.getByRole('link', { name: '更新履歴', exact: true }).click()
    await expect(table.getByRole('row')).toHaveCount(5)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('malformed-releases-notice.png'), fullPage: true })

    // The following poll reads good releases again: the notice leaves, the rows stay.
    await expect.poll(() => goodReads, { timeout: 12_000 }).toBeGreaterThan(before)
    await expect(notice).toHaveCount(0)
    expect(corrupted).toBe(1)
    expect(await table.getByRole('row').allTextContents()).toEqual(rows)
  })

  test('a settings save answered 2xx unreadably offers only 「最新の状態を確認する」, which re-reads and never resends @mock @story', async ({ page, mock }, testInfo) => {
    void mock
    const patches: number[] = []
    let reads = 0
    await page.route(`**${consolePath}`, async (route: Route) => {
      const method = route.request().method()
      if (method === 'GET') reads++
      if (method !== 'PATCH') return route.continue()
      const response = await route.fetch()
      patches.push(response.status())
      return route.fulfill({ response, json: { ...(await response.json()), share: 'the share of this app' } })
    })
    await page.goto(`${appPath}/-/settings`)
    await expect(page.getByRole('heading', { level: 1, name: app.name, exact: true })).toBeVisible()
    const general = page.getByRole('region', { name: '名前と説明', exact: true })
    const name = '見積作成 v2'
    await general.getByLabel(/^アプリの名前/).fill(name)
    const save = general.getByRole('button', { name: '保存', exact: true })
    await save.click()

    const warning = general.getByRole('status').filter({ hasText: '処理結果を確認できませんでした' })
    await expect(warning).toHaveCount(1)
    await expect(warning.getByRole('button')).toHaveCount(1)
    await expect(warning.getByRole('button', { name: '最新の状態を確認する', exact: true })).toBeVisible()
    await expect(general.getByRole('button', { name: 'もう一度試す', exact: true })).toHaveCount(0)
    await expect(general.getByText('保存しました。', { exact: true })).toHaveCount(0)
    await expect(save).toBeDisabled()
    await expect(general.getByLabel(/^アプリの名前/)).toHaveValue(name)
    await expect(page.getByText('the share of this app')).toHaveCount(0)
    expect(patches).toEqual([200])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('unreadable-save-confirm.png'), fullPage: true })

    const before = reads
    await warning.getByRole('button', { name: '最新の状態を確認する', exact: true }).click()
    await expect.poll(() => reads).toBeGreaterThan(before)
    await expect(warning).toHaveCount(0)
    // The write had happened: the read-back shows the new name, and nothing was sent again.
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
    expect(patches).toEqual([200])
  })
})
