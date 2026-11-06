import { useForm, useStore } from '@tanstack/react-form'
import { z } from 'zod'
import type { BusinessApp } from '../../../api/console'
import { copy } from '../../../copy'
import { ActionError, Field, TextArea, TextInput, useUnsavedChangesGuard } from '../../../ui'
import { text } from '../copy'
import { useUpdateApp } from '../mutations'
import { fieldError, SaveRow, SettingsCard } from './parts'

const schema = z.object({
  displayName: z.string().refine((value) => value.trim().length > 0, { error: () => text.settings.nameRequired }),
  description: z.string(),
  icon: z.string(),
  tags: z.string(),
})

type GeneralValues = z.infer<typeof schema>

const valuesOf = (app: BusinessApp): GeneralValues => ({
  displayName: app.displayName,
  description: app.description,
  icon: app.icon,
  tags: app.tags.join(', '),
})

/** 名前・説明・アイコン・タグ. */
export function GeneralSection({ app, canEdit }: { app: BusinessApp; canEdit: boolean }) {
  const mutation = useUpdateApp(app)
  const form = useForm({
    defaultValues: valuesOf(app),
    validators: { onChange: schema },
    onSubmit: ({ value, formApi }) => {
      mutation.mutate(
        {
          displayName: value.displayName.trim(),
          description: value.description.trim(),
          tags: value.tags
            .split(/[,、]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
          icon: value.icon.trim(),
        },
        { onSuccess: (updated) => formApi.reset(valuesOf(updated)) }
      )
    },
  })
  const dirty = useStore(form.store, (state) => state.isDirty)
  useUnsavedChangesGuard(canEdit && dirty, text.settings.unsaved(text.settings.sections.name))

  return (
    <SettingsCard id="name" title={copy.app.settings.general} lead={text.settings.generalLead}>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
        className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_12rem]"
      >
        <form.Field name="displayName">
          {(field) => {
            const error = fieldError(field.state.meta.errors)
            return (
              <Field id="settings-name" label={copy.app.settings.name} error={error} required>
                <TextInput
                  id="settings-name"
                  name={field.name}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  invalid={error !== undefined}
                  disabled={!canEdit}
                />
              </Field>
            )
          }}
        </form.Field>
        <form.Field name="icon">
          {(field) => (
            <Field id="settings-icon" label={copy.app.settings.icon}>
              <div className="w-20">
                <TextInput
                  id="settings-icon"
                  name={field.name}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  disabled={!canEdit}
                  maxLength={4}
                  className="text-center text-lg"
                />
              </div>
            </Field>
          )}
        </form.Field>
        <form.Field name="description">
          {(field) => (
            <Field id="settings-description" label={copy.app.settings.description} className="sm:col-span-2">
              <TextArea
                id="settings-description"
                name={field.name}
                rows={2}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                disabled={!canEdit}
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="tags">
          {(field) => (
            <Field id="settings-tags" label={copy.app.settings.tags} className="sm:col-span-2">
              <TextInput
                id="settings-tags"
                name={field.name}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                disabled={!canEdit}
              />
            </Field>
          )}
        </form.Field>
        <div className="sm:col-span-2">
          <form.Subscribe selector={(state) => [state.isDirty, state.canSubmit] as const}>
            {([dirty, canSubmit]) => (
              <SaveRow pending={mutation.isPending} disabled={!canEdit || !dirty || !canSubmit} saved={mutation.isSuccess && !dirty} />
            )}
          </form.Subscribe>
          {mutation.isError ? (
            <div className="mt-3">
              <ActionError error={mutation.error} />
            </div>
          ) : null}
        </div>
      </form>
    </SettingsCard>
  )
}
