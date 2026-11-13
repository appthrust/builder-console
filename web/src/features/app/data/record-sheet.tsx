// One row of a 表 in a right-side Sheet (design "Layout"): view → 「編集」 →
// form with 「保存」/「キャンセル」, 「⋯」 → 「この行を削除」, and the same Sheet
// empty for 「+ 行を追加」. The Sheet holds no PostgREST or platform words:
// model/data-record.ts parses the form and maps save errors, mutations.ts
// writes and refreshes the 表's cached pages.
import { useQueries } from '@tanstack/react-query'
import { Lock, MoreHorizontal, Pencil, RotateCw, Trash2, X } from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import { useEffect, useId, useRef, useState, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from 'react'
import { databaseTableSchemaQuery } from '../../../api/queries/data'
import { platformErrorEnvelope } from '../../../api/platform-error'
import { copy } from '../../../copy'
import { deriveCollection, displayValue, formatValue, type Collection, type DataRow, type Field } from '../../../model/data-catalog'
import {
  changedFields,
  CREATED_AT,
  diff,
  expectedFor,
  formatTimestampFull,
  mapSaveError,
  parseFormValues,
  rebaseForm,
  toFormValues,
  UPDATED_AT,
  type FormValues,
  type SaveError,
} from '../../../model/data-record'
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Notice,
  useReturnFocus,
  useUnsavedChangesGuard,
} from '../../../ui'
import { writeText } from './copy-write'
import { DeleteRowDialog } from './delete-dialog'
import { FieldEditor } from './field-kinds/editors'
import { useDatabaseRowMutations } from './mutations'

export interface RecordSheetProps {
  projectId: string
  databaseId: string
  collection: Collection
  /** null = create a row. */
  row: DataRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  canEdit: boolean
}

export function RecordSheet(props: RecordSheetProps) {
  const focus = useReturnFocus(props.open)
  // The body reports unsaved input here: Escape and outside clicks ask before discarding it.
  const dirtyRef = useRef(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const guardDismiss = (event: Event) => {
    if (!dirtyRef.current) return
    event.preventDefault()
    setConfirmDiscard(true)
  }
  // Overlay and Content are the Portal's direct children (like the kit Dialog), so the
  // overlay is portalled first and never covers the sheet.
  return (
    <RDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-stone-900/40 animate-fade-in" />
        <RDialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          onEscapeKeyDown={guardDismiss}
          onInteractOutside={guardDismiss}
          className="fixed inset-0 z-50 flex flex-col bg-white shadow-xl animate-fade-in focus:outline-none sm:inset-y-0 sm:right-0 sm:left-auto sm:w-full sm:max-w-lg sm:border-l sm:border-line"
        >
          {/* Remounted per row: a different row (or create) never inherits a draft. */}
          <SheetBody
            key={props.row?.key ?? '+'}
            {...props}
            dirtyRef={dirtyRef}
            confirmDiscard={confirmDiscard}
            setConfirmDiscard={setConfirmDiscard}
          />
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

type SheetNotice = { tone: 'success' | 'info'; text: string }

function SheetBody({
  projectId,
  databaseId,
  collection,
  row,
  onOpenChange,
  canEdit,
  dirtyRef,
  confirmDiscard,
  setConfirmDiscard,
}: RecordSheetProps & {
  /** Written with this body's unsaved state for the Content's dismiss guard. */
  dirtyRef: RefObject<boolean>
  confirmDiscard: boolean
  setConfirmDiscard: Dispatch<SetStateAction<boolean>>
}) {
  const mutations = useDatabaseRowMutations(projectId, databaseId, collection)
  const idPrefix = useId()
  const formId = `${idPrefix}-form`
  const menuRef = useRef<HTMLButtonElement>(null)

  // A created row stays in the Sheet (with its auto-filled 番号 and dates) until it closes.
  const [created, setCreated] = useState<DataRow>()
  const current = created ?? row
  const [editing, setEditing] = useState(current === null)
  /** The row as it was when editing started: the diff and the optimistic lock are against it. */
  const [base, setBase] = useState<DataRow | null>(current)
  const [form, setForm] = useState<FormValues>(() => toFormValues(collection, current))
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saveError, setSaveError] = useState<SaveError>()
  const [notice, setNotice] = useState<SheetNotice>()
  const [reloading, setReloading] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()

  const mode = base ? 'update' : 'create'
  const dirty = editing && Object.entries(toFormValues(collection, base)).some(([name, value]) => form[name] !== value)
  useUnsavedChangesGuard(dirty, writeText.sheet.unsaved)
  useEffect(() => {
    dirtyRef.current = dirty
    return () => {
      dirtyRef.current = false
    }
  }, [dirty, dirtyRef])

  const writable = canEdit && collection.editable && !mutations.editingUnavailable
  const pending = mutations.create.isPending || mutations.update.isPending
  const auditFields = collection.fields.filter((field) => field.name === CREATED_AT || field.name === UPDATED_AT)
  const referenceLabels = useReferenceLabels(projectId, databaseId, collection)

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true)
    else onOpenChange(false)
  }

  const startEditing = () => {
    setBase(current)
    setForm(toFormValues(collection, current))
    setFieldErrors({})
    setSaveError(undefined)
    setNotice(undefined)
    setEditing(true)
  }

  const cancelEditing = () => {
    if (!current) {
      onOpenChange(false)
      return
    }
    setEditing(false)
    setFieldErrors({})
    setSaveError(undefined)
  }

  const fail = (error: unknown, op: 'save' | 'delete') => {
    const mapped = mapSaveError(platformErrorEnvelope(error), collection, op)
    if (mapped.kind === 'editingUnavailable') {
      // Seen once, 編集 and 削除 disappear for this database; the reason stays visible.
      mutations.markEditingUnavailable()
      setEditing(false)
      setDeleteOpen(false)
    }
    return mapped
  }

  const focusField = (name: string | undefined) => {
    if (name) document.getElementById(`${idPrefix}-${name}`)?.focus()
  }
  // A server-side field error arrives while the inputs are still disabled for
  // the pending save; focus once the re-enabled field has rendered.
  useEffect(() => {
    if (!saveError || pending) return
    focusField(collection.fields.find((field) => saveError.fieldErrors[field.name])?.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once per error
  }, [saveError, pending])

  const save = (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseFormValues(collection, form, mode)
    setFieldErrors(parsed.errors)
    setSaveError(undefined)
    const firstInvalid = collection.fields.find((field) => parsed.errors[field.name])
    if (firstInvalid) {
      focusField(firstInvalid.name)
      return
    }
    const onError = (error: unknown) => {
      const mapped = fail(error, 'save')
      setFieldErrors(mapped.fieldErrors)
      setSaveError(mapped)
    }
    if (!base) {
      mutations.create.mutate(parsed.values, {
        onSuccess: (saved) => {
          if (!saved) {
            onOpenChange(false)
            return
          }
          setCreated(saved)
          setEditing(false)
          setNotice({ tone: 'success', text: writeText.sheet.created })
        },
        onError,
      })
      return
    }
    // Both sides go through the same parse, so untouched inputs never count as changes.
    const changes = diff(parseFormValues(collection, toFormValues(collection, base), 'update').values, parsed.values)
    if (Object.keys(changes).length === 0) {
      setEditing(false)
      return
    }
    mutations.update.mutate(
      { key: base.key, values: changes, expected: expectedFor(collection, base, changes) },
      {
        onSuccess: (saved) => {
          if (created && saved) setCreated(saved)
          setEditing(false)
          setNotice({ tone: 'success', text: writeText.sheet.saved })
        },
        onError,
      }
    )
  }

  const reloadLatest = async () => {
    if (!base) return
    setReloading(true)
    try {
      const latest = await mutations.reload(base.key)
      if (!latest) {
        setSaveError({ kind: 'other', fieldErrors: {}, message: writeText.errors.notFound })
        return
      }
      const others = changedFields(collection, base, latest)
      setForm(rebaseForm(collection, base, latest, form))
      setBase(latest)
      if (created) setCreated(latest)
      setSaveError(undefined)
      setFieldErrors({})
      setNotice({
        tone: 'info',
        text: others.length ? writeText.errors.reloaded(others.map((field) => field.label).join(writeText.errors.fieldSeparator)) : writeText.errors.reloadedSame,
      })
    } catch (error) {
      setSaveError(fail(error, 'save'))
    } finally {
      setReloading(false)
    }
  }

  const confirmDelete = () => {
    if (!current) return
    setDeleteError(undefined)
    mutations.remove.mutate(current.key, {
      onSuccess: () => {
        setDeleteOpen(false)
        onOpenChange(false)
      },
      onError: (error) => {
        const mapped = fail(error, 'delete')
        if (mapped.kind === 'editingUnavailable') setSaveError(mapped)
        else setDeleteError(mapped.message)
      },
    })
  }

  const title = current ? writeText.sheet.title(collection.label, displayValue(collection, current)) : writeText.sheet.createTitle(collection.label)
  const formError = saveError && Object.keys(saveError.fieldErrors).length === 0 ? saveError : undefined
  const fieldErrorShown = saveError && !formError

  return (
    <>
      <div className="flex items-start gap-2 border-b border-stone-100 px-5 py-4">
        <RDialog.Title className="min-w-0 flex-1 pt-1.5 text-base font-semibold break-words text-stone-900">{title}</RDialog.Title>
        {current && !editing && writable ? (
          <>
            <Button size="sm" icon={<Pencil />} onClick={startEditing}>
              {writeText.sheet.edit}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button ref={menuRef} size="sm" tone="ghost" aria-label={writeText.sheet.menu}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setDeleteOpen(true)}>
                  <Trash2 aria-hidden />
                  {writeText.sheet.delete}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
        <button
          type="button"
          aria-label={copy.common.close}
          onClick={requestClose}
          className="-mr-1 flex size-10 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-800 md:size-8"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
        {!collection.editable ? (
          <p className="flex items-center gap-2 text-sm text-stone-500">
            <Lock aria-hidden className="size-4 shrink-0" />
            {writeText.sheet.readOnlyTable}
          </p>
        ) : null}
        {saveError?.kind === 'conflict' ? (
          <Notice
            tone="warning"
            actions={
              <Button size="sm" icon={<RotateCw />} loading={reloading} onClick={() => void reloadLatest()}>
                {writeText.errors.reload}
              </Button>
            }
          >
            {saveError.message}
          </Notice>
        ) : formError ? (
          <Notice tone={formError.kind === 'editingUnavailable' || formError.kind === 'forbidden' ? 'warning' : 'error'}>{formError.message}</Notice>
        ) : fieldErrorShown ? (
          <Notice tone="error">{writeText.validation.fixBelow}</Notice>
        ) : null}

        {editing ? (
          <form id={formId} noValidate onSubmit={save} className="space-y-5">
            {collection.fields.map((field) => (
              <FieldEditor
                key={field.name}
                id={`${idPrefix}-${field.name}`}
                field={field}
                value={form[field.name] ?? ''}
                stored={base?.values[field.name]}
                onChange={(value) => setForm((previous) => ({ ...previous, [field.name]: value }))}
                error={fieldErrors[field.name]}
                mode={mode}
                referenceLabel={field.reference ? referenceLabels.get(`${field.reference.schema}.${field.reference.table}`) : undefined}
                disabled={pending}
              />
            ))}
          </form>
        ) : current ? (
          <RowValues
            collection={collection}
            row={current}
            fields={collection.fields.filter((field) => !auditFields.includes(field))}
            referenceLabels={referenceLabels}
          />
        ) : null}
      </div>

      {editing ? (
        <div className="flex flex-col-reverse gap-2 border-t border-stone-100 bg-stone-50/60 px-5 py-3 sm:flex-row sm:justify-end">
          <Button onClick={cancelEditing} disabled={pending}>
            {writeText.sheet.cancel}
          </Button>
          <Button type="submit" form={formId} tone="primary" loading={pending}>
            {pending ? writeText.sheet.saving : writeText.sheet.save}
          </Button>
        </div>
      ) : current && auditFields.length ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 border-t border-stone-100 px-5 py-3 text-xs text-stone-500" data-testid="row-audit">
          {auditFields.map((field) => {
            const at = formatTimestampFull(current.values[field.name])
            return at ? (
              <span key={field.name}>
                {field.name === CREATED_AT ? writeText.sheet.createdAt : writeText.sheet.updatedAt} {at}
              </span>
            ) : null
          })}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={writeText.sheet.discardTitle}
        body={writeText.sheet.discardBody}
        confirmLabel={writeText.sheet.discardConfirm}
        cancelLabel={writeText.sheet.discardCancel}
        onConfirm={() => {
          setConfirmDiscard(false)
          onOpenChange(false)
        }}
      />
      {current ? (
        <DeleteRowDialog
          open={deleteOpen}
          onOpenChange={(next) => {
            setDeleteOpen(next)
            if (!next) setDeleteError(undefined)
          }}
          rowName={displayValue(collection, current)}
          onConfirm={confirmDelete}
          pending={mutations.remove.isPending}
          error={deleteError}
          returnFocusRef={menuRef}
        />
      ) : null}
    </>
  )
}

/** The read view: every field in full (the grid truncates), references named by their 表. */
function RowValues({ collection, row, fields, referenceLabels }: { collection: Collection; row: DataRow; fields: Field[]; referenceLabels: ReadonlyMap<string, string> }) {
  return (
    <dl className="divide-y divide-stone-100" aria-label={collection.label}>
      {fields.map((field) => {
        const value = row.values[field.name]
        const empty = value === null || value === undefined
        return (
          <div key={field.name} data-field={field.name} className="grid gap-1 py-2.5 sm:grid-cols-[9rem_1fr] sm:gap-4">
            <dt className="text-sm text-stone-500">{field.label}</dt>
            <dd className="min-w-0 text-sm break-words text-stone-900">
              {empty ? (
                <span className="text-stone-400">{formatValue(field, value)}</span>
              ) : field.kind === 'json' ? (
                <pre className="overflow-x-auto rounded-md bg-stone-50 p-2 font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>
              ) : field.kind === 'timestamp' ? (
                formatTimestampFull(value) ?? formatValue(field, value)
              ) : field.kind === 'text' || field.kind === 'longtext' || field.kind === 'uuid' ? (
                <span className="whitespace-pre-wrap">{String(value)}</span>
              ) : field.kind === 'reference' ? (
                <>
                  <span className="font-mono">{String(value)}</span>
                  {field.reference ? (
                    <span className="ml-2 text-xs text-stone-500">
                      {writeText.sheet.referenceNote(writeText.field.referenceHint(referenceLabels.get(`${field.reference.schema}.${field.reference.table}`) ?? field.reference.table))}
                    </span>
                  ) : null}
                </>
              ) : (
                formatValue(field, value)
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/** `schema.table` → 表 label for every 表 a field points to (descriptions are cached by the catalog). */
function useReferenceLabels(projectId: string, databaseId: string, collection: Collection): ReadonlyMap<string, string> {
  const targets = [...new Set(collection.fields.flatMap((field) => (field.reference ? [`${field.reference.schema}.${field.reference.table}`] : [])))]
  return useQueries({
    queries: targets.map((target) => {
      const [schema = '', table = ''] = target.split('.')
      return databaseTableSchemaQuery(projectId, databaseId, schema, table)
    }),
    combine: (results) => new Map(results.flatMap((result) => (result.data ? [[`${result.data.schema}.${result.data.name}`, deriveCollection(result.data).label] as const] : []))),
  })
}
