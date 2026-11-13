import { test, expect, seed, captureWrite } from '../support/fixtures'

function expectVariables(body: unknown, featureValue?: string) {
  if (!body || typeof body !== 'object' || !('variables' in body) || !Array.isArray(body.variables)) {
    throw new Error('Environment write must contain a variables array')
  }
  expect(body).toEqual({
    variables: [
      { key: 'APP_TITLE', value: seed.apps.mitsumori.slug, sensitive: false },
      ...(featureValue === undefined ? [] : [{ key: 'FEATURE_FLAG', value: featureValue, sensitive: false }]),
    ],
  })
}

test.describe('App settings update @app', () => {
  test('updates app details, sharing, environment values, and group with persisted readback @mock @story', async ({ page, mock }) => {
    // Several saves with readback, a group move and two reloads: about 13 s locally, 28–30 s on
    // GitHub runners (27.9 s and 29.5 s passing, 31.6 s timed out on run 43359019553).
    test.setTimeout(60_000)
    void mock
    const app = seed.apps.mitsumori
    const appPath = `/${app.groupPath}/${app.slug}`
    const settingsPath = `${appPath}/-/settings`
    const consolePath = `/api/console/apps/${app.id}`
    const envPath = `/api/v1/projects/${seed.projectId}/applications/${app.slug}/branches/production/components/${app.slug}-web/env-vars`
    const name = '見積作成 v2'
    const description = '営業の見積書を作成し、承認後に PDF で共有します。'
    const tag = '見積'

    await page.goto(settingsPath)
    await expect(page.getByRole('heading', { level: 1, name: app.name, exact: true })).toBeVisible()

    await test.step('Save the name, description, and additional tag', async () => {
      const general = page.getByRole('region', { name: '名前と説明', exact: true })
      const icon = await general.getByLabel('アイコン（絵文字 1 文字）', { exact: true }).inputValue()
      await general.getByLabel(/^アプリの名前/).fill(name)
      await general.getByLabel('説明', { exact: true }).fill(description)
      await general.getByLabel('タグ（カンマ区切り）', { exact: true }).fill(`営業, 書類, ${tag}`)
      const { body } = await captureWrite(page, 'PATCH', consolePath, () => general.getByRole('button', { name: '保存', exact: true }).click())
      if (!body || typeof body !== 'object' || !('displayName' in body) || typeof body.displayName !== 'string') {
        throw new Error('General settings write must contain displayName')
      }
      expect(body).toEqual({ displayName: name, description, tags: ['営業', '書類', tag], icon })
      await expect(general.getByRole('status')).toHaveText('保存しました。')
      await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()

      await page.reload()
      await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
      await expect(general.getByLabel('説明', { exact: true })).toHaveValue(description)
      await expect(general.getByLabel('タグ（カンマ区切り）', { exact: true })).toHaveValue(`営業, 書類, ${tag}`)
      await page.goto(appPath)
      await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
      await expect(page.getByText(description, { exact: true })).toBeVisible()
      await expect(page.getByText(tag, { exact: true })).toBeVisible()
      await page.goto(settingsPath)
    })

    await test.step('Confirm and save company-wide sharing', async () => {
      const sharing = page.getByRole('region', { name: '公開範囲', exact: true })
      await sharing.getByRole('button', { name: '共有', exact: true }).click()
      const shareDialog = page.getByRole('dialog', { name: '共有', exact: true })
      await shareDialog.getByRole('radio', { name: '全社 会社の全員が開けます。', exact: true }).click()
      await shareDialog.getByRole('button', { name: '保存', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '公開範囲を広げますか？', exact: true })
      // Settings previews sharing in this confirmation and the app header; share-preview belongs to the create wizard.
      await expect(dialog).toContainText('変更後は「全社に公開」になります。')
      await dialog.getByLabel(`確認のため「${name}」と入力してください。`, { exact: true }).fill(name)
      const { body } = await captureWrite(page, 'PATCH', consolePath, () => dialog.getByRole('button', { name: '広げて保存する', exact: true }).click())
      if (!body || typeof body !== 'object' || !('share' in body) || !body.share || typeof body.share !== 'object' || !('scope' in body.share)) {
        throw new Error('Sharing write must contain share.scope')
      }
      expect(body.share.scope).toBe('company')
      expect(body).toEqual({ share: { scope: 'company', groupIds: [], extraPersonIds: [] } })
      await expect(dialog).not.toBeVisible()
      await expect(page.getByTestId('share-access-status')).toHaveText('社員のみ', { timeout: 12_000 })
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('app-meta')).toContainText('社員のみ')

      await page.reload()
      await expect(page.getByTestId('settings-access-status')).toHaveText('社員のみ')
      await expect(page.getByTestId('app-meta')).toContainText('社員のみ')
    })

    await test.step('Stage an add, edit, and removal of an environment value, saving each with 保存 while retaining existing values', async () => {
      const env = page.getByRole('region', { name: '設定値', exact: true })
      const adding = env.getByRole('form', { name: '追加する設定値', exact: true })
      const table = page.getByTestId('env-table')
      const feature = table.getByRole('row').filter({ hasText: 'FEATURE_FLAG' })
      const save = env.getByRole('button', { name: '保存', exact: true })
      const envWrites: string[] = []
      page.on('request', (request) => {
        if (request.method() === 'PUT' && new URL(request.url()).pathname === envPath) envWrites.push(request.url())
      })
      await expect(table.getByRole('row').filter({ hasText: 'APP_TITLE' })).toContainText(app.slug)
      await expect(save).toBeDisabled()

      // 追加 only stages the value: marked in the table, nothing written until 保存.
      await adding.getByLabel('名前', { exact: true }).fill('FEATURE_FLAG')
      await adding.getByLabel('値', { exact: true }).fill('on')
      await adding.getByRole('button', { name: '追加', exact: true }).click()
      await expect(feature.getByRole('cell', { name: 'on', exact: true })).toBeVisible()
      await expect(feature).toContainText('追加')
      await expect(adding.getByLabel('名前', { exact: true })).toBeEmpty()
      await expect(env).toContainText('保存していない変更が 1 件あります。')
      expect(envWrites).toHaveLength(0)
      const added = await captureWrite(page, 'PUT', envPath, () => save.click())
      expectVariables(added.body, 'on')
      await expect(env.getByRole('status')).toHaveText('保存しました。')
      await expect(feature).not.toContainText('追加')
      await page.reload()
      await expect(feature.getByRole('cell', { name: 'on', exact: true })).toBeVisible()

      await feature.getByRole('button', { name: 'FEATURE_FLAG の値を変える', exact: true }).click()
      await feature.getByLabel('FEATURE_FLAG の新しい値', { exact: true }).fill('off')
      await feature.getByRole('button', { name: '変更する', exact: true }).click()
      await expect(feature.getByRole('cell', { name: 'off', exact: true })).toBeVisible()
      await expect(feature).toContainText('変更')
      expect(envWrites).toHaveLength(1)
      const edited = await captureWrite(page, 'PUT', envPath, () => save.click())
      expectVariables(edited.body, 'off')
      await expect(env.getByRole('status')).toHaveText('保存しました。')
      await page.reload()
      await expect(feature.getByRole('cell', { name: 'off', exact: true })).toBeVisible()

      // 変更を取り消す discards what is staged without writing.
      await feature.getByRole('button', { name: 'FEATURE_FLAG を削除', exact: true }).click()
      await expect(feature).toContainText('削除')
      await env.getByRole('button', { name: '変更を取り消す', exact: true }).click()
      await expect(feature.getByRole('button', { name: 'FEATURE_FLAG を削除', exact: true })).toBeVisible()
      await expect(save).toBeDisabled()
      expect(envWrites).toHaveLength(2)

      await feature.getByRole('button', { name: 'FEATURE_FLAG を削除', exact: true }).click()
      const removed = await captureWrite(page, 'PUT', envPath, () => save.click())
      expectVariables(removed.body)
      await expect(feature).toHaveCount(0)
      expect(envWrites).toHaveLength(3)
      await page.reload()
      await expect(table.getByRole('row').filter({ hasText: 'APP_TITLE' })).toContainText(app.slug)
      await expect(feature).toHaveCount(0)
    })

    await test.step('Move the app to another group and follow its new URL', async () => {
      const target = seed.groups.planning
      const placement = page.getByRole('region', { name: '所属グループと担当者', exact: true })
      await placement.getByRole('combobox', { name: '所属グループ', exact: true }).click()
      await page.getByRole('option', { name: target.name, exact: true }).click()
      const { body } = await captureWrite(page, 'PATCH', consolePath, () => placement.getByRole('button', { name: 'グループを移す', exact: true }).click())
      if (!body || typeof body !== 'object' || !('groupId' in body) || typeof body.groupId !== 'string') {
        throw new Error('Placement write must contain groupId')
      }
      expect(body).toEqual({ groupId: target.id })
      await expect(page).toHaveURL(`/${target.path}/${app.slug}/-/settings`)
      await expect(placement.getByRole('combobox', { name: '所属グループ', exact: true })).toHaveText(target.name)
      await page.reload()
      await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
      await expect(placement.getByRole('combobox', { name: '所属グループ', exact: true })).toHaveText(target.name)
      await page.goto(`/${target.path}/${app.slug}`)
      await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
      await expect(page.getByTestId('app-meta').getByRole('link', { name: target.name, exact: true })).toHaveAttribute('href', `/${target.path}`)
      await expect(page.getByTestId('app-meta')).toContainText('社員のみ')
    })
  })
})
