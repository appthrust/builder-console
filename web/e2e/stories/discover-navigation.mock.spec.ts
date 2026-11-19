import { test, expect, seed } from '../support/fixtures'

test.describe('Discover navigation @discover', () => {
  test('finds seeded apps by search, ownership, company, and group, tells 作りかけ from 問題あり, and follows stable links @mock @story', async ({ page, mock }) => {
    // An abandoned draft (25 minutes idle): it reads 作りかけ, not 問題あり, and never feeds the problem badge.
    await mock.console('app-draft', {})
    const draftName = '備品予約'
    const nav = page.getByRole('navigation', { name: 'メインメニュー' })
    const main = page.getByRole('main')

    // Home: every usable app as a card under 「使えるアプリ」, narrowed by membership chips (the draft is not usable yet).
    const details = (name: string) => `${name}をくわしく見る`
    await page.goto('/')
    await expect(main.getByRole('heading', { name: /^使えるアプリ/, level: 2 })).toBeVisible()
    const usable = main.getByRole('list', { name: '使えるアプリ', exact: true })
    await expect(usable.getByRole('listitem')).toHaveCount(6)
    for (const name of [seed.apps.mitsumori.name, seed.apps.nippo.name, seed.apps.keihi.name, '引っ越し見積', seed.apps.kintai.name, '会議室予約']) {
      await expect(usable.getByRole('link', { name: details(name), exact: true })).toBeVisible()
    }
    await expect(usable.getByRole('listitem').filter({ hasText: draftName })).toHaveCount(0)
    const chips = main.getByRole('group', { name: '使えるアプリの絞り込み', exact: true })
    await chips.getByRole('button', { name: seed.groups.teamA.name, exact: true }).click()
    await expect(chips.getByRole('button', { name: seed.groups.teamA.name, exact: true })).toHaveAttribute('aria-pressed', 'true')
    const teamCards = main.getByRole('list', { name: `使えるアプリ: ${seed.groups.teamA.name}`, exact: true })
    await expect(teamCards.getByRole('listitem')).toHaveCount(3)
    for (const app of [seed.apps.mitsumori, seed.apps.nippo, seed.apps.keihi]) {
      await expect(teamCards.getByRole('link', { name: details(app.name), exact: true })).toBeVisible()
    }
    await chips.getByRole('button', { name: 'すべて', exact: true }).click()
    await expect(usable.getByRole('listitem')).toHaveCount(6)

    await page.getByRole('searchbox', { name: 'アプリを探す', exact: true }).fill('見積')
    await page.getByRole('button', { name: '探す', exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/' && url.searchParams.get('q') === '見積')
    const results = main.getByRole('list', { name: '「見積」の検索結果', exact: true })
    await expect(results.getByRole('listitem')).toHaveCount(2)
    await expect(results.getByRole('link', { name: details('見積作成'), exact: true })).toBeVisible()
    await expect(results.getByRole('link', { name: details('引っ越し見積'), exact: true })).toBeVisible()
    await expect(results.getByRole('link', { name: details('経費精算'), exact: true })).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('searchbox', { name: 'アプリを探す', exact: true })).toHaveValue('見積')
    await expect(results.getByRole('listitem')).toHaveCount(2)

    // 自分のアプリ lists apps that exist; the half-made wizard app is under 作りかけ.
    await nav.getByRole('link', { name: '自分のアプリ', exact: true }).click()
    await expect(page).toHaveURL('/mine')
    const mine = page.getByRole('table', { name: '自分のアプリ', exact: true })
    await expect(mine.getByRole('row')).toHaveCount(3)
    await expect(mine.getByRole('row').filter({ hasText: seed.apps.mitsumori.name })).toContainText(seed.me.name)
    await expect(mine.getByRole('row').filter({ hasText: seed.apps.keihi.name })).toContainText(seed.me.name)
    await expect(mine.getByRole('link', { name: /^日報/ })).toHaveCount(0)
    await expect(mine.getByRole('row').filter({ hasText: draftName })).toHaveCount(0)
    await nav.getByRole('link', { name: /^作りかけ（1 件）$/ }).click()
    await expect(page).toHaveURL('/-/drafts')
    await expect(main.getByRole('heading', { name: '作りかけ', exact: true, level: 1 })).toBeVisible()
    const drafts = main.getByRole('list', { name: '作りかけ', exact: true })
    const draftRow = drafts.getByRole('listitem').filter({ hasText: draftName })
    await expect(draftRow).toContainText('作りかけ')
    await expect(draftRow).not.toContainText('問題あり')
    await expect(draftRow.getByRole('link', { name: '続きから作る', exact: true })).toHaveAttribute('href', /^\/new\?resume=/)
    await nav.getByRole('link', { name: '問題ありのアプリが 1 件あります', exact: true }).click()
    await expect(page).toHaveURL('/mine?status=problem')
    await expect(mine.getByRole('row')).toHaveCount(2)
    await expect(mine.getByRole('row').filter({ hasText: seed.apps.keihi.name })).toContainText('問題あり')
    await expect(mine.getByRole('link', { name: /^見積作成/ })).toHaveCount(0)
    await page.reload()
    await expect(mine.getByRole('row')).toHaveCount(2)
    await expect(mine.getByRole('link', { name: /^経費精算/ })).toBeVisible()

    // 「削除」 drops the draft after a light confirmation (no name typing) and stays on the list.
    await page.goto('/-/drafts')
    await draftRow.getByRole('button', { name: `「${draftName}」を削除する`, exact: true }).click()
    const discard = page.getByRole('dialog', { name: `「${draftName}」を削除しますか？`, exact: true })
    await expect(discard).toContainText('作りかけのアプリを一覧から消します。元に戻せません。')
    await expect(discard.getByRole('textbox')).toHaveCount(0)
    await discard.getByRole('button', { name: '削除する', exact: true }).click()
    await expect(discard).toHaveCount(0)
    await expect(page).toHaveURL('/-/drafts')
    await expect(main.getByText('作りかけのアプリはありません', { exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: '作りかけ', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: '問題ありのアプリが 1 件あります', exact: true })).toBeVisible()

    await nav.getByRole('link', { name: 'ディレクトリ', exact: true }).click()
    await expect(page).toHaveURL('/company')
    await expect(main.getByRole('heading', { name: 'ディレクトリ', exact: true, level: 1 })).toBeVisible()
    const soumu = main.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 2, name: seed.groups.soumu.name, exact: true }) })
    await expect(soumu).toContainText('アプリ 2')
    await expect(soumu.getByRole('link', { name: /^勤怠申請/ })).toBeVisible()
    await expect(soumu.getByRole('link', { name: /^会議室予約/ })).toBeVisible()

    // Directory → group → app → back to the group.
    await soumu.getByRole('link', { name: seed.groups.soumu.name, exact: true }).click()
    await expect(page).toHaveURL(`/${seed.groups.soumu.path}`)
    await expect(main.getByRole('heading', { name: seed.groups.soumu.name, exact: true, level: 1 })).toBeVisible()
    await main.getByRole('link', { name: seed.apps.kintai.name, exact: true }).click()
    await expect(page).toHaveURL(`/${seed.apps.kintai.groupPath}/${seed.apps.kintai.slug}`)
    await expect(main.getByRole('heading', { name: seed.apps.kintai.name, exact: true, level: 1 })).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(`/${seed.groups.soumu.path}`)
    await expect(main.getByRole('heading', { name: seed.groups.soumu.name, exact: true, level: 1 })).toBeVisible()

    // Arriving at a group page reveals its ancestors even after manual collapse.
    await nav.getByRole('button', { name: `${seed.groups.salesEast.name} を閉じる`, exact: true }).click()
    await nav.getByRole('button', { name: `${seed.groups.sales.name} を閉じる`, exact: true }).click()
    await expect(nav.getByRole('link', { name: seed.groups.teamA.name, exact: true })).not.toBeVisible()
    // The maker's home link carries the inbox count in its name (「ホーム（あなたの対応待ち N 件）」).
    await nav.getByRole('link', { name: /^ホーム/ }).click()
    await expect(page).toHaveURL('/')
    await main.getByRole('list', { name: '使えるアプリ', exact: true }).getByRole('link', { name: details(seed.apps.mitsumori.name), exact: true }).click()
    await expect(main.getByRole('heading', { name: seed.apps.mitsumori.name, exact: true, level: 1 })).toBeVisible()
    await main.getByRole('link', { name: `${seed.groups.teamA.name} のアプリ`, exact: true }).click()
    await expect(page).toHaveURL(`/${seed.groups.teamA.path}`)
    await expect(main.getByRole('heading', { name: seed.groups.teamA.name, exact: true, level: 1 })).toBeVisible()
    await page.getByRole('navigation', { name: 'グループのページ', exact: true }).getByRole('link', { name: 'アプリ', exact: true }).click()
    await expect(page).toHaveURL(`/${seed.groups.teamA.path}/-/apps`)
    const team = page.getByRole('table', { name: seed.groups.teamA.name, exact: true })
    await expect(team.getByRole('row')).toHaveCount(4)
    for (const app of [seed.apps.mitsumori, seed.apps.nippo, seed.apps.keihi]) {
      await expect(team.getByRole('link', { name: new RegExp(`^${app.name}`) })).toBeVisible()
    }
    await expect(nav.getByRole('button', { name: `${seed.groups.sales.name} を閉じる`, exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(nav.getByRole('button', { name: `${seed.groups.salesEast.name} を閉じる`, exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(nav.getByRole('link', { name: seed.groups.teamA.name, exact: true })).toHaveAttribute('href', `/${seed.groups.teamA.path}`)
    await expect(nav.getByRole('link', { name: seed.groups.teamA.name, exact: true })).toBeVisible()

    await page.goto(`/-/apps/${seed.apps.mitsumori.id}`)
    await expect(page).toHaveURL(`/${seed.apps.mitsumori.groupPath}/${seed.apps.mitsumori.slug}`)
    await expect(main.getByRole('heading', { name: seed.apps.mitsumori.name, exact: true, level: 1 })).toBeVisible()
    await page.goto('/sales/tokyo')
    await expect(page).toHaveURL(`/${seed.groups.salesEast.path}`)
    await expect(main.getByRole('heading', { name: seed.groups.salesEast.name, exact: true, level: 1 })).toBeVisible()
    await expect(main.getByRole('link', { name: seed.apps.mitsumori.name, exact: true })).toBeVisible()
  })
})
