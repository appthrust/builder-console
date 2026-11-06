// 作りかけ (ux-design §7.1): everything the caller started that is not an app
// yet. 自分のアプリ lists bound apps only; half-made work lives here.
//   - AI build sessions: the caller's Platform drafts (the API lists only the
//     principal's own) that no bound app has taken over yet. Listing from the
//     API, not from this tab's sessionStorage, keeps the list the same in every
//     tab and lets an orphaned draft be deleted.
//   - AI improvement sessions (kind `improvement`, bound to a live app from
//     the start): listed under the app's name with the session's state word.
//   - Wizard apps: the caller's console apps that never got a platform binding.
import type { ApplicationDraft, SourceChangeProposal } from '@appthrust/api-schema/platform-api'
import { useQuery } from '@tanstack/react-query'
import { PencilLine } from 'lucide-react'
import { draftsOptions } from '../../api/build-queries'
import type { BusinessApp, Me } from '../../api/console'
import { appsQuery } from '../../api/queries'
import { relativeTime } from '../../copy'
import { deriveStage, draftPublished } from '../../model/build/stage'
import { parseSpec } from '../../model/build/spec'
import type { BuildStage } from '../../model/build/types'
import { deriveImprove, isImprovementDraft } from '../../model/improve'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { EmptyState, HrefLink, LinkButton, LoadFailed, PageHeader, StatusPill, useDocumentTitle } from '../../ui'
import { useAppViews } from '../app/use-app-views'
import { readBuildSession, stageLabels } from '../build/session'
import { DiscardBuildButton } from '../build/discard'
import { stateWord } from '../build/session-header'
import { improveStateWord, text as improveText } from '../improve/copy'
import { AppListSkeleton, AppStatus, StatusLoadNotice } from './app-list'
import { text } from './copy'
import { proposalsOptions } from '../proposals/queries'
import { proposalTerminal } from '../proposals/model'
import { ProposalStatus } from '../proposals/proposal-ui'
import { text as proposalText } from '../proposals/copy'

export type UnfinishedItem =
  | { kind: 'build'; id: string; name: string; stage: BuildStage; at: string; draft: ApplicationDraft }
  | { kind: 'improve'; id: string; name: string; state: string; working: boolean; at: string; draft: ApplicationDraft }
  | { kind: 'app'; id: string; name: string; at: string; app: BusinessApp }
  | { kind: 'sent-proposal' | 'review-proposal'; id: string; name: string; at: string; proposal: SourceChangeProposal }

function buildStage(draft: ApplicationDraft): BuildStage {
  const session = readBuildSession(draft.id)
  return deriveStage({ draft, published: draftPublished(draft), lastPlannedIntent: session?.lastPlannedIntent, now: Date.now() }).stage
}

/**
 * The caller's 作りかけ, newest activity first. `poll: false` (the nav badge) reads
 * the same caches without keeping a running draft polled from every page.
 */
export function useUnfinished(me: Me, { poll = true }: { poll?: boolean } = {}) {
  const apps = useQuery(appsQuery({ scope: 'mine' }))
  const drafts = useQuery({ ...draftsOptions(me.projectId), ...(poll ? {} : { refetchInterval: false as const }) })
  const sent = useQuery({ ...proposalsOptions(me.projectId, { proposer: 'me' }), ...(poll ? {} : { refetchInterval: false as const }) })
  const incoming = useQuery({ ...proposalsOptions(me.projectId, { reviewer: 'me', phase: 'Proposed' }), ...(poll ? {} : { refetchInterval: false as const }) })
  const bound = (apps.data ?? []).filter((app) => app.stackId)
  const open = (drafts.data?.data ?? []).filter((draft) => draft.phase !== 'archived' && !draft.proposalId)
  const builds = open.filter((draft) => !isImprovementDraft(draft) && !bound.some((app) => app.stackId === draft.createdApplicationStackId))
  // An AI session's own app is briefly unbound before binding; it is listed once, as the session.
  const sessionApps = new Set(builds.map((draft) => readBuildSession(draft.id)?.createdAppId).filter(Boolean))
  const items: UnfinishedItem[] = [
    ...(sent.data?.data ?? []).filter((proposal) => !proposalTerminal(proposal.phase)).map((proposal) => ({ kind: 'sent-proposal' as const, id: proposal.id, name: proposal.title, at: proposal.updatedAt, proposal })),
    ...(incoming.data?.data ?? []).map((proposal) => ({ kind: 'review-proposal' as const, id: proposal.id, name: proposal.title, at: proposal.updatedAt, proposal })),
    ...builds.map((draft) => ({ kind: 'build' as const, id: draft.id, name: parseSpec(draft.specMarkdown).spec.name ?? draft.title, stage: buildStage(draft), at: draft.updatedAt, draft })),
    ...open.filter(isImprovementDraft).map((draft) => {
      const state = deriveImprove(draft)
      const name = bound.find((app) => app.stackId === draft.createdApplicationStackId)?.displayName ?? draft.title
      return { kind: 'improve' as const, id: draft.id, name, state: improveStateWord(state.phase, state.version), working: state.phase === 'running', at: draft.updatedAt, draft }
    }),
    ...(apps.data ?? []).filter((app) => !app.stackId && !sessionApps.has(app.id)).map((app) => ({ kind: 'app' as const, id: app.id, name: app.displayName, at: Date.parse(app.updatedAt) > Date.parse(app.createdAt) ? app.updatedAt : app.createdAt, app })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return { items, apps, drafts, sent, incoming, loading: apps.isPending || drafts.isPending || sent.isPending || incoming.isPending }
}

export function DraftsPage() {
  useDocumentTitle(text.drafts.title)
  const { me } = useShell()
  const lookup = useAppViews(me.projectId)
  const { items, apps, drafts, sent, incoming, loading } = useUnfinished(me)
  const start = me.canCreateApps ? <LinkButton tone="primary" href={paths.new()}>{text.drafts.create}</LinkButton> : undefined
  return (
    <div className="space-y-6">
      <PageHeader title={text.drafts.title} lead={text.drafts.lead} actions={items.length ? start : undefined} />
      {items.some((item) => item.kind === 'app') ? <StatusLoadNotice lookup={lookup} /> : null}
      {drafts.isLoadingError ? <LoadFailed error={drafts.error} onRetry={() => void drafts.refetch()} /> : null}
      {apps.isError ? <LoadFailed error={apps.error} onRetry={() => void apps.refetch()} /> : null}
      {sent.isError ? <LoadFailed error={sent.error} onRetry={() => void sent.refetch()} /> : null}
      {incoming.isError ? <LoadFailed error={incoming.error} onRetry={() => void incoming.refetch()} /> : null}
      {loading ? <AppListSkeleton /> : items.length ? (
        <ul aria-label={text.drafts.title} className="divide-y divide-stone-100 rounded-lg border border-line bg-white">
          {items.map((item) => {
            const updated = relativeTime(item.at)
            return <li key={`${item.kind}-${item.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-0 flex-[1_1_16rem]">
              <HrefLink href={item.kind === 'build' ? paths.build(item.id) : item.kind === 'improve' ? paths.improve(item.id) : item.kind === 'app' ? paths.app(item.app.group.path, item.app.slug) : paths.proposal(item.id)} className="block truncate text-sm font-semibold text-stone-900 hover:text-accent-strong hover:underline">{item.name}</HrefLink>
              <p className="mt-0.5 text-xs text-stone-500">
                {item.kind === 'build' ? text.drafts.building(stageLabels[item.stage]) : item.kind === 'improve' ? item.state : item.kind === 'app' ? item.app.group.name : item.kind === 'sent-proposal' ? proposalText.outgoing : proposalText.incoming}
                {updated ? text.drafts.updated(updated) : ''}
              </p>
            </div>
            {item.kind === 'build' ? <div className="flex items-center gap-3">
              <StatusPill status={item.stage === 'build' ? 'deploying' : 'unfinished'} label={stateWord[item.stage]} />
              <HrefLink href={paths.build(item.id)} className="inline-flex min-h-10 items-center text-xs font-medium text-accent-strong underline md:min-h-8">{text.list.resume}</HrefLink>
              <DiscardBuildButton draft={item.draft} />
            </div> : item.kind === 'improve' ? <div className="flex items-center gap-3">
              <StatusPill status={item.working ? 'deploying' : 'unfinished'} label={improveText.entry.action} />
              <HrefLink href={paths.improve(item.id)} className="inline-flex min-h-10 items-center text-xs font-medium text-accent-strong underline md:min-h-8">{improveText.drafts.resume}</HrefLink>
            </div> : item.kind === 'app' ? <AppStatus app={item.app} lookup={lookup} /> : <ProposalStatus proposal={item.proposal} />}
            </li>
          })}
        </ul>
      ) : apps.isError ? null : (
        <EmptyState
          icon={<PencilLine aria-hidden />}
          title={text.drafts.empty}
          body={me.canCreateApps ? text.drafts.emptyBody : text.mine.cannotCreate}
          action={start}
        />
      )}
    </div>
  )
}
