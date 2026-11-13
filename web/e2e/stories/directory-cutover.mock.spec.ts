import { captureWrite, expect, seed, test } from '../support/fixtures'

test.describe('Directory cutover @directory', () => {
  test('groups and members are read-only with links into the Directory; profiles redirect there @mock @story', async ({ page, mock }) => {
    void mock
    const main = page.getByRole('main')
    const team = seed.groups.teamA

    await page.goto(`/${team.path}`)
    await expect(main.getByRole('heading', { name: team.name, exact: true, level: 1 })).toBeVisible()
    // The headline counts the team's own members; people reached through 営業本部 are secondary.
    await expect(main.getByText('メンバー 2 人・ほか継承 1 人', { exact: true })).toBeVisible()
    const tabs = main.getByRole('navigation', { name: 'グループのページ', exact: true })
    await expect(tabs.getByRole('link')).toHaveText(['フロント', 'アプリ', 'メンバー'])
    const manage = main.getByRole('link', { name: 'ディレクトリで管理', exact: true })
    await expect(manage).toHaveAttribute('href', new RegExp(`/groups/${team.id}$`))
    await expect(manage).toHaveAttribute('target', '_blank')
    await expect(main.getByRole('button', { name: '書く', exact: true })).toHaveCount(0)
    await expect(main.getByRole('button', { name: '編集', exact: true })).toHaveCount(0)
    // People live in the Directory: a maker chip leaves the console, so it opens a new tab and this page stays.
    const maker = main.getByRole('region', { name: 'この部署で作っている人', exact: true }).getByRole('link').first()
    await expect(maker).toHaveAttribute('href', /\/people\/[^/]+$/)
    await expect(maker).toHaveAttribute('target', '_blank')
    await expect(maker).toHaveAttribute('rel', /noopener/)

    await tabs.getByRole('link', { name: 'メンバー', exact: true }).click()
    await expect(page).toHaveURL(`/${team.path}/-/members`)
    const members = main.getByRole('table', { name: 'メンバー', exact: true })
    await expect(members.getByRole('row').filter({ hasText: seed.me.name })).toBeVisible()
    await expect(members.getByRole('row').filter({ hasText: '佐藤 花子' })).toHaveCount(0)
    const inheritedToggle = main.getByRole('button', { name: '上位グループから引き継いだメンバー（1 人）', exact: true })
    await expect(inheritedToggle).toHaveAttribute('aria-expanded', 'false')
    await inheritedToggle.click()
    const inherited = main.getByRole('table', { name: '上位グループから引き継いだメンバー（1 人）', exact: true })
    await expect(inherited.getByRole('row').filter({ hasText: '佐藤 花子' })).toContainText('営業本部 から')
    await expect(main.getByRole('button', { name: '人を追加' })).toHaveCount(0)
    await expect(main.getByRole('combobox')).toHaveCount(0)
    await expect(main.getByText('メンバーの追加や役割の変更は、ディレクトリで行います。', { exact: true })).toBeVisible()

    await page.goto(`/${team.path}/-/settings`)
    await expect(main.getByRole('heading', { name: 'ページが見つかりません', exact: true })).toBeVisible()
    await page.goto('/-/admin/groups')
    await expect(main.getByRole('heading', { name: 'ページが見つかりません', exact: true })).toBeVisible()

    await page.goto('/-/account')
    await expect(main.getByRole('link', { name: 'ディレクトリで変更する', exact: true })).toHaveAttribute('href', /\/people\/me$/)

    // The Directory app serves the profile; the mock has no Directory UI, so stand in for its page.
    await page.route((url) => url.pathname === '/people/p-sato', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Directory profile</h1>' }))
    await page.goto('/-/people/p-sato')
    await page.waitForURL((url) => url.pathname === '/people/p-sato')
    await expect(page.getByRole('heading', { name: 'Directory profile', exact: true })).toBeVisible()
  })

  test('a console admin moves people and groups into the Directory once and sees the result @mock @story', async ({ page, mock }) => {
    await mock.console('migration', {})
    await page.goto('/-/admin/platform')
    const main = page.getByRole('main')
    const banner = main.getByRole('status').filter({ hasText: '人とグループをディレクトリへ移す' })
    await expect(banner).toContainText('人 4 人・グループ 6 件・所属 5 件')
    await banner.getByRole('button', { name: 'ディレクトリへ移す', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '人とグループをディレクトリへ移しますか？', exact: true })
    const migrate = await captureWrite(page, 'POST', '/api/console/admin/directory-migrate', () => dialog.getByRole('button', { name: '移す', exact: true }).click())
    expect(migrate.request.method()).toBe('POST')
    const done = main.getByRole('status').filter({ hasText: 'ディレクトリへ移しました' })
    await expect(done).toContainText('移した数: 人 4 人・グループ 6 件・所属 5 件')
    await expect(main.getByRole('button', { name: 'ディレクトリへ移す', exact: true })).toHaveCount(0)

    await page.reload()
    await expect(main.getByRole('heading', { name: '基盤の設定', exact: true, level: 1 })).toBeVisible()
    await expect(main.getByText('人とグループをディレクトリへ移す', { exact: true })).toHaveCount(0)
  })
})
