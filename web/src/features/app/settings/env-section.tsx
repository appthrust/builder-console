import { useForm, useStore } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { KeyRound, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { client } from '../../../api/client'
import { keys, useEnvVars, type ComponentScope } from '../../../api/queries'
import { copy } from '../../../copy'
import { ActionError, Button, Checkbox, cn, DataTable, Disclosure, EmptyState, Field, LoadFailed, Loading, TextInput, useUnsavedChangesGuard } from '../../../ui'
import { text } from '../copy'
import { pendingRows, stageAdd, stageEdit, stageRemove, unstage, variablesToSave, type EnvChanges, type EnvRow, type EnvVariable } from './env-changes'
import { fieldError, SaveRow, SettingsCard } from './parts'

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Per-render state the cells read; columns stay stable within a mount so the inline input keeps focus while typing. */
interface EnvMeta {
  canEdit: boolean
  busy: boolean
  editing: { key: string; value: string } | undefined
  setEditing: (editing: { key: string; value: string } | undefined) => void
  apply: (key: string, value: string) => void
  remove: (key: string) => void
  undo: (key: string) => void
}

const CHANGE_BADGE: Record<NonNullable<EnvRow['change']>, string> = {
  added: 'bg-accent-soft text-accent-strong ring-accent-line',
  edited: 'bg-busy-soft text-busy-ink ring-amber-200',
  removed: 'bg-bad-soft text-bad-ink ring-red-200',
}

/** Staged-change actions for a user-owned value; null for automatic values or read-only viewers. */
function rowActions(entry: EnvRow, meta: EnvMeta) {
  if (entry.source !== 'user' || !meta.canEdit) return null
  const undo = (
    <Button size="sm" tone="ghost" icon={<RotateCcw />} disabled={meta.busy} onClick={() => meta.undo(entry.key)} aria-label={text.settings.envUndoLabel(entry.key)}>
      {text.settings.envUndo}
    </Button>
  )
  if (entry.change === 'removed') return <span className="inline-flex gap-1">{undo}</span>
  if (meta.editing?.key === entry.key) {
    return (
      <span className="inline-flex gap-2">
        <Button size="sm" tone="primary" onClick={() => meta.apply(entry.key, meta.editing?.value ?? '')}>
          {text.settings.envApply}
        </Button>
        <Button size="sm" onClick={() => meta.setEditing(undefined)}>
          {copy.common.cancel}
        </Button>
      </span>
    )
  }
  return (
    <span className="inline-flex gap-1">
      <Button
        size="sm"
        tone="ghost"
        icon={<Pencil />}
        disabled={meta.busy}
        onClick={() => meta.setEditing({ key: entry.key, value: entry.sensitive ? '' : (entry.value ?? '') })}
        aria-label={text.settings.envEditLabel(entry.key)}
      >
        {text.settings.envEdit}
      </Button>
      <Button
        size="sm"
        tone="ghost"
        icon={<Trash2 />}
        disabled={meta.busy}
        onClick={() => meta.remove(entry.key)}
        aria-label={text.settings.envRemoveLabel(entry.key)}
      >
        {copy.app.settings.envRemove}
      </Button>
      {entry.change === 'edited' ? undo : null}
    </span>
  )
}

const column = createColumnHelper<EnvRow>()

const createColumns = () => [
  column.accessor('key', {
    header: copy.app.settings.envKey,
    meta: { className: 'w-2/5' },
    cell: ({ row, table }) => {
      const entry = row.original
      const actions = rowActions(entry, table.options.meta as EnvMeta)
      return (
        <span className="flex flex-wrap items-center gap-2">
          <span className={cn('font-mono break-all text-stone-900', entry.change === 'removed' && 'text-stone-500 line-through')}>{entry.key}</span>
          {entry.change ? (
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', CHANGE_BADGE[entry.change])}>
              {text.settings.envChange[entry.change]}
            </span>
          ) : null}
          {/* Narrow screens show rows as cards; the actions sit in the card title instead of their own line. */}
          {actions ? <span className="ml-auto md:hidden">{actions}</span> : null}
        </span>
      )
    },
  }),
  column.display({
    id: 'value',
    header: copy.app.settings.envValue,
    cell: ({ row, table }) => {
      const entry = row.original
      const meta = table.options.meta as EnvMeta
      if (meta.editing?.key === entry.key) {
        return (
          <TextInput
            aria-label={text.settings.envNewValue(entry.key)}
            type={entry.sensitive ? 'password' : 'text'}
            value={meta.editing.value}
            onChange={(event) => meta.setEditing({ key: entry.key, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') meta.apply(entry.key, meta.editing?.value ?? '')
              if (event.key === 'Escape') meta.setEditing(undefined)
            }}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        )
      }
      const removed = entry.change === 'removed' && 'line-through'
      if (entry.source === 'generated') return <span className="text-stone-500">{copy.app.settings.envAutomatic}</span>
      if (entry.sensitive || entry.value === undefined) return <span className={cn('text-stone-500', removed)}>{copy.app.settings.envHidden}</span>
      return <span className={cn('font-mono break-all text-stone-800', removed && 'text-stone-500 line-through')}>{entry.value}</span>
    },
  }),
  column.display({
    id: 'actions',
    header: () => <span className="sr-only">{text.settings.envActions}</span>,
    meta: { label: text.settings.envActions, className: 'w-px text-right whitespace-nowrap', hideOnMobile: true },
    cell: ({ row, table }) => rowActions(row.original, table.options.meta as EnvMeta),
  }),
]

const NO_CHANGES: EnvChanges = {}

/**
 * 設定値 (branch config of the web component). Adds, edits and removals are
 * staged and marked in the table; 保存 sends them as one PUT of the full
 * user-owned list, like every other settings section.
 */
export function EnvSection({ scope, canEdit }: { scope: ComponentScope | undefined; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const [columns] = useState(createColumns)
  const config = useEnvVars(scope)
  const entries = useMemo(() => config.data?.variables ?? [], [config.data])
  const [changes, setChanges] = useState<EnvChanges>(NO_CHANGES)
  const [editing, setEditing] = useState<{ key: string; value: string }>()
  const rows = useMemo(() => pendingRows(entries, changes), [entries, changes])
  const ownRows = useMemo(() => rows.filter((entry) => entry.source === 'user' && !entry.key.startsWith('DATABASE_')), [rows])
  const automaticRows = useMemo(() => rows.filter((entry) => entry.source !== 'user' || entry.key.startsWith('DATABASE_')), [rows])

  const mutation = useMutation({
    // PUT replaces the user-owned set.
    mutationFn: (variables: EnvVariable[]) => {
      if (!scope) throw new Error('env vars require a web component')
      return client.platformApiUpdateApplicationBranchComponentConfig({ params: scope, body: { variables } })
    },
    onSuccess: (result) => {
      if (scope) {
        queryClient.setQueryData(keys.envVars(scope.projectId, scope.applicationId, scope.branchId, scope.componentId), result.resource)
      }
      setChanges(NO_CHANGES)
      setEditing(undefined)
    },
  })

  const busy = mutation.isPending
  const meta = useMemo<EnvMeta>(() => ({
    canEdit,
    busy,
    editing,
    setEditing,
    apply: (key, value) => {
      setChanges((current) => stageEdit(entries, current, key, value))
      setEditing(undefined)
    },
    remove: (key) => {
      setChanges((current) => stageRemove(current, key))
      setEditing(undefined)
    },
    undo: (key) => setChanges((current) => unstage(current, key)),
  }), [entries, canEdit, busy, editing])

  const table = useReactTable({
    data: ownRows,
    columns,
    meta,
    enableSorting: false,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (entry) => entry.key,
  })
  const automaticTable = useReactTable({
    data: automaticRows,
    columns,
    meta,
    enableSorting: false,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (entry) => entry.key,
  })

  const form = useForm({
    defaultValues: { key: '', value: '', sensitive: false },
    onSubmit: ({ value, formApi }) => {
      setChanges((current) => stageAdd(entries, current, value.key.trim(), value.value, value.sensitive))
      formApi.reset()
    },
  })
  const addingDirty = useStore(form.store, (state) => state.isDirty)
  const edited = editing ? rows.find((entry) => entry.key === editing.key) : undefined
  const editingDirty = Boolean(editing && editing.value !== (edited?.sensitive ? '' : edited?.value ?? ''))
  const pendingCount = Object.keys(changes).length
  useUnsavedChangesGuard(canEdit && (pendingCount > 0 || addingDirty || editingDirty), text.settings.unsaved(text.settings.sections.env))

  const discard = () => {
    setChanges(NO_CHANGES)
    setEditing(undefined)
    form.reset()
    mutation.reset()
  }
  const ready = scope !== undefined && !config.isPending && !config.isError

  return (
    <SettingsCard id="env" title={copy.app.settings.env} lead={copy.app.settings.envHelp}>
      {!scope ? (
        <EmptyState icon={<KeyRound />} title={copy.app.settings.envEmpty} />
      ) : config.isPending ? (
        <Loading />
      ) : config.isError ? (
        <LoadFailed onRetry={() => void config.refetch()} error={config.error} />
      ) : (
        <div data-testid="env-table">
          <DataTable table={table} caption={copy.app.settings.env} emptyState={<EmptyState icon={<KeyRound />} title={copy.app.settings.envEmpty} />} />
        </div>
      )}

      {ready && canEdit ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
          className="mt-5 rounded-lg border border-dashed border-stone-300 p-4"
          aria-label={text.settings.envAdding}
        >
          <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <form.Field
              name="key"
              validators={{
                onChange: ({ value }) => {
                  const trimmed = value.trim()
                  if (!trimmed) return text.settings.envKeyRequired
                  if (!ENV_KEY.test(trimmed)) return copy.app.settings.envKeyInvalid
                  if (rows.some((entry) => entry.key === trimmed && entry.change !== 'removed')) return copy.app.settings.envKeyDuplicate
                  return undefined
                },
              }}
            >
              {(field) => {
                const error = field.state.meta.isTouched ? fieldError(field.state.meta.errors) : undefined
                return (
                  <Field id="env-key" label={copy.app.settings.envKey} error={error}>
                    <TextInput
                      id="env-key"
                      name="env-key"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                      onBlur={field.handleBlur}
                      invalid={error !== undefined}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                    />
                  </Field>
                )
              }}
            </form.Field>
            <form.Subscribe selector={(state) => state.values.sensitive}>
              {(sensitive) => (
                <form.Field name="value">
                  {(field) => (
                    <Field id="env-value" label={copy.app.settings.envValue}>
                      <TextInput
                        id="env-value"
                        name="env-value"
                        type={sensitive ? 'password' : 'text'}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                        onBlur={field.handleBlur}
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono"
                      />
                    </Field>
                  )}
                </form.Field>
              )}
            </form.Subscribe>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <form.Field name="sensitive">
              {(field) => (
                <Checkbox
                  id="env-sensitive"
                  name="env-sensitive"
                  checked={field.state.value}
                  onCheckedChange={(checked) => field.handleChange(checked)}
                  label={copy.app.settings.envSecret}
                />
              )}
            </form.Field>
            <form.Subscribe selector={(state) => [state.values.key.trim().length > 0, state.canSubmit] as const}>
              {([hasKey, canSubmit]) => (
                <Button type="submit" icon={<Plus />} disabled={busy || !hasKey || !canSubmit}>
                  {copy.app.settings.envAdd}
                </Button>
              )}
            </form.Subscribe>
          </div>
        </form>
      ) : null}

      {ready && canEdit ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            // An open inline edit is part of what the user sees as their change.
            const staged = editing && editingDirty ? stageEdit(entries, changes, editing.key, editing.value) : changes
            mutation.mutate(variablesToSave(entries, staged))
          }}
          className="mt-5 space-y-3"
        >
          {pendingCount > 0 ? <p className="text-sm text-stone-600">{text.settings.envPending(pendingCount)}</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <SaveRow pending={busy} disabled={pendingCount === 0 && !editingDirty} saved={mutation.isSuccess && pendingCount === 0} />
            {pendingCount > 0 || editingDirty ? (
              <Button tone="ghost" disabled={busy} onClick={discard}>
                {text.settings.envDiscard}
              </Button>
            ) : null}
          </div>
          {mutation.isError ? <ActionError error={mutation.error} /> : null}
        </form>
      ) : null}

      {automaticRows.length > 0 ? (
        <div className="mt-5">
          <Disclosure title={text.settings.advanced}>
            <Disclosure title={text.settings.automatic(automaticRows.length)}>
              <DataTable table={automaticTable} caption={text.settings.automatic(automaticRows.length)} />
            </Disclosure>
          </Disclosure>
        </div>
      ) : null}
    </SettingsCard>
  )
}
