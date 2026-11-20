// 「あなたの対応待ち」 rows (role-based-views ux-design §6.3): pure composition
// of the console inbox (access requests, unread feedback) and the Platform-side
// facts (問題あり apps, proposals awaiting the caller, unfinished drafts).
// `useInbox` is the only caller; no screen derives these counts itself.
import type { BusinessApp, InboxServerItem } from '../../model/contracts/console'
import type { Proposal } from '../../model/contracts/proposal'
import { paths } from '../../routes/paths'
import type { UnfinishedItem } from '../discover/drafts'
import { inboxText } from './copy'

export type InboxKind = 'problem' | 'proposal' | 'accessRequest' | 'feedback' | 'draft'
export type InboxApp = { id: string; path: string; displayName: string; icon: string }
export type InboxItem = {
  kind: InboxKind
  app: InboxApp
  count: number
  since?: string
  href: string
  /** One plain sentence saying why the row is here. */
  note?: string
}

/** Most urgent first (ux-design §6.3). */
export const INBOX_ORDER: readonly InboxKind[] = ['problem', 'proposal', 'accessRequest', 'feedback', 'draft']

export const appRef = (app: Pick<BusinessApp, 'id' | 'slug' | 'displayName' | 'icon' | 'group'>): InboxApp => ({
  id: app.id,
  path: `${app.group.path}/${app.slug}`,
  displayName: app.displayName,
  icon: app.icon,
})

/** App page of a `<group-path>/<slug>` path. */
export function appPathHref(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? paths.home : paths.app(path.slice(0, slash), path.slice(slash + 1))
}

/** The anchor of the maintainer's 「利用者の声」 panel on the app page (DS-3 VoicesPanel). */
export const VOICES_ANCHOR = 'voices'

export function problemRows(apps: readonly { app: BusinessApp; note: string }[]): InboxItem[] {
  return apps.map(({ app, note }) => ({ kind: 'problem', app: appRef(app), count: 1, href: paths.app(app.group.path, app.slug), note }))
}

/**
 * Proposals awaiting the caller (reviewer=me, phase Proposed), one row per app.
 * An app the console cannot resolve keeps its row under the proposal's title.
 */
export function proposalRows(
  proposals: readonly Proposal[],
  resolveApp: (applicationId: string) => BusinessApp | undefined,
  proposerName: (subject: string) => string | undefined
): InboxItem[] {
  const byApp = new Map<string, Proposal[]>()
  for (const proposal of proposals) byApp.set(proposal.applicationId, [...(byApp.get(proposal.applicationId) ?? []), proposal])
  return [...byApp.entries()]
    .map(([applicationId, group]): InboxItem => {
      const app = resolveApp(applicationId)
      const since = group.map((proposal) => proposal.updatedAt).sort().at(-1)
      const only = group.length === 1 ? group[0] : undefined
      const name = only ? proposerName(only.proposer) : undefined
      return {
        kind: 'proposal',
        app: app ? appRef(app) : { id: applicationId, path: '', displayName: group[0].title, icon: '' },
        count: group.length,
        since,
        href: only ? paths.proposal(only.id) : paths.proposals(applicationId),
        note: name ? inboxText.note.proposalBy(name) : inboxText.note.proposal,
      }
    })
    .sort((a, b) => (b.since ?? '').localeCompare(a.since ?? ''))
}

/** Console-held rows; the server already omits zero counts and orders within a kind. */
export function serverRows(items: readonly InboxServerItem[]): InboxItem[] {
  return items.filter((item) => item.count > 0).map((item) => ({
    kind: item.kind,
    app: item.app,
    count: item.count,
    since: item.since,
    href: item.kind === 'feedback' ? `${appPathHref(item.app.path)}#${VOICES_ANCHOR}` : appPathHref(item.app.path),
    note: item.kind === 'feedback' ? inboxText.note.feedback : inboxText.note.accessRequest,
  }))
}

export type DraftItem = Extract<UnfinishedItem, { kind: 'unreadable' | 'build' | 'improve' | 'app' }>

/** Work the caller started that is not an app yet (proposals are rows of their own). */
export function isDraftItem(item: UnfinishedItem): item is DraftItem {
  return item.kind === 'unreadable' || item.kind === 'build' || item.kind === 'improve' || item.kind === 'app'
}

export function draftRow(item: DraftItem, note: string): InboxItem {
  const href = item.kind === 'build' ? paths.build(item.id)
    : item.kind === 'improve' ? paths.improve(item.id)
    : item.kind === 'app' ? paths.new({ resume: item.app.id })
    : paths.drafts()
  const app = item.kind === 'app' ? appRef(item.app) : { id: item.id, path: '', displayName: item.name, icon: '' }
  return { kind: 'draft', app, count: 1, since: item.at || undefined, href, note }
}

/** Stable by kind; each kind keeps the order its source gave it. */
export function orderInbox(items: readonly InboxItem[]): InboxItem[] {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => INBOX_ORDER.indexOf(a.item.kind) - INBOX_ORDER.indexOf(b.item.kind) || a.index - b.index)
    .map(({ item }) => item)
}
