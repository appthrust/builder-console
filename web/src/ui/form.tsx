import { Check, ChevronDown } from 'lucide-react'
import { Checkbox as RCheckbox, RadioGroup, Select as RSelect } from 'radix-ui'
import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import type { GroupNode } from '../api/console'
import { copy } from '../copy'
import { cn } from './cn'

/** Control look without width; inputs add `w-full`. */
export const controlClasses =
  'block rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-900 shadow-xs transition-colors placeholder:text-stone-400 hover:border-stone-400 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500 aria-invalid:border-bad aria-invalid:focus-visible:outline-bad'

/** `${id}-error` when invalid, else `${id}-hint`; Field renders those ids. */
const describedBy = (id: string | undefined, invalid: boolean | undefined) => (id ? `${id}-${invalid ? 'error' : 'hint'}` : undefined)

/**
 * Labelled control. The control itself gets `id`; hint and error are rendered
 * with ids `${id}-hint` / `${id}-error`, which TextInput / TextArea / Select
 * wire through aria-describedby from their own `id`.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-stone-800">
        {label}
        {required ? (
          <span className="rounded bg-stone-100 px-1.5 py-px text-[11px] font-medium text-stone-500">{copy.common.required}</span>
        ) : null}
      </label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-bad-ink">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-stone-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function TextInput({
  invalid,
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy(rest.id, invalid)}
      className={cn(controlClasses, 'h-10 w-full md:h-9', className)}
      {...rest}
    />
  )
}

export function TextArea({
  invalid,
  className,
  ref,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy(rest.id, invalid)}
      className={cn(controlClasses, 'min-h-20 w-full py-2', className)}
      {...rest}
    />
  )
}

/** `indent`: nesting level, applied to the menu row only (the closed trigger shows the plain label). */
export type SelectOption = { value: string; label: ReactNode; disabled?: boolean; indent?: number }

/** Radix Select. `value` undefined shows the placeholder; option values must be non-empty. */
export function Select({
  id,
  value,
  onChange,
  options,
  placeholder,
  invalid,
  disabled,
  className,
  'aria-label': ariaLabel,
}: {
  id?: string
  value: string | undefined
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
  className?: string
  'aria-label'?: string
}) {
  return (
    <RSelect.Root value={value ?? ''} onValueChange={onChange} disabled={disabled}>
      <RSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy(id, invalid)}
        className={cn(controlClasses, 'flex h-10 w-full items-center justify-between gap-2 text-left data-placeholder:text-stone-400 md:h-9', className)}
      >
        <span className="min-w-0 truncate">
          <RSelect.Value placeholder={placeholder} />
        </span>
        <RSelect.Icon asChild>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-stone-500" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-line bg-white shadow-lg animate-pop-in"
        >
          <RSelect.Viewport className="p-1">
            {options.map((option) => (
              <RSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                style={option.indent ? { paddingLeft: `${2 + option.indent * 0.875}rem` } : undefined}
                className="relative flex min-h-10 cursor-default items-center rounded py-1.5 pr-3 pl-8 text-sm text-stone-800 outline-none select-none md:min-h-0 data-disabled:text-stone-400 data-highlighted:bg-accent-soft data-highlighted:text-accent-strong"
              >
                <RSelect.ItemIndicator className="absolute left-2 inline-flex">
                  <Check aria-hidden className="size-4" />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{option.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  )
}

/** Radix checkbox with a clickable label and optional description. */
export function Checkbox({
  id,
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  name,
  className,
}: {
  id?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
  name?: string
  className?: string
}) {
  const box = (
    <RCheckbox.Root
      id={id}
      name={name}
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next === true)}
      disabled={disabled}
      aria-label={label ? undefined : typeof description === 'string' ? description : undefined}
      className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-stone-400 bg-white transition-colors hover:border-stone-500 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
    >
      <RCheckbox.Indicator>
        <Check aria-hidden strokeWidth={3} className="size-3 text-white" />
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  )
  if (!label) return box
  return (
    <label className={cn('flex cursor-pointer items-start gap-2.5 text-sm text-stone-800', disabled && 'cursor-not-allowed opacity-60', className)}>
      {box}
      <span className="min-w-0">
        <span className="block">{label}</span>
        {description ? <span className="mt-0.5 block text-xs text-stone-500">{description}</span> : null}
      </span>
    </label>
  )
}

export type RadioCardOption<V extends string> = {
  value: V
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  disabled?: boolean
  /** Rendered below the card while it is selected (outside the radio, so it may hold inputs). */
  children?: ReactNode
  /** Always rendered inside the card, under the description. */
  note?: ReactNode
}

/** One-of-N choice as cards (Radix RadioGroup: arrow keys move, Space selects; nothing submits). */
export function RadioCards<V extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  columns = 1,
  error,
  idPrefix,
  disabled,
}: {
  name: string
  legend: ReactNode
  options: Array<RadioCardOption<V>>
  value: V | undefined
  onChange: (value: V) => void
  columns?: 1 | 2 | 3
  error?: string
  idPrefix?: string
  disabled?: boolean
}) {
  const prefix = idPrefix ?? name
  const legendId = `${prefix}-legend`
  const errorId = `${prefix}-error`
  return (
    <div>
      <p id={legendId} className="text-sm font-medium text-stone-800">
        {legend}
      </p>
      <RadioGroup.Root
        name={name}
        value={value ?? ''}
        onValueChange={(next) => onChange(next as V)}
        disabled={disabled}
        aria-labelledby={legendId}
        aria-describedby={error ? errorId : undefined}
        className={cn('mt-2 grid gap-2', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-3')}
      >
        {options.map((option) => {
          const selected = option.value === value
          return (
            <div key={option.value} className="min-w-0">
              <RadioGroup.Item
                value={option.value}
                disabled={option.disabled}
                id={`${prefix}-${option.value}`}
                className={cn(
                  'flex w-full items-start gap-3 rounded-lg border bg-white px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  selected ? 'border-accent ring-1 ring-accent bg-accent-soft/40' : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-accent' : 'border-stone-400'
                  )}
                >
                  {selected ? <span className="size-2 rounded-full bg-accent" /> : null}
                </span>
                {option.icon ? (
                  <span aria-hidden className="mt-px shrink-0 text-stone-500 [&_svg]:size-4">
                    {option.icon}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-stone-900">{option.title}</span>
                  {option.description ? <span className="mt-0.5 block text-xs text-stone-500">{option.description}</span> : null}
                  {option.note ? <span className="mt-1.5 block text-xs text-stone-600">{option.note}</span> : null}
                </span>
              </RadioGroup.Item>
              {selected && option.children ? <div className="mt-2 pl-4">{option.children}</div> : null}
            </div>
          )
        })}
      </RadioGroup.Root>
      {error ? (
        <p id={errorId} className="mt-1.5 text-xs text-bad-ink">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Group picker over a flattened tree (`flattenGroupTree`); labels indented by depth. */
export function GroupSelect({
  id,
  groups,
  value,
  onChange,
  disabled,
  invalid,
  className,
  placeholder,
}: {
  id: string
  groups: GroupNode[]
  value: string | undefined
  onChange: (groupId: string) => void
  disabled?: boolean
  invalid?: boolean
  className?: string
  placeholder?: string
}) {
  return (
    <Select
      id={id}
      value={value}
      onChange={onChange}
      disabled={disabled}
      invalid={invalid}
      className={className}
      placeholder={placeholder}
      options={groups.map((group) => ({
        value: group.id,
        label: group.name,
        indent: group.depth,
      }))}
    />
  )
}

/** Multi-select over a flattened tree: one checkbox per group, indented by depth. */
export function GroupChecklist({
  groups,
  selected,
  onChange,
  legend,
  error,
  idPrefix,
  disabled,
}: {
  groups: GroupNode[]
  selected: string[]
  onChange: (groupIds: string[]) => void
  legend: ReactNode
  error?: string
  idPrefix: string
  disabled?: boolean
}) {
  const errorId = `${idPrefix}-error`
  return (
    <fieldset aria-describedby={error ? errorId : undefined} disabled={disabled}>
      <legend className="text-xs font-medium text-stone-600">{legend}</legend>
      <ul className="mt-1.5 max-h-56 space-y-1.5 overflow-auto rounded-md border border-stone-200 bg-white p-3">
        {groups.map((group) => (
          <li key={group.id} style={{ paddingLeft: `${group.depth * 1.25}rem` }}>
            <Checkbox
              id={`${idPrefix}-${group.id}`}
              checked={selected.includes(group.id)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(checked ? [...selected, group.id] : selected.filter((groupId) => groupId !== group.id))
              }
              label={group.name}
            />
          </li>
        ))}
      </ul>
      {error ? (
        <p id={errorId} className="mt-1.5 text-xs text-bad-ink">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}
