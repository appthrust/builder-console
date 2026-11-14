import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { conversationSettingApi, isConversationSettingConflict } from '../../api/conversation-setting'
import { consoleKeys, conversationSettingQuery, searchPeople } from '../../api/queries/console'
import { copy, relativeTime } from '../../copy'
import { isUnknownPerson, type ConversationSetting, type ConversationSettingInput, type DirectoryUser } from '../../model/contracts/console'
import { ActionError, Avatar, Button, Card, CardBody, CardHeader, Notice, RadioCards, ResourceBoundary, Skeleton, useUnsavedChangesGuard } from '../../ui'
import { UnconfirmedNotice, useWriteConfirmation } from '../app/notices'
import { PersonSearch, SaveRow } from '../app/settings/parts'
import { text } from './copy'

type ConversationMode = ConversationSettingInput['mode']
type Draft = { mode: ConversationMode; allowlist: ConversationSetting['allowlist'] }
/** The unsaved choice and the version it was started from: saving sends that version as `If-Match`. */
type Pending = Draft & { base: number }

const MODES: readonly ConversationMode[] = ['off', 'allowlist', 'on']
/** The contract's bound on the allowlist (`ConversationSettingInput.allowlist` max 200). */
export const CONVERSATION_ALLOWLIST_LIMIT = 200

/** Same choice: the mode and the set of people (order is not a choice). */
function sameDraft(a: Draft, b: Draft): boolean {
  if (a.mode !== b.mode || a.allowlist.length !== b.allowlist.length) return false
  const subjects = new Set(b.allowlist.map((entry) => entry.subject))
  return a.allowlist.every((entry) => subjects.has(entry.subject))
}

/** What the server holds, in words (the 412 notice compares it with the unsaved choice). */
function describe(setting: ConversationSetting): string {
  if (setting.mode.kind === 'unknown') return text.conversation.unknownMode
  const title = text.conversation.modes[setting.mode.value].title
  return setting.mode.value === 'allowlist' ? text.conversation.summaryWithPeople(title, setting.allowlist.length) : title
}

/**
 * 新しい AI 会話 (APT-753): who starts new apps in the console-v1 conversation. Console administrators only (the page
 * renders it for them); the setting applies to this Console installation and to apps started from now on.
 */
export function ConversationSettingCard() {
  const setting = useQuery(conversationSettingQuery)
  return (
    <section aria-labelledby="conversation-setting-title" data-testid="conversation-setting">
      <Card>
        <CardHeader title={<span id="conversation-setting-title">{text.conversation.title}</span>} lead={text.conversation.lead} />
        <CardBody>
          <ResourceBoundary
            query={setting}
            resetKey="admin-conversation"
            loading={
              <div className="grid gap-2 sm:grid-cols-3" aria-busy="true">
                {MODES.map((mode) => <Skeleton key={mode} className="h-20" />)}
              </div>
            }
          >
            {(data, stale) => <ConversationForm setting={data} stale={stale} />}
          </ResourceBoundary>
        </CardBody>
      </Card>
    </section>
  )
}

function ConversationForm({ setting, stale }: { setting: ConversationSetting; stale: ReactNode }) {
  const queryClient = useQueryClient()
  const words = text.conversation
  const known = setting.mode.kind === 'known' ? setting.mode.value : undefined
  const server: Draft | undefined = known ? { mode: known, allowlist: setting.allowlist } : undefined
  // The unsaved choice; undefined while the screen shows (and follows) what the server holds.
  const [draft, setDraft] = useState<Pending>()
  // A save answered 412: the conflict stays even if the read-back that names the newer setting fails.
  const [rejected, setRejected] = useState(false)
  const [saved, setSaved] = useState(false)
  const [notSignedIn, setNotSignedIn] = useState<string>()
  // Addresses of people picked here (the setting stores subjects and names only): marks them 追加済み in the search.
  const [emails, setEmails] = useState<Record<string, string>>({})
  const shown = draft ?? server
  const dirty = draft !== undefined && server !== undefined && !sameDraft(draft, server)
  // Someone saved since the choice was started (a poll read it, or the save was refused): nothing is saved or edited
  // until the user discards the choice or keeps it on top of the newer setting.
  const conflict = draft !== undefined && dirty && (draft.base !== setting.version || rejected)

  // A new read that already matches the unsaved choice (a read-back, another administrator's identical save) ends it.
  useEffect(() => {
    if (draft && server && sameDraft(draft, server)) {
      setDraft(undefined)
      setRejected(false)
    }
  }, [setting])

  // Rejects when the read fails or answers malformed, so a failed confirmation never unlocks saving.
  const readBack = () => queryClient.refetchQueries({ queryKey: consoleKeys.conversationSetting, exact: true }, { throwOnError: true })
  const save = useMutation({
    mutationFn: ({ body, version }: { body: ConversationSettingInput; version: number }) => conversationSettingApi.put(body, version),
    onSuccess: (next) => {
      queryClient.setQueryData(consoleKeys.conversationSetting, next)
      setDraft(undefined) // the next choice starts from the version this save returned
      setRejected(false)
      setSaved(true)
    },
    // Someone saved since this choice was started: show their setting next to the unsaved choice; nothing is resent.
    onError: (error) => {
      if (!isConversationSettingConflict(error)) return
      setRejected(true)
      void readBack().catch(() => undefined) // a failed re-read shows as the stale notice; the conflict notice stays
    },
  })
  // A save whose answer could not be read may have happened: only a successful read-back unlocks saving again.
  const confirmation = useWriteConfirmation([save.error], save.reset, readBack)
  const busy = save.isPending || confirmation.unconfirmed
  const locked = busy || conflict
  useUnsavedChangesGuard(dirty && !save.isPending, words.unsaved)

  const update = (next: (current: Draft) => Draft) => {
    if (!server || conflict) return
    setSaved(false)
    setDraft((current) => {
      const changed = { ...next(current ?? server), base: current?.base ?? setting.version }
      // Back to what the server holds: nothing is unsaved, so the card follows new reads again.
      return sameDraft(changed, server) ? undefined : changed
    })
  }
  const resolveConflict = (keep: boolean) => {
    // Keeping adopts the newer version as the base: the next 保存 replaces that setting, as the user chose.
    setDraft((current) => keep && current ? { ...current, base: setting.version } : undefined)
    setRejected(false)
    save.reset()
  }
  const lookup = useMutation({
    // The Directory person behind the picked account: the setting lists sign-in subjects.
    mutationFn: async (entry: DirectoryUser) => {
      const email = entry.email.toLowerCase()
      return (await searchPeople(entry.email)).find((person) => person.email.toLowerCase() === email)
    },
    onSuccess: (person, entry) => {
      if (!person?.subject) {
        setNotSignedIn(words.notSignedIn(entry.displayName))
        return
      }
      const subject = person.subject
      setNotSignedIn(undefined)
      setEmails((current) => ({ ...current, [subject]: person.email.toLowerCase() }))
      update((current) => current.allowlist.some((item) => item.subject === subject) || current.allowlist.length >= CONVERSATION_ALLOWLIST_LIMIT
        ? current
        : { ...current, allowlist: [...current.allowlist, { subject, displayName: person.displayName }] })
    },
  })

  const people = shown?.allowlist ?? setting.allowlist
  const atLimit = people.length >= CONVERSATION_ALLOWLIST_LIMIT
  const editable = shown !== undefined
  const updatedBy = setting.updatedBy && !isUnknownPerson(setting.updatedBy) ? setting.updatedBy.displayName : copy.common.unknownPerson
  const updatedAt = relativeTime(setting.updatedAt)

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (!draft || !dirty || locked) return
        save.mutate({ body: { mode: draft.mode, allowlist: draft.allowlist.map(({ subject }) => ({ subject })) }, version: draft.base })
      }}
    >
      {stale}
      {editable ? null : <Notice tone="warning">{words.unknownMode}</Notice>}
      {conflict ? (
        <Notice
          tone="warning"
          title={words.conflictTitle}
          actions={<>
            <Button size="sm" onClick={() => resolveConflict(false)}>{words.discard}</Button>
            <Button size="sm" onClick={() => resolveConflict(true)}>{words.keep}</Button>
          </>}
        >
          {words.conflictBody(describe(setting))}
        </Notice>
      ) : null}
      <RadioCards
        name="conversation-mode"
        legend={words.legend}
        columns={3}
        value={shown?.mode}
        disabled={!editable || locked}
        onChange={(mode) => update((current) => ({ ...current, mode }))}
        options={MODES.map((mode) => ({ value: mode, title: words.modes[mode].title, description: words.modes[mode].description }))}
      />
      {shown?.mode === 'allowlist' || (!editable && people.length > 0) ? (
        <div className="border-t border-stone-100 pt-5" data-testid="conversation-allowlist">
          <h3 className="text-sm font-medium text-stone-800">
            {words.people}
            <span className="ml-2 font-normal text-stone-500">{words.peopleCount(people.length)}</span>
          </h3>
          {people.length === 0 ? (
            <p className="mt-2 text-sm text-stone-500">{words.empty}</p>
          ) : (
            <ul className="mt-2 divide-y divide-stone-100 border-y border-stone-100">
              {people.map((entry) => {
                const name = entry.displayName || copy.common.unknownPerson
                return (
                  <li key={entry.subject} className="flex items-center gap-3 py-2" data-testid="conversation-person">
                    {entry.displayName ? <Avatar person={{ id: entry.subject, displayName: entry.displayName, avatarVersion: null }} size="sm" /> : null}
                    <span className="min-w-0 flex-1" data-testid="conversation-person-label">
                      <span className={entry.displayName ? 'block truncate text-sm text-stone-900' : 'block truncate text-sm text-stone-500'}>{name}</span>
                      {emails[entry.subject] ? <span className="block truncate text-xs text-stone-500">{emails[entry.subject]}</span> : null}
                    </span>
                    {editable ? (
                      <Button
                        size="sm"
                        tone="ghost"
                        icon={<X />}
                        disabled={locked}
                        aria-label={words.removeLabel(name)}
                        onClick={() => update((current) => ({ ...current, allowlist: current.allowlist.filter((item) => item.subject !== entry.subject) }))}
                      >
                        {words.remove}
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
          {editable ? (
            <div className="mt-4 sm:max-w-md">
              <PersonSearch
                id="conversation-person-search"
                label={words.search}
                actionLabel={words.add}
                takenEmails={people.flatMap((entry) => emails[entry.subject] ? [emails[entry.subject]!] : [])}
                takenLabel={words.added}
                pendingId={lookup.isPending ? lookup.variables.id : undefined}
                onPick={(entry) => lookup.mutate(entry)}
                disabled={locked || atLimit}
              />
              {atLimit ? <p className="mt-2 text-xs text-stone-600" role="status">{words.limit(CONVERSATION_ALLOWLIST_LIMIT)}</p> : null}
              {notSignedIn ? <p className="mt-2 text-xs text-stone-600" role="status">{notSignedIn}</p> : null}
              {lookup.isError ? <div className="mt-2"><ActionError error={lookup.error} /></div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-stone-100 pt-4">
        {editable ? <SaveRow pending={save.isPending} disabled={!dirty || locked} saved={saved && !dirty} /> : <span />}
        <p className="text-xs text-stone-500" data-testid="conversation-updated">
          {updatedAt ? words.updated(updatedBy, updatedAt) : words.neverUpdated}
        </p>
      </div>
      {confirmation.unconfirmed ? (
        // A failed read-back keeps the gate (no reset) and shows as the stale notice above.
        <UnconfirmedNotice onConfirm={() => void confirmation.confirm().catch(() => undefined)} confirming={confirmation.confirming} />
      ) : save.isError && !isConversationSettingConflict(save.error) ? (
        <ActionError error={save.error} />
      ) : null}
    </form>
  )
}
