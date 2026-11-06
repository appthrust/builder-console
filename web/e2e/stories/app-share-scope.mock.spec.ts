import { captureWrite, expect, seed, test } from '../support/fixtures'

test('scope writes platform access before console metadata and observes pending then ready @mock @story', async ({ page, mock }, testInfo) => {
  void mock
  const app = seed.apps.mitsumori
  const consolePath = `/api/console/apps/${app.id}`
  const accessPath = `/api/v1/projects/${seed.projectId}/publishes/${app.slug}-web/access`
  const order: string[] = []
  page.on('request', (request) => { const path = new URL(request.url()).pathname; if (request.method() === 'PUT' && path === accessPath) order.push('platform'); if (request.method() === 'PATCH' && path === consolePath) order.push('console') })
  await page.goto(`/${app.groupPath}/${app.slug}/-/settings`)
  await expect(page.getByTestId('header-access-status')).toHaveText('公開中（誰でも）')
  await page.getByRole('region', { name: '公開範囲', exact: true }).getByRole('button', { name: '共有', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '共有', exact: true })
  await dialog.getByRole('radio', { name: /^指定した人のみ / }).click()
  const first = await captureWrite(page, 'PUT', accessPath, () => dialog.getByRole('button', { name: '保存', exact: true }).click())
  expect(first.body).toEqual({ mode: 'Authenticated', externalAuthorization: { appInstallation: 'builder-console' } })
  expect(first.request.headers()['idempotency-key']).toBeTruthy()
  await expect(page.getByTestId('share-access-status')).toHaveText('反映中')
  await page.screenshot({ path: testInfo.outputPath('share-pending.png'), fullPage: true })
  await expect(page.getByTestId('share-access-status')).toHaveText('限定（1 人）', { timeout: 12_000 })
  expect(order).toEqual(['platform', 'console'])
  expect((await (await page.request.get(consolePath)).json()).share.scope).toBe('private')

  await dialog.getByRole('radio', { name: /^全社 / }).click()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '公開範囲を広げますか？', exact: true })
  await confirmation.getByLabel(`確認のため「${app.name}」と入力してください。`, { exact: true }).fill(app.name)
  const second = await captureWrite(page, 'PUT', accessPath, () => confirmation.getByRole('button', { name: '広げて保存する', exact: true }).click())
  expect(second.body).toEqual({ mode: 'Authenticated' })
  await expect(confirmation).not.toBeVisible()
  await expect(page.getByTestId('share-access-status')).toHaveText('社員のみ', { timeout: 12_000 })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-access-status')).toHaveText('社員のみ')
  await page.screenshot({ path: testInfo.outputPath('share-company.png'), fullPage: true })
})

test('platform 403 changes no console metadata and explains Team Editor @mock @story', async ({ page, mock }, testInfo) => {
  await mock.platform('access-forbidden', { forbidden: true })
  const app = seed.apps.mitsumori
  const consolePath = `/api/console/apps/${app.id}`
  const before = await (await page.request.get(consolePath)).json()
  const writes: string[] = []
  page.on('request', (request) => { if (request.method() === 'PATCH' && new URL(request.url()).pathname === consolePath) writes.push(request.url()) })
  await page.goto(`/${app.groupPath}/${app.slug}`)
  await page.getByRole('button', { name: '共有', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '共有', exact: true })
  await dialog.getByRole('radio', { name: /^指定した人のみ / }).click()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByText('基盤の編集権限（Team Editor）が必要です', { exact: true })).toBeVisible()
  await expect(page.getByTestId('share-access-status')).toHaveText('未適用（基盤の権限が必要）')
  expect(writes).toEqual([])
  expect(await (await page.request.get(consolePath)).json()).toEqual(before)
  await page.screenshot({ path: testInfo.outputPath('share-forbidden.png'), fullPage: true })
})

for (const scope of ['private', 'group'] as const) {
  test(`rejected ${scope} access stays failed outside the dialog and recovers on successful apply @mock @story`, async ({ page, mock }) => {
    void mock
    const app = seed.apps.mitsumori
    const consolePath = `/api/console/apps/${app.id}`
    const accessPath = `/api/v1/projects/${seed.projectId}/publishes/${app.slug}-web/access`
    const before = await (await page.request.get(consolePath)).json()
    await page.route(`**${accessPath}`, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      expect(route.request().postDataJSON()).toEqual({ mode: 'Authenticated', externalAuthorization: { appInstallation: 'builder-console' } })
      await route.fulfill({ status: 400, json: { error: { code: 'invalid_argument', message: 'invalid publish access request' } } })
    })
    await page.goto(`/${app.groupPath}/${app.slug}/-/settings`)
    await page.getByRole('region', { name: '公開範囲', exact: true }).getByRole('button', { name: '共有', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '共有', exact: true })
    await dialog.getByRole('radio', { name: scope === 'private' ? /^指定した人のみ / : /^グループ / }).click()
    await dialog.getByRole('button', { name: /^(保存|公開範囲を反映する)$/ }).click()
    const failed = '公開範囲の反映に失敗（現在は誰でもアクセスできます）'
    await expect(page.getByTestId('share-access-status')).toHaveText(failed)
    expect(await (await page.request.get(consolePath)).json()).toEqual(before)
    expect(await (await page.request.get(accessPath)).json()).toEqual({ mode: 'Public' })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('header-access-status')).toHaveText(failed)
    await expect(page.getByTestId('settings-access-status')).toHaveText(failed)
    await page.unroute(`**${accessPath}`)
    await page.getByRole('region', { name: '公開範囲', exact: true }).getByRole('button', { name: '共有', exact: true }).click()
    await expect(page.getByTestId('share-access-status')).toHaveText(failed)
    await dialog.getByRole('radio', { name: scope === 'private' ? /^指定した人のみ / : /^グループ / }).click()
    await dialog.getByRole('button', { name: /^(保存|公開範囲を反映する)$/ }).click()
    await expect(page.getByTestId('share-access-status')).toHaveText(/^限定（/, { timeout: 12_000 })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('header-access-status')).toHaveText(/^限定（/)
    expect((await (await page.request.get(consolePath)).json()).share.scope).toBe(scope)
  })
}

test('public access requires an administrator and name confirmation @mock @story', async ({ page, mock }) => {
  void mock
  const app = seed.apps.mitsumori
  await page.goto(`/${app.groupPath}/${app.slug}`)
  await page.getByRole('button', { name: '共有', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '共有', exact: true })
  await dialog.getByRole('radio', { name: /^社外にも / }).click()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '公開範囲を広げますか？', exact: true })
  const save = confirmation.getByRole('button', { name: '広げて保存する', exact: true })
  await expect(save).toBeDisabled()
  await confirmation.getByLabel(`確認のため「${app.name}」と入力してください。`, { exact: true }).fill(app.name)
  const result = await captureWrite(page, 'PUT', `/api/v1/projects/${seed.projectId}/publishes/${app.slug}-web/access`, () => save.click())
  expect(result.body).toEqual({ mode: 'Public' })
  await expect(confirmation).not.toBeVisible()
  await expect(dialog.getByText('誰でも', { exact: true })).toBeVisible()
  await expect(page.getByTestId('share-access-status')).toHaveText('公開中（誰でも）', { timeout: 12_000 })
  await page.route('**/api/console/me', async (route) => {
    const response = await route.fetch()
    const me = await response.json()
    await route.fulfill({ response, json: { ...me, isConsoleAdmin: false } })
  })
  await page.reload()
  await page.getByRole('button', { name: '共有', exact: true }).click()
  await expect(dialog.getByRole('radio', { name: /^社外にも / })).toBeDisabled()
})
