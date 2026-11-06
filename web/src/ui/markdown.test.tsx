import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './markdown'

describe('Markdown', () => {
  test('renders headings, paragraphs, emphasis and both kinds of lists', () => {
    const html = renderToStaticMarkup(<Markdown source={'# はじめに\n\n紹介の段落\n続きの行\n\n## 手順\n1. 開く\n2. 保存する\n\n### できること\n- **見積書**を作る\n* _検索_と*共有*'} />)
    expect(html).toMatch(/<h2[^>]*>はじめに<\/h2>/)
    expect(html).toMatch(/<h3[^>]*>手順<\/h3>/)
    expect(html).toMatch(/<h4[^>]*>できること<\/h4>/)
    expect(html).toMatch(/<p[^>]*>紹介の段落\n続きの行<\/p>/)
    expect(html).toMatch(/<ol[^>]*><li>開く<\/li><li>保存する<\/li><\/ol>/)
    expect(html).toMatch(/<ul[^>]*><li><strong>見積書<\/strong>を作る<\/li><li><em>検索<\/em>と<em>共有<\/em><\/li><\/ul>/)
    expect(html).not.toContain('<h1')
  })

  test('renders only allowed links with new-tab isolation', () => {
    const html = renderToStaticMarkup(<Markdown source={'[案内](https://example.test/guide) [資料](http://example.test/docs) [窓口](mailto:help@example.test)'} />)
    expect(html.match(/<a /g)).toHaveLength(3)
    for (const href of ['https://example.test/guide', 'http://example.test/docs', 'mailto:help@example.test']) {
      expect(html).toContain(`href="${href}"`)
    }
    expect(html.match(/target="_blank"/g)).toHaveLength(3)
    expect(html.match(/rel="noreferrer"/g)).toHaveLength(3)
  })

  test('keeps HTML literal and never renders script or image elements', () => {
    const html = renderToStaticMarkup(<Markdown source={'<script>alert("unsafe")</script>\n<img src=x onerror=alert(1)>\n![写真](https://example.test/photo.png)'} />)
    expect(html).toContain('&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('![写真](https://example.test/photo.png)')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<a ')
  })

  test('keeps unsafe and relative links literal, including emphasis in their labels', () => {
    const source = '[**実行**](javascript:alert) [埋込](data:text/html,test) [部署](/sales) [外部](//example.test)'
    const html = renderToStaticMarkup(<Markdown source={source} />)
    expect(html).toContain(source)
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<strong>')
  })

  test('keeps unmatched emphasis and unsupported block syntax literal', () => {
    const source = '**未完\n**\n*未完\n_未完\n#### 見出しではない\n> 引用ではない\n```code```'
    const html = renderToStaticMarkup(<Markdown source={source} />)
    expect(html).toContain('**未完\n**\n*未完\n_未完\n#### 見出しではない\n&gt; 引用ではない\n```code```')
    expect(html).not.toContain('<strong>')
    expect(html).not.toContain('<em>')
    expect(html).not.toContain('<h5')
    expect(html).not.toContain('<blockquote')
    expect(html).not.toContain('<code')
  })

  test('normalizes line endings and separates neighboring block types', () => {
    const html = renderToStaticMarkup(<Markdown source={'段落\r\n# 見出し\r\n- 箇条書き\r\n1. 手順\r\n\r\n次の段落'} />)
    expect(html).toMatch(/<p[^>]*>段落<\/p><h2[^>]*>見出し<\/h2><ul[^>]*><li>箇条書き<\/li><\/ul><ol[^>]*><li>手順<\/li><\/ol><p[^>]*>次の段落<\/p>/)
    expect(renderToStaticMarkup(<Markdown source={' \n\n'} />)).not.toContain('<p')
  })
})
