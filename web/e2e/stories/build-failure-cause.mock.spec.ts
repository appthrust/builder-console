import type { ApplicationStack, BuildFailure } from '@appthrust/api-schema/platform-api'
import { test, expect, seed, captureWrite } from '../support/fixtures'

const failure: BuildFailure = {
  lines: ['./lib/fourm-seed.ts', "Module not found: Can't resolve '[workspace]'"],
  kind: 'module-not-found', observedAt: '2026-11-01T00:00:00Z',
  buildRef: 'https://github.com/acme/app/actions/runs/77',
}
const root = `/api/v1/projects/${seed.projectId}`

for (const surface of ['app', 'build'] as const) {
  test(`${surface} shows a safe build cause and sends it to a new improvement in one click @mock @story`, async ({ page, mock, request }, testInfo) => {
    await mock.platform('codex', { available: true })
    let failed = true
    let path: string
    if (surface === 'app') {
      await page.route(`**${root}/application-stacks`, async (route) => {
        const response = await route.fetch()
        const body = await response.json()
        body.data = body.data.map((stack: ApplicationStack) => stack.id === 'mitsumori' ? { ...stack, buildFailure: failed ? failure : undefined } : stack)
        await route.fulfill({ response, json: body })
      })
      path = `/${seed.apps.mitsumori.groupPath}/${seed.apps.mitsumori.slug}`
    } else {
      const created = await request.post(`${root}/application-drafts`, { data: { title: '見積作成', intent: '見積を管理する' } })
      expect(created.ok()).toBe(true)
      const draft = (await created.json()).resource
      await page.route(`**${root}/application-drafts/${draft.id}`, async (route) => {
        const response = await route.fetch()
        // A poll the navigation below cuts off disposes its fetched response; nothing is left to answer.
        const body: unknown = await response.json().catch(() => undefined)
        if (body === undefined) return
        await route.fulfill({ response, json: { ...(body as object), ownerUserId: 'sub-yamada', createdApplicationStackId: 'mitsumori', buildFailure: failed ? failure : undefined } })
      })
      path = `/-/build/${draft.id}`
    }
    await page.goto(path)
    const cause = page.getByTestId('build-failure-cause')
    await expect(cause).toContainText('ビルドが失敗しました。原因:')
    await expect(cause).toContainText(failure.lines[1]!)
    await expect(page.getByRole('button', { name: 'AI に直させる', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${surface}-failure-desktop.png`), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(cause).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${surface}-failure-mobile.png`), fullPage: true })
    const firstTurn = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/conversation-turns'))
    const creation = await captureWrite(page, 'POST', `${root}/application-drafts`, () => page.getByRole('button', { name: 'AI に直させる', exact: true }).click())
    expect(creation.body).toMatchObject({ kind: 'improvement', applicationStackId: 'mitsumori', intent: failure.lines.join('\n') })
    expect((await firstTurn).postDataJSON()).toEqual({ message: failure.lines.join('\n') })
    await expect(page).toHaveURL(/\/-\/improve\/[^/]+$/)
    failed = false
    await page.goto(path)
    await expect(page.getByTestId('build-failure-cause')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'AI に直させる', exact: true })).toHaveCount(0)
  })
}
