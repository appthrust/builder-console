import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { Building2, Globe, Lock, Users } from 'lucide-react'
import { buildGroupTree, flattenGroupTree, isUnknownPerson, type AccessRequest, type BusinessApp, type Me, type Person, type PersonRef } from '../../model/contracts/console'
import { isOneOf, knownValue } from '../../model/contracts/build'
import { putAppAccess, retryAccess } from '../../api/access'
import { appAccessRequestsQuery, consoleKeys, peopleQuery, useGroups } from '../../api/queries/console'
import { keys } from '../../api/queries/shared'
import { copy } from '../../copy'
import { sharingCopy as words } from '../../copy/sharing'
import { accessRequestCopy } from '../../copy/access-request'
import { movePerson, type AccessDisplay } from '../../model/access'
import { knownShare, shareSentence, widensShare, type KnownShare, type ShareScope } from '../../model/share'
import { locale } from '../../shell/language'
import { ActionError, Avatar, Button, ConfirmDialog, CopyButton, Dialog, Disclosure, GroupChecklist, LoadFailed, Notice, RadioCards, Select, Tooltip } from '../../ui'
import { text } from './copy'
import { ensurePerson, useApproveAccessRequest, useDeclineAccessRequest, useUpdateApp } from './mutations'
import { PersonSearch } from './settings/parts'
import { PendingBadge } from './pending-badge'
import { UnconfirmedNotice, useWriteConfirmation } from './notices'

const SCOPES: readonly ShareScope[] = ['private', 'group', 'company', 'public']
const ICONS = { private: Lock, group: Users, company: Building2, public: Globe }

export function ShareDialog({ app, me, canEdit, publishId, url, access, open, onOpenChange, onAccessError }: {
  app: BusinessApp; me: Me; canEdit: boolean; publishId?: string; url?: string; access: AccessDisplay
  open: boolean; onOpenChange: (open: boolean) => void; onAccessError: (error: unknown) => void
}) {
  const groups = useGroups().data
  const flatGroups = useMemo(() => flattenGroupTree(buildGroupTree(groups)), [groups])
  const extraIds = app.share.extraPersonIds.filter((id) => !app.owners.some((owner) => owner.id === id))
  const people = useQuery({ ...peopleQuery(extraIds), enabled: open && extraIds.length > 0 })
  const requests = useQuery({ ...appAccessRequestsQuery(app.id), enabled: open && canEdit })
  const approve = useApproveAccessRequest(app.id)
  const decline = useDeclineAccessRequest(app.id)
  const pending = requests.data?.filter((request) => isOneOf(request.status, 'pending')) ?? []
  const previous = requests.data?.filter((request) => !isOneOf(request.status, 'pending')).slice(0, 20) ?? []
  const update = useUpdateApp(app)
  const queryClient = useQueryClient()
  // A share scope this console does not know is shown as such; nothing that writes the share is offered.
  const share = knownShare(app.share)
  const [scope, setScope] = useState<ShareScope | undefined>(share?.scope)
  const [groupIds, setGroupIds] = useState(app.share.groupIds.length ? [...app.share.groupIds] : [app.group.id])
  const [confirm, setConfirm] = useState<KnownShare>()
  const [invitationEmail, setInvitationEmail] = useState('')
  const requestKey = useRef('')
  const scopeWrite = useMutation({
    mutationFn: async (share: KnownShare) => {
      if (!publishId) throw new Error(words.unavailable)
      // Never PATCH intent before the user's platform write has succeeded.
      await putAppAccess(me.projectId, publishId, share.scope, requestKey.current)
      await update.mutateAsync({ share })
    },
    retry: retryAccess,
    retryDelay: 3_000,
    onError: onAccessError,
    onSuccess: async () => {
      onAccessError(null)
      setConfirm(undefined)
      await queryClient.invalidateQueries({ queryKey: keys.publishes(me.projectId) })
    },
  })
  const add = useMutation({
    mutationFn: async (entry: Parameters<typeof ensurePerson>[0]) => {
      if (!share) throw new Error(text.unsupported.share)
      const person = await ensurePerson(entry)
      await update.mutateAsync(movePerson({ owners: app.owners, share }, person.id, 'viewer'))
      return person
    },
    onSuccess: (person) => setInvitationEmail(person.email),
  })
  // A write whose answer could not be read may have happened: read the app, requests and publish back before anything else.
  const confirmation = useWriteConfirmation(
    [update.error, scopeWrite.error, add.error, approve.error, decline.error],
    () => { update.reset(); scopeWrite.reset(); add.reset(); approve.reset(); decline.reset() },
    () => Promise.all([
      queryClient.refetchQueries({ queryKey: consoleKeys.app(app.id) }),
      queryClient.refetchQueries({ queryKey: consoleKeys.accessRequestsOfApp(app.id) }),
      queryClient.refetchQueries({ queryKey: keys.publishes(me.projectId) }),
    ]),
  )
  const busy = update.isPending || scopeWrite.isPending || add.isPending || approve.isPending || decline.isPending || confirmation.unconfirmed
  const members: PersonRef[] = [...app.owners, ...extraIds.flatMap((id) => {
    const person = people.data?.find((entry) => entry.id === id) ?? requests.data?.find((request) => request.requester.id === id)?.requester
    return person ? [person] : []
  })]
  // Only resolved people have an address; an unknown person is never offered where an email is needed.
  const reachable = members.filter((person): person is Person => !isUnknownPerson(person))
  const dirty = scope !== share?.scope || (scope === 'group' && (groupIds.length !== app.share.groupIds.length || groupIds.some((id) => !app.share.groupIds.includes(id))))
  const saveScope = () => {
    if (!share || !scope) return
    const next: KnownShare = { ...share, scope, groupIds: scope === 'group' ? groupIds : [] }
    requestKey.current = crypto.randomUUID()
    if (widensShare(app.share, next)) setConfirm(next)
    else scopeWrite.mutate(next)
  }
  const movePersonTo = (id: string, role: 'editor' | 'viewer' | 'remove') => {
    if (share) update.mutate(movePerson({ owners: app.owners, share }, id, role))
  }
  const openToAll = isOneOf(app.share.scope, 'company', 'public')
  const invitationOptions = reachable.map((person) => ({ value: person.email, label: person.email }))
  const selectedEmail = reachable.some((person) => person.email === invitationEmail) ? invitationEmail : reachable.find((person) => !app.owners.some((owner) => owner.id === person.id))?.email ?? reachable[0]?.email
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }} title={words.title} description={app.displayName} className="sm:max-w-2xl">
        <div className="space-y-6">
          <p role="status" data-testid="share-access-status" className="text-sm text-stone-700">{access.label}</p>
          {!share ? <Notice tone="warning">{text.unsupported.share}</Notice> : null}
          {confirmation.unconfirmed ? <UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} /> : null}
          {canEdit && requests.isLoadingError ? <LoadFailed error={requests.error} onRetry={() => void requests.refetch()} /> : null}
          {canEdit && pending.length > 0 ? (
            <section aria-label={accessRequestCopy.section}>
              <h3 className="mb-3 flex items-center gap-2 font-medium text-stone-900">{accessRequestCopy.section}<PendingBadge count={pending.length} /></h3>
              <ul className="divide-y divide-stone-100">
                {pending.map((request) => {
                  const approveButton = (
                    <Button tone="primary" size="sm" disabled={busy} loading={approve.isPending && approve.variables === request.id} onClick={() => { decline.reset(); approve.mutate(request.id) }}>
                      {accessRequestCopy.approveViewer}
                    </Button>
                  )
                  return (
                    <li key={request.id} className="flex flex-wrap items-start gap-3 py-3">
                      <RequestDetails request={request} />
                      <div className="flex flex-wrap gap-2">
                        {openToAll ? <Tooltip content={accessRequestCopy.alreadyOpen}>{approveButton}</Tooltip> : approveButton}
                        <Button size="sm" disabled={busy} loading={decline.isPending && decline.variables === request.id} onClick={() => { approve.reset(); decline.mutate(request.id) }}>{accessRequestCopy.decline}</Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
              {!confirmation.unconfirmed && (approve.error || decline.error) ? <ActionError error={approve.error ?? decline.error} /> : null}
            </section>
          ) : null}
          {canEdit && previous.length > 0 ? (
            <Disclosure title={accessRequestCopy.previous}>
              <ul className="divide-y divide-stone-100">
                {previous.map((request) => (
                  <li key={request.id} className="flex flex-wrap items-start gap-3 py-3">
                    <RequestDetails request={request} />
                    <span className="text-xs text-stone-500">{previousLabel(request)}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
          <section aria-label={words.people}>
            <h3 className="mb-3 font-medium text-stone-900">{words.people}</h3>
            {canEdit ? <PersonSearch id="share-person" label={words.search} actionLabel={words.add} takenLabel={words.already} takenEmails={reachable.map((person) => person.email.toLowerCase())} pendingId={add.isPending ? add.variables.id : undefined} onPick={(person) => add.mutate(person)} allowEmail disabled={busy || !share || people.isLoading || people.isLoadingError} /> : null}
            {people.isLoadingError ? <LoadFailed error={people.error} onRetry={() => void people.refetch()} /> : null}
            <ul className="mt-3 divide-y divide-stone-100">
              {members.map((person) => {
                const owner = app.owners.some((entry) => entry.id === person.id)
                const lastOwner = owner && app.owners.length === 1
                const name = isUnknownPerson(person) ? copy.common.unknownPerson : person.displayName
                return (
                  <li key={person.id} className="flex flex-wrap items-center gap-2 py-3" data-testid={`share-person-${person.id}`}>
                    {isUnknownPerson(person) ? null : <Avatar person={person} size="sm" />}
                    <div className="min-w-0 flex-1">
                      <p className={isUnknownPerson(person) ? 'truncate text-stone-500' : 'truncate text-stone-900'}>{name}</p>
                      {isUnknownPerson(person) ? null : <p className="truncate text-xs text-stone-500">{person.email}</p>}
                      {!isUnknownPerson(person) && person.pending ? <p className="text-xs text-stone-500">{words.pending}</p> : null}
                    </div>
                    <div className="w-24 shrink-0">
                      <Select
                        aria-label={words.role(name)}
                        value={owner ? 'editor' : 'viewer'}
                        onChange={(role) => movePersonTo(person.id, role === 'editor' ? 'editor' : 'viewer')}
                        options={[{ value: 'viewer', label: words.viewer, disabled: lastOwner }, { value: 'editor', label: words.editor }]}
                        disabled={!canEdit || busy || !share}
                      />
                    </div>
                    {canEdit ? <Button size="sm" tone="ghost" aria-label={words.remove(name)} disabled={busy || lastOwner || !share} title={lastOwner ? words.lastOwner : undefined} onClick={() => movePersonTo(person.id, 'remove')}>{copy.app.settings.ownerRemoveShort}</Button> : null}
                  </li>
                )
              })}
              {(knownValue(app.share.scope) === 'group' ? app.share.groupIds.map((id) => words.group(groups.find((group) => group.id === id)?.name ?? id)) : knownValue(app.share.scope) === 'company' ? [words.company] : knownValue(app.share.scope) === 'public' ? [words.public] : []).map((name) => <li key={name} className="flex items-center gap-3 py-3"><Users aria-hidden className="size-5 text-stone-500" /><span className="flex-1">{name}</span><span className="text-stone-500">{words.viewer}</span></li>)}
            </ul>
            {!confirmation.unconfirmed && (add.error || update.error) ? <ActionError error={add.error ?? update.error} /> : null}
          </section>
          <section aria-label={words.general} className="border-t border-stone-100 pt-4">
            <RadioCards name="share-scope" legend={words.general} value={scope} onChange={setScope} disabled={!canEdit || busy || !share} options={SCOPES.map((value) => {
              const Icon = ICONS[value]
              return { value, title: value === 'private' ? words.limited : copy.create.share[value].title, description: value === 'private' ? words.limitedHint : copy.create.share[value].body, icon: <Icon />, disabled: value === 'public' && !me.isConsoleAdmin,
                children: value === 'group' && scope === 'group' ? <GroupChecklist groups={flatGroups} selected={groupIds} onChange={setGroupIds} legend={copy.create.share.groupPick} idPrefix="dialog-share-groups" disabled={!canEdit || busy} /> : undefined }
            })} />
            {canEdit ? <Button className="mt-4" tone="primary" loading={scopeWrite.isPending} disabled={busy || !share || !publishId || (!dirty && access.applied) || (scope === 'group' && !groupIds.length)} onClick={saveScope}>{dirty ? copy.app.settings.save : words.apply}</Button> : null}
            {!publishId ? <p className="mt-2 text-xs text-stone-500">{words.unavailable}</p> : null}
            {scopeWrite.error && !confirmation.unconfirmed ? <div className="mt-3"><ActionError error={scopeWrite.error} /></div> : null}
          </section>
          <div className="space-y-3 border-t border-stone-100 pt-4">
            <p className="text-xs text-stone-500">{words.noMail}</p>
            {url ? <>
              <Select aria-label={words.invitationEmail} value={selectedEmail} onChange={setInvitationEmail} options={invitationOptions} />
              <div className="flex flex-wrap gap-2"><CopyButton value={url} label={words.copyLink} />{selectedEmail ? <CopyButton value={words.invitation(app.displayName, url, selectedEmail)} label={words.copyInvitation} /> : null}</div>
            </> : null}
          </div>
        </div>
      </Dialog>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(next) => { if (!next) setConfirm(undefined) }} title={text.settings.shareConfirmTitle} body={confirm ? text.settings.shareConfirmBody(shareSentence(confirm, groups, app.group)) : null} confirmLabel={text.settings.shareConfirmLabel} confirmText={app.displayName} onConfirm={() => { if (confirm) scopeWrite.mutate(confirm) }} pending={scopeWrite.isPending} error={scopeWrite.error ?? undefined} />
    </>
  )
}

function previousLabel(request: AccessRequest): string {
  const status = knownValue(request.status)
  return status === 'approved' ? accessRequestCopy.approveViewer : status === 'declined' ? accessRequestCopy.decline : text.unsupported.request
}

function RequestDetails({ request }: { request: AccessRequest }) {
  const requester = request.requester
  return (
    <>
      {isUnknownPerson(requester) ? null : <Avatar person={requester} size="sm" />}
      <div className="min-w-0 flex-1 basis-48">
        <p className={isUnknownPerson(requester) ? 'break-words text-stone-500' : 'break-words text-stone-900'}>{isUnknownPerson(requester) ? copy.common.unknownPerson : requester.displayName}</p>
        {isUnknownPerson(requester) ? null : <p className="break-all text-xs text-stone-500">{requester.email}</p>}
        <time dateTime={request.requestedAt} className="text-xs text-stone-500">{new Date(request.requestedAt).toLocaleString(locale())}</time>
        {request.message ? <p className="mt-1 whitespace-pre-wrap break-words text-sm text-stone-700">{request.message}</p> : null}
      </div>
    </>
  )
}
