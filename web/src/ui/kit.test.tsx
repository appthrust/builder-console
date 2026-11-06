import { describe, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { Check } from 'lucide-react'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../test/language'
import { AccessForbiddenError } from '../api/access'
import { ConsoleApiError } from '../api/console'
import { copy } from '../copy'
import { isProductLanguage } from '../model/build/wording'
import { setLanguage } from '../shell/language'
import { Button, IconButton, OpenLink } from './button'
import { ActionError, EmptyState, LoadFailed, StatusPill } from './feedback'
import { splitHref } from './link'
import { Stepper } from './stepper'

describe('shared console UI contracts', () => {
  test('compact buttons retain 40px mobile targets and explicit accessible names', () => {
    const button = renderToStaticMarkup(<Button size="sm">保存する</Button>)
    expect(button).toContain('h-10')
    expect(button).toContain('md:h-8')
    const icon = renderToStaticMarkup(<IconButton label="確認する" icon={<Check />} />)
    expect(icon).toContain('aria-label="確認する"')
    expect(icon).toContain('w-10')
    expect(icon).toContain('aria-hidden="true"')
  })

  test('open links preserve their destination and new-tab isolation', () => {
    const html = renderToStaticMarkup(<OpenLink href="https://apps.example.test/inventory" />)
    expect(html).toContain('href="https://apps.example.test/inventory"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('aria-label="開く ↗"')
  })

  test('status second line is outside the compact pill', () => {
    const html = renderToStaticMarkup(<StatusPill status="failed" second="続きから作れます。" />)
    expect(html).toContain('問題あり</span><span')
    expect(html).toContain('続きから作れます。')
    expect(renderToStaticMarkup(<StatusPill status="live" />)).not.toContain('flex-col')
  })

  test('page empty states can expose a single h1 without changing section defaults', () => {
    expect(renderToStaticMarkup(<EmptyState heading="h1" title="ページが見つかりません" />)).toMatch(/<h1[^>]*>ページが見つかりません<\/h1>/)
    expect(renderToStaticMarkup(<EmptyState title="アプリはありません" />)).not.toContain('<h1')
  })

  test('load failures invite a later reload in product language', () => {
    const html = renderToStaticMarkup(<LoadFailed onRetry={() => {}} />)
    expect(html).toContain('情報を読み込めませんでした。しばらくしてから再読み込みしてください。')
    expect(html).toContain('再読み込み</button>')
    expect(isProductLanguage(html.replace(/<[^>]+>/g, ''))).toBe(true)
  })

  test('stepper announces exactly one current step and preserves completed labels', () => {
    const html = renderToStaticMarkup(<Stepper step={1} labels={['始め方', '名前', '公開範囲']} />)
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
    expect(html).toContain('作成の手順')
    expect(html).toContain('始め方')
    expect(html).toContain('名前')
    expect(html).toContain('公開範囲')
  })

  test('string hrefs retain search and settings anchors independently', () => {
    expect(splitHref('/mine?status=problem')).toEqual({ to: '/mine', search: { status: 'problem' }, hash: undefined })
    expect(splitHref('/sales/app/-/settings#share')).toEqual({ to: '/sales/app/-/settings', search: {}, hash: 'share' })
    expect(splitHref('/')).toEqual({ to: '/', search: {}, hash: undefined })
  })
})

describe('action error presentation', () => {
  const serverMessage = 'external authorization app installation and its publish must be Ready'
  function platformError(status: number, code: string, reason?: string) {
    return new ORPCError('UNKNOWN', { status, data: { body: { error: { code, message: serverMessage, details: { reason } } } } })
  }

  test.each(['ja', 'en'] as const)('typed publish waits use a temporary notice without server detail in %s', (language) => {
    const restoreLanguage = preserveLanguage()
    setLanguage(language)
    try {
      for (const error of [
        platformError(409, 'app_installation_not_ready'),
        platformError(412, 'failed_precondition', 'ApplicationBranchRuntimeMigrationInProgress'),
        platformError(412, 'failed_precondition', 'OrganizationRenameInProgress'),
      ]) {
        const html = renderToStaticMarkup(<ActionError error={error} />)
        expect(html).toContain('role="status"')
        expect(html).toContain(copy.errors.publishPreparationPending)
        expect(html).not.toContain(copy.common.actionFailed)
        expect(html).not.toContain(serverMessage)
        expect(html).not.toContain('role="alert"')
        expect(html).toContain(language === 'ja' ? '1〜2 分待ってから' : 'Wait a minute or two')
      }
    } finally {
      restoreLanguage()
    }
  })

  test('unrelated errors retain their failure text even with the same server diagnostic', () => {
    for (const error of [
      platformError(409, 'conflict'),
      platformError(412, 'failed_precondition', 'PortUnresolved'),
      platformError(500, 'app_installation_not_ready'),
    ]) {
      const html = renderToStaticMarkup(<ActionError error={error} />)
      expect(html).toContain('role="alert"')
      expect(html).toContain(copy.common.actionFailed)
      expect(html).toContain(serverMessage)
      expect(html).not.toContain(copy.errors.publishPreparationPending)
    }
    const unknown = renderToStaticMarkup(<ActionError error={new Error(serverMessage)} />)
    expect(unknown).toContain(copy.common.actionFailed)
    expect(unknown).not.toContain(serverMessage)
  })

  test('permission, console conflict and transport errors keep their existing notices', () => {
    const forbidden = new AccessForbiddenError()
    for (const [error, message] of [
      [forbidden, forbidden.message],
      [platformError(401, 'unauthorized'), copy.common.accessDenied],
      [new ConsoleApiError(409, { error: 'conflict', message: serverMessage }), copy.errors.conflict],
      [new ConsoleApiError(503, undefined), copy.errors.transient],
    ] as const) {
      const html = renderToStaticMarkup(<ActionError error={error} />)
      expect(html).toContain('role="alert"')
      expect(html).toContain(message)
      expect(html).not.toContain(copy.errors.publishPreparationPending)
      expect(html).not.toContain(serverMessage)
    }
  })
})
