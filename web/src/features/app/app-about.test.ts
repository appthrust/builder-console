import { describe, expect, test } from 'bun:test'
import { guideExcerpt } from './app-about'

describe('guideExcerpt', () => {
  test('keeps the words, drops headings, list marks, emphasis and link targets', () => {
    const guide = '# 見積書を作る\n\n1. 「新しい見積」を押します。\n2. **お客さま**と品目を入力します。\n\n## 困ったとき\n\n- [担当者に相談する](mailto:yamada@example.com)\n![画面](x.png)'
    expect(guideExcerpt(guide)).toBe('「新しい見積」を押します。 お客さまと品目を入力します。 担当者に相談する')
  })

  test('skips code fences, tables, quotes and rules, and is empty for an empty guide', () => {
    expect(guideExcerpt('```\ncode\n```\n| a | b |\n> quote\n---\n本文')).toBe('code 本文')
    expect(guideExcerpt('')).toBe('')
    expect(guideExcerpt('# 見出しだけ')).toBe('')
  })

  test('cuts at the limit by characters, not UTF-16 units', () => {
    expect(guideExcerpt('𠮷'.repeat(10), 4)).toBe(`${'𠮷'.repeat(4)}…`)
    expect(guideExcerpt('𠮷'.repeat(4), 4)).toBe('𠮷'.repeat(4))
  })
})
