import { test, expect, seed, captureWrite, freeUrlNameChecks, withExpectedFailures } from '../support/fixtures'
import { textJa } from '../../src/model/build/copy'
import { numberedUrlName } from '../../src/model/create'

// A URL can be claimed after planning. Recover with a rename intent against a
// legacy stored plan, without cleanup or resending schema-added defaults.
test('a creation URL conflict offers a checked name and retry creates the app @app-build-ai @mock @story', async ({ page, mock, request }, testInfo) => {
  test.setTimeout(90_000)
  await mock.platform('codex', { available: true })
  await mock.platform('plan-generation', { outcome: 'succeeded', autoAdvance: false })
  const root = `/api/v1/projects/${seed.projectId}`
  const draft = (await (await request.post(`${root}/application-drafts`, { data: { intent: '顧客を管理するアプリ', title: '顧客管理' } })).json()).resource
  const path = `${root}/application-drafts/${draft.id}`
  await request.post(`${path}/creation-plan-generations`, { data: {} })
  for (let step = 0; step < 4; step++) await mock.advance()
  const planned = await (await request.get(path)).json()
  const urlName = planned.creationPlan.applicationStackRequest.publish.subdomain
  const suggested = numberedUrlName(urlName, 2)
  // The real pre-#5827 plan had neither application nor database.provider.
  const storedStack = planned.creationPlan.applicationStackRequest
  storedStack.applicationName = urlName
  delete storedStack.application
  delete storedStack.database.provider
  expect((await request.patch(path, { data: { creationPlan: planned.creationPlan } })).ok()).toBe(true)
  const stored = await (await request.get(path)).json()
  expect(stored.creationPlan.applicationStackRequest).not.toHaveProperty('application')
  expect(stored.creationPlan.applicationStackRequest.database).not.toHaveProperty('provider')
  await mock.platform('plan-generation', { autoAdvance: true })
  await mock.platform('creation-publish-conflict')
  const cleanups: string[] = []
  page.on('request', (write) => {
    if (write.method() === 'POST' && new URL(write.url()).pathname === `${path}/creation-cleanups`) cleanups.push(write.url())
  })
  await page.goto(`/-/build/${draft.id}`)
  const checkedSuggestion = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/console/resolve' && url.searchParams.get('path')?.endsWith(`/${suggested}`) === true
  })
  const conversation = page.getByRole('log', { name: 'AI との会話' })
  const choice = page.getByRole('button', { name: `${suggested} にする`, exact: true })
  await withExpectedFailures([freeUrlNameChecks(1)], async () => {
    await page.getByRole('button', { name: 'この内容で作る', exact: true }).click()
    await expect(conversation).toContainText(textJa.failure.urlNameTaken, { timeout: 20_000 })
    await expect(choice).toBeVisible()
    expect((await checkedSuggestion).status()).toBe(404)
  })
  const failed = await (await request.get(path)).json()
  expect(failed.creationExecutions.at(-1).steps.find((step: { status: string }) => step.status === 'failed')).toMatchObject({
    tool: 'appthrust.applicationStack.validate', detail: { reason: 'PublishURLConflict' },
  })
  expect(failed.createdApplicationStackId).toBeFalsy()
  expect(failed.createdSourceRepositoryId).toBeFalsy()
  const stacks = await (await request.get(`${root}/application-stacks`)).json()
  expect(stacks.data.some((stack: { applicationName: string }) => stack.applicationName === suggested)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('url-conflict-suggestion.png'), fullPage: true })
  const update = await captureWrite(page, 'PATCH', path, () => choice.click())
  expect(update.body).toEqual({ renameApplication: { name: suggested } })
  await expect.poll(async () => (await (await request.get(path)).json()).creationExecutions.at(-1)?.status, { timeout: 20_000 }).toBe('succeeded')
  const created = await (await request.get(path)).json()
  expect(created.createdApplicationStackId).toBeTruthy()
  expect(created.creationPlan.applicationStackRequest.publish.subdomain).toBe(suggested)
  expect(created.creationPlan.applicationStackRequest.applicationName).toBe(suggested)
  expect(created.creationPlan.applicationStackRequest).not.toHaveProperty('application')
  expect(created.creationPlan.applicationStackRequest.database).toEqual(storedStack.database)
  expect(created.createdSourceRepositories[0].repositoryName).toBe(planned.creationPlan.applicationSourceRepositoryRequest.destination.repositoryName)
  expect(created.creationExecutions).toHaveLength(2)
  expect(cleanups).toEqual([])
  await expect(page.getByTestId('build-session')).toHaveAttribute('data-stage', 'build', { timeout: 20_000 })
  await expect(conversation).not.toContainText(textJa.failure.urlNameTaken)
  await page.screenshot({ path: testInfo.outputPath('url-conflict-retry-created.png'), fullPage: true })
})
