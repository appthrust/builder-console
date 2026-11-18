import { describe, expect, test } from 'bun:test'
import { emptySpec, parseSpec, serializeSpec } from './spec'
import { composeBuildIntent, decomposeBuildIntent } from './questions'
import type { BuildSpec } from './types'

import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
const spec: BuildSpec = {
  name: '見積: 作成', oneLine: '営業が顧客ごとに見積を作る\nPDF で出す', users: ['営業', '課長'], screens: ['見積の編集'],
  records: [{ name: '見積', fields: ['品目', '金額', '状態'] }], rules: ['承認後は編集不可'], approval: 'one-step', importFrom: 'csv',
}

describe('spec front matter', () => {
  test('round-trips every field and preserves free markdown byte for byte', () => {
    const body = '\n# 詳細\n\nPDF を作る。\n---\n本文の区切り\n'
    expect(parseSpec(serializeSpec(spec, body))).toEqual({ spec, body })
    expect(parseSpec(serializeSpec(emptySpec(), ''))).toEqual({ spec: emptySpec(), body: '' })
  })
  test.each(['none', 'csv', 'excel'] as const)('round-trips the existing-data source %s', (importFrom) => {
    const imported = { ...spec, importFrom }
    const body = '\n## 9. 画面の決定\n一覧と登録画面\n'
    expect(parseSpec(serializeSpec(imported, body))).toEqual({ spec: imported, body })
  })
  test.each(['# plain markdown', '', '---\nspec: [\n---\nbody', '---\nspec:\n  name: first\n  name: duplicate\n---\nbody', '---\nspec: text\n---\nbody', '---\nother: {}\n---\nbody', '---\nspec: {}'])('preserves missing/invalid front matter: %s', (text) => {
    expect(parseSpec(text)).toEqual({ spec: emptySpec(), body: text })
  })
  test('reads block, flow arrays, quoted values, optional fields and CRLF', () => {
    const text = '---\r\nspec:\r\n  name: 見積\r\n  users: [営業, "課長"]\r\n  records:\r\n    - name: 見積\r\n      fields: [品目, 金額]\r\n  approval: none\r\n---\r\nbody'
    expect(parseSpec(text)).toEqual({ spec: { ...emptySpec(), name: '見積', users: ['営業', '課長'], records: [{ name: '見積', fields: ['品目', '金額'] }], approval: 'none' }, body: 'body' })
    expect(parseSpec('---\nspec: {}\n---\nbody')).toEqual({ spec: emptySpec(), body: 'body' })
  })
  test('does not trust YAML scalar types or malformed list elements', () => {
    const parsed = parseSpec('---\nspec:\n  name: 99\n  users: [true, 営業]\n  screens: invalid\n  records: [null, {name: 顧客}, {name: 7}]\n  rules: [17, 禁止]\n  approval: unknown\n  importFrom: spreadsheet\n---\nbody')
    expect(parsed.spec).toEqual({ ...emptySpec(), users: ['営業'], records: [{ name: '顧客', fields: [] }], rules: ['禁止'] })
  })
  test('returns independently owned empty arrays', () => {
    const first = emptySpec()
    first.rules.push('rule')
    expect(emptySpec().rules).toEqual([])
  })
})

describe('build intent', () => {
  test('recovers the user-authored opening after composition and a language switch', async () => {
    const restore = preserveLanguage()
    try {
      for (const language of ['ja', 'en'] as const) {
        setLanguage(language)
        for (const publish of [undefined, false, true]) {
          for (const replies of [[], ['検索も', 'PDF も出す']]) {
            const intent = await composeBuildIntent('見積を作る\n入力はかんたんに', replies, publish)
            setLanguage(language === 'ja' ? 'en' : 'ja')
            expect(decomposeBuildIntent(intent)).toBe('見積を作る\n入力はかんたんに')
            setLanguage(language)
          }
        }
      }
      expect(decomposeBuildIntent('普通の本文に ### 追記 と書く')).toBe('普通の本文に ### 追記 と書く')
    } finally { restore() }
  })
  test('keeps the English envelope of a resumed plan independently of the current display language', async () => {
    const stored = 'Track stock\n\n### Follow-up\n\nCSV\n\nPublish: yes'
    const replies = ['CSV', 'x'.repeat(3800), 'y'.repeat(3800), 'Use a barcode']
    const result = await composeBuildIntent(stored, replies, true)
    expect(result).toContain('(2 earlier follow-ups omitted)')
    expect(result.endsWith('\n\n### Follow-up\n\nUse a barcode\n\nPublish: yes')).toBe(true)
    expect(await composeBuildIntent(result, replies, true)).toBe(result)
  })
  test('composes follow-ups in order without a console-authored premises block', async () => {
    expect(await composeBuildIntent(' 見積を作る ', [' PDF も出す ', ' ', '検索も'])).toBe('見積を作る\n\n### 追記\n\nPDF も出す\n\n### 追記\n\n検索も')
  })
  test('publication keeps the explicit marker', async () => {
    expect(await composeBuildIntent('見積を作る', [])).not.toContain('公開: する')
    expect(await composeBuildIntent('見積を作る', [], false)).not.toContain('公開: する')
    expect(await composeBuildIntent('見積を作る', [], true)).toBe('見積を作る\n\n公開: する')
  })
  test('keeps an exact 4000-byte Japanese opening and abbreviates an oversized one without splitting a code point', async () => {
    const exact = '見'.repeat(1332) + '😀'
    expect(await composeBuildIntent(exact, [])).toBe(exact)
    const oversized = '😀見'.repeat(600)
    const result = await composeBuildIntent(oversized, [])
    const excerpt = decomposeBuildIntent(result)
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(4000)
    expect(excerpt).toMatch(/^(?:😀見)+(?:😀)?…$/u)
    expect(await composeBuildIntent(result, [])).toBe(result)
  })
  test('keeps a chronological suffix of complete replies and marks the omitted count deterministically', async () => {
    const base = '在庫管理'
    const replies = Array.from({ length: 30 }, (_, i) => `要件${i}: ${'棚卸'.repeat(40)}`)
    const result = await composeBuildIntent(base, replies, true)
    const count = Number(/以前の追記 (\d+) 件を省略/.exec(result)?.[1])
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(replies.length - 1)
    expect(result).toBe([base, `（以前の追記 ${count} 件を省略）`, ...replies.slice(count)].join('\n\n### 追記\n\n') + '\n\n公開: する')
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(4000)
    const restore = preserveLanguage()
    try {
      setLanguage('en')
      expect(await composeBuildIntent(base, [...replies], true)).toBe(result)
      expect(await composeBuildIntent(result, replies, true)).toBe(result)
    } finally { restore() }
  })
  test('even a full opening cannot crowd out the newest message or the publication decision', async () => {
    const opening = 'a'.repeat(4000)
    const earlier = '以前の変更'.repeat(300)
    for (const latest of ['この内容で提案して', '変更点：' + '😀'.repeat(1200)]) {
      const result = await composeBuildIntent(opening, [earlier, latest], true)
      expect(result).toContain(latest.length < 100 ? latest : '変更点：😀')
      expect(result).not.toContain(earlier)
      expect(result.endsWith('\n\n公開: する')).toBe(true)
      expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(4000)
      expect(await composeBuildIntent(result, [earlier, latest], true)).toBe(result)
    }
  })
})
