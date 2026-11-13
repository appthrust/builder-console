import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useDeferredValue, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { sharingCopy } from '../../../copy/sharing'
import type { DirectoryUser } from '../../../model/contracts/console'
import { directoryUsersQuery } from '../../../api/queries/console'
import { copy } from '../../../copy'
import { Avatar, Button, Card, CardBody, CardHeader, LoadFailed, Loading, TextInput } from '../../../ui'
import { text } from '../copy'

/** First message among TanStack Form field errors (strings or Standard Schema issues). */
export function fieldError(errors: readonly unknown[]): string | undefined {
  for (const error of errors) {
    if (typeof error === 'string') return error
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  }
  return undefined
}

/** One independently saved settings block; `id` is the in-page anchor (`…/-/settings#share`). */
export function SettingsCard({
  id,
  title,
  lead,
  danger = false,
  children,
}: {
  id: string
  title: string
  lead?: string
  danger?: boolean
  children: ReactNode
}) {
  return (
    <section id={id} aria-label={title} className="scroll-mt-48 md:scroll-mt-24">
      <Card>
        <CardHeader title={danger ? <span className="text-bad-ink">{title}</span> : title} lead={lead} />
        <CardBody>{children}</CardBody>
      </Card>
    </section>
  )
}

/** Save button + 「保存しました。」 in place, shared by every settings form. */
export function SaveRow({ pending, disabled, saved, label = copy.app.settings.save }: { pending: boolean; disabled: boolean; saved: boolean; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="submit" tone="primary" loading={pending} disabled={disabled}>
        {pending ? copy.app.settings.saving : label}
      </Button>
      {saved ? (
        <span role="status" className="text-sm text-accent-strong">
          {copy.app.settings.saved}
        </span>
      ) : null}
    </div>
  )
}

const DIRECTORY_LIMIT = 6

/** Search the Directory's realm accounts by name or email and act on a hit (make owner, add viewer). */
export function PersonSearch({
  id,
  label,
  hint,
  actionLabel,
  takenEmails,
  takenLabel,
  pendingId,
  onPick,
  allowEmail = false,
  disabled = false,
}: {
  id: string
  label: string
  hint?: string
  actionLabel: string
  /** Emails already chosen (shown with `takenLabel` instead of the action); realm account ids differ from Directory person ids. */
  takenEmails: readonly string[]
  takenLabel: string
  /** Realm account id (or the typed email for an invitation) whose action is in flight. */
  pendingId?: string
  onPick: (entry: DirectoryUser) => void
  allowEmail?: boolean
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const term = useDeferredValue(query.trim())
  const directory = useQuery(directoryUsersQuery(term))
  const email = query.trim().toLowerCase()
  const validEmail = z.email().safeParse(email).success
  const emailKnown = takenEmails.includes(email) || directory.data?.some((person) => person.email.toLowerCase() === email)

  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-stone-800">
        {label}
      </label>
      {hint ? <p className="mt-0.5 text-xs text-stone-500">{hint}</p> : null}
      <div className="relative mt-1.5">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
        <TextInput
          id={id}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={text.settings.ownerSearchPlaceholder}
          autoComplete="off"
          className="pl-9"
          disabled={disabled}
        />
      </div>
      {term ? (
        <div className="mt-2" aria-live="polite">
          {directory.isPending ? (
            <Loading className="py-3" />
          ) : directory.isError ? (
            <LoadFailed error={directory.error} onRetry={() => void directory.refetch()} />
          ) : directory.data.length === 0 ? (
            <p className="py-2 text-sm text-stone-500">{text.settings.ownerNoMatch}</p>
          ) : (
            <ul className="divide-y divide-stone-100 rounded-md border border-stone-200 bg-white">
              {directory.data.slice(0, DIRECTORY_LIMIT).map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 px-3 py-2">
                  <Avatar person={{ id: entry.id, displayName: entry.displayName, avatarVersion: null }} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-stone-900">{entry.displayName}</span>
                    <span className="block truncate text-xs text-stone-500">{entry.email}</span>
                  </span>
                  {takenEmails.includes(entry.email.toLowerCase()) ? (
                    <span className="text-xs text-stone-500">{takenLabel}</span>
                  ) : (
                    <Button
                      size="sm"
                      loading={pendingId === entry.id}
                      disabled={disabled || pendingId !== undefined}
                      onClick={() => onPick(entry)}
                      aria-label={text.settings.personAction(entry.displayName, actionLabel)}
                    >
                      {actionLabel}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {allowEmail && email && !emailKnown ? (
        <div className="mt-2">
          <Button disabled={disabled || pendingId !== undefined || !validEmail} onClick={() => onPick({ id: email, email, displayName: email })}>
            {sharingCopy.invite}
          </Button>
          {!validEmail && email.includes('@') ? <p className="mt-1 text-xs text-bad-ink">{sharingCopy.invalidEmail}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
