// The app's introduction for people who use it but do not maintain it
// (ux-design §6.5, WF-03/04/07): no tabs, sharing, status sentence or
// engineering details, only what the app is, a way to open it, and a way to
// reach its owners. `EntryPage` (people who cannot open the app) shares the
// layout; only the primary action differs (「使いたい」 vs 「アプリを開く」).
import { useNavigate, useLocation } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMe } from '../../api/queries/console'
import { copy } from '../../copy'
import type { AppView } from '../../model/app'
import type { BusinessApp, DirectoryEntry } from '../../model/contracts/console'
import { paths } from '../../routes/paths'
import { AppIcon, Button, CopyButton, HrefLink, LinkButton, LoadFailed, Markdown, Notice, Section, useDocumentTitle } from '../../ui'
import { AppAbout } from './app-about'
import { Comments } from './comments'
import { text } from './copy'
import { OwnerContact } from './owner-contact'
import { OwnerLinks } from './owner-links'
import { ownerNames, ProposalStatusLine, ProposeButton } from './propose-button'
import { ScreenshotStrip } from './screenshots'
import { useAppViews } from './use-app-views'

type IntroSubject = Pick<DirectoryEntry, 'id' | 'displayName' | 'icon' | 'group' | 'owners' | 'screenshots' | 'description' | 'capabilities' | 'tags'>

/**
 * WF-03's order: back link, header, primary actions with the state under them,
 * pictures, about, guide, feedback. `propose` sits right of the name (under the
 * primary actions on phones, WF-08) with its status line above the actions.
 */
export function IntroLayout({ subject, banner, propose, proposeStatus, primary, state, guide, feedback }: {
  subject: IntroSubject
  banner?: ReactNode
  propose?: ReactNode
  proposeStatus?: ReactNode
  primary: ReactNode
  state?: ReactNode
  guide?: string
  feedback: ReactNode
}) {
  useDocumentTitle(subject.displayName)
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <header className="space-y-4">
        {banner}
        <HrefLink href={paths.home} className="inline-flex min-h-10 items-center gap-1 text-sm text-accent-strong hover:underline md:min-h-8">
          <ArrowLeft aria-hidden className="size-4" />{text.intro.back}
        </HrefLink>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="flex min-w-0 items-center gap-4">
            <AppIcon icon={subject.icon} name={subject.displayName} size="lg" />
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight break-words text-stone-900 sm:text-2xl">{subject.displayName}</h1>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-stone-500">
                <HrefLink href={paths.group(subject.group.path)} className="inline-flex min-h-8 items-center hover:text-accent-strong hover:underline">{text.intro.ofGroup(subject.group.name)}</HrefLink>
                <span aria-hidden className="hidden sm:inline">・</span>
                <span className="inline-flex min-w-0 items-center gap-1.5">{text.intro.owner} <OwnerLinks owners={subject.owners} /></span>
              </p>
            </div>
          </div>
          {propose ? <div className="order-last empty:hidden sm:order-none [&>button]:w-full sm:[&>button]:w-auto">{propose}</div> : null}
          {proposeStatus ? <div className="order-last empty:hidden sm:order-none sm:col-span-2">{proposeStatus}</div> : null}
          <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">{primary}</div>
          {state ? <div className="sm:col-span-2">{state}</div> : null}
        </div>
      </header>

      <ScreenshotStrip appId={subject.id} screenshots={subject.screenshots} canEdit={false} />
      <AppAbout description={subject.description} capabilities={subject.capabilities} tags={subject.tags} />
      {guide?.trim() ? (
        <Section title={copy.app.tabs.guide}>
          <Markdown source={guide} />
        </Section>
      ) : null}
      {feedback}
    </div>
  )
}

/** 「担当者に伝える」: the comment thread re-headed for the people who use the app, with the owners' mail beside it. */
export function FeedbackSection({ subject, canDeleteAny, unavailable }: {
  subject: Pick<IntroSubject, 'id' | 'displayName' | 'owners'>
  canDeleteAny: boolean
  /** A draft app has no thread yet: the heading stays and says why. */
  unavailable?: boolean
}) {
  const heading = { title: text.feedback.title, lead: text.feedback.lead, actions: <OwnerContact app={subject} compact /> }
  return unavailable ? (
    <Section title={heading.title} lead={heading.lead}><p className="text-sm text-stone-500">{text.comments.draft}</p></Section>
  ) : <Comments appId={subject.id} owners={subject.owners} canDeleteAny={canDeleteAny} heading={heading} />
}

/** The intro's large primary action (アプリを開く / 使いたい): 44px tall, full width on phones (WF-08). */
export const INTRO_PRIMARY = 'h-11 w-full px-5 text-base md:h-11 sm:w-auto'

/**
 * Whether the app can be opened, from the platform view (§6.4 table, §9):
 * - `loading`: the platform has not answered yet;
 * - `unavailable`: the platform could not be read; no state is claimed;
 * - `trouble`: 問題あり with a URL; the button stays usable (WF-07 E);
 * - `preparing`: no URL yet, 問題あり included; the button cannot be pressed (WF-07 D);
 * - `ready`: open it; nothing more is said.
 */
export type IntroOpenState = 'loading' | 'unavailable' | 'trouble' | 'preparing' | 'ready'

export function introOpenState(views: { loading: boolean; failed: boolean }, view: Pick<AppView, 'status' | 'url'>): IntroOpenState {
  if (views.failed) return 'unavailable'
  if (views.loading && !view.url) return 'loading'
  if (!view.url) return 'preparing'
  return view.status === 'failed' ? 'trouble' : 'ready'
}

/** `?as=user` on the app page: a maintainer previews what people who use the app see (WF-05 ②). */
export function useUserPreview(): { active: boolean; exit: () => void } {
  const location = useLocation()
  const navigate = useNavigate()
  const search = new URLSearchParams(location.searchStr)
  const active = search.get('as') === 'user'
  return {
    active,
    exit: () => {
      search.delete('as')
      void navigate({ href: `${location.pathname}${search.size ? `?${search}` : ''}`, replace: true })
    },
  }
}

/** The intro page for one app the caller may use; `preview` shows it to a maintainer under a banner. */
export function IntroPage({ app, onExitPreview }: { app: BusinessApp; onExitPreview?: () => void }) {
  const me = useMe().data
  const projectId = me.projectId
  const views = useAppViews(projectId)
  const view = views.viewFor(app)
  const state = introOpenState(views, view)
  const owner = ownerNames(app)
  const openLabel = <>{text.intro.open}<ExternalLink aria-hidden /></>

  return (
    <IntroLayout
      subject={app}
      banner={onExitPreview ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-accent-line bg-accent-soft py-2 pr-2 pl-4 text-sm text-accent-strong" data-testid="user-preview-banner">
          <p className="min-w-0">{text.intro.preview}</p>
          <Button size="sm" onClick={onExitPreview}>{text.intro.previewExit}</Button>
        </div>
      ) : undefined}
      propose={<ProposeButton app={app} projectId={projectId} />}
      proposeStatus={<ProposalStatusLine app={app} projectId={projectId} />}
      primary={view.url && state !== 'unavailable' ? (
        <>
          <LinkButton external href={view.url} tone="primary" className={INTRO_PRIMARY} data-testid="intro-open">{openLabel}</LinkButton>
          <CopyButton value={view.url} label={copy.app.copyUrl} size="md" className="w-full sm:w-auto" />
        </>
      ) : (
        <Button tone="primary" disabled loading={state === 'loading'} className={INTRO_PRIMARY} data-testid="intro-open">{openLabel}</Button>
      )}
      state={state === 'unavailable' ? <LoadFailed onRetry={views.refetch} error={views.error} />
        : state === 'preparing' ? (
          <Notice title={text.intro.preparingTitle}>
            <p>{text.intro.preparing}</p>
            {owner ? <p>{text.intro.askSoon(owner)}</p> : null}
          </Notice>
        ) : state === 'trouble' ? (
          <Notice tone="warning" title={text.intro.troubleTitle}>
            <p>{text.intro.trouble}</p>
            {owner ? <p>{text.intro.askStill(owner)}</p> : null}
          </Notice>
        ) : undefined}
      guide={app.guide}
      // Users delete only their own comments; a maintainer's ?as=user preview shows the same, and moderation stays on the guide tab.
      feedback={<FeedbackSection subject={app} canDeleteAny={false} unavailable={view.draft} />}
    />
  )
}
