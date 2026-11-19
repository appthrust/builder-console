import { useState } from 'react'
import type { BusinessApp } from '../../model/contracts/console'
import { paths } from '../../routes/paths'
import { Button, LinkButton, Notice } from '../../ui'
import { text } from './copy'

export type IntroPart = 'description' | 'capabilities' | 'screenshots' | 'guide'

type IntroFields = Pick<BusinessApp, 'description' | 'capabilities' | 'screenshots' | 'guide'>

/** The parts of the store face (WF-03) a user sees nothing in, in the order the page shows them. */
export function introGaps(app: IntroFields): IntroPart[] {
  const gaps: IntroPart[] = []
  if (!app.description.trim()) gaps.push('description')
  if (app.capabilities.length === 0) gaps.push('capabilities')
  if (app.screenshots.length === 0) gaps.push('screenshots')
  if (!app.guide.trim()) gaps.push('guide')
  return gaps
}

/**
 * Where 「紹介を書く」 goes: the first gap's editor. The description is written in 設定; できること and つかいかた in
 * the つかいかた tab; pictures in the strip right below this notice on 概要.
 */
export function introGapHref(app: Pick<BusinessApp, 'group' | 'slug'>, gaps: readonly IntroPart[]): string {
  if (gaps.includes('description')) return `${paths.app(app.group.path, app.slug, 'settings')}#name`
  if (gaps.includes('capabilities') || gaps.includes('guide')) return paths.app(app.group.path, app.slug, 'guide')
  return `${paths.app(app.group.path, app.slug)}#screenshots`
}

const dismissKey = (appId: string) => `builder-console:intro-gap-dismissed:${appId}`

// Static page imports also run outside a browser, before storage is installed.
function readDismissed(appId: string): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(dismissKey(appId)) === '1'
}

/**
 * 「紹介がまだ足りません」 (ux-design §6.7, WF-05 ③): names the empty parts of the introduction until all four are
 * filled. Closing it hides it for this app in this browser.
 */
export function IntroGapNotice({ app }: { app: Pick<BusinessApp, 'id' | 'group' | 'slug'> & IntroFields }) {
  const [dismissed, setDismissed] = useState(() => readDismissed(app.id))
  const gaps = introGaps(app)
  if (dismissed || gaps.length === 0) return null
  const dismiss = () => {
    localStorage.setItem(dismissKey(app.id), '1')
    setDismissed(true)
  }
  return (
    <div data-testid="intro-gap-notice">
      <Notice
        tone="warning"
        title={text.maintainer.gapTitle}
        actions={<>
          <LinkButton size="sm" href={introGapHref(app, gaps)}>{text.maintainer.gapWrite}</LinkButton>
          <Button size="sm" tone="ghost" onClick={dismiss}>{text.maintainer.gapDismiss}</Button>
        </>}
      >
        {text.maintainer.gapDetail(gaps.map((gap) => text.maintainer.gapItems[gap]))}
      </Notice>
    </div>
  )
}
