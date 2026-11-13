import type { Application, ApplicationReleaseOverview, ApplicationStack, ComponentReleaseState, Publish } from '@appthrust/api-schema/platform-api'
import { test, expect, seed, captureWrite } from '../support/fixtures'

test.describe('App releases @app-releases', () => {
  test('restores an older release and retains the current version after reload @mock @story', async ({ page, mock }) => {
    // Request the fixture so this story starts from both mocks' seeded state.
    void mock
    const app = seed.apps.mitsumori
    await page.goto(`/${app.groupPath}/${app.slug}/-/releases`)
    await expect(page.getByRole('heading', { name: app.name, exact: true })).toBeVisible()
    const history = page.getByTestId('release-history').getByRole('table', { name: '更新履歴（新しい順）' })
    await expect(history).toBeVisible()
    await expect(history.getByRole('row')).toHaveCount(5)
    await expect(page.getByTestId('current-version')).toHaveText('v3')
    await expect(history.getByRole('row', { name: /^v3\b/ })).toContainText('いま動いている')
    await expect(history.getByRole('row', { name: /^v4\b/ })).toContainText('待機中')
    await expect(history.getByRole('row', { name: /^v4\b/ })).not.toContainText('いま動いている')
    await expect(history.getByRole('row', { name: /^v1\b/ })).toBeVisible()
    const olderRelease = history.getByRole('row', { name: /^v2\b/ })
    await expect(olderRelease.getByTitle('edge-v2', { exact: true })).toBeVisible()
    await olderRelease.getByRole('button', { name: 'v2 この版に戻す', exact: true }).click()

    const confirmation = page.getByRole('dialog', { name: '前の版に戻しますか？', exact: true })
    await expect(confirmation).toContainText('版 v2 に戻します。よろしいですか？')
    const rollback = await captureWrite(
      page,
      'POST',
      `/api/v1/projects/${seed.projectId}/applications/${app.slug}/branches/production/components/${app.slug}-web/rollback`,
      async () => { await confirmation.getByRole('button', { name: 'この版に戻す', exact: true }).click() }
    )
    if (!rollback.body || typeof rollback.body !== 'object' || !('targetTransitionId' in rollback.body)) {
      throw new Error('Rollback must send the selected release transition ID')
    }
    expect(rollback.body).toEqual({ targetTransitionId: 'tr-edgev2' })
    await expect(confirmation).not.toBeVisible()
    await expect(page.getByText('戻す処理を始めました。', { exact: true })).toBeVisible()

    // Rollback synchronously appends a new release of edge-v2; UI numbering is by release, not image tag.
    await expect(page.getByTestId('current-version')).toHaveText('v5')
    await expect(history.getByRole('row')).toHaveCount(6)
    const restoredRelease = history.getByRole('row', { name: /^v5\b/ })
    await expect(restoredRelease).toContainText('いま動いている')
    await expect(restoredRelease.getByTitle('edge-v2', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('current-version')).toHaveText('v5')
    await expect(restoredRelease).toContainText('いま動いている')
    await expect(restoredRelease.getByTitle('edge-v2', { exact: true })).toBeVisible()
    await expect(history.getByRole('row', { name: /^v3\b/ })).not.toContainText('いま動いている')
  })

  test('a recreated stack resolves release state and the header version @mock @story', async ({ page, mock, request }, testInfo) => {
    void mock
    const root = `/api/v1/projects/${seed.projectId}`
    const applicationId = 'quality-issues'
    const oldStackId = 'stack-5c2cfe9ddb14'
    const stackId = 'stack-710052df3c82'
    const scope = { applicationId, branchId: 'production', componentId: `${stackId}-web` }
    const created = await request.post('/api/console/apps', {
      data: { displayName: 'Quality issues', slug: applicationId, groupId: seed.groups.teamA.id },
    })
    expect(created.status()).toBe(201)
    const app = await created.json()
    const bound = await request.post(`/api/console/apps/${app.id}/bind`, { data: { stackId, appName: applicationId } })
    expect(bound.status()).toBe(200)

    const application: Application = {
      id: applicationId, name: applicationId, projectId: seed.projectId, defaultBranchId: 'production',
      status: { phase: 'healthy', conditions: [] }, sourceKind: 'applicationStack', sourceId: oldStackId, pendingSync: false,
    }
    const stack: ApplicationStack = {
      id: stackId, projectId: seed.projectId, templateId: 'nextjs-postgres', applicationId,
      applicationName: applicationId, sourceKind: 'sample-image', branchId: 'production',
      webComponentId: scope.componentId, pendingSync: false,
    }
    const publish: Publish = {
      id: scope.componentId, projectId: seed.projectId, ...scope, phase: 'succeeded',
      publicUrl: 'https://quality-issues.example.test/', access: { mode: 'Public' }, pendingSync: false,
    }
    // The obsolete stack comes first, but only the recreated stack's component
    // is projected into production. Application.sourceId still names its creator.
    await page.route((url) => url.pathname === `${root}/applications`, (route) =>
      route.fulfill({ json: { data: [application], meta: { total: 1 } } }))
    await page.route(`**${root}/application-stacks`, (route) => route.fulfill({
      json: { data: [{ ...stack, id: oldStackId, webComponentId: `${oldStackId}-web` }, stack], meta: { total: 2 } },
    }))
    await page.route(`**${root}/publishes`, (route) =>
      route.fulfill({ json: { data: [publish], meta: { total: 1 } } }))
    await page.route((url) => url.pathname === `${root}/component-summaries`, (route) => route.fulfill({
      json: { items: [{
        id: scope.componentId, projectId: seed.projectId, applicationId, name: scope.componentId,
        kindKey: 'Container', statusKey: 'Ready', reasonKey: 'ComponentReady', pendingSync: false,
      }] },
    }))

    // The mock's wire as served (no schema parse that would fill defaults into the copy).
    const overview = await (await request.get(`${root}/applications/mitsumori/releases?branchId=production`)).json() as ApplicationReleaseOverview
    const history = {
      ...overview, applicationId,
      components: overview.components.map((component) => ({
        ...component, id: scope.componentId, name: scope.componentId,
        latestRelease: component.latestRelease ? { ...component.latestRelease, ...scope } : undefined,
        releases: component.releases.map((release) => ({ ...release, ...scope })),
        queue: { ...component.queue, ...scope },
      })),
    }
    await page.route((url) => url.pathname === `${root}/applications/${applicationId}/releases`, (route) =>
      route.fulfill({ json: history }))
    const releaseState = await (await request.get(`${root}/applications/mitsumori/branches/production/components/mitsumori-web/release-state`)).json() as ComponentReleaseState
    const statePath = `${root}/applications/${applicationId}/branches/production/components/${scope.componentId}/release-state`
    await page.route(`**${root}/applications/${applicationId}/branches/*/components/*/release-state`, (route) =>
      new URL(route.request().url()).pathname === statePath
        ? route.fulfill({ json: { ...releaseState, ...scope } })
        : route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'resource not found', details: { reason: 'component_not_found' } } } }))

    const stateResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/release-state'))
    await page.goto(`/${seed.groups.teamA.path}/${applicationId}/-/releases`)
    const response = await stateResponse
    expect(new URL(response.url()).pathname).toBe(statePath)
    expect(response.status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Quality issues', exact: true })).toBeVisible()
    await expect(page.getByTestId('status-text')).toContainText('v3')
    await expect(page.getByTestId('current-version')).toHaveText('v3')
    await expect(page.getByTestId('release-history')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('recreated-stack-release-state.png'), fullPage: true })
  })
})
