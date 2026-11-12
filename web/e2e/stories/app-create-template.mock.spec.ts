import { expect, seed, test } from '../support/fixtures'
import {
  continueToShare,
  openCreateWizard,
  pickBusinessTemplate,
  pickShareScope,
  submitCreateWizard,
  waitForAppPage,
} from '../support/create-wizard'

test.describe('App create from a business template @create', () => {
  test('creates the suggested inventory app for its group, publishes it, and finds it in mine @mock @story', async ({ page, mock }) => {
    const displayName = '在庫管理'
    const description = '品物の在庫と入出庫を、ひとつの画面で管理します。'
    const group = seed.groups.teamA

    await openCreateWizard(page)
    await pickBusinessTemplate(page, 'biz-inventory-postgres')
    await expect(page.getByRole('textbox', { name: 'アプリの名前 必須', exact: true })).toHaveValue(displayName)
    await expect(page.getByLabel('説明（任意）', { exact: true })).toHaveValue(description)
    // A kanji-only name takes the template's English word, not a random app-<hex>.
    await expect(page.getByTestId('url-name')).toHaveText('inventory')
    await expect(page.getByTestId('url-preview')).toContainText('https://inventory.commerce.appthrust.test')
    const slug = await continueToShare(page)
    expect(slug).toBe('inventory')
    await expect(page.getByRole('checkbox', { name: group.name, exact: true })).toBeChecked()
    await expect(page.getByTestId('share-preview')).toContainText(`${group.name} に公開`)
    await pickShareScope(page, group.name)
    await expect(page.getByTestId('confirm-summary')).toContainText(`「${displayName}」を ${group.name} のアプリとして作り`)

    const writes = await submitCreateWizard(page, 'repository')
    const draft = writes.draft.body
    if (!draft || typeof draft !== 'object' || !('displayName' in draft) || !('groupId' in draft) || !('share' in draft)) {
      throw new Error('Console create did not send app details and sharing')
    }
    expect(draft).toEqual({
      displayName,
      description,
      tags: [],
      groupId: group.id,
      slug,
      share: { scope: 'group', groupIds: [group.id], extraPersonIds: [] },
    })

    const repository = writes.repository?.body
    if (!repository || typeof repository !== 'object' || !('template' in repository) || !('destinationRevision' in repository) || !('destination' in repository)) {
      throw new Error('Template create did not send its template, destination and destination revision')
    }
    // The platform resolves owner, connection and image path; the console only binds the revision it showed.
    expect(repository).toEqual({
      template: { repository: 'appthrust/template-biz-inventory', ref: 'main' },
      destination: { repositoryName: slug, visibility: 'private' },
      destinationRevision: expect.stringMatching(/^rev-github-source-207cb7ce-/),
      image: { tagFilter: 'edge-', versioningScheme: 'Alphabetical' },
      build: { mode: 'observed-image', ref: 'main' },
    })

    const stack = writes.stack.body
    if (!stack || typeof stack !== 'object' || !('source' in stack) || !('application' in stack)) {
      throw new Error('Stack create did not send its application and source')
    }
    expect(stack).toMatchObject({
      templateId: 'biz-inventory-postgres',
      definitionRef: { name: 'web-postgres', version: 'v1' },
      application: { name: slug },
      branch: { id: 'production', role: 'production', createIfMissing: true },
      source: { kind: 'application-source-repository', sourceRepositoryId: `${slug}-src` },
      publish: { enabled: true, customDomain: 'commerce.appthrust.test', hostnamePattern: 'wildcard', subdomain: slug },
    })

    const bind = writes.bind.body
    if (!bind || typeof bind !== 'object' || !('stackId' in bind) || !('appName' in bind)) {
      throw new Error('Console bind did not send its stack and application name')
    }
    expect(bind).toEqual({ stackId: slug, appName: slug })

    const app = { displayName, slug, groupPath: group.path }
    await waitForAppPage(page, app)
    await expect(page.getByText(description, { exact: true })).toBeVisible()
    // The mock exposes the public URL only at stage 3 (置き場 → 最初の版 → URL → 公開中).
    for (let stage = 0; stage < 3; stage++) expect(await mock.advance()).toBeGreaterThan(0)
    await expect(page.getByTestId('overview-status-text')).toHaveText(/^最新の版 \(v1(?:・.*)?\) が動いています。$/, { timeout: 15_000 })
    await expect(page.getByText('公開中', { exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('app-url')).toHaveAttribute('href', `https://${slug}.commerce.appthrust.test/`)
    await expect(page.getByTestId('app-meta')).toContainText(`限定（1 人・${group.name}）`)

    await page.reload()
    await waitForAppPage(page, app)
    await expect(page.getByTestId('app-url')).toHaveAttribute('href', `https://${slug}.commerce.appthrust.test/`)
    await expect(page.getByTestId('source-link')).toHaveAttribute('href', `https://github.com/acme/${slug}`)
    await page.goto('/mine')
    await expect(page.getByRole('heading', { name: '自分のアプリ', exact: true })).toBeVisible()
    const listedApp = page.getByRole('table').getByRole('link', { name: displayName })
    await expect(listedApp).toHaveAttribute('href', `/${group.path}/${slug}`)
    await listedApp.click()
    await waitForAppPage(page, app)
    await expect(page.getByTestId('app-url')).toHaveAttribute('href', `https://${slug}.commerce.appthrust.test/`)
  })
})
