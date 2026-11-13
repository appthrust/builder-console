import { useQuery } from '@tanstack/react-query'
import { MoreHorizontal, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { isConsoleError } from '../../api/console'
import { isUnknownPerson, membershipRoots, type AppComment, type Group, type Me, type Person } from '../../model/contracts/console'
import { commentsQuery, useGroups, useMe } from '../../api/queries/console'
import { copy, relativeTime } from '../../copy'
import { ActionError, Avatar, Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, IconButton, Notice, ResourceBoundary, Section, TextArea } from '../../ui'
import { text } from './copy'
import { usePostComment, useRemoveComment } from './mutations'

const MAX_COMMENT_LENGTH = 1000
const COMMENT_COUNTER_THRESHOLD = 900
const COMMENT_LIST_LIMIT = 100

export function commentInput(body: string) {
  const length = Array.from(body).length
  const trimmed = body.trim()
  const tooLong = length > MAX_COMMENT_LENGTH
  return { body: trimmed, length, tooLong, canSend: trimmed.length > 0 && !tooLong }
}

/** The caller's shallowest membership root, from `me` without another request. */
export function commentDepartment(me: Pick<Me, 'effectiveGroupIds'>, groups: readonly Group[]): string | undefined {
  return membershipRoots(me, groups)
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.name.localeCompare(b.name, 'ja'))[0]?.name
}

export function canDeleteComment(comment: AppComment, personId: string, canDeleteAny: boolean): boolean {
  return comment.author.id === personId || canDeleteAny
}

export function commentPreview(body: string): string {
  const characters = Array.from(body)
  return characters.slice(0, 30).join('') + (characters.length > 30 ? '…' : '')
}

export function commentErrorText(error: unknown): string | undefined {
  if (!isConsoleError(error)) return undefined
  if (error.status === 429) return text.comments.tooMany
  if (error.status === 400) return text.comments.tooLong
  return undefined
}

type CommentsProps = { appId: string; owners: Person[]; canDeleteAny: boolean }

/** Shared by the guide and the directory entry; never needs the full app or its visibility policy. */
export function Comments(props: CommentsProps) {
  // Changing apps must discard the previous thread's composer and delete target.
  return <CommentThread key={props.appId} {...props} />
}

function CommentThread({ appId, owners, canDeleteAny }: CommentsProps) {
  const me = useMe().data
  const groups = useGroups().data
  const comments = useQuery(commentsQuery(appId))
  const post = usePostComment(appId)
  const remove = useRemoveComment(appId)
  const [body, setBody] = useState('')
  const [focused, setFocused] = useState(false)
  const [deleting, setDeleting] = useState<AppComment>()
  const id = useId()
  const input = commentInput(body)
  const department = commentDepartment(me, groups)
  const ownerIds = new Set(owners.map((owner) => owner.id))
  const showCounter = input.length > COMMENT_COUNTER_THRESHOLD
  const title = comments.data ? text.comments.title(comments.data.length) : text.comments.loadingTitle

  return (
    <Section title={title}>
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault()
        if (!input.canSend || post.isPending) return
        post.mutate(input.body, { onSuccess: () => {
          setBody('')
          post.reset()
        } })
      }}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <TextArea
              id={id}
              aria-label={text.comments.body}
              aria-describedby={input.tooLong ? `${id}-error` : showCounter ? `${id}-hint` : undefined}
              placeholder={text.comments.placeholder}
              className="min-h-0 resize-y"
              rows={focused ? 3 : 1}
              value={body}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(event) => {
                setBody(event.target.value)
                if (post.isError) post.reset()
              }}
              disabled={post.isPending}
              invalid={input.tooLong}
            />
            {showCounter ? <p id={`${id}-hint`} className="mt-1.5 text-right text-xs text-stone-500" aria-live="polite">{text.comments.remaining(MAX_COMMENT_LENGTH - input.length)}</p> : null}
            {input.tooLong ? <p id={`${id}-error`} className="mt-1.5 text-xs text-bad-ink">{text.comments.tooLong}</p> : null}
          </div>
          <Button type="submit" tone="primary" loading={post.isPending} disabled={!input.canSend}>{text.comments.send}</Button>
        </div>
        {post.error ? <CommentError error={post.error} /> : null}
      </form>

      {/* The list can fail or go stale on its own; the composer above stays usable either way. */}
      <div className="mt-4">
        <ResourceBoundary
          query={comments}
          resetKey={appId}
          failure={(error, retry) => (
            <div className="space-y-3">
              <CommentError error={error} />
              <Button size="sm" onClick={retry} loading={comments.isFetching}>{copy.common.retry}</Button>
            </div>
          )}
        >
          {(list) => list.length === 0 ? <p className="py-6 text-sm text-stone-500">{text.comments.empty}</p> : (
            <>
              <ul className="divide-y divide-stone-100">
                {list.map((comment) => {
                  const authorDepartment = comment.author.id === me.person.id ? department : undefined
                  // A removed person keeps their comment, shown without a name or contact that no longer exists.
                  const author = isUnknownPerson(comment.author) ? undefined : comment.author
                  const authorName = author ? author.displayName : copy.common.unknownPerson
                  return (
                    <li key={comment.id} className="flex items-start gap-3 py-4">
                      <Avatar person={author ?? { id: comment.author.id, displayName: authorName, avatarVersion: null }} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
                          <span className={author ? 'text-sm font-medium break-words text-stone-900' : 'text-sm font-medium text-stone-500'}>{authorName}</span>
                          {authorDepartment ? <span>{authorDepartment}</span> : null}
                          {ownerIds.has(comment.author.id) ? <span className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-700">{text.comments.ownerBadge}</span> : null}
                          <time dateTime={comment.createdAt}>{relativeTime(comment.createdAt)}</time>
                        </div>
                        <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-stone-800">{comment.body}</p>
                      </div>
                      {canDeleteComment(comment, me.person.id, canDeleteAny) ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton label={text.comments.menu} icon={<MoreHorizontal />} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => {
                              remove.reset()
                              setDeleting(comment)
                            }} className="text-bad-ink data-highlighted:bg-bad-soft data-highlighted:text-bad-ink [&_svg]:text-bad">
                              <Trash2 aria-hidden />
                              {text.comments.delete}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              {list.length >= COMMENT_LIST_LIMIT ? <p className="mt-3 text-xs text-stone-500">{text.comments.truncated}</p> : null}
            </>
          )}
        </ResourceBoundary>
      </div>

      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(undefined)
            remove.reset()
          }
        }}
        title={text.comments.deleteTitle}
        body={deleting ? <div className="space-y-3">
          <p className="break-words whitespace-pre-wrap">{text.comments.deleteBody(commentPreview(deleting.body))}</p>
          {remove.error ? <CommentError error={remove.error} /> : null}
        </div> : null}
        tone="danger"
        confirmLabel={text.comments.delete}
        pending={remove.isPending}
        onConfirm={() => {
          if (!deleting || remove.isPending || !canDeleteComment(deleting, me.person.id, canDeleteAny)) return
          remove.mutate(deleting.id, { onSuccess: () => setDeleting(undefined) })
        }}
      />
    </Section>
  )
}

function CommentError({ error }: { error: unknown }) {
  const message = commentErrorText(error)
  return message ? <Notice tone="error">{message}</Notice> : <ActionError error={error} />
}
