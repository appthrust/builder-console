import { test, expect, seed, withExpectedFailures, type ExpectedFailure } from '../support/fixtures'

/** A deep link resolves its path; the console answers a non-member with 403 not_project_member. */
const refusedResolve: ExpectedFailure = { method: 'GET', path: '/api/console/resolve', status: 403, count: 1, reason: 'a non-member cannot resolve app paths' }

test('explains Project non-membership with its Team, hides app actions, and lets the user log out @mock @story', async ({ page, request, mock }) => {
  const teamSlug = 'owning-project-team'
  const title = 'この基盤（Project）のメンバーではありません'
  const body = `この基盤は Team「${teamSlug}」が管理しています。管理者に追加を依頼してください。`
  await mock.console('not-member', { teamSlug })

  const me = await request.get('/api/console/me')
  expect(me.status()).toBe(200)
  expect(await me.json()).toMatchObject({
    notMember: true, teamSlug, isConsoleAdmin: false, canCreateApps: false,
  })
  const apps = await request.get('/api/console/apps')
  expect(apps.status()).toBe(403)
  expect(await apps.json()).toEqual({ error: 'not_project_member', message: `This Project belongs to Team ${teamSlug}` })

  await page.goto('/')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible()
  await expect(main.getByText(body, { exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'メインメニュー' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /新しいアプリ/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /新しいアプリ/ })).toHaveCount(0)
  await expect(main.getByRole('table')).toHaveCount(0)
  await expect(page.getByText('いまアプリの作成状態を確認できません', { exact: true })).toHaveCount(0)

  // A deep app link must not replace the explanation with a route-load failure.
  await withExpectedFailures([refusedResolve], async () => {
    await page.goto(`/${seed.apps.mitsumori.groupPath}/${seed.apps.mitsumori.slug}`)
    await expect(main.getByRole('heading', { name: title, exact: true })).toBeVisible()
  })
  await expect(main.getByText(body, { exact: true })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await withExpectedFailures([refusedResolve], async () => {
    await page.reload()
    await expect(main.getByRole('heading', { name: title, exact: true })).toBeVisible()
  })
  await expect(main.getByText(body, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'メニューを開く', exact: true })).toHaveCount(0)

  // Before the server has read the Project successfully, it must not invent a Team name.
  await mock.console('not-member', { teamSlug: '' })
  await withExpectedFailures([refusedResolve], async () => {
    await page.reload()
    await expect(main.getByText('管理者に追加を依頼してください。', { exact: true })).toBeVisible()
  })
  await expect(main.getByText(body, { exact: true })).toHaveCount(0)

  // The edge owns logout; prove this stays a full document navigation, not an API call.
  await page.route('**/logout', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Signed out</p>' }))
  await page.getByRole('button', { name: 'ユーザーメニュー', exact: true }).click()
  const logout = page.getByRole('menuitem', { name: 'ログアウト', exact: true })
  await expect(logout).toHaveAttribute('href', '/logout')
  await logout.click()
  await expect(page).toHaveURL('/logout')
  await expect(page.getByText('Signed out', { exact: true })).toBeVisible()
})
