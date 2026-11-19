import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { commentsQuery } from '../../api/queries/console'
import { copy, relativeTime } from '../../copy'
import { isUnknownPerson, type AppComment, type BusinessApp } from '../../model/contracts/console'
import { paths } from '../../routes/paths'
import { Avatar, Button, Card, CardBody, HrefLink, ResourceBoundary } from '../../ui'
import { useInbox } from '../inbox'
import { ImproveDialog } from '../improve/entry'
import { text } from './copy'
import { useMarkCommentsSeen } from './mutations'

const SHOWN = 2

/**
 * 「利用者の声」 on a maintainer's 概要 (ux-design §6.7/§6.10, WF-05 ④): the two newest comments, how many were new
 * when the page opened, the way to the whole thread, and 「これを AIで直す」 per comment. Opening it counts as
 * having seen the comments; the new count stays as it was on arrival so the badge does not vanish under the reader.
 * `stackId`: the app's stack while it can be improved (no build session running); without it there is no AI entry.
 */
export function VoicesPanel({ app, projectId, stackId }: { app: BusinessApp; projectId: string; stackId: string | undefined }) {
  const comments = useQuery(commentsQuery(app.id))
  const inbox = useInbox()
  const unread = inbox.items.find((item) => item.kind === 'feedback' && item.app.id === app.id)?.count ?? 0
  const { mutate: markSeen } = useMarkCommentsSeen(app.id)
  const [arrival, setArrival] = useState<number>()
  const marked = useRef(false)
  // Once per mount, after the inbox has answered: pin the new count, then mark the thread seen.
  useEffect(() => {
    if (marked.current || !inbox.ready) return
    marked.current = true
    setArrival(unread)
    markSeen()
  }, [inbox.ready, unread, markSeen])
  const [fixing, setFixing] = useState<AppComment>()
  const ownerIds = new Set(app.owners.filter((owner) => !isUnknownPerson(owner)).map((owner) => owner.id))
  const newCount = arrival ?? unread

  return (
    <section id="voices" aria-labelledby="voices-title" className="scroll-mt-24" data-testid="voices-panel">
      <Card>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-100 px-5 py-3">
          <h2 id="voices-title" className="text-sm font-semibold text-stone-900">{text.maintainer.voicesTitle}</h2>
          {newCount > 0 ? (
            <span className="rounded-full bg-busy-soft px-2 py-0.5 text-xs font-medium text-busy-ink" data-testid="voices-new">{text.maintainer.voicesNew(newCount)}</span>
          ) : null}
          <HrefLink
            href={`${paths.app(app.group.path, app.slug, 'guide')}#comments`}
            className="ml-auto inline-flex min-h-10 items-center text-sm font-medium text-accent-strong underline-offset-2 hover:underline md:min-h-8"
          >
            {text.maintainer.voicesAll}
          </HrefLink>
        </div>
        <CardBody>
          <ResourceBoundary query={comments} resetKey={app.id}>
            {(list, stale) => (
              <>
                {stale ? <div className="mb-3">{stale}</div> : null}
                {list.length === 0 ? (
                  <p className="text-sm text-stone-500">{text.maintainer.voicesEmpty}</p>
                ) : (
                  <ul className="-my-3 divide-y divide-stone-100">
                    {list.slice(0, SHOWN).map((comment) => {
                      // A removed person keeps their comment, shown without a name that no longer exists.
                      const author = isUnknownPerson(comment.author) ? undefined : comment.author
                      const authorName = author ? author.displayName : copy.common.unknownPerson
                      return (
                        <li key={comment.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start">
                          <div className="flex min-w-0 flex-1 items-start gap-3">
                            <Avatar person={author ?? { id: comment.author.id, displayName: authorName, avatarVersion: null }} />
                            <div className="min-w-0 flex-1">
                              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
                                <span className={author ? 'font-medium text-stone-700' : undefined}>{authorName}</span>
                                {ownerIds.has(comment.author.id) ? <span className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-700">{text.comments.ownerBadge}</span> : null}
                                <time dateTime={comment.createdAt}>{relativeTime(comment.createdAt)}</time>
                              </p>
                              <p className="mt-1 line-clamp-3 text-sm leading-relaxed break-words whitespace-pre-wrap text-stone-800">{comment.body}</p>
                            </div>
                          </div>
                          {stackId ? (
                            <Button size="sm" icon={<Sparkles />} className="self-start sm:shrink-0" onClick={() => setFixing(comment)}>
                              {text.maintainer.voicesFix}
                            </Button>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </>
            )}
          </ResourceBoundary>
        </CardBody>
      </Card>
      {stackId ? (
        <ImproveDialog
          app={app}
          stackId={stackId}
          projectId={projectId}
          open={fixing !== undefined}
          onOpenChange={(open) => { if (!open) setFixing(undefined) }}
          draft={fixing?.body ?? ''}
        />
      ) : null}
    </section>
  )
}
