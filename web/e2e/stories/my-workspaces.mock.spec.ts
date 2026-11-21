import { test, expect, seed, captureWrite } from '../support/fixtures'

const workspaces = `/api/v1/projects/${seed.projectId}/dev-workspaces`

test.describe('My workspaces @workspaces', () => {
  test('opens my workspaces in three groups, extends a lease, shows a Retired row, and deletes idle ones behind the unpushed-changes warning @mock @story', async ({ page }) => {
    await page.goto('/')
    // The header entry carries the running count (Ready + Degraded of the six seeded workspaces).
    const entry = page.getByRole('button', { name: '自分の作業場所（動いているもの 2 件）', exact: true })
    await expect(entry).toBeVisible()
    await expect(page.getByTestId('my-workspaces-badge')).toHaveText('2')
    await entry.click()

    const drawer = page.getByRole('dialog', { name: '自分の作業場所', exact: true })
    await expect(drawer.getByTestId('my-workspaces-summary')).toHaveText('データを残している作業場所 6 件 · 7 日以上使っていないもの 2 件')
    const group = (name: string) => drawer.getByRole('region', { name: new RegExp(`^${name}`) })
    const running = group('動いている')
    const sleeping = group('休止中')
    const other = group('停止・使用終了・失敗')
    await expect(running.getByRole('listitem')).toHaveCount(2)
    await expect(sleeping.getByRole('listitem')).toHaveCount(2)
    await expect(other.getByRole('listitem')).toHaveCount(2)

    // Running rows: the lease countdown, the Degraded one inside the five-minute warning.
    const ready = drawer.locator('[data-workspace-id="devws-mitsumori-fix"]')
    await expect(ready.getByTestId('workspace-line')).toHaveText(/^あと 4[12] 分で休止します$/)
    const degraded = drawer.locator('[data-workspace-id="devws-nippo-filter"]')
    await expect(degraded.getByTestId('workspace-line')).toHaveText(/^あと [1-3] 分で休止します$/)
    await expect(degraded.getByTestId('workspace-line')).toHaveClass(/text-busy-ink/)
    // Sleeping: resumable, with when its data is released; running rows cannot be chosen for deletion.
    await expect(sleeping.getByRole('listitem').first()).toContainText(/データは .+ まで残ります/)
    await expect(running.getByRole('checkbox')).toHaveCount(0)

    // Extend lease: immediate, with Idempotency-Key, and the row shows the renewed hour.
    const extended = await captureWrite(page, 'POST', `${workspaces}/devws-mitsumori-fix/extend-lease`, () =>
      ready.getByRole('button', { name: '「見積の明細を直す」を延長する', exact: true }).click())
    expect(await extended.request.headerValue('idempotency-key')).toBeTruthy()
    expect((await extended.request.response())?.status()).toBe(202)
    await expect(drawer.getByRole('status').filter({ hasText: '「見積の明細を直す」の休止までの時間を延ばしました。' })).toBeVisible()
    await expect(ready.getByTestId('workspace-line')).toHaveText(/^あと (60|59) 分で休止します$/)

    // Stopped: Platform allows `start` (not `restart`); there is no start route, so 再開する calls restart. It sits beside 削除する.
    const stopped = drawer.locator('[data-workspace-id="devws-kintai-csv"]')
    await expect(stopped.getByRole('button')).toHaveText(['再開する', '削除する'])
    await expect(stopped.getByRole('button', { name: '「勤怠を CSV で出す」を再開する', exact: true })).toBeEnabled()

    // Retired: unusable, deleted by Platform on its date; deleting is the only action.
    const retired = drawer.locator('[data-workspace-id="devws-mitsumori-old"]')
    await expect(retired).toContainText('使用終了')
    await expect(retired.getByTestId('workspace-line')).toHaveText(/^もう使えません。.+ に自動で削除されます。$/)
    await expect(retired.getByRole('button')).toHaveText(['削除する'])
    await expect(retired.getByRole('link')).toHaveCount(0)

    // 片づける checks the idle Sleeping and Stopped rows, never the Retired one.
    await drawer.getByRole('button', { name: '片づける', exact: true }).click()
    await expect(drawer.getByRole('checkbox', { name: '「売上ダッシュボード」を選ぶ', exact: true })).toBeChecked()
    await expect(drawer.getByRole('checkbox', { name: '「勤怠を CSV で出す」を選ぶ', exact: true })).toBeChecked()
    await expect(drawer.getByRole('checkbox', { name: '「経費に領収書を添付する」を選ぶ', exact: true })).not.toBeChecked()
    await expect(drawer.getByRole('checkbox', { name: '「見積の旧作業場所」を選ぶ', exact: true })).not.toBeChecked()

    // Delete: the Dashboard's warning, and rows whose work never left the workspace are named.
    await drawer.getByRole('button', { name: '選んだ 2 件を削除', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '作業場所 2 件を削除しますか？', exact: true })
    await expect(confirm).toContainText('置き場に送っていない変更は消えます。')
    await expect(confirm).toContainText('2 件は置き場に送っていません。変更はこの作業場所にしかありません。')
    const rows = confirm.getByRole('list', { name: '削除する作業場所', exact: true }).getByRole('listitem')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: '置き場に未送信' })).toHaveCount(2)

    const deletes = ['devws-uriage-board', 'devws-kintai-csv'].map((id) =>
      page.waitForResponse((response) => response.request().method() === 'DELETE' && new URL(response.url()).pathname === `${workspaces}/${id}`))
    await confirm.getByRole('button', { name: '2 件を削除する', exact: true }).click()
    for (const response of await Promise.all(deletes)) {
      expect(response.status()).toBe(202)
      expect(await response.request().headerValue('idempotency-key')).toBeTruthy()
    }
    await expect(rows.filter({ hasText: '削除を受け付けました' })).toHaveCount(2)
    // The footer's 閉じる replaces 削除する once the run is over (the header ✕ is the other 閉じる).
    await expect(confirm.getByRole('button', { name: '閉じる', exact: true })).toHaveCount(2)
    await confirm.getByRole('button', { name: '閉じる', exact: true }).last().click()
    await expect(confirm).toBeHidden()
    await expect(drawer.locator('[data-workspace-id="devws-uriage-board"], [data-workspace-id="devws-kintai-csv"]')).toHaveCount(0)
    await expect(drawer.getByTestId('my-workspaces-summary')).toHaveText('データを残している作業場所 4 件 · 7 日以上使っていないもの 0 件')
    await expect(drawer.getByRole('button', { name: '片づける', exact: true })).toHaveCount(0)
  })
})
