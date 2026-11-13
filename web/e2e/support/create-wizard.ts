import type { Page } from '@playwright/test'
import { captureWrite, expect, seed, type CapturedWrite } from './fixtures'

export async function openCreateWizard(page: Page) {
  await page.goto('/new')
  await expect(page.getByRole('heading', { name: 'どんなアプリを作りますか？' })).toBeVisible()
}

export async function pickBusinessTemplate(page: Page, templateId: string) {
  const card = page.getByTestId(`template-${templateId}`)
  await card.click()
  await expect(card).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '次へ', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'アプリの名前と説明' })).toBeVisible()
}

export async function pickExistingRepository(page: Page, repository: string) {
  await page.getByRole('button', { name: /作ったコードから/ }).click()
  await expect(page.getByRole('heading', { name: '置き場と名前' })).toBeVisible()
  await page.getByLabel('作ったものの置き場（GitHub）', { exact: true }).fill(repository)
  await page.getByTestId('repository-options').getByRole('button').filter({ hasText: repository }).click()
  await expect(page.getByTestId('picked-repository')).toContainText(repository)
}

export async function pickImage(page: Page, imageRef: string) {
  await page.getByRole('button', { name: '詳しい人向け', exact: true }).click()
  await page.getByLabel('コンテナイメージ', { exact: true }).fill(imageRef)
  await page.getByRole('button', { name: 'このイメージで次へ', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'アプリの名前と説明' })).toBeVisible()
}

export async function fillAppDetails(page: Page, details: { displayName?: string; description?: string; tags?: readonly string[] }) {
  if (details.displayName !== undefined) await page.getByRole('textbox', { name: 'アプリの名前 必須', exact: true }).fill(details.displayName)
  if (details.description !== undefined) await page.getByLabel('説明（任意）', { exact: true }).fill(details.description)
  for (const tag of details.tags ?? []) {
    await page.getByLabel('タグ（任意）', { exact: true }).fill(tag)
    await page.getByLabel('タグ（任意）', { exact: true }).press('Enter')
    await expect(page.getByRole('button', { name: `タグ「${tag}」を外す`, exact: true })).toBeVisible()
  }
}

/**
 * Preserve the displayed suggestion, including a generated name for a Japanese-only title.
 * The wizard moves on only after this exact name was checked free (resolve 404), whether
 * 次へ sent the check or joined the one leaving the name field had started.
 */
export async function continueToShare(page: Page): Promise<string> {
  const suggestion = page.getByTestId('url-name')
  await expect(suggestion).toHaveText(/^[a-z0-9][a-z0-9-]*$/)
  const slug = (await suggestion.innerText()).trim()
  await expect(page.getByLabel(/^所属グループ/)).toContainText(seed.groups.teamA.name)
  const finalNameChecked = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/console/resolve' && url.searchParams.get('path') === `/${seed.groups.teamA.path}/${slug}` && response.status() === 404
  })
  await page.getByRole('button', { name: '次へ', exact: true }).click()
  await finalNameChecked
  await expect(page.getByRole('heading', { name: '誰に見せますか？' })).toBeVisible()
  return slug
}

export async function pickShareScope(page: Page, scope: string) {
  const choice = page.getByRole('radiogroup', { name: '公開範囲', exact: true }).getByRole('radio', { name: new RegExp(`^${scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `) })
  await choice.click()
  await expect(choice).toBeChecked()
  await page.getByRole('button', { name: '次へ', exact: true }).click()
  await expect(page.getByRole('heading', { name: '確認して作る', exact: true })).toBeVisible()
}

/** Arm every request observer before 作る; one click performs the entire create/bind sequence. */
export async function submitCreateWizard(page: Page, source: 'repository' | 'image') {
  let draft: CapturedWrite | undefined
  let repository: CapturedWrite | undefined
  let stack: CapturedWrite | undefined
  const projectPath = `/api/v1/projects/${seed.projectId}`
  const createDraft = async () => {
    draft = await captureWrite(page, 'POST', '/api/console/apps', async () => {
      await page.getByRole('button', { name: '作る', exact: true }).click()
    })
  }
  const createRepository = async () => {
    if (source === 'repository') {
      repository = await captureWrite(page, 'POST', `${projectPath}/application-source-repositories`, createDraft)
    } else {
      await createDraft()
    }
  }
  const bind = await captureWrite(page, 'POST', /^\/api\/console\/apps\/[^/]+\/bind$/, async () => {
    stack = await captureWrite(page, 'POST', `${projectPath}/application-stacks`, createRepository)
  })
  if (!draft || !stack) throw new Error('Create did not capture the console draft and Platform stack writes')
  return { draft, repository, stack, bind }
}

export async function waitForAppPage(page: Page, app: { displayName: string; slug: string; groupPath: string }) {
  await expect(page).toHaveURL((url) => url.pathname === `/${app.groupPath}/${app.slug}`)
  await expect(page.getByRole('heading', { name: app.displayName, level: 1, exact: true })).toBeVisible()
}
