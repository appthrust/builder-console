import { useForm, useStore } from '@tanstack/react-form'
import { Pencil } from 'lucide-react'
import { useId, useState } from 'react'
import { z } from 'zod'
import type { BusinessApp } from '../../api/console-unverified'
import { copy, relativeTime } from '../../copy'
import type { AppView } from '../../model/app'
import { ActionError, Button, Card, CardBody, CardHeader, ConfirmDialog, Field, Markdown, TextArea, useUnsavedChangesGuard } from '../../ui'
import { Comments } from './comments'
import { text } from './copy'
import { useSaveGuide } from './mutations'
import { fieldError, SaveRow } from './settings/parts'

const MAX_CAPABILITIES = 10
const MAX_CAPABILITY_LENGTH = 60
const MAX_GUIDE_LENGTH = 4000

export function parseCapabilities(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean)
}

export function capabilitiesError(value: string): string | undefined {
  const capabilities = parseCapabilities(value)
  if (capabilities.length > MAX_CAPABILITIES) return text.app.capabilitiesTooMany
  if (capabilities.some((item) => Array.from(item).length > MAX_CAPABILITY_LENGTH)) return text.app.capabilityTooLong
  return undefined
}

const schema = z.object({
  capabilities: z.string().superRefine((value, context) => {
    const message = capabilitiesError(value)
    if (message) context.addIssue({ code: 'custom', message })
  }),
  guide: z.string().refine((value) => Array.from(value).length <= MAX_GUIDE_LENGTH, text.app.guideTooLong),
})

export function GuideTab({ app, view, canEdit }: { app: BusinessApp; view: AppView; canEdit: boolean }) {
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  const updatedAt = relativeTime(app.updatedAt)
  const owner = app.owners[0]?.displayName
  const guideEmpty = canEdit ? text.app.guideEmptyOwner : owner ? text.app.guideEmptyViewer(owner) : text.app.guideEmpty
  const beginEditing = () => {
    setSaved(false)
    setEditing(true)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={text.app.capabilities}
          actions={canEdit && !editing ? <Button size="sm" icon={<Pencil />} onClick={beginEditing}>{text.app.edit}</Button> : undefined}
        />
        <CardBody className="space-y-6">
          {editing && canEdit ? (
            <GuideEditor app={app} onCancel={() => setEditing(false)} onSaved={() => {
              setEditing(false)
              setSaved(true)
            }} />
          ) : (
            <>
              {app.capabilities.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed break-words text-stone-800">
                  {app.capabilities.map((capability, index) => <li key={index}>{capability}</li>)}
                </ul>
              ) : <p className="text-sm text-stone-500">{text.app.capabilitiesEmpty}</p>}
              <section aria-label={copy.app.tabs.guide} className="space-y-3">
                <h2 className="text-base font-semibold text-stone-900">{copy.app.tabs.guide}</h2>
                {app.guide.trim() ? <Markdown source={app.guide} /> : (
                  <div className="space-y-3">
                    <p className="text-sm leading-relaxed text-stone-500">{guideEmpty}</p>
                    {canEdit ? <Button size="sm" onClick={beginEditing}>{text.app.write}</Button> : null}
                  </div>
                )}
              </section>
              {updatedAt ? <p className="text-xs text-stone-500">{copy.app.updated(updatedAt)}</p> : null}
              {saved ? <p role="status" className="text-sm text-accent-strong">{copy.app.settings.saved}</p> : null}
            </>
          )}
        </CardBody>
      </Card>
      {view.draft ? <p className="text-sm text-stone-500">{text.comments.draft}</p> : <Comments appId={app.id} owners={app.owners} canDeleteAny={canEdit} />}
    </div>
  )
}

function GuideEditor({ app, onCancel, onSaved }: { app: BusinessApp; onCancel: () => void; onSaved: () => void }) {
  const id = useId()
  const mutation = useSaveGuide(app.id)
  const [discarding, setDiscarding] = useState(false)
  const form = useForm({
    defaultValues: { guide: app.guide, capabilities: app.capabilities.join('\n') },
    validators: { onChange: schema },
    onSubmit: ({ value, formApi }) => {
      if (mutation.isPending) return
      mutation.mutate(
        { guide: value.guide, capabilities: parseCapabilities(value.capabilities) },
        { onSuccess: (updated) => {
          formApi.reset({ guide: updated.guide, capabilities: updated.capabilities.join('\n') })
          onSaved()
        } }
      )
    },
  })
  const dirty = useStore(form.store, (state) => state.isDirty)
  const unsaved = text.settings.unsaved(copy.app.tabs.guide)
  useUnsavedChangesGuard(dirty, unsaved)

  return (
    <>
      <form className="space-y-5" noValidate onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}>
        <form.Field name="capabilities">
          {(field) => {
            const error = fieldError(field.state.meta.errors)
            return (
              <Field id={`${id}-capabilities`} label={text.app.capabilities} hint={text.app.capabilitiesHint} error={error}>
                <TextArea
                  id={`${id}-capabilities`}
                  name={field.name}
                  rows={4}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  invalid={error !== undefined}
                  disabled={mutation.isPending}
                />
              </Field>
            )
          }}
        </form.Field>
        <form.Field name="guide">
          {(field) => {
            const error = fieldError(field.state.meta.errors)
            return (
              <div className="grid min-w-0 gap-5 md:grid-cols-2">
                <Field id={`${id}-guide`} label={copy.app.tabs.guide} hint={text.app.guideHint} error={error}>
                  <TextArea
                    id={`${id}-guide`}
                    name={field.name}
                    rows={12}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    invalid={error !== undefined}
                    disabled={mutation.isPending}
                  />
                </Field>
                <section aria-label={text.app.preview} className="min-w-0 space-y-3">
                  <h3 className="text-sm font-medium text-stone-800">{text.app.preview}</h3>
                  {field.state.value.trim() ? <Markdown source={field.state.value} /> : <p className="text-sm text-stone-500">{text.app.previewEmpty}</p>}
                </section>
              </div>
            )
          }}
        </form.Field>
        <div className="flex flex-wrap items-center gap-3">
          <form.Subscribe selector={(state) => [state.isDirty, state.canSubmit] as const}>
            {([dirty, canSubmit]) => <SaveRow pending={mutation.isPending} disabled={!dirty || !canSubmit} saved={false} />}
          </form.Subscribe>
          <Button disabled={mutation.isPending} onClick={() => dirty ? setDiscarding(true) : onCancel()}>{copy.common.cancel}</Button>
        </div>
        {mutation.error ? <ActionError error={mutation.error} /> : null}
      </form>
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title={text.app.discardTitle}
        body={unsaved}
        confirmLabel={text.app.discard}
        cancelLabel={text.app.keepEditing}
        onConfirm={onCancel}
      />
    </>
  )
}
