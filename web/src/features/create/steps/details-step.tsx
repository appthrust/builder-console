// Step 1: app name, description, tags, owner group and URL name.
// Existing work asks for its source first.
import { useStore } from '@tanstack/react-form'
import { Plus, X } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import type { GroupNode } from '../../../api/console'
import { copy } from '../../../copy'
import { appUrl, isValidAppName } from '../../../model/create'
import { Button, Field, GroupSelect, TextInput } from '../../../ui'
import { detailsSchema, firstError, syncUrlName, type CreateFormApi } from '../form'
import { RepositoryPicker } from './repository-picker'

/** A URL name someone already uses: found by the Step 1 check, or `reported` by a failed create. */
export interface TakenUrlName {
  urlName: string
  /** A free numbered variant, once found. */
  suggestion?: string
  reported?: boolean
}

export function DetailsStep({
  form,
  projectId,
  sourceConnectionId,
  groups,
  domain,
  nameTaken,
  checkingName,
  onUrlNameSettled,
}: {
  form: CreateFormApi
  projectId: string
  sourceConnectionId: string | undefined
  /** Depth-first group tree. */
  groups: GroupNode[]
  /** Publish domain; undefined while unknown. */
  domain: string | undefined
  nameTaken: TakenUrlName | undefined
  /** A check of the URL name is running. */
  checkingName: boolean
  /** The URL name may have its final value (blur): check whether it is free. */
  onUrlNameSettled: () => void
}) {
  const entry = useStore(form.store, (state) => state.values.entry)
  return (
    <div className="space-y-6">
      {entry === 'existing' ? (
        <form.Field name="repository" validators={{ onChange: detailsSchema.shape.repository }}>
          {(field) => (
            <RepositoryPicker
              projectId={projectId}
              connectionId={sourceConnectionId}
              selected={field.state.value}
              onSelect={(repository) => {
                field.handleChange(repository)
                if (repository && !form.state.values.displayName) {
                  form.setFieldValue('displayName', repository.fullName.slice(repository.fullName.indexOf('/') + 1))
                }
                syncUrlName(form)
              }}
              error={firstError(field.state.meta.errors)}
            />
          )}
        </form.Field>
      ) : null}
      {entry === 'existing' ? <p className="text-sm leading-relaxed text-stone-600">{copy.create.existing.dockerfile}</p> : null}

      <form.Field
        name="displayName"
        validators={{ onChange: detailsSchema.shape.displayName }}
        listeners={{ onChange: () => syncUrlName(form) }}
      >
        {(field) => {
          const error = firstError(field.state.meta.errors)
          return (
            <Field id="create-name" label={copy.create.details.name} hint={copy.create.details.nameHint} error={error} required>
              <TextInput
                id="create-name"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={() => {
                  field.handleBlur()
                  // The URL name follows the name until the user takes it over.
                  if (!form.state.values.urlNameEdited) onUrlNameSettled()
                }}
                invalid={Boolean(error)}
                autoComplete="off"
                autoFocus={entry !== 'existing'}
                className="max-w-md"
              />
            </Field>
          )
        }}
      </form.Field>

          <form.Field name="description">
            {(field) => (
              <Field id="create-description" label={copy.create.details.description} hint={copy.create.details.descriptionHint}>
                <TextInput
                  id="create-description"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  autoComplete="off"
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="tags">
            {(field) => (
              <Field id="create-tags" label={copy.create.details.tags} hint={copy.create.details.tagsHint}>
                <TagEditor tags={field.state.value} onChange={(tags) => field.handleChange(tags)} />
              </Field>
            )}
          </form.Field>

      <form.Field name="groupId" validators={{ onChange: detailsSchema.shape.groupId }}>
        {(field) => {
          const error = firstError(field.state.meta.errors)
          return (
            <Field id="create-group" label={copy.create.details.group} hint={copy.create.details.groupHint} error={error} required>
              <GroupSelect
                id="create-group"
                groups={groups}
                value={field.state.value || undefined}
                onChange={(groupId) => field.handleChange(groupId)}
                disabled={groups.length === 0}
                invalid={Boolean(error)}
                className="max-w-sm"
              />
            </Field>
          )
        }}
      </form.Field>

      <form.Field name="urlName" validators={{ onChange: detailsSchema.shape.urlName }}>
        {(field) => (
          <UrlNameField
            form={form}
            value={field.state.value}
            onChange={field.handleChange}
            onBlur={() => {
              field.handleBlur()
              onUrlNameSettled()
            }}
            error={firstError(field.state.meta.errors)}
            taken={nameTaken?.urlName === field.state.value ? nameTaken : undefined}
            checking={checkingName}
            domain={domain}
          />
        )}
      </form.Field>
    </div>
  )
}

function UrlNameField({
  form,
  value,
  onChange,
  onBlur,
  error,
  taken,
  checking,
  domain,
}: {
  form: CreateFormApi
  value: string
  onChange: (value: string) => void
  onBlur: () => void
  error: string | undefined
  /** Set when this very name is already used. */
  taken: TakenUrlName | undefined
  checking: boolean
  /** Shows the app URL preview; undefined for the AI entry (its plan decides the URL). */
  domain: string | undefined
}) {
  const edited = useStore(form.store, (state) => state.values.urlNameEdited)
  const shown = error ?? (taken ? copy.create.details.urlNameTaken : undefined)
  const url = domain && isValidAppName(value) ? appUrl(value, domain) : undefined
  const suggestion = taken?.suggestion
  return (
    <div>
      {edited ? (
        <Field
          id="create-url"
          label={copy.create.details.urlName}
          hint={copy.create.details.urlNameHint}
          // A taken name arrives after a check, so it is announced; the format error follows typing.
          error={!error && taken ? <span role="alert">{shown}</span> : shown}
        >
          <TextInput
            id="create-url"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            maxLength={63}
            onBlur={onBlur}
            invalid={Boolean(shown)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            className="max-w-sm font-mono"
          />
        </Field>
      ) : (
        <div>
          <p id="create-url-label" className="text-sm font-medium text-stone-800">
            {copy.create.details.urlName}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <code className="rounded-md bg-stone-100 px-2 py-1 font-mono text-stone-900" data-testid="url-name">
              {value}
            </code>
            <span className="text-stone-500">{copy.create.details.urlNameAuto}</span>
            <Button
              tone="ghost"
              size="sm"
              aria-describedby="create-url-label"
              onClick={() => form.setFieldValue('urlNameEdited', true)}
            >
              {copy.create.details.urlNameEdit}
            </Button>
          </div>
          {shown ? (
            <p className="mt-1 text-xs text-red-700" role="alert">
              {shown}
            </p>
          ) : null}
        </div>
      )}
      {suggestion && !error ? (
        <Button
          id="create-url-suggestion"
          size="sm"
          className="mt-2 font-mono"
          data-testid="url-name-suggestion"
          onClick={() => {
            onChange(suggestion)
            form.setFieldValue('urlNameEdited', true)
          }}
        >
          {copy.create.details.urlNameUse(suggestion)}
        </Button>
      ) : null}
      {checking && !shown ? (
        <p role="status" className="mt-2 text-xs text-stone-500" data-testid="url-name-checking">
          {copy.create.details.urlNameChecking}
        </p>
      ) : url && !shown ? (
        <p className="mt-2 text-sm text-stone-500" data-testid="url-preview">
          {copy.create.details.urlPreview}: <span className="font-mono break-all text-stone-700">{url}</span>
        </p>
      ) : null}
    </div>
  )
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const tag = draft.trim()
    if (tag && !tags.includes(tag)) onChange([...tags, tag])
    setDraft('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    add()
  }
  return (
    <div className="space-y-2">
      {tags.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li key={tag} className="inline-flex items-center gap-1 rounded-full bg-stone-100 py-0.5 pr-1 pl-2.5 text-sm text-stone-700">
              {tag}
              <button
                type="button"
                onClick={() => onChange(tags.filter((item) => item !== tag))}
                aria-label={copy.create.details.tagRemove(tag)}
                className="rounded-full p-0.5 text-stone-500 hover:bg-stone-200 hover:text-stone-900"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex max-w-sm gap-2">
        <TextInput id="create-tags" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} autoComplete="off" />
        <Button onClick={add} disabled={!draft.trim()} icon={<Plus className="size-4" />}>
          {copy.create.details.tagAdd}
        </Button>
      </div>
    </div>
  )
}
