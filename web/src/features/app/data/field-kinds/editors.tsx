// Field-kind editor registry of the row Sheet (design "field-kinds/": kind →
// editor). A new kind is one entry here plus its parse rule in
// model/data-record.ts; the Sheet does not change. Every editor edits the
// string form value (model/data-record.ts `FormValues`).
import type { ComponentType } from 'react'
import { formatValue, type Field as DataField, type FieldKind } from '../../../../model/data-catalog'
import { formatTimestampFull, type FormMode } from '../../../../model/data-record'
import { Checkbox, Field, Select, TextArea, TextInput } from '../../../../ui'
import { writeText } from '../copy-write'

export interface EditorProps {
  id: string
  field: DataField
  value: string
  onChange: (value: string) => void
  invalid: boolean
  mode: FormMode
  disabled?: boolean
}

/** Radix Select needs a non-empty value; this one stands for the empty input (（なし）). */
const NONE = '__none__'

function TextEditor({ id, value, onChange, invalid, disabled }: EditorProps) {
  return <TextInput id={id} value={value} onChange={(event) => onChange(event.target.value)} invalid={invalid} disabled={disabled} autoComplete="off" />
}

function LongTextEditor({ id, value, onChange, invalid, disabled }: EditorProps) {
  return <TextArea id={id} value={value} onChange={(event) => onChange(event.target.value)} invalid={invalid} disabled={disabled} rows={4} />
}

function NumberEditor({ id, field, value, onChange, invalid, disabled }: EditorProps) {
  // Text, not type=number: people type 「１２０,０００」 and the parser accepts it.
  return (
    <TextInput
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      invalid={invalid}
      disabled={disabled}
      inputMode={field.kind === 'integer' ? 'numeric' : 'decimal'}
      autoComplete="off"
      className="tabular-nums"
    />
  )
}

/** Choice editor for enums and nullable/defaulted booleans; the empty choice is （なし） or the default. */
function ChoiceEditor({ id, field, value, onChange, invalid, disabled, mode, options }: EditorProps & { options: Array<{ value: string; label: string }> }) {
  const withNone = field.nullable
  const placeholder = mode === 'create' && field.hasDefault ? writeText.field.auto : writeText.field.choose
  return (
    <Select
      id={id}
      value={value === '' ? (withNone ? NONE : undefined) : value}
      onChange={(next) => onChange(next === NONE ? '' : next)}
      options={withNone ? [...options, { value: NONE, label: writeText.field.none }] : options}
      placeholder={placeholder}
      invalid={invalid}
      disabled={disabled}
    />
  )
}

function BooleanEditor(props: EditorProps) {
  const { id, field, value, onChange, disabled, mode } = props
  // A checkbox cannot show "empty": nullable or defaulted-on-create booleans pick from はい/いいえ/（なし）.
  if (field.nullable || (mode === 'create' && field.hasDefault)) {
    return <ChoiceEditor {...props} options={[{ value: 'true', label: writeText.field.yes }, { value: 'false', label: writeText.field.no }]} />
  }
  return (
    <span className="flex h-10 items-center gap-2.5 md:h-9">
      <Checkbox id={id} checked={value === 'true'} onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')} disabled={disabled} />
      <span aria-hidden className="text-sm text-stone-700">{value === 'true' ? writeText.field.yes : writeText.field.no}</span>
    </span>
  )
}

function EnumEditor(props: EditorProps) {
  return <ChoiceEditor {...props} options={(props.field.enumValues ?? []).map((item) => ({ value: item, label: item }))} />
}

function DateEditor({ id, value, onChange, invalid, disabled }: EditorProps) {
  return <TextInput id={id} type="date" value={value} onChange={(event) => onChange(event.target.value)} invalid={invalid} disabled={disabled} className="sm:max-w-52" />
}

function TimestampEditor({ id, value, onChange, invalid, disabled }: EditorProps) {
  return <TextInput id={id} type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} invalid={invalid} disabled={disabled} className="sm:max-w-64" />
}

function JsonEditor({ id, value, onChange, invalid, disabled }: EditorProps) {
  return (
    <TextArea
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      invalid={invalid}
      disabled={disabled}
      rows={6}
      spellCheck={false}
      className="font-mono text-xs"
    />
  )
}

function KeyEditor({ id, value, onChange, invalid, disabled }: EditorProps) {
  return <TextInput id={id} value={value} onChange={(event) => onChange(event.target.value)} invalid={invalid} disabled={disabled} autoComplete="off" spellCheck={false} className="font-mono" />
}

export const fieldEditors: Record<Exclude<FieldKind, 'unsupported'>, ComponentType<EditorProps>> = {
  text: TextEditor,
  longtext: LongTextEditor,
  integer: NumberEditor,
  number: NumberEditor,
  boolean: BooleanEditor,
  date: DateEditor,
  timestamp: TimestampEditor,
  enum: EnumEditor,
  reference: KeyEditor,
  json: JsonEditor,
  uuid: KeyEditor,
}

/**
 * One labelled form row. Read-only fields (auto-filled keys and timestamps)
 * are text: 「自動で入ります」 on create, the stored value on edit. A column of a
 * type this console does not know has no input: its fixed placeholder says it
 * keeps its stored value.
 */
export function FieldEditor({
  id,
  field,
  value,
  stored,
  onChange,
  error,
  mode,
  referenceLabel,
  disabled,
}: {
  id: string
  field: DataField
  value: string
  /** The row's stored value, shown for read-only fields while editing. */
  stored: unknown
  onChange: (value: string) => void
  error?: string
  mode: FormMode
  /** Label of the 表 a reference points to (falls back to its table name). */
  referenceLabel?: string
  disabled?: boolean
}) {
  if (field.readOnly) {
    const text = mode === 'create' ? writeText.field.auto : field.kind === 'timestamp' ? formatTimestampFull(stored) ?? formatValue(field, stored) : formatValue(field, stored)
    return (
      <div data-field={field.name}>
        <p className="text-sm font-medium text-stone-800">{field.label}</p>
        <p className="mt-1.5 text-sm text-stone-500">{text}</p>
      </div>
    )
  }
  if (field.kind === 'unsupported') {
    return (
      <div data-field={field.name}>
        <p className="text-sm font-medium text-stone-800">{field.label}</p>
        <p className="mt-1.5 text-sm text-stone-400">{formatValue(field, stored)}</p>
        <p className="mt-1 text-xs text-stone-500">{error ?? writeText.field.unsupportedNote}</p>
      </div>
    )
  }
  const Editor = fieldEditors[field.kind]
  const required = !field.nullable && !(mode === 'create' && field.hasDefault)
  const hint = field.reference
    ? writeText.field.referenceHint(referenceLabel ?? field.reference.table)
    : field.kind === 'json'
      ? writeText.field.jsonHint
      : undefined
  return (
    <Field id={id} label={field.label} required={required} error={error} hint={hint}>
      <Editor id={id} field={field} value={value} onChange={onChange} invalid={!!error} mode={mode} disabled={disabled} />
    </Field>
  )
}
