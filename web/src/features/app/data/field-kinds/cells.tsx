// Grid cells by field kind (design §Console architecture, "field-kinds/ registry").
// A new kind is one entry here (and one editor in ./editors.tsx); the grid does not change.
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatValue, type Field, type FieldKind } from '../../../../model/data-catalog'
import { Tooltip } from '../../../../ui'
import { dataText } from '../copy'

export interface CellProps {
  field: Field
  value: unknown
  /** Label of the 表 a reference points to (tooltip on the raw key). */
  referenceLabel?: string
}

type CellRenderer = (props: CellProps) => ReactNode

function PlainCell({ field, value }: CellProps) {
  return <span className="block max-w-xs truncate">{formatValue(field, value)}</span>
}

function LongTextCell({ field, value }: CellProps) {
  return <span className="block max-w-sm truncate text-stone-700">{formatValue(field, value)}</span>
}

function NumberCell({ field, value }: CellProps) {
  return <span className="tabular-nums">{formatValue(field, value)}</span>
}

function DateCell({ field, value }: CellProps) {
  return <span className="whitespace-nowrap tabular-nums">{formatValue(field, value)}</span>
}

function BooleanCell({ field, value }: CellProps) {
  return value === true ? (
    <span className="inline-flex items-center gap-1 text-accent-strong">
      <Check aria-hidden className="size-3.5" />
      {formatValue(field, value)}
    </span>
  ) : (
    <span className="text-stone-500">{formatValue(field, value)}</span>
  )
}

function EnumCell({ field, value }: CellProps) {
  return <span className="inline-block rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-700">{formatValue(field, value)}</span>
}

/** Phase 1: the raw key, muted, with the target 表 named on hover/focus. */
function ReferenceCell({ field, value, referenceLabel }: CellProps) {
  const text = <span className="tabular-nums text-stone-500">{formatValue(field, value)}</span>
  return referenceLabel ? (
    <Tooltip content={dataText.referenceHint(referenceLabel)}>
      <span tabIndex={0} className="rounded underline decoration-stone-300 decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent">
        {text}
      </span>
    </Tooltip>
  ) : text
}

function MonoCell({ field, value }: CellProps) {
  return <span className="block max-w-[10rem] truncate font-mono text-xs text-stone-500">{formatValue(field, value)}</span>
}

export const cellRenderers: Record<FieldKind, CellRenderer> = {
  text: PlainCell,
  longtext: LongTextCell,
  integer: NumberCell,
  number: NumberCell,
  boolean: BooleanCell,
  date: DateCell,
  timestamp: DateCell,
  enum: EnumCell,
  reference: ReferenceCell,
  json: MonoCell,
  uuid: MonoCell,
}

/** Column classes by kind: numbers align right. */
export const cellAlign: Partial<Record<FieldKind, string>> = { integer: 'text-right', number: 'text-right' }

export function FieldCell(props: CellProps) {
  if (props.value === null || props.value === undefined) {
    return <span className="text-stone-400">{formatValue(props.field, props.value)}</span>
  }
  const Render = cellRenderers[props.field.kind]
  return <Render {...props} />
}
