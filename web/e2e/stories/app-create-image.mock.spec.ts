import { expect, freeUrlNameChecks, seed, test, withExpectedFailures } from '../support/fixtures'
import {
  continueToShare,
  fillAppDetails,
  openCreateWizard,
  pickImage,
  pickShareScope,
  submitCreateWizard,
  waitForAppPage,
} from '../support/create-wizard'

test.describe('App create from a container image @create', () => {
  test('creates an app from an image and reads back its source and details @mock @story', async ({ page, mock: _mock }) => {
    const imageRef = 'ghcr.io/acme/demo:1.0.0'
    const displayName = 'Image demo'
    const description = '既存のコンテナイメージを公開します。'
    const tags = ['デモ', 'コンテナ']
    const group = seed.groups.teamA

    await openCreateWizard(page)
    let slug = ''
    await withExpectedFailures([freeUrlNameChecks(3)], async () => {
      await pickImage(page, imageRef)
      await fillAppDetails(page, { displayName, description, tags })
      slug = await continueToShare(page)
    })
    expect(slug).toBe('image-demo')
    await pickShareScope(page, '自分だけ')
    await expect(page.getByTestId('confirm-summary')).toContainText(`「${displayName}」を ${group.name} のアプリとして作り、自分だけに公開します`)
    await page.getByRole('button', { name: '詳しい人向け', exact: true }).click()
    await expect(page.getByText(imageRef, { exact: true })).toBeVisible()

    const writes = await submitCreateWizard(page, 'image')
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
      share: { scope: 'private', groupIds: [], extraPersonIds: [] },
    })

    const stack = writes.stack.body
    if (!stack || typeof stack !== 'object' || !('source' in stack) || !('application' in stack)) {
      throw new Error('Stack create did not send its application and source')
    }
    expect(stack).toMatchObject({
      templateId: 'nextjs-postgres',
      definitionRef: { name: 'web-postgres', version: 'v1' },
      application: { name: slug },
      branch: { id: 'production', role: 'production', createIfMissing: true },
      source: { kind: 'sample-image', imageRef },
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
    await page.reload()
    await waitForAppPage(page, app)
    await expect(page.getByText(description, { exact: true })).toBeVisible()
    for (const tag of tags) await expect(page.getByText(tag, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '詳しい人向け（イメージ・ポート・ひな形）', exact: true }).click()
    await expect(page.getByText(imageRef, { exact: true })).toBeVisible()
  })
})
