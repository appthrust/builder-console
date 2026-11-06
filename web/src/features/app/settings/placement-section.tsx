import { useForm, useStore } from '@tanstack/react-form'
import { useMutation } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useMemo } from 'react'
import { buildGroupTree, flattenGroupTree, type BusinessApp } from '../../../api/console'
import { useGroups } from '../../../api/queries'
import { copy } from '../../../copy'
import { movePerson } from '../../../model/access'
import { ActionError, Avatar, Button, Field, GroupSelect, Notice, useUnsavedChangesGuard } from '../../../ui'
import { text } from '../copy'
import { ensurePerson, useUpdateApp } from '../mutations'
import { PersonSearch, SaveRow, SettingsCard } from './parts'

/** 所属グループ (moving changes the page URL) and 担当者 (directory search to add). */
export function PlacementSection({ app, canEdit }: { app: BusinessApp; canEdit: boolean }) {
  const groups = useGroups().data
  const flatGroups = useMemo(() => flattenGroupTree(buildGroupTree(groups)), [groups])
  const move = useUpdateApp(app)
  const owners = useUpdateApp(app)
  const add = useMutation({
    mutationFn: ensurePerson,
    onSuccess: (person) => owners.mutate(movePerson(app, person.id, 'editor')),
  })
  const ownersBusy = owners.isPending || add.isPending

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
          {(dirty) => <SaveRow pending={move.isPending} disabled={!canEdit || !dirty} saved={false} label={text.settings.moveSave} />}
        </form.Subscribe>
        {move.isSuccess ? <Notice tone="success">{text.settings.moved}</Notice> : null}
        {move.isError ? <ActionError error={move.error} /> : null}
      </form>

      <div className="mt-6 border-t border-stone-100 pt-5">
        <h3 className="text-sm font-medium text-stone-800">{copy.app.settings.owners}</h3>
        <p className="mt-0.5 text-xs text-stone-500">{copy.app.settings.ownersHint}</p>
        <ul className="mt-3 divide-y divide-stone-100 rounded-md border border-stone-200" data-testid="owners">
          {app.owners.map((owner) => (
            <li key={owner.id} className="flex items-center gap-3 px-3 py-2.5">
              <Avatar person={owner} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-stone-900">{owner.displayName}</span>
                <span className="block truncate text-xs text-stone-500">{owner.email}</span>
              </span>
              {canEdit && app.owners.length > 1 ? (
                <Button
                  size="sm"
                  tone="ghost"
                  icon={<X />}
                  disabled={ownersBusy}
                  onClick={() => owners.mutate(movePerson(app, owner.id, 'remove'))}
                  aria-label={copy.app.settings.ownerRemove(owner.displayName)}
                >
                  {copy.app.settings.ownerRemoveShort}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {canEdit && app.owners.length === 1 ? <p className="mt-2 text-xs text-stone-500">{text.settings.ownerLast}</p> : null}
        {canEdit ? (
          <div className="mt-4 sm:max-w-md">
            <PersonSearch
              id="settings-owner-search"
              label={copy.app.settings.ownerAdd}
              actionLabel={text.settings.ownerAddShort}
              takenEmails={app.owners.map((owner) => owner.email.toLowerCase())}
              takenLabel={text.settings.ownerAlready}
              pendingId={ownersBusy ? add.variables?.id ?? '' : undefined}
              onPick={(entry) => add.mutate(entry)}
            />
          </div>
        ) : null}
        {add.isError || owners.isError ? (
          <div className="mt-3">
            <ActionError error={add.error ?? owners.error} />
          </div>
        ) : null}
      </div>
    </SettingsCard>
  )
}
