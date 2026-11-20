// The single composition point for 「あなたの対応待ち」 (ux-design §6.3) and the
// maker nav badges: the console inbox plus the Platform-side facts the server
// cannot see. Every read below is shared with the screens that already make it.
import { useQuery } from '@tanstack/react-query'
import { inboxQuery, useApps, useMe } from '../../api/queries/console'
import { useProposalPeople } from '../../api/queries/proposal'
import { applicationForStack } from '../../model/app'
import type { ConsoleView } from '../../model/contracts/console'
import { useAppViews } from '../app/use-app-views'
import { stageLabels } from '../build/session'
import { text as discoverText } from '../discover/copy'
import { useUnfinished } from '../discover/drafts'
import { inboxText } from './copy'
import { draftRow, isDraftItem, orderInbox, problemRows, proposalRows, serverRows, type InboxItem } from './model'

export type Inbox = {
  /** Ordered problem, proposal, accessRequest, feedback, draft. */
  items: InboxItem[]
  /** Number of rows. */
  total: number
  /** GET /api/console/inbox has answered (data or failure); Platform-side rows do not gate it. */
  ready: boolean
}

export function useInbox(): Inbox {
  const { data: me } = useMe()
  const server = useQuery(inboxQuery)
  const mine = useApps({ scope: 'mine' })
  const views = useAppViews(me.projectId)
  const unfinished = useUnfinished(me, { poll: false })
  const incoming = unfinished.incoming.data?.data ?? []
  // Proposals name a Platform application; the visible list maps it back to the console app.
  const visible = useApps({ scope: 'all' }, incoming.length > 0)
  const people = useProposalPeople(incoming.map((proposal) => proposal.proposer))

  // A status that is still loading or unreadable claims no problem.
  const problems = views.loading || views.failed ? [] : (mine.data ?? [])
    .filter((app) => app.stackId)
    .map((app) => ({ app, view: views.viewFor(app) }))
    .filter(({ view }) => view.status === 'failed')
    .map(({ app, view }) => ({ app, note: view.second }))
    .sort((a, b) => a.app.displayName.localeCompare(b.app.displayName))

  const items = orderInbox([
    ...problemRows(problems),
    ...proposalRows(
      incoming,
      (applicationId) => visible.data?.find((app) => applicationForStack(app.stackId, views.input)?.id === applicationId),
      (subject) => people.find((person) => person.subject === subject)?.displayName
    ),
    ...serverRows(server.data ?? []),
    ...unfinished.items.filter(isDraftItem).map((item) => draftRow(item,
      item.kind === 'build' ? discoverText.drafts.building(stageLabels[item.stage])
        : item.kind === 'improve' ? item.state
        : inboxText.note.draft)),
  ])
  return { items, total: items.length, ready: server.data !== undefined || server.isError }
}

/**
 * The view the shell and home render. The server decides `me.view`; unfinished
 * drafts (a Platform fact) widen `user` to `maker`. Nothing here narrows it.
 */
export function useConsoleView(): ConsoleView {
  const { data: me } = useMe()
  const { items } = useUnfinished(me, { poll: false })
  return me.view === 'maker' || items.some(isDraftItem) ? 'maker' : 'user'
}
