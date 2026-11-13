import { expect, freeUrlNameChecks, seed, test, withExpectedFailures } from '../support/fixtures'
import { continueToShare, fillAppDetails, openCreateWizard, pickImage, pickShareScope, submitCreateWizard, waitForAppPage } from '../support/create-wizard'

test('creation retries delivery_pending with one key and completes sharing only after policy observation @mock @story', async ({ page, mock }, testInfo) => {
  const writes: Array<{ key: string | undefined; body: unknown }> = []
  let allowWrite!: () => void
  const gate = new Promise<void>((resolve) => { allowWrite = resolve })
  await page.route('**/publishes/access-proof-web/access', async (route) => {
    const request = route.request()
    if (request.method() !== 'PUT') return route.continue()
    writes.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() })
    if (writes.length === 1) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'conflict', message: 'Delivery pending', details: { reason: 'delivery_pending' } } }) })
    await gate
    await route.continue()
  })
  try {
    await openCreateWizard(page)
    await withExpectedFailures([freeUrlNameChecks(3)], async () => {
      await pickImage(page, 'ghcr.io/acme/demo:1.0.0')
      await fillAppDetails(page, { displayName: 'Access proof' })
      expect(await continueToShare(page)).toBe('access-proof')
    })
    await pickShareScope(page, '自分だけ')
    await withExpectedFailures([{ method: 'PUT', path: '/api/v1/projects/{projectId}/publishes/access-proof-web/access', status: 409, count: 1, reason: 'the first access write meets delivery_pending' }], async () => {
      await submitCreateWizard(page, 'image')
      await waitForAppPage(page, { displayName: 'Access proof', slug: 'access-proof', groupPath: seed.groups.teamA.path })
      await mock.advance()
      await mock.advance()
      await mock.advance()
      await expect(page.getByTestId('app-url')).toBeVisible({ timeout: 12_000 })
      await expect.poll(() => writes.length, { timeout: 12_000 }).toBe(2)
    })
    const share = page.getByTestId('create-progress').locator('[data-step="share"]')
    await expect(share).not.toHaveAttribute('data-state', 'done')
    expect(writes[0]?.body).toEqual({ mode: 'Authenticated', externalAuthorization: { appInstallation: 'builder-console' } })
    expect(writes[0]?.key).toBeTruthy()
    expect(writes[1]?.key).toBe(writes[0]?.key)
    allowWrite()
    await expect(share).toHaveAttribute('data-state', 'active')
    await expect(share).toContainText('反映中')
    await page.screenshot({ path: testInfo.outputPath('create-access-pending.png'), fullPage: true })
    // Once the requested audience is observed on the publish, creation is over:
    // the progress list gives way to the plain overview with the applied label.
    await expect(page.getByTestId('create-progress')).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByTestId('overview-status-text')).toBeVisible()
    await expect(page.getByTestId('header-access-status')).toHaveText('限定（1 人）')
    await page.screenshot({ path: testInfo.outputPath('create-access-done.png'), fullPage: true })
    await page.reload()
    await expect(page.getByTestId('header-access-status')).toHaveText('限定（1 人）')
    expect(writes).toHaveLength(2)
  } finally {
    allowWrite()
  }
})

test('a rejected creation access write stays unfinished until sharing is successfully applied @mock @story', async ({ page, mock }) => {
  await mock.platform('access-forbidden', { forbidden: true })
  await openCreateWizard(page)
  await withExpectedFailures([freeUrlNameChecks(3)], async () => {
    await pickImage(page, 'ghcr.io/acme/demo:1.0.0')
    await fillAppDetails(page, { displayName: 'Access recovery' })
    await continueToShare(page)
  })
  await pickShareScope(page, '自分だけ')
  const share = page.getByTestId('create-progress').locator('[data-step="share"]')
  await withExpectedFailures([{ method: 'PUT', path: '/api/v1/projects/{projectId}/publishes/access-recovery-web/access', status: 403, count: 1, reason: 'the Platform refuses the access write without Team Editor' }], async () => {
    await submitCreateWizard(page, 'image')
    await waitForAppPage(page, { displayName: 'Access recovery', slug: 'access-recovery', groupPath: seed.groups.teamA.path })
    await mock.advance()
    await mock.advance()
    await mock.advance()
    await expect(share).toHaveAttribute('data-state', 'failed', { timeout: 12_000 })
    await expect(page.getByText('基盤の編集権限（Team Editor）が必要です', { exact: true })).toBeVisible()
  })
  await mock.platform('access-forbidden', { forbidden: false })
  await page.getByRole('button', { name: '共有', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '共有', exact: true })
  await dialog.getByRole('button', { name: '公開範囲を反映する', exact: true }).click()
  await expect(page.getByTestId('share-access-status')).toHaveText('反映中')
  await expect(page.getByTestId('share-access-status')).toHaveText('限定（1 人）', { timeout: 12_000 })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('create-progress')).toHaveCount(0)
  await expect(page.getByTestId('header-access-status')).toHaveText('限定（1 人）')
  await expect(page.getByText('基盤の編集権限（Team Editor）が必要です', { exact: true })).toHaveCount(0)
})
