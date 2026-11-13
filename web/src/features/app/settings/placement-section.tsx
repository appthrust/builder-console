import { useForm, useStore } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useMemo } from 'react'
import { buildGroupTree, flattenGroupTree, isUnknownPerson, type BusinessApp, type Person } from '../../../model/contracts/console'
import { consoleKeys, useGroups } from '../../../api/queries/console'
import { copy } from '../../../copy'
import { movePerson } from '../../../model/access'
import { knownShare } from '../../../model/share'
import { ActionError, Avatar, Button, Field, GroupSelect, Notice, useUnsavedChangesGuard } from '../../../ui'
import { text } from '../copy'
import { ensurePerson, useUpdateApp } from '../mutations'
import { PersonSearch, SaveRow, SettingsCard } from './parts'
import { UnconfirmedNotice, useWriteConfirmation } from '../notices'

/** 所属グループ (moving changes the page URL) and 担当者 (directory search to add). */
export function PlacementSection({ app, canEdit }: { app: BusinessApp; canEdit: boolean }) {
  const groups = useGroups().data
  const flatGroups = useMemo(() => flattenGroupTree(buildGroupTree(groups)), [groups])
  const queryClient = useQueryClient()
  const move = useUpdateApp(app)
  const owners = useUpdateApp(app)
  // Owner changes rewrite the share (a viewer who becomes an owner leaves it): only a known share can be written.
  const share = knownShare(app.share)
  const setOwner = (id: string, role: 'editor' | 'remove') => {
    if (share) owners.mutate(movePerson({ owners: app.owners, share }, id, role))
  }
  const add = useMutation({
    mutationFn: ensurePerson,
    onSuccess: (person) => setOwner(person.id, 'editor'),
  })
  // A change whose answer could not be read may have happened: read the app back before offering more.
  const confirmation = useWriteConfirmation([move.error, owners.error], () => { move.reset(); owners.reset() }, () => queryClient.refetchQueries({ queryKey: consoleKeys.app(app.id), exact: true }))
  const ownersBusy = owners.isPending || add.isPending || confirmation.unconfirmed || !share
  const reachable = app.owners.filter((owner): owner is Person => !isUnknownPerson(owner))

  const form = useForm({
    defaultValues: { groupId: app.group.id },
    onSubmit: ({ value, formApi }) => {
      move.mutate({ groupId: value.groupId }, { onSuccess: (updated) => formApi.reset({ groupId: updated.group.id }) })
    },
  })
  const dirty = useStore(form.store, (state) => state.isDirty)
  useUnsavedChangesGuard(canEdit && dirty && !move.isPending, text.settings.unsaved(text.settings.sections.owners))

  return (
    <SettingsCard id="owners" title={text.settings.placement} lead={text.settings.placementLead}>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
        className="space-y-3"
      >
        <form.Field name="groupId">
          {(field) => (
            <Field id="settings-group" label={copy.app.settings.group}>
              <GroupSelect
                id="settings-group"
                groups={flatGroups}
                value={field.state.value}
                onChange={(groupId) => field.handleChange(groupId)}
                disabled={!canEdit}
                className="sm:max-w-sm"
              />
            </Field>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.isDirty}>
          {(dirty) => <SaveRow pending={move.isPending} disabled={!canEdit || !dirty || confirmation.unconfirmed} saved={false} label={text.settings.moveSave} />}
        </form.Subscribe>
        {move.isSuccess ? <Notice tone="success">{text.settings.moved}</Notice> : null}
        {confirmation.unconfirmed ? <UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} /> : move.isError ? <ActionError error={move.error} /> : null}
      </form>

      <div className="mt-6 border-t border-stone-100 pt-5">
        <h3 className="text-sm font-medium text-stone-800">{copy.app.settings.owners}</h3>
        <p className="mt-0.5 text-xs text-stone-500">{copy.app.settings.ownersHint}</p>
        <ul className="mt-3 divide-y divide-stone-100 rounded-md border border-stone-200" data-testid="owners">
          {app.owners.map((owner) => {
            const name = isUnknownPerson(owner) ? copy.common.unknownPerson : owner.displayName
            return (
            <li key={owner.id} className="flex items-center gap-3 px-3 py-2.5">
              {isUnknownPerson(owner) ? null : <Avatar person={owner} size="sm" />}
              <span className="min-w-0 flex-1">
                <span className={isUnknownPerson(owner) ? 'block truncate text-sm text-stone-500' : 'block truncate text-sm text-stone-900'}>{name}</span>
                {isUnknownPerson(owner) ? null : <span className="block truncate text-xs text-stone-500">{owner.email}</span>}
              </span>
              {canEdit && app.owners.length > 1 ? (
                <Button
                  size="sm"
                  tone="ghost"
                  icon={<X />}
                  disabled={ownersBusy}
                  onClick={() => setOwner(owner.id, 'remove')}
                  aria-label={copy.app.settings.ownerRemove(name)}
                >
                  {copy.app.settings.ownerRemoveShort}
                </Button>
              ) : null}
            </li>
            )
          })}
        </ul>
        {canEdit && !share ? <Notice tone="warning">{text.unsupported.share}</Notice> : null}
        {canEdit && app.owners.length === 1 ? <p className="mt-2 text-xs text-stone-500">{text.settings.ownerLast}</p> : null}
        {canEdit ? (
          <div className="mt-4 sm:max-w-md">
            <PersonSearch
              id="settings-owner-search"
              label={copy.app.settings.ownerAdd}
              actionLabel={text.settings.ownerAddShort}
              takenEmails={reachable.map((owner) => owner.email.toLowerCase())}
              takenLabel={text.settings.ownerAlready}
              pendingId={ownersBusy ? add.variables?.id ?? '' : undefined}
              onPick={(entry) => add.mutate(entry)}
              disabled={confirmation.unconfirmed || !share}
            />
          </div>
        ) : null}
        {!confirmation.unconfirmed && (add.isError || owners.isError) ? (
          <div className="mt-3">
            <ActionError error={add.error ?? owners.error} />
          </div>
        ) : null}
      </div>
    </SettingsCard>
  )
}
