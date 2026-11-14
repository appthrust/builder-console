import { expect, freeUrlNameChecks, seed, test, withExpectedFailures } from '../support/fixtures'
import {
  continueToShare,
  fillAppDetails,
  openCreateWizard,
  pickExistingRepository,
  pickShareScope,
  submitCreateWizard,
  waitForAppPage,
} from '../support/create-wizard'

test.describe('App create from an existing repository @create', () => {
  test('adopts a seeded GitHub repository and opens its app with the saved details @mock @story', async ({ page, mock: _mock }) => {
    const repositoryName = 'acme/sales-dashboard'
    const displayName = '営業ダッシュボード'
    const description = '営業の実績をまとめて確認します。'
    const tags = ['営業', '集計']
    const group = seed.groups.teamA

    await openCreateWizard(page)
    let slug = ''
    await withExpectedFailures([freeUrlNameChecks(2)], async () => {
      await pickExistingRepository(page, repositoryName)
      await fillAppDetails(page, { displayName, description, tags })
      slug = await continueToShare(page)
    })
    expect(slug).toBe('sales-dashboard')
    await pickShareScope(page, '全社')
    await expect(page.getByTestId('confirm-summary')).toContainText(`「${displayName}」を ${group.name} のアプリとして作り、全社に公開します`)
    await expect(page.getByText(repositoryName, { exact: true })).toBeVisible()
    // The image location is Platform's answer to the adoption validation, never computed here.
    await expect(page.getByText('ghcr.io/acme/sales-dashboard', { exact: true })).toBeVisible()

    const writes = await submitCreateWizard(page, 'repository')
    const draft = writes.draft.body
    if (!draft || typeof draft !== 'object' || !('displayName' in draft) || !('groupId' in draft) || !('share' in draft)) {
      throw new Error('Console create did not send app details and sharing')
    }
    expect(draft).toEqual({
      displayName,
      description,
      tags,
      groupId: group.id,
      slug,
      share: { scope: 'company', groupIds: [], extraPersonIds: [] },
    })

    const repository = writes.repository?.body
    if (!repository || typeof repository !== 'object' || !('existing' in repository) || !('sourceConnectionId' in repository)) {
      throw new Error('Repository adoption did not send its existing repository and source connection')
    }
    // Adoption names its connection and repository only; Platform derives the image path and its access.
    expect(repository).toEqual({
      sourceConnectionId: 'github-source-207cb7ce',
      existing: { repository: repositoryName, ref: 'develop' },
    })

    const stack = writes.stack.body
    if (!stack || typeof stack !== 'object' || !('source' in stack) || !('application' in stack)) {
      throw new Error('Stack create did not send its application and source')
    }
    expect(stack).toMatchObject({
      templateId: 'nextjs-postgres',
      application: { name: slug },
      branch: { id: 'production', role: 'production', createIfMissing: true },
      source: { kind: 'application-source-repository', sourceRepositoryId: 'sales-dashboard-src' },
      publish: { enabled: true, customDomain: 'commerce.appthrust.test', hostnamePattern: 'wildcard', subdomain: slug },
    })

    const bind = writes.bind.body
    if (!bind || typeof bind !== 'object' || !('stackId' in bind) || !('appName' in bind)) {
      throw new Error('Console bind did not send its stack and application name')
    }
    expect(bind).toEqual({ stackId: slug, appName: slug })

    const app = { displayName, slug, groupPath: group.path }
    await waitForAppPage(page, app)
    await expect(page.getByTestId('source-link')).toHaveAttribute('href', `https://github.com/${repositoryName}`)
    await page.reload()
    await waitForAppPage(page, app)
    await expect(page.getByText(description, { exact: true })).toBeVisible()
    for (const tag of tags) await expect(page.getByText(tag, { exact: true })).toBeVisible()
    await expect(page.getByTestId('source-link')).toHaveAttribute('href', `https://github.com/${repositoryName}`)
  })
})
