import type { DirectoryEntry } from '../../model/contracts/console'
import { paths } from '../../routes/paths'
import { Button, LinkButton, Notice } from '../../ui'
import { FeedbackSection, INTRO_PRIMARY, IntroLayout } from '../app/intro-page'
import { text } from './copy'

/**
 * The app page for people who cannot open the app (store-ux §3.4, ux-design §6.5): the intro page's
 * layout with 「使いたい」 as the primary action, from a directory projection only: no app URL, sharing
 * policy or settings, and no guide (it is not part of the projection).
 */
export function EntryPage({ entry }: { entry: DirectoryEntry }) {
  return (
    <IntroLayout
      subject={entry}
      primary={entry.appName ? (
        <LinkButton tone="primary" href={paths.requestAccess(entry.appName, 'not_visible')} className={INTRO_PRIMARY}>{text.entry.wantToUse}</LinkButton>
      ) : <Button tone="primary" disabled title={text.entry.requestUnavailable} className={INTRO_PRIMARY}>{text.entry.wantToUse}</Button>}
      state={<Notice>{text.entry.restricted(entry.group.name)}</Notice>}
      feedback={<FeedbackSection subject={entry} canDeleteAny={false} />}
    />
  )
}
