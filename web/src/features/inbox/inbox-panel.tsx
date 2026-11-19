// 「あなたの対応待ち」 (ux-design §6.3, WF-02): one row per thing to do, most
// urgent first, each with exactly one next action. Nothing to do → no section.
import { HrefLink, cn } from '../../ui'
import { inboxText } from './copy'
import type { InboxItem, InboxKind } from './model'
import { useInbox } from './use-inbox'

const PILL: Record<InboxKind, string> = {
  problem: 'bg-bad-soft text-bad-ink ring-red-200',
  proposal: 'bg-busy-soft text-busy-ink ring-amber-200',
  accessRequest: 'bg-busy-soft text-busy-ink ring-amber-200',
  feedback: 'bg-busy-soft text-busy-ink ring-amber-200',
  draft: 'bg-stone-100 text-stone-600 ring-stone-200',
}

/** `limit` rows at most; when more wait, 「すべて見る」 leads to `seeAllHref`. */
export function InboxPanel({ limit = 5, seeAllHref }: { limit?: number; seeAllHref?: string }) {
  const { items, total } = useInbox()
  if (total === 0) return null
  return (
    <section aria-labelledby="inbox-title">
      <div className="mb-3 flex items-end justify-between gap-4">
        <h2 id="inbox-title" className="flex items-baseline gap-2 text-lg font-semibold text-stone-900">
          {inboxText.title}
          <span className="text-sm font-normal text-stone-500">{inboxText.count(total)}</span>
        </h2>
        {seeAllHref && total > limit ? (
          <HrefLink href={seeAllHref} className="inline-flex min-h-10 shrink-0 items-center text-sm font-medium text-accent-strong hover:underline">
            {inboxText.seeAll}
          </HrefLink>
        ) : null}
      </div>
      <ul aria-label={inboxText.rowsLabel} className="divide-y divide-stone-100 overflow-hidden rounded-lg border border-line bg-white">
        {items.slice(0, limit).map((item) => <InboxRow key={`${item.kind}-${item.app.id}`} item={item} />)}
      </ul>
    </section>
  )
}

function InboxRow({ item }: { item: InboxItem }) {
  const action = inboxText.action[item.kind]
  const pill: (count: number) => string = inboxText.pill[item.kind]
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-2 text-sm sm:grid-cols-[8.5rem_10rem_minmax(0,1fr)_auto]">
      <span className={cn('inline-flex items-center justify-self-start rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', PILL[item.kind])}>
        {pill(item.count)}
      </span>
      <span className="min-w-0 truncate font-medium text-stone-900">{item.app.displayName}</span>
      <span className="col-span-3 row-start-2 min-w-0 text-stone-600 sm:col-span-1 sm:row-start-auto">{item.note}</span>
      <HrefLink
        href={item.href}
        aria-label={inboxText.actionLabel(action, item.app.displayName)}
        className="col-start-3 row-start-1 inline-flex min-h-10 items-center justify-self-end text-sm font-medium whitespace-nowrap text-accent-strong underline underline-offset-2 hover:text-accent sm:col-start-auto sm:row-start-auto md:min-h-8"
      >
        {action}
      </HrefLink>
    </li>
  )
}
