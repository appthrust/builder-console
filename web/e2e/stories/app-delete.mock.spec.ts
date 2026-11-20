import type { Route } from '@playwright/test'
import { test, expect, seed, captureWrite, withExpectedFailures } from '../support/fixtures'

test.describe('App delete @app', () => {
  test('deletes the stack, its source binding and the app, keeps the GitHub repository, and retires its URL @mock @story', async ({ page, mock }) => {
    void mock
    const app = seed.apps.keihi
    const appPath = `/${app.groupPath}/${app.slug}`
    const groupPath = `/${app.groupPath}`
    const groupApps = `${groupPath}/-/apps`
    const main = page.getByRole('main')

    await page.goto('/mine')
    await expect(page.getByRole('heading', { level: 1, name: '自分のアプリ', exact: true })).toBeVisible()
    await expect(main.getByRole('table').getByRole('link', { name: new RegExp(app.name) })).toBeVisible()
    await page.goto(groupApps)
    await expect(page.getByRole('heading', { level: 1, name: seed.groups.teamA.name, exact: true })).toBeVisible()
    await expect(main.getByRole('link', { name: new RegExp(app.name) })).toBeVisible()

    await page.goto(`${appPath}/-/settings`)
    await expect(page.getByRole('heading', { level: 1, name: app.name, exact: true })).toBeVisible()
    // Wait for the joined Platform view before deletion so useDeleteApp includes the seeded stack.
    await expect(page.getByTestId('env-table').getByRole('row').filter({ hasText: 'APP_TITLE' })).toContainText(app.slug)
    await page.getByRole('region', { name: '危険な操作', exact: true }).getByRole('button', { name: '削除する', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `「${app.name}」を削除しますか？`, exact: true })
    await expect(dialog).toContainText('アプリと URL、保存されたデータを削除します。元に戻せません。')
    await expect(dialog).toContainText(`GitHub の置き場（acme/${app.slug}）は消さずに残ります。`)
    await dialog.getByLabel(`確認のため「${app.name}」と入力してください。`, { exact: true }).fill(app.name)

    // Stack first, then the source binding the console made for it, then the console record (the index) last.
    const sources = `/api/v1/projects/${seed.projectId}/application-source-repositories`
    const consoleDelete = await captureWrite(page, 'DELETE', `/api/console/apps/${app.id}`, async () => {
      const sourceDelete = await captureWrite(page, 'DELETE', `${sources}/${app.slug}-src`, async () => {
        const platformDelete = await captureWrite(
          page,
          'DELETE',
          `/api/v1/projects/${seed.projectId}/application-stacks/${app.slug}`,
          () => dialog.getByRole('button', { name: '完全に削除する', exact: true }).click()
        )
        expect(platformDelete.body).toBeNull()
        expect((await platformDelete.request.response())?.status()).toBe(202)
      })
      expect(sourceDelete.body).toBeNull()
      expect(await sourceDelete.request.headerValue('idempotency-key')).toBeTruthy()
      expect((await sourceDelete.request.response())?.status()).toBe(202)
    })
    expect(consoleDelete.body).toBeNull()
    expect((await consoleDelete.request.response())?.status()).toBe(204)
    const remaining: unknown = await (await page.request.get(sources)).json()
    expect(JSON.stringify(remaining)).not.toContain(`"${app.slug}-src"`)
    expect(JSON.stringify(remaining)).toContain(`"${seed.apps.mitsumori.slug}-src"`)

    await expect(page).toHaveURL(groupPath)
    await expect(page.getByRole('heading', { level: 1, name: seed.groups.teamA.name, exact: true })).toBeVisible()
    await expect(main.getByRole('link', { name: seed.apps.mitsumori.name, exact: true })).toBeVisible()
    await expect(main.getByRole('link', { name: new RegExp(app.name) })).toHaveCount(0)
    await page.goto(groupApps)
    await expect(main.getByRole('link', { name: new RegExp(seed.apps.nippo.name) })).toBeVisible()
    await expect(main.getByRole('link', { name: new RegExp(app.name) })).toHaveCount(0)

    await page.goto('/mine')
    await expect(page.getByRole('heading', { level: 1, name: '自分のアプリ', exact: true })).toBeVisible()
    await expect(main.getByRole('table').getByRole('link', { name: new RegExp(seed.apps.mitsumori.name) })).toBeVisible()
    await expect(main.getByRole('link', { name: new RegExp(app.name) })).toHaveCount(0)

    await withExpectedFailures([{ method: 'GET', path: '/api/console/resolve', status: 404, count: 1, reason: 'the deleted app\'s URL resolves to nothing' }], async () => {
      await page.goto(appPath)
      await expect(page.getByRole('heading', { level: 1, name: 'ページが見つかりません', exact: true })).toBeVisible()
    })
    await expect(main.getByText(appPath, { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: app.name, exact: true })).toHaveCount(0)
  })

  // APT-1234: Platform refuses to delete an app that still has work areas (412 `branch_has_active_delivery`, the
  // blockers counted by kind). Only that answer is rewritten in the browser; once they are gone the same dialog
  // deletes the app.
  test('a deletion stopped by the app\'s remaining work areas says what blocks it and what to do, never the platform\'s message @mock @story', async ({ page, mock }, testInfo) => {
    void mock
    const app = seed.apps.keihi
    const stackPath = `/api/v1/projects/${seed.projectId}/application-stacks/${app.slug}`
    const deletes: number[] = []
    await page.route(`**${stackPath}`, (route: Route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      deletes.push(412)
      return route.fulfill({ status: 412, json: { error: { code: 'failed_precondition', message: 'application branch still has active delivery consumers', details: {
        reason: 'branch_has_active_delivery',
        activeConsumers: [{ kind: 'DevWorkspace', count: 2 }],
        nextActions: ['Stop or delete the listed delivery consumers, then retry the Application Branch deletion.'],
      } } } })
    })

    await page.goto(`/${app.groupPath}/${app.slug}/-/settings`)
    await expect(page.getByRole('heading', { level: 1, name: app.name, exact: true })).toBeVisible()
    await expect(page.getByTestId('env-table').getByRole('row').filter({ hasText: 'APP_TITLE' })).toContainText(app.slug)
    await page.getByRole('region', { name: '危険な操作', exact: true }).getByRole('button', { name: '削除する', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `「${app.name}」を削除しますか？`, exact: true })
    await dialog.getByLabel(`確認のため「${app.name}」と入力してください。`, { exact: true }).fill(app.name)
    const confirm = dialog.getByRole('button', { name: '完全に削除する', exact: true })

    await withExpectedFailures([{ method: 'DELETE', path: stackPath, status: 412, count: 1, reason: 'the app still has work areas' }], async () => {
      await confirm.click()
      const refusal = dialog.getByRole('alert')
      await expect(refusal).toContainText('このアプリにはまだ残っているものがあるため、削除できませんでした')
      await expect(refusal).toContainText('このアプリの作業場所が 2 か所残っています。')
      await expect(refusal).toContainText('この画面からは片づけられません。基盤の担当者に片づけてもらってから、もう一度「完全に削除する」を押してください。')
    })
    for (const word of ['application branch', 'delivery consumers', 'DevWorkspace', '操作に失敗しました']) await expect(dialog.getByText(word)).toHaveCount(0)
    expect(deletes).toEqual([412])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('delete-blocked.png'), fullPage: true })

    // The work areas are gone: the same dialog deletes the app.
    await page.unroute(`**${stackPath}`)
    await confirm.click()
    await expect(page).toHaveURL(`/${app.groupPath}`)
    await expect(page.getByRole('main').getByRole('link', { name: new RegExp(app.name) })).toHaveCount(0)
  })
})
