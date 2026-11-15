import type { Page, TestInfo } from '@playwright/test'
import { captureWrite, expect, freeUrlNameChecks, seed, test, withExpectedFailures } from '../support/fixtures'
import {
  continueToShare,
  fillAppDetails,
  openCreateWizard,
  pickBusinessTemplate,
  pickExistingRepository,
  pickShareScope,
  submitCreateWizard,
  waitForAppPage,
} from '../support/create-wizard'
import { textJa as buildText } from '../../src/model/build/copy'
import { textJa as createText } from '../../src/features/create/copy'

// Where a new repository and its image go is the Project's repository
// destination, resolved by Platform (`GET repository-destination`); the
// console shows it and binds the create to its revision. The mock switches it
// with `__mock/repository-destination` (src/dev/mock-platform.ts).
const root = `/api/v1/projects/${seed.projectId}`

async function currentDestination(page: Page): Promise<{ state: string; revision?: string; destination?: { registryNamespace: string } }> {
  return (await page.request.get(`${root}/repository-destination`)).json()
}

/** Desktop and mobile captures of the settled screen; the page never scrolls sideways. */
async function captureWidths(page: Page, testInfo: TestInfo, name: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} fits ${width}px`).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}

/** The template path up to 確認して作る: 在庫管理 → inventory, shared with its group. */
async function templateToConfirm(page: Page) {
  await openCreateWizard(page)
  let slug = ''
  await withExpectedFailures([freeUrlNameChecks(2)], async () => {
    await pickBusinessTemplate(page, 'biz-inventory-postgres')
    slug = await continueToShare(page)
  })
  expect(slug).toBe('inventory')
  await pickShareScope(page, seed.groups.teamA.name)
  return slug
}

test.describe('App create at the Project repository destination @create', () => {
  test('a built-in registry destination: the confirm step shows the repository and the registry location, and the create binds its revision @mock @story', async ({ page, mock }, testInfo) => {
    await mock.platform('repository-destination', { state: 'builtin' })
    const destination = await currentDestination(page)
    expect(destination).toMatchObject({ state: 'Resolved', destination: { registryNamespace: 'registry.appthrust.test/commerce' } })
    const slug = await templateToConfirm(page)

    await expect(page.getByText(createText.destination.repository, { exact: true })).toBeVisible()
    await expect(page.getByText(`acme/${slug}`, { exact: true })).toBeVisible()
    await expect(page.getByText(createText.destination.image, { exact: true })).toBeVisible()
    await expect(page.getByText(`registry.appthrust.test/commerce/${slug}`, { exact: true })).toBeVisible()
    await captureWidths(page, testInfo, 'confirm-builtin')

    const writes = await submitCreateWizard(page, 'repository')
    // Only the template, the name and the revision shown: never a registry connection or an image path.
    expect(writes.repository?.body).toEqual({
      template: { repository: 'appthrust/template-biz-inventory', ref: 'main' },
      destination: { repositoryName: slug, visibility: 'private' },
      destinationRevision: destination.revision,
      build: { mode: 'observed-image', ref: 'main' },
    })
    expect(writes.stack.body).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: `${slug}-src` } })
    await waitForAppPage(page, { displayName: '在庫管理', slug, groupPath: seed.groups.teamA.path })
    // Platform pushed the image under the built-in registry it resolved.
    const made = await (await page.request.get(`${root}/application-source-repositories/${slug}-src`)).json()
    expect(made.image.imagePath).toBe(`registry.appthrust.test/commerce/${slug}`)
  })

  test('a destination not set disables the template and AI entries with the fixed notice; adopting existing code still works @mock @story', async ({ page, mock }, testInfo) => {
    await mock.platform('codex', { available: true })
    await mock.platform('repository-destination', { state: 'NotConfigured' })
    await openCreateWizard(page)
    await page.getByLabel('やりたいことを書く', { exact: true }).fill('備品の貸し出しを記録するアプリ')

    const notice = page.getByTestId('create-destination-blocked')
    await expect(notice).toHaveText(createText.destination.blocked)
    // One notice for the page, not one per entry; the server's reason never shows.
    await expect(page.getByText(createText.destination.blocked, { exact: true })).toHaveCount(1)
    await expect(page.getByText('No repository destination', { exact: false })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'AI と作る', exact: true })).toBeDisabled()
    await expect(page.getByTestId('template-biz-inventory-postgres')).toBeDisabled()
    // The wizard's remembered choice is not shown as chosen while it cannot be used.
    await expect(page.getByTestId('template-biz-inventory-postgres')).toHaveAttribute('aria-pressed', 'false')
    const customize = page.getByRole('button', { name: createText.customizeWithAi, exact: true })
    await expect(customize).not.toHaveCount(0)
    for (const button of await customize.all()) await expect(button).toBeDisabled()
    await page.getByRole('button', { name: '詳しい人向け', exact: true }).click()
    await expect(page.getByRole('button', { name: '空のアプリを選ぶ', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '詳しい人向け', exact: true }).click()
    await expect(page.getByRole('button', { name: /作ったコードから/ })).toBeEnabled()
    await captureWidths(page, testInfo, 'start-blocked')

    const repositoryName = 'acme/sales-dashboard'
    const displayName = '営業ダッシュボード'
    let slug = ''
    await withExpectedFailures([freeUrlNameChecks(2)], async () => {
      await pickExistingRepository(page, repositoryName)
      await fillAppDetails(page, { displayName })
      slug = await continueToShare(page)
    })
    await pickShareScope(page, '全社')
    await expect(page.getByText('ghcr.io/acme/sales-dashboard', { exact: true })).toBeVisible()
    await expect(notice).toHaveCount(0)
    const writes = await submitCreateWizard(page, 'repository')
    expect(writes.repository?.body).toEqual({ sourceConnectionId: 'github-source-207cb7ce', existing: { repository: repositoryName, ref: 'develop' } })
    await waitForAppPage(page, { displayName, slug, groupPath: seed.groups.teamA.path })
  })

  test('a destination that changes between display and submit shows the new one and creates only after the user confirms again @mock @story', async ({ page, mock }, testInfo) => {
    const slug = await templateToConfirm(page)
    await expect(page.getByText(`ghcr.io/acme/${slug}`, { exact: true })).toBeVisible()
    const sourceWrites: string[] = []
    page.on('request', (sent) => {
      const path = new URL(sent.url()).pathname
      if (sent.method() === 'POST' && path.startsWith(`${root}/application-source-repositories`)) sourceWrites.push(path)
    })

    // An administrator moves the destination to the built-in registry after the page read it.
    await mock.platform('repository-destination', { state: 'builtin' })
    const moved = await currentDestination(page)
    await withExpectedFailures([{ method: 'POST', path: '/api/v1/projects/{projectId}/application-source-repositories/validate', status: 409, count: 1, reason: 'the shown destination revision is no longer current (DestinationChanged)' }], async () => {
      const reread = page.waitForResponse((response) => new URL(response.url()).pathname === `${root}/repository-destination` && response.ok())
      await page.getByRole('button', { name: '作る', exact: true }).click()
      await expect(page.getByText(createText.destination.changedTitle, { exact: true })).toBeVisible()
      await reread
      await expect(page.getByText(`registry.appthrust.test/commerce/${slug}`, { exact: true })).toBeVisible()
    })
    await expect(page.getByText(`ghcr.io/acme/${slug}`, { exact: true })).toHaveCount(0)
    // Nothing was created and nothing is sent again on its own.
    expect(sourceWrites).toEqual([`${root}/application-source-repositories/validate`])
    await captureWidths(page, testInfo, 'confirm-changed')
    expect(sourceWrites).toHaveLength(1)

    const created = await captureWrite(page, 'POST', `${root}/application-source-repositories`, async () => {
      await page.getByRole('button', { name: '作る', exact: true }).click()
    })
    expect(created.body).toMatchObject({ destination: { repositoryName: slug }, destinationRevision: moved.revision })
    await waitForAppPage(page, { displayName: '在庫管理', slug, groupPath: seed.groups.teamA.path })
    const made = await (await page.request.get(`${root}/application-source-repositories/${slug}-src`)).json()
    expect(made.image.imagePath).toBe(`registry.appthrust.test/commerce/${slug}`)
  })

  test('the AI proposal shows the destination; one that moved before approval is shown with a fixed notice and creates on the next approval @mock @story', async ({ page, mock, request }, testInfo) => {
    test.setTimeout(90_000)
    await mock.platform('codex', { available: true })
    await mock.platform('plan-generation', { outcome: 'succeeded', autoAdvance: false })
    const draft = (await (await request.post(`${root}/application-drafts`, { data: { intent: '顧客を管理するアプリ', title: '顧客管理' } })).json()).resource
    const path = `${root}/application-drafts/${draft.id}`
    await request.post(`${path}/creation-plan-generations`, { data: {} })
    for (let step = 0; step < 4; step++) await mock.advance()
    const planned = await (await request.get(path)).json()
    const name: string = planned.creationPlan.applicationSourceRepositoryRequest.destination.repositoryName
    const shown = await currentDestination(page)
    expect(planned.creationPlan.applicationSourceRepositoryRequest.destinationRevision).toBe(shown.revision)
    await mock.platform('plan-generation', { autoAdvance: true })

    await page.goto(`/-/build/${draft.id}`)
    const proposal = page.getByTestId('build-proposal')
    await expect(proposal.getByText(`ghcr.io/acme/${name}`, { exact: true })).toBeVisible()
    const create = page.getByRole('button', { name: 'この内容で作る', exact: true })
    await expect(create).toBeEnabled({ timeout: 20_000 })
    await captureWidths(page, testInfo, 'ai-proposal-ghcr')

    const creationWrites: string[] = []
    page.on('request', (sent) => {
      const pathname = new URL(sent.url()).pathname
      if (sent.method() === 'POST' && /\/creation-(plan-validations|executions|cleanups)/.test(pathname)) creationWrites.push(pathname.slice(path.length))
    })
    await mock.platform('repository-destination', { state: 'builtin' })
    const moved = await currentDestination(page)
    // The approval reads the destination first: it moved, so the plan is bound to the new one and nothing is approved.
    const rebound = await captureWrite(page, 'PATCH', path, () => create.click())
    expect(rebound.body).toMatchObject({ creationPlan: { applicationSourceRepositoryRequest: { destinationRevision: moved.revision } } })
    expect(rebound.body).not.toHaveProperty('creationPlan.applicationSourceRepositoryRequest.image.imagePath')
    const conversation = page.getByRole('log', { name: 'AI との会話' })
    const notice = conversation.getByRole('status').filter({ hasText: buildText.failure.destination.changed.title })
    await expect(notice).toContainText(buildText.failure.destination.changed.reason)
    // Not a fault to report: no support reference, and the side pane does not repeat it.
    await expect(notice.getByRole('button', { name: buildText.failure.copyReference, exact: true })).toHaveCount(0)
    await expect(page.getByText(buildText.failure.destination.changed.title, { exact: true })).toHaveCount(1)
    await expect(proposal.getByText(`registry.appthrust.test/commerce/${name}`, { exact: true })).toBeVisible()
    await expect(proposal.getByText(`ghcr.io/acme/${name}`, { exact: true })).toHaveCount(0)
    // One way on: the notice carries the approval (the proposal does not repeat it).
    await expect(page.getByRole('button', { name: 'この内容で作る', exact: true })).toHaveCount(1)
    await expect(notice.getByRole('button', { name: 'この内容で作る', exact: true })).toBeEnabled()
    expect(creationWrites).toEqual([])
    await captureWidths(page, testInfo, 'ai-changed')
    expect(creationWrites).toEqual([])

    // The user approves the destination now shown: a fresh preparation, nothing to clean up.
    await notice.getByRole('button', { name: 'この内容で作る', exact: true }).click()
    await expect.poll(async () => (await (await request.get(path)).json()).creationExecutions.at(-1)?.status, { timeout: 20_000 }).toBe('succeeded')
    await expect(conversation.getByText(buildText.failure.destination.changed.title, { exact: true })).toHaveCount(0)
    const done = await (await request.get(path)).json()
    const made = await (await request.get(`${root}/application-source-repositories/${done.createdSourceRepositoryId}`)).json()
    expect(made.image.imagePath).toBe(`registry.appthrust.test/commerce/${name}`)
    await expect(page.getByTestId('build-session')).toHaveAttribute('data-stage', 'build', { timeout: 20_000 })
  })
})
