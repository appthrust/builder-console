import { textJa as buildText } from '../../src/features/build/copy'
import { expect, freeUrlNameChecks, seed, test, withExpectedFailures } from '../support/fixtures'
import { fillAppDetails, openCreateWizard, pickImage } from '../support/create-wizard'

// Only members of a group create apps there, from every entry (APT-1128). A member chooses among their own groups;
// someone who belongs to no group cannot start any entry, and the mock refuses the writes like the server.

const BUILD_SESSIONS = '/api/console/v1/build-sessions'
const headers = { connection: 'close' }

test.describe('Creating needs a group membership @create', () => {
  test('a member chooses only among the groups they belong to, whatever group the link names @mock @story', async ({ page, request }, testInfo) => {
    // The server's rule: a group the caller does not belong to is refused, for a Console administrator too.
    const refused = await request.post('/api/console/apps', { headers, data: { displayName: 'Not mine', slug: 'not-mine', groupId: seed.groups.soumu.id } })
    expect(refused.status()).toBe(400)
    expect(await refused.json()).toMatchObject({ message: 'groupId must be one of your directory groups' })

    // 山田 (a Console administrator) belongs to 営業1課 only; the link asks for 総務部, which he only looks at.
    await page.goto(`/new?group=${seed.groups.soumu.path}`)
    await expect(page.getByRole('heading', { name: 'どんなアプリを作りますか？' })).toBeVisible()
    await expect(page.getByTestId('create-no-group')).toHaveCount(0)
    await expect(page.getByTestId('create-excel2app')).toHaveAttribute('href', '/-/excel2app')
    await page.screenshot({ path: testInfo.outputPath('new-app-member.png'), fullPage: true })
    const group = page.getByLabel(/^所属グループ/)
    await withExpectedFailures([freeUrlNameChecks(2)], async () => {
      await pickImage(page, 'ghcr.io/acme/demo:1.0.0')
      await expect(group).toHaveText(seed.groups.teamA.name)
      // Leaving the name field for the group checks the URL name is free; that check answers within this step.
      await fillAppDetails(page, { displayName: 'Group rule' })
      const nameChecked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/console/resolve')
      await group.click()
      await expect(page.getByRole('option')).toHaveText([seed.groups.teamA.name])
      await page.keyboard.press('Escape')
      await nameChecked
    })
  })

  test('membership is inherited downwards: a member of a parent group chooses it and every group below it @mock @story', async ({ page, mock }) => {
    // 佐藤 manages 営業本部 (and is a member of 営業企画部 below it); 総務部 is not hers.
    await mock.console('caller', { personId: 'p-sato', role: 'Editor' })
    await openCreateWizard(page)
    await withExpectedFailures([freeUrlNameChecks(2)], async () => {
      await pickImage(page, 'ghcr.io/acme/demo:1.0.0')
      await fillAppDetails(page, { displayName: 'Group rule' })
      const nameChecked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/console/resolve')
      await page.getByLabel(/^所属グループ/).click()
      await expect(page.getByRole('option')).toHaveText([seed.groups.sales.name, seed.groups.salesEast.name, seed.groups.teamA.name, '営業2課', seed.groups.planning.name])
      await nameChecked
    })
  })

  test('someone who belongs to no group can start no entry, and nothing is created @mock @story', async ({ page, request, mock }, testInfo) => {
    await mock.console('leave-groups')
    const writes: string[] = []
    page.on('request', (sent) => {
      const path = new URL(sent.url()).pathname
      if (sent.method() !== 'GET' && !path.includes('/__mock/') && (path.endsWith('/application-drafts') || path === '/api/console/apps' || path === BUILD_SESSIONS)) writes.push(`${sent.method()} ${path}`)
    })

    await openCreateWizard(page)
    const notice = page.getByTestId('create-no-group')
    await expect(notice).toContainText(buildText.page.noGroup.title)
    await expect(notice).toContainText(buildText.page.noGroup.body)
    await expect(notice.getByRole('link', { name: buildText.page.noGroup.directory, exact: true })).toHaveAttribute('href', '/company')
    await page.getByLabel('やりたいことを書く', { exact: true }).fill('備品の貸し出しを記録したい')
    // AI, AI customization, business templates, existing code, Excel.
    await expect(page.getByRole('button', { name: 'AI と作る', exact: true })).toBeDisabled()
    const customize = page.getByRole('button', { name: 'AI でカスタマイズ', exact: true })
    await expect(customize.first()).toBeVisible()
    for (const button of await customize.all()) await expect(button).toBeDisabled()
    const templates = page.locator('[data-testid^="template-"]')
    await expect(templates.first()).toBeVisible()
    for (const template of await templates.all()) await expect(template).toBeDisabled()
    await expect(page.getByRole('button', { name: /作ったコードから/ })).toBeDisabled()
    await expect(page.getByTestId('create-excel2app')).toBeDisabled()
    await expect(page.getByTestId('create-excel2app')).not.toHaveAttribute('href', /./)
    // Framework template and container image.
    await page.getByRole('button', { name: '詳しい人向け', exact: true }).click()
    await expect(page.getByRole('button', { name: '空のアプリを選ぶ', exact: true })).toBeDisabled()
    await expect(page.getByLabel('コンテナイメージ', { exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'このイメージで次へ', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '次へ', exact: true })).toBeDisabled()
    // The guidance stands once, not again under every entry.
    await expect(page.getByText(buildText.page.noGroup.body, { exact: true })).toHaveCount(1)
    // A full-page capture from the top keeps the sticky shell in place.
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: testInfo.outputPath('new-app-no-group.png'), fullPage: true })

    // The Excel page opened directly does not open its upload (which makes the draft).
    await page.goto('/-/excel2app')
    await expect(page.getByTestId('excel2app-no-group')).toContainText(buildText.page.noGroup.body)
    await expect(page.getByTestId('excel2app-drop')).toHaveCount(0)
    expect(writes).toEqual([])

    // The server's rules, as another client would meet them: no app and no AI session in any group.
    const app = await request.post('/api/console/apps', { headers, data: { displayName: 'No group', slug: 'no-group', groupId: seed.groups.teamA.id } })
    expect(app.status()).toBe(400)
    const session = await request.post(BUILD_SESSIONS, { headers: { ...headers, 'Idempotency-Key': `story-${crypto.randomUUID()}` }, data: { kind: 'new-app', groupId: seed.groups.teamA.id, intent: '備品の貸し出しを記録したい', locale: 'ja' } })
    expect(session.status()).toBe(404)
    expect(await session.json()).toMatchObject({ error: 'not_found', message: 'Build group is not accessible' })
  })
})
