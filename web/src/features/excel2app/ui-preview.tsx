// The planned app as the user will get it: a framed browser window with the
// app's own navigation and the selected screen, filled from entity sources.
// Pure render of (plan, design, grids): every design change shows
// immediately. Search, filters and opening a row are local to the preview.
// `design` is a read `UiDesign`: the server's (written by the ui-design turn)
// or the heuristic `ui-design.ts` one, read through the same constructor. A
// screen, card, list layout or field of a kind this console does not know and
// a list, form or dashboard it cannot read stay where they are and show a
// fixed note; the rest of the design renders normally.
// The frame fills its parent's height when the parent has one (side by side
// with the chat) and scrolls the screen inside it; otherwise it grows.
import { AlertCircle, Check, ChevronDown, CircleDashed, Database, FileText, Image, LayoutDashboard, LayoutGrid, Lock, Paperclip, Pencil, Plus, Search, SquareKanban, SquarePen, Table2, Upload, User } from 'lucide-react'
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { isOneOf, knownValue } from '../../model/contracts/build'
import { partValue, type Accent, type DashboardCard, type Density, type DesignPart, type FormDesign, type ListDesign, type ListLayout, type ScreenDesign, type ScreenKind, type UiDesign } from '../../model/contracts/excel'
import { locale } from '../../shell/language'
import { cn } from '../../ui'
import { cellText, entityRows, type AppPlan, type CellValue, type EntityRow, type PlannedEntity, type PlannedField, type WorkbookGrid } from './model'
import { previewText as text } from './preview-copy'

/** Rows a list or master screen shows before the 「全 N 件中」 footer. */
const MAX_ROWS = 8
/** Cards per board column before 「ほか N 件」. */
const MAX_BOARD_CARDS = 4
/** Overdue rows the dashboard card names. */
const MAX_OVERDUE_ITEMS = 3

type Row = EntityRow

interface Theme {
  solid: string
  soft: string
  text: string
  bar: string
  focus: string
  active: string
}

// Literal class names so Tailwind generates every accent.
const ACCENT: Record<Accent, Theme> = {
  teal: { solid: 'bg-teal-600 text-white hover:bg-teal-700', soft: 'bg-teal-50 text-teal-800 ring-teal-600/25', text: 'text-teal-700', bar: 'bg-teal-500', focus: 'focus:border-teal-500 focus:ring-teal-500/20', active: 'bg-teal-50 text-teal-800 [&_svg]:text-teal-600' },
  blue: { solid: 'bg-blue-600 text-white hover:bg-blue-700', soft: 'bg-blue-50 text-blue-800 ring-blue-600/25', text: 'text-blue-700', bar: 'bg-blue-500', focus: 'focus:border-blue-500 focus:ring-blue-500/20', active: 'bg-blue-50 text-blue-800 [&_svg]:text-blue-600' },
  violet: { solid: 'bg-violet-600 text-white hover:bg-violet-700', soft: 'bg-violet-50 text-violet-800 ring-violet-600/25', text: 'text-violet-700', bar: 'bg-violet-500', focus: 'focus:border-violet-500 focus:ring-violet-500/20', active: 'bg-violet-50 text-violet-800 [&_svg]:text-violet-600' },
  amber: { solid: 'bg-amber-500 text-white hover:bg-amber-600', soft: 'bg-amber-50 text-amber-800 ring-amber-600/25', text: 'text-amber-700', bar: 'bg-amber-500', focus: 'focus:border-amber-500 focus:ring-amber-500/20', active: 'bg-amber-50 text-amber-800 [&_svg]:text-amber-600' },
  rose: { solid: 'bg-rose-600 text-white hover:bg-rose-700', soft: 'bg-rose-50 text-rose-800 ring-rose-600/25', text: 'text-rose-700', bar: 'bg-rose-500', focus: 'focus:border-rose-500 focus:ring-rose-500/20', active: 'bg-rose-50 text-rose-800 [&_svg]:text-rose-600' },
  stone: { solid: 'bg-stone-800 text-white hover:bg-stone-900', soft: 'bg-stone-200/70 text-stone-900 ring-stone-600/25', text: 'text-stone-900', bar: 'bg-stone-500', focus: 'focus:border-stone-500 focus:ring-stone-500/20', active: 'bg-stone-200/70 text-stone-900 [&_svg]:text-stone-700' },
}

interface Spacing {
  cell: string
  head: string
  page: string
  card: string
  gap: string
  input: string
}

const DENSITY: Record<Density, Spacing> = {
  comfortable: { cell: 'px-3 py-2.5', head: 'px-3 py-2', page: 'px-5 py-5', card: 'p-3.5', gap: 'gap-4', input: 'py-2' },
  compact: { cell: 'px-2.5 py-1.5', head: 'px-2.5 py-1.5', page: 'px-4 py-3.5', card: 'p-2.5', gap: 'gap-2.5', input: 'py-1' },
}

interface Tone {
  pill: string
  bar: string
}

const TONE = {
  stone: { pill: 'bg-stone-100 text-stone-700 ring-stone-500/20', bar: 'bg-stone-400' },
  amber: { pill: 'bg-amber-50 text-amber-800 ring-amber-600/25', bar: 'bg-amber-400' },
  sky: { pill: 'bg-sky-50 text-sky-800 ring-sky-600/25', bar: 'bg-sky-500' },
  violet: { pill: 'bg-violet-50 text-violet-800 ring-violet-600/25', bar: 'bg-violet-500' },
  emerald: { pill: 'bg-emerald-50 text-emerald-800 ring-emerald-600/25', bar: 'bg-emerald-500' },
  rose: { pill: 'bg-rose-50 text-rose-800 ring-rose-600/25', bar: 'bg-rose-500' },
  orange: { pill: 'bg-orange-50 text-orange-800 ring-orange-600/25', bar: 'bg-orange-400' },
  indigo: { pill: 'bg-indigo-50 text-indigo-800 ring-indigo-600/25', bar: 'bg-indigo-500' },
  lime: { pill: 'bg-lime-50 text-lime-800 ring-lime-600/25', bar: 'bg-lime-500' },
  fuchsia: { pill: 'bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-600/25', bar: 'bg-fuchsia-500' },
  cyan: { pill: 'bg-cyan-50 text-cyan-800 ring-cyan-600/25', bar: 'bg-cyan-500' },
} satisfies Record<string, Tone>

const VALUE_TONES: Tone[] = [TONE.sky, TONE.amber, TONE.violet, TONE.emerald, TONE.rose, TONE.orange, TONE.indigo, TONE.lime, TONE.fuchsia, TONE.cyan]
const MIDDLE_STAGE_TONES: Tone[] = [TONE.amber, TONE.sky, TONE.violet, TONE.indigo]

const SCREEN_ICON: Record<ScreenKind, typeof Table2> = {
  dashboard: LayoutDashboard,
  list: Table2,
  form: SquarePen,
  detail: FileText,
  board: SquareKanban,
  master: Database,
}

/** A part of the design this preview cannot show: of an unknown kind (`unsupported`) or unreadable (`broken`). Fixed text only. */
function UnavailablePart({ reason }: { reason: 'unsupported' | 'broken' }) {
  return (
    <p data-testid={`excel2app-ui-preview-${reason}`} className={cn('flex items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-stone-600', reason === 'broken' ? 'border-rose-300 bg-rose-50/60' : 'border-stone-300 bg-stone-50')}>
      {reason === 'broken' ? <AlertCircle aria-hidden className="size-4 shrink-0 text-rose-600" /> : <CircleDashed aria-hidden className="size-4 shrink-0 text-stone-400" />}
      {text[reason]}
    </p>
  )
}

const REJECTED_STAGE = /廃止|中止|却下|取消|取り消し|cancel|reject/i
const DONE_STAGE = /完了|済|クローズ|close|done|完成|承認/i
const DEADLINE_FIELD = /期限|予定|納期/
const TITLE_FIELD = /内容|件名|タイトル|名称|概要|項目/
const UNIT = /[(（]([^)）]+)[)）]\s*$/

const DAY_MS = 86_400_000
/** The day the sample ledgers were written for (their 経過日数 count to it); overdue deadlines are measured against it. */
const PREVIEW_TODAY = new Date(2026, 9, 26)

/** Deterministic tone for a choice value: workflow stages progress grey → amber → … → green; other values by option position. */
function toneOf(value: string, field: PlannedField | undefined, entity: PlannedEntity): Tone {
  const stages = entity.workflow && field && entity.workflow.column === field.name ? entity.workflow.stages : undefined
  if (stages) {
    const position = stages.indexOf(value)
    const final = stages.lastIndexOf(stages.filter((stage) => !REJECTED_STAGE.test(stage)).at(-1) ?? '')
    if (REJECTED_STAGE.test(value)) return TONE.rose
    if (position === final) return TONE.emerald
    if (position === 0) return TONE.stone
    if (position > 0) return MIDDLE_STAGE_TONES[(position - 1) % MIDDLE_STAGE_TONES.length]
  }
  const option = field?.options?.indexOf(value) ?? -1
  if (option >= 0) return VALUE_TONES[option % VALUE_TONES.length]
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return VALUE_TONES[hash % VALUE_TONES.length]
}

/** Stages after which a deadline no longer counts as overdue. */
function doneStages(entity: PlannedEntity): Set<string> {
  const stages = entity.workflow?.stages ?? []
  const done = stages.filter((stage) => DONE_STAGE.test(stage) || REJECTED_STAGE.test(stage))
  return new Set(done.length ? done : stages.slice(-1))
}

function toDate(value: CellValue): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
  if (typeof value === 'string') {
    const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(value.trim())
    if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  }
  return undefined
}

const formatDate = (date: Date) => `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`

const isBlank = (value: CellValue) => cellText(value) === ''

function numberOf(value: CellValue): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value.replace(/,/g, '')))) return Number(value.replace(/,/g, ''))
  return undefined
}

const formatNumber = (value: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(value)

function display(value: CellValue, field: PlannedField | undefined): string {
  if (isBlank(value)) return ''
  const date = isOneOf(field?.kind, 'date') ? toDate(value) : value instanceof Date ? value : undefined
  if (date) return formatDate(date)
  if (typeof value === 'number' && !isOneOf(field?.kind, 'id')) return formatNumber(value)
  return cellText(value)
}

function titleFieldOf(entity: PlannedEntity): string | undefined {
  const named = entity.fields.find((field) => !isOneOf(field.kind, 'id') && TITLE_FIELD.test(field.name))
  return (named ?? entity.fields.find((field) => isOneOf(field.kind, 'reference')) ?? entity.fields.find((field) => isOneOf(field.kind, 'text')) ?? entity.fields.find((field) => !isOneOf(field.kind, 'id')))?.name
}

interface Context {
  entity: PlannedEntity
  /** The name the design uses for this entity (keys of `design.lists`/`design.forms`). */
  designEntity: string
  fields: Map<string, PlannedField>
  rows: Row[]
  theme: Theme
  space: Spacing
  /** Master key → display name per master entity. */
  masterLabels: Map<string, Map<string, string>>
  today: number
  done: Set<string>
  deadline?: string
  titleField?: string
  idField?: string
}

/** Days a row is past its deadline while still open; 0 when it is not overdue. */
function overdueDays(row: Row, context: Context, field = context.deadline): number {
  if (!field) return 0
  const status = context.entity.workflow ? cellText(row.values[context.entity.workflow.column]) : ''
  if (status && context.done.has(status)) return 0
  const date = toDate(row.values[field])
  if (!date) return 0
  const days = Math.floor((context.today - date.getTime()) / DAY_MS)
  return days > 0 ? days : 0
}

function sortRows(rows: Row[], field: PlannedField | undefined): Row[] {
  if (!field) return rows
  const key = (row: Row) => {
    const value = row.values[field.name]
    if (isOneOf(field.kind, 'date')) return -(toDate(value)?.getTime() ?? -Infinity)
    return numberOf(value) ?? cellText(value)
  }
  return [...rows].sort((a, b) => {
    const left = key(a)
    const right = key(b)
    if (typeof left === 'number' && typeof right === 'number') return left - right
    return String(left).localeCompare(String(right), locale())
  })
}

/** Values of a field in the order a filter or chart lists them: declared options first, then what the rows hold. */
function valuesOf(field: PlannedField | undefined, rows: Row[]): string[] {
  if (!field) return []
  const seen = rows.map((row) => cellText(row.values[field.name])).filter(Boolean)
  return [...new Set([...(field.options ?? []), ...seen])]
}

export interface UiPreviewProps {
  plan: AppPlan
  design: UiDesign
  grids: ReadonlyMap<string, WorkbookGrid>
  screenId: string
  onScreenChange: (id: string) => void
  /** Reference date for overdue deadlines; defaults to `PREVIEW_TODAY` (2026-10-26). */
  today?: Date
}

export function UiPreview({ plan, design, grids, screenId, onScreenChange, today }: UiPreviewProps) {
  // An accent or density this console does not know renders in the neutral look; the decisions list leaves it out.
  const accent = knownValue(design.accent)
  const density = knownValue(design.density)
  const theme = accent ? ACCENT[accent] : ACCENT.stone
  const space = density ? DENSITY[density] : DENSITY.comfortable
  const visible = design.screens.filter((screen) => !screen.hidden)
  const screen = visible.find((item) => item.id === screenId) ?? visible[0]
  const [openedRow, setOpenedRow] = useState<Record<string, number>>({})
  const body = useRef<HTMLDivElement>(null)
  // A newly selected screen starts at its top, as a page load in the built app would.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the shown screen changes.
  useEffect(() => {
    body.current?.scrollTo({ top: 0 })
  }, [screen?.id])
  const masterLabels = useMemo(() => {
    const labels = new Map<string, Map<string, string>>()
    for (const entity of plan.entities) {
      if (!isOneOf(entity.kind, 'master') || entity.fields.length === 0) continue
      const [key, name] = entity.fields
      labels.set(entity.name, new Map(entityRows(entity, grids).map((row) => [cellText(row.values[key.name]), name ? cellText(row.values[name.name]) : ''])))
    }
    return labels
  }, [plan, grids])
  const rowsByEntity = useMemo(() => new Map(plan.entities.map((entity) => [entity.name, entityRows(entity, grids)])), [plan, grids])

  const go = (kind: ScreenKind, entity: string) => {
    const target = visible.find((item) => isOneOf(item.kind, kind) && item.entity === entity)
    if (target) onScreenChange(target.id)
  }
  const canGo = (kind: ScreenKind, entity: string) => visible.some((item) => isOneOf(item.kind, kind) && item.entity === entity)

  const entity = screen ? plan.entities.find((entity) => entity.name === screen.entity) : undefined
  const now = today ?? PREVIEW_TODAY
  const context: Context | undefined = entity && screen && {
    entity,
    designEntity: screen.entity,
    fields: new Map(entity.fields.map((field) => [field.name, field])),
    rows: rowsByEntity.get(entity.name) ?? [],
    theme,
    space,
    masterLabels,
    today: Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
    done: doneStages(entity),
    deadline: entity.fields.find((field) => isOneOf(field.kind, 'date') && DEADLINE_FIELD.test(field.name))?.name,
    titleField: titleFieldOf(entity),
    idField: entity.fields.find((field) => isOneOf(field.kind, 'id'))?.name,
  }
  const openRow = (row: Row) => {
    if (!entity) return
    setOpenedRow((current) => ({ ...current, [entity.name]: row.index }))
    go('detail', entity.name)
  }

  return (
    <section aria-label={text.frame(design.appName)} data-testid="excel2app-ui-preview" className="@container/frame flex h-full flex-col overflow-hidden rounded-xl border border-stone-300/80 bg-white text-[13px] leading-normal text-stone-700 shadow-sm">
      <div className="flex shrink-0 items-center gap-3 border-b border-stone-200 bg-stone-100 px-3 py-2">
        <span aria-hidden className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-stone-300" />
          <span className="size-2.5 rounded-full bg-stone-300" />
          <span className="size-2.5 rounded-full bg-stone-300" />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-white px-2.5 py-1 text-xs text-stone-500 ring-1 ring-stone-200">
          <Lock aria-hidden className="size-3 shrink-0" />
          <span className="truncate" data-testid="excel2app-ui-preview-address">{text.address(design.appName)}</span>
        </span>
      </div>
      <div className="flex min-h-[30rem] flex-1 flex-col @xl/frame:flex-row">
        <nav aria-label={text.nav} className="flex shrink-0 flex-col border-b border-stone-200 bg-stone-50 @xl/frame:w-44 @xl/frame:overflow-y-auto @xl/frame:border-r @xl/frame:border-b-0">
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <span aria-hidden className={cn('flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold', theme.solid)}>{[...design.appName][0]}</span>
            <span className="min-w-0 truncate font-semibold text-stone-900">{design.appName}</span>
          </div>
          <ul className="flex gap-0.5 overflow-x-auto px-2 pb-2 @xl/frame:flex-col @xl/frame:overflow-visible">
            {visible.map((item) => {
              const kind = knownValue(item.kind)
              const Icon = !kind ? CircleDashed : kind === 'list' && isOneOf(partValue(design.lists[item.entity])?.layout, 'cards') ? LayoutGrid : SCREEN_ICON[kind]
              const current = item.id === screen?.id
              return (
                <li key={item.id} className="shrink-0">
                  <button
                    type="button"
                    aria-current={current ? 'page' : undefined}
                    data-testid={`excel2app-ui-preview-nav-${kind ?? 'unsupported'}`}
                    onClick={() => onScreenChange(item.id)}
                    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left whitespace-nowrap transition-colors', current ? cn('font-medium', theme.active) : 'text-stone-600 hover:bg-stone-200/60 hover:text-stone-900 [&_svg]:text-stone-400')}
                  >
                    <Icon aria-hidden className="size-4 shrink-0" />
                    <span className="truncate">{item.title}</span>
                    {kind ? null : <span className="sr-only">{`（${text.unsupportedScreen}）`}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard. */}
        <div
          ref={body}
          role="region"
          aria-label={screen?.title ?? text.nav}
          tabIndex={0}
          className="@container min-h-0 min-w-0 flex-1 overflow-y-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-stone-400"
          data-testid={screen ? `excel2app-ui-preview-screen-${knownValue(screen.kind) ?? 'unsupported'}` : undefined}
        >
          {screen && !knownValue(screen.kind) ? (
            <div className={space.page}><UnavailablePart reason="unsupported" /></div>
          ) : !screen || !context ? (
            <p className={cn('text-stone-500', space.page)}>{text.noScreens}</p>
          ) : (
            <ScreenView
              key={screen.id}
              screen={screen}
              design={design}
              context={context}
              openedRow={openedRow[context.entity.name]}
              onOpenRow={canGo('detail', context.entity.name) ? openRow : undefined}
              onCreate={canGo('form', context.entity.name) ? () => go('form', context.entity.name) : undefined}
              onEdit={canGo('form', context.entity.name) ? () => go('form', context.entity.name) : undefined}
            />
          )}
        </div>
      </div>
    </section>
  )
}

interface ScreenProps {
  screen: ScreenDesign
  design: UiDesign
  context: Context
  openedRow?: number
  onOpenRow?: (row: Row) => void
  onCreate?: () => void
  onEdit?: () => void
}

function ScreenView({ screen, design, context, openedRow, onOpenRow, onCreate, onEdit }: ScreenProps) {
  const { space, theme } = context
  const kind = knownValue(screen.kind)
  const actions: ReactNode =
    kind === 'list' && onCreate ? (
      <ActionButton theme={theme} onClick={onCreate} icon={<Plus aria-hidden className="size-3.5" />}>{text.create}</ActionButton>
    ) : kind === 'dashboard' ? (
      <span className="text-xs text-stone-500">{text.asOf(formatDate(new Date(context.today)))}</span>
    ) : null
  return (
    <div>
      <header className={cn('flex min-h-12 items-center gap-3 border-b border-stone-100', space.page.replace(/py-\S+/, 'py-3'))}>
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-stone-900">{screen.title}</h3>
        {actions}
      </header>
      <div className={space.page}>
        {kind === 'list' ? <ListPart part={design.lists[context.designEntity] ?? design.lists[context.entity.name]} context={context} onOpenRow={onOpenRow} /> : null}
        {kind === 'form' ? <FormPart part={design.forms[context.designEntity] ?? design.forms[context.entity.name]} context={context} /> : null}
        {kind === 'detail' ? <DetailScreen context={context} openedRow={openedRow} onEdit={onEdit} /> : null}
        {kind === 'board' ? <BoardScreen context={context} onOpenRow={onOpenRow} /> : null}
        {kind === 'master' ? <MasterScreen context={context} /> : null}
        {kind === 'dashboard' ? (design.dashboard.state === 'ok' ? <DashboardScreen cards={design.dashboard.value} context={context} onOpenRow={onOpenRow} /> : <UnavailablePart reason="broken" />) : null}
      </div>
    </div>
  )
}

/** A list screen: the entity's list design, or its records as a plain table when the design has none. */
function ListPart({ part, context, onOpenRow }: { part: DesignPart<ListDesign> | undefined; context: Context; onOpenRow?: (row: Row) => void }) {
  if (!part) return <MasterScreen context={context} />
  if (part.state === 'broken') return <UnavailablePart reason="broken" />
  const layout = knownValue(part.value.layout)
  return layout ? <ListScreen list={part.value} layout={layout} context={context} onOpenRow={onOpenRow} /> : <UnavailablePart reason="unsupported" />
}

/** A form screen: the entity's form design, or every field when the design has none. */
function FormPart({ part, context }: { part: DesignPart<FormDesign> | undefined; context: Context }) {
  if (part?.state === 'broken') return <UnavailablePart reason="broken" />
  return <FormScreen form={partValue(part)} context={context} />
}

function ActionButton({ theme, onClick, icon, children, tone = 'solid' }: { theme: Theme; onClick?: () => void; icon?: ReactNode; children: ReactNode; tone?: 'solid' | 'plain' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium shadow-xs transition-colors', tone === 'solid' ? theme.solid : 'bg-white text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50')}
    >
      {icon}
      {children}
    </button>
  )
}

function Pill({ value, tone }: { value: string; tone: Tone }) {
  return (
    <span data-pill={value} className={cn('inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset', tone.pill)}>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current opacity-60" />
      <span className="truncate">{value}</span>
    </span>
  )
}

function PersonChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-stone-200 text-[10px] font-semibold text-stone-600">{[...name][0]}</span>
      {name}
    </span>
  )
}

/** One value as the built app would show it in a table cell, card or detail; a field of an unknown kind shows the plain cell text. */
function Value({ name, row, context, colorField, wrap = false }: { name: string; row: Row; context: Context; colorField?: string; wrap?: boolean }) {
  const field = context.fields.get(name)
  const value = row.values[name]
  const shown = display(value, field)
  if (!shown) return <span className="text-stone-300">{text.empty}</span>
  if (name === colorField) return <Pill value={shown} tone={toneOf(shown, field, context.entity)} />
  switch (knownValue(field?.kind)) {
    case 'id':
      return <span className="whitespace-nowrap text-stone-500 tabular-nums">{shown}</span>
    case 'person':
      return <PersonChip name={shown} />
    case 'reference': {
      const label = field?.referenceEntity ? context.masterLabels.get(field.referenceEntity)?.get(shown) : undefined
      return (
        <span className={cn(!wrap && 'whitespace-nowrap', context.theme.text)} title={label || undefined}>
          {shown}
          {wrap && label ? <span className="ml-1.5 text-stone-500">{label}</span> : null}
        </span>
      )
    }
    case 'attachment':
      return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-stone-600">
          <Paperclip aria-hidden className="size-3.5 text-stone-400" />
          {shown}
        </span>
      )
    case 'boolean':
      return <span className="text-stone-700">{shown}</span>
    case 'date': {
      const late = name === context.deadline ? overdueDays(row, context) : 0
      return late ? (
        <span className="inline-flex items-center gap-1 font-medium whitespace-nowrap text-rose-700" title={text.overdueSince(late)}>
          <AlertCircle aria-hidden className="size-3.5" />
          {shown}
        </span>
      ) : (
        <span className="whitespace-nowrap tabular-nums">{shown}</span>
      )
    }
    case 'number':
    case 'formula':
      return <span className="tabular-nums">{shown}</span>
    case 'longText':
      return <span className={wrap ? 'whitespace-pre-wrap' : 'line-clamp-1'}>{shown}</span>
    default:
      return <span className={wrap ? undefined : 'whitespace-nowrap'}>{shown}</span>
  }
}

const isNumeric = (field: PlannedField | undefined) => isOneOf(field?.kind, 'number')

function ListScreen({ list, layout, context, onOpenRow }: { list: ListDesign; layout: ListLayout; context: Context; onOpenRow?: (row: Row) => void }) {
  const { fields, space, theme } = context
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const columns = list.columns.filter((name) => fields.has(name))
  const groupField = list.groupBy ? fields.get(list.groupBy) : undefined
  const filtered = sortRows(context.rows, list.sortBy ? fields.get(list.sortBy) : undefined).filter((row) => {
    for (const [name, value] of Object.entries(filters)) if (value && cellText(row.values[name]) !== value) return false
    if (!query.trim()) return true
    const needle = query.trim().toLowerCase()
    return Object.entries(row.values).some(([name, value]) => display(value, fields.get(name)).toLowerCase().includes(needle))
  })
  const groupOrder = valuesOf(groupField, context.rows)
  const ordered = groupField ? [...filtered].sort((a, b) => groupOrder.indexOf(cellText(a.values[groupField.name])) - groupOrder.indexOf(cellText(b.values[groupField.name]))) : filtered
  const shown = ordered.slice(0, MAX_ROWS)
  const groups: { key: string; rows: Row[] }[] = []
  for (const row of shown) {
    const key = groupField ? cellText(row.values[groupField.name]) : ''
    const last = groups.at(-1)
    if (last && last.key === key) last.rows.push(row)
    else groups.push({ key, rows: [row] })
  }
  const groupSize = (key: string) => (groupField ? filtered.filter((row) => cellText(row.values[groupField.name]) === key).length : 0)
  const groupLabel = (key: string) => (
    <span className="flex items-center gap-2">
      {groupField && key ? (list.colorField === groupField.name ? <Pill value={key} tone={toneOf(key, groupField, context.entity)} /> : <span className="font-semibold text-stone-800">{key}</span>) : <span className="text-stone-400">{text.empty}</span>}
      <span className="text-xs text-stone-500">{text.groupCount(groupSize(key))}</span>
    </span>
  )

  return (
    <div data-layout={layout} className={cn('flex flex-col', space.gap)}>
      {list.searchable || list.filters.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {list.searchable ? (
            <label className="relative min-w-40 flex-1">
              <span className="sr-only">{text.search}</span>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-stone-400" />
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.search} className={cn('w-full rounded-md border border-stone-300 bg-white py-1.5 pr-2.5 pl-8 text-[13px] text-stone-900 placeholder:text-stone-400 focus:ring-2 focus:outline-none', theme.focus)} />
            </label>
          ) : null}
          {list.filters.map((name) => {
            const field = fields.get(name)
            if (!field) return null
            const selected = filters[name] ?? ''
            return (
              <label key={name} className="relative inline-flex">
                <span className="sr-only">{name}</span>
                <select
                  value={selected}
                  data-testid={`excel2app-ui-preview-filter-${name}`}
                  onChange={(event) => setFilters((current) => ({ ...current, [name]: event.target.value }))}
                  className={cn('appearance-none rounded-full py-1 pr-7 pl-3 text-xs font-medium ring-1 ring-inset focus:ring-2 focus:outline-none', selected ? theme.soft : 'bg-white text-stone-600 ring-stone-300 hover:bg-stone-50', theme.focus)}
                >
                  <option value="">{text.filterAll(name)}</option>
                  {valuesOf(field, context.rows).map((value) => (
                    <option key={value} value={value}>{text.filterValue(name, value)}</option>
                  ))}
                </select>
                <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-stone-400" />
              </label>
            )
          })}
        </div>
      ) : null}
      {context.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 px-4 py-8 text-center text-stone-500">{text.noRows}</p>
      ) : shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 px-4 py-8 text-center text-stone-500">{text.noMatch}</p>
      ) : layout === 'cards' ? (
        <div className={cn('flex flex-col', space.gap)}>
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-2">
              {groupField ? <h4 className="text-[13px]">{groupLabel(group.key)}</h4> : null}
              <ul className={cn('grid @lg:grid-cols-2', space.gap === 'gap-4' ? 'gap-3' : 'gap-2')}>
                {group.rows.map((row) => (
                  <li key={row.key}>
                    <RecordCard row={row} context={context} fields={columns} colorField={list.colorField} onOpen={onOpenRow} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200">
          <table className="w-full text-left">
            <thead className="border-b border-stone-200 bg-stone-50 text-xs text-stone-500">
              <tr>
                {columns.map((name) => (
                  <th key={name} scope="col" className={cn('font-medium whitespace-nowrap', space.head, isNumeric(fields.get(name)) && 'text-right')}>{name}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {groups.map((group) => (
                <Fragment key={group.key}>
                  {groupField ? (
                    <tr className="bg-stone-50/70">
                      <th scope="colgroup" colSpan={columns.length} className={cn('text-left font-normal', space.head)}>{groupLabel(group.key)}</th>
                    </tr>
                  ) : null}
                  {group.rows.map((row) => (
                    <tr key={row.key} onClick={onOpenRow ? () => onOpenRow(row) : undefined} className={cn('text-stone-800', onOpenRow && 'cursor-pointer hover:bg-stone-50')}>
                      {columns.map((name, position) => (
                        <td key={name} className={cn('max-w-64 align-middle', space.cell, isNumeric(fields.get(name)) && 'text-right')}>
                          {position === 0 && onOpenRow ? (
                            <button type="button" onClick={(event) => { event.stopPropagation(); onOpenRow(row) }} aria-label={text.open(cellText(row.values[context.titleField ?? name]) || name)} className="text-left">
                              <Value name={name} row={row} context={context} colorField={list.colorField} />
                            </button>
                          ) : (
                            <Value name={name} row={row} context={context} colorField={list.colorField} />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {context.rows.length ? <p className="text-xs text-stone-500">{text.shown(shown.length, filtered.length)}</p> : null}
    </div>
  )
}

function RecordCard({ row, context, fields, colorField, onOpen, compact = false }: { row: Row; context: Context; fields: string[]; colorField?: string; onOpen?: (row: Row) => void; compact?: boolean }) {
  const { idField, titleField } = context
  const title = titleField ? display(row.values[titleField], context.fields.get(titleField)) : ''
  const status = colorField && fields.includes(colorField) ? colorField : undefined
  const rest = fields.filter((name) => name !== idField && name !== titleField && name !== status).slice(0, compact ? 2 : 4)
  const body = (
    <>
      <span className="flex items-center gap-2">
        {idField ? <span className="text-xs text-stone-400 tabular-nums">#{cellText(row.values[idField])}</span> : null}
        {status ? <span className="ml-auto"><Value name={status} row={row} context={context} colorField={status} /></span> : null}
      </span>
      <span className="line-clamp-2 font-medium text-stone-900">{title || text.empty}</span>
      {rest.length ? (
        <span className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs', compact && 'justify-between')}>
          {rest.map((name) => (
            <span key={name} className="flex min-w-0 items-center gap-1.5">
              {compact ? null : <span className="shrink-0 text-stone-400">{name}</span>}
              <span className="min-w-0 truncate text-stone-700"><Value name={name} row={row} context={context} colorField={colorField} /></span>
            </span>
          ))}
        </span>
      ) : null}
    </>
  )
  const classes = cn('flex w-full flex-col gap-1.5 rounded-lg border border-stone-200 bg-white text-left shadow-xs', compact ? 'p-2.5' : context.space.card)
  return onOpen ? (
    <button type="button" onClick={() => onOpen(row)} aria-label={text.open(title || cellText(row.values[idField ?? '']))} className={cn(classes, 'transition hover:border-stone-300 hover:shadow-sm')}>{body}</button>
  ) : (
    <div className={classes}>{body}</div>
  )
}

function FormScreen({ form, context }: { form: FormDesign | undefined; context: Context }) {
  const { fields, theme, space } = context
  const id = useId()
  const names = (form?.fields ?? context.entity.fields.map((field) => field.name)).filter((name) => fields.has(name))
  const required = new Set(form?.required ?? [])
  const twoColumns = form?.twoColumns ?? true
  const sample = (name: string) => context.rows.map((row) => display(row.values[name], fields.get(name))).find(Boolean)
  const input = cn('w-full rounded-md border border-stone-300 bg-white px-2.5 text-[13px] text-stone-900 shadow-xs placeholder:text-stone-400 focus:ring-2 focus:outline-none', space.input, theme.focus)

  const control = (field: PlannedField, controlId: string) => {
    const example = sample(field.name)
    const isRequired = required.has(field.name)
    switch (knownValue(field.kind)) {
      case undefined:
        // A field of a kind this console does not know gets no guessed input.
        return <span id={controlId} data-testid="excel2app-ui-preview-unsupported-field" className="flex items-center gap-2 rounded-md border border-dashed border-stone-300 bg-stone-50 px-2.5 py-2 text-xs text-stone-600"><CircleDashed aria-hidden className="size-3.5 shrink-0 text-stone-400" />{text.unsupported}</span>
      case 'date':
        return <input id={controlId} type="date" required={isRequired} className={input} />
      case 'choice':
      case 'reference': {
        const labels = isOneOf(field.kind, 'reference') && field.referenceEntity ? context.masterLabels.get(field.referenceEntity) : undefined
        const options = labels ? [...labels] : valuesOf(field, context.rows).map((value): [string, string] => [value, ''])
        return (
          <span className="relative block">
            <select id={controlId} required={isRequired} defaultValue="" className={cn(input, 'appearance-none pr-8')}>
              <option value="" disabled>{text.choose}</option>
              {options.map(([key, label]) => <option key={key} value={key}>{label ? `${key} — ${label}` : key}</option>)}
            </select>
            <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-stone-400" />
          </span>
        )
      }
      case 'number':
        return <input id={controlId} type="number" inputMode="decimal" required={isRequired} placeholder={example ? text.example(example) : undefined} className={cn(input, 'tabular-nums')} />
      case 'longText':
        return <textarea id={controlId} rows={3} required={isRequired} placeholder={example ? text.example(example) : undefined} className={cn(input, 'resize-y leading-relaxed')} />
      case 'person':
        return (
          <span className="relative block">
            <User aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-stone-400" />
            <input id={controlId} type="text" list={`${controlId}-people`} required={isRequired} placeholder={text.personPlaceholder} className={cn(input, 'pl-8')} />
            <datalist id={`${controlId}-people`}>{valuesOf(field, context.rows).map((value) => <option key={value} value={value} />)}</datalist>
          </span>
        )
      case 'attachment':
        return (
          <span className="flex items-center gap-3 rounded-md border border-dashed border-stone-300 bg-stone-50 px-3 py-3 text-stone-500">
            <Upload aria-hidden className="size-4 shrink-0 text-stone-400" />
            <span className="flex flex-col">
              <span className={cn('font-medium', theme.text)}>{text.attach(field.name)}</span>
              <span className="text-xs">{text.attachHint}</span>
            </span>
            <input id={controlId} type="file" required={isRequired} className="sr-only" />
          </span>
        )
      case 'boolean':
        return (
          <span className="flex items-center gap-2 py-1">
            <input id={controlId} type="checkbox" className="size-4 rounded border-stone-300" />
            <span className="text-stone-600">{text.yes}</span>
          </span>
        )
      case 'id':
      case 'formula':
        return <input id={controlId} type="text" readOnly tabIndex={-1} value={isOneOf(field.kind, 'id') ? text.autoNumber : text.computed} className={cn(input, 'bg-stone-50 text-stone-500 shadow-none')} />
      default:
        return <input id={controlId} type="text" required={isRequired} placeholder={example ? text.example(example) : undefined} className={input} />
    }
  }

  return (
    <form onSubmit={(event) => event.preventDefault()} noValidate className={cn('flex flex-col', space.gap, !twoColumns && 'max-w-md')}>
      <div className={cn('grid', space.gap, twoColumns && '@lg:grid-cols-2')}>
        {names.map((name, position) => {
          const field = fields.get(name)
          if (!field) return null
          const controlId = `${id}-${position}`
          const attachment = isOneOf(field.kind, 'attachment')
          const wide = attachment || isOneOf(field.kind, 'longText')
          const Wrapper = attachment ? 'label' : 'div'
          return (
            <Wrapper key={name} htmlFor={attachment ? controlId : undefined} data-field={name} className={cn('flex flex-col gap-1', wide && twoColumns && '@lg:col-span-2', attachment && 'cursor-pointer')}>
              {attachment ? (
                <span className="font-medium text-stone-800">{name}{required.has(name) ? <RequiredMark /> : null}</span>
              ) : (
                <label htmlFor={controlId} className="font-medium text-stone-800">{name}{required.has(name) ? <RequiredMark /> : null}</label>
              )}
              {control(field, controlId)}
            </Wrapper>
          )
        })}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-stone-100 pt-4">
        <ActionButton theme={theme} tone="plain">{text.cancel}</ActionButton>
        <ActionButton theme={theme} icon={<Check aria-hidden className="size-3.5" />}>{text.save}</ActionButton>
      </div>
    </form>
  )
}

function RequiredMark() {
  return (
    <>
      <span aria-hidden className="ml-0.5 text-rose-600">*</span>
      <span className="sr-only">{`（${text.required}）`}</span>
    </>
  )
}

/** The row opened from a list, board or dashboard; otherwise the workbook's first row. */
function DetailScreen({ context, openedRow, onEdit }: { context: Context; openedRow?: number; onEdit?: () => void }) {
  const { entity, fields, theme, space, idField, titleField } = context
  const row = context.rows.find((item) => item.index === openedRow) ?? context.rows[0]
  if (!row) return <p className="text-stone-500">{text.noRows}</p>
  const workflow = entity.workflow
  const status = workflow ? cellText(row.values[workflow.column]) : ''
  const stage = workflow ? workflow.stages.indexOf(status) : -1
  const shownFields = entity.fields.filter((field) => field.name !== titleField && field.name !== idField && field.name !== workflow?.column)
  const short = shownFields.filter((field) => !isOneOf(field.kind, 'longText', 'attachment'))
  const long = shownFields.filter((field) => isOneOf(field.kind, 'longText'))
  const files = shownFields.filter((field) => isOneOf(field.kind, 'attachment'))
  return (
    <article className={cn('flex flex-col', space.gap)}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-xs text-stone-500">
            {idField ? <span className="tabular-nums">#{cellText(row.values[idField])}</span> : null}
            {workflow && status ? <Pill value={status} tone={toneOf(status, fields.get(workflow.column), entity)} /> : null}
          </p>
          <h4 className="mt-1 text-[15px] leading-snug font-semibold text-stone-900">{titleField ? display(row.values[titleField], fields.get(titleField)) || text.empty : text.empty}</h4>
        </div>
        {onEdit ? <ActionButton theme={theme} tone="plain" onClick={onEdit} icon={<Pencil aria-hidden className="size-3.5" />}>{text.edit}</ActionButton> : null}
      </div>
      {workflow ? (
        <ol aria-label={text.progress} className="flex items-center gap-1.5 overflow-x-auto">
          {workflow.stages.map((name, position) => {
            const reached = stage >= 0 && position <= stage
            return (
              <li key={name} aria-current={position === stage ? 'step' : undefined} className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold', reached ? theme.solid : 'bg-stone-100 text-stone-400 ring-1 ring-stone-200')}>{reached && position < stage ? <Check aria-hidden className="size-3" /> : position + 1}</span>
                <span className={cn('truncate text-xs', position === stage ? 'font-semibold text-stone-900' : reached ? 'text-stone-600' : 'text-stone-400')}>{name}</span>
                {position < workflow.stages.length - 1 ? <span aria-hidden className={cn('h-px min-w-3 flex-1', position < stage ? theme.bar : 'bg-stone-200')} /> : null}
              </li>
            )
          })}
        </ol>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-stone-200">
        <dl className="-mb-px grid grid-cols-1 @md:grid-cols-2">
          {short.map((field) => (
            <div key={field.name} className={cn('flex min-w-0 items-center gap-3 border-b border-stone-100', space.cell)}>
              <dt className="w-24 shrink-0 text-stone-500">{field.name}</dt>
              <dd className="min-w-0 text-stone-900"><Value name={field.name} row={row} context={context} wrap /></dd>
            </div>
          ))}
        </dl>
      </div>
      {long.map((field) => (
        <section key={field.name} className="flex flex-col gap-1">
          <h5 className="text-xs font-medium text-stone-500">{field.name}</h5>
          <p className="rounded-lg bg-stone-50 px-3 py-2.5 leading-relaxed whitespace-pre-wrap text-stone-800">{display(row.values[field.name], field) || text.empty}</p>
        </section>
      ))}
      {files.map((field) => {
        const name = display(row.values[field.name], field)
        return (
          <section key={field.name} className="flex flex-col gap-1">
            <h5 className="text-xs font-medium text-stone-500">{field.name}</h5>
            {name ? (
              <span className="flex w-fit items-center gap-3 rounded-lg border border-stone-200 p-2 pr-4">
                <span aria-hidden className="flex size-12 items-center justify-center rounded-md bg-stone-100 text-stone-400"><Image className="size-5" /></span>
                <span className="text-stone-700">{name}</span>
              </span>
            ) : (
              <span className="text-stone-300">{text.empty}</span>
            )}
          </section>
        )
      })}
    </article>
  )
}

function BoardScreen({ context, onOpenRow }: { context: Context; onOpenRow?: (row: Row) => void }) {
  const { entity, fields, space } = context
  const workflow = entity.workflow
  if (!workflow) return <p className="text-stone-500">{text.noRows}</p>
  const field = fields.get(workflow.column)
  const cardFields = [context.titleField, context.idField, entity.fields.find((item) => isOneOf(item.kind, 'person'))?.name, context.deadline].filter((name): name is string => Boolean(name))
  const deadlineField = context.deadline ? fields.get(context.deadline) : undefined
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <ol className={cn('grid auto-cols-[minmax(11rem,1fr)] grid-flow-col', space.gap === 'gap-4' ? 'gap-3' : 'gap-2')}>
        {workflow.stages.map((stage) => {
          const rows = sortRows(context.rows.filter((row) => cellText(row.values[workflow.column]) === stage), deadlineField).reverse()
          return (
            <li key={stage} data-stage={stage} className="flex flex-col gap-2 rounded-lg bg-stone-100/70 p-2">
              <h4 className="flex items-center gap-2 px-0.5">
                <Pill value={stage} tone={toneOf(stage, field, entity)} />
                <span className="text-xs text-stone-500 tabular-nums">{rows.length}</span>
              </h4>
              {rows.length === 0 ? <p className="rounded-md border border-dashed border-stone-300 px-2 py-4 text-center text-xs text-stone-400">{text.emptyColumn}</p> : null}
              <ul className="flex flex-col gap-2">
                {rows.slice(0, MAX_BOARD_CARDS).map((row) => (
                  <li key={row.key}>
                    <RecordCard row={row} context={context} fields={cardFields} onOpen={onOpenRow} compact />
                  </li>
                ))}
              </ul>
              {rows.length > MAX_BOARD_CARDS ? <p className="px-1 text-xs text-stone-500">{text.moreCards(rows.length - MAX_BOARD_CARDS)}</p> : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function MasterScreen({ context }: { context: Context }) {
  const { entity, space } = context
  const shown = context.rows.slice(0, MAX_ROWS)
  if (context.rows.length === 0) return <p className="rounded-lg border border-dashed border-stone-300 px-4 py-8 text-center text-stone-500">{text.noRows}</p>
  return (
    <div className={cn('flex flex-col', space.gap)}>
      <div className="overflow-x-auto rounded-lg border border-stone-200">
        <table className="w-full text-left">
          <thead className="border-b border-stone-200 bg-stone-50 text-xs text-stone-500">
            <tr>
              {entity.fields.map((field) => <th key={field.name} scope="col" className={cn('font-medium whitespace-nowrap', space.head, isNumeric(field) && 'text-right')}>{field.name}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {shown.map((row) => (
              <tr key={row.key} className="text-stone-800">
                {entity.fields.map((field, position) => (
                  <td key={field.name} className={cn(space.cell, isNumeric(field) && 'text-right', position === 0 && 'font-medium')}>
                    <Value name={field.name} row={row} context={context} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-500">{text.shown(shown.length, context.rows.length)}</p>
    </div>
  )
}

function DashboardScreen({ cards, context, onOpenRow }: { cards: DashboardCard[]; context: Context; onOpenRow?: (row: Row) => void }) {
  const { space } = context
  if (cards.length === 0) return <p className="rounded-lg border border-dashed border-stone-300 px-4 py-8 text-center text-stone-500">{text.noCards}</p>
  return (
    <ul className={cn('grid @md:grid-cols-2 @2xl:grid-cols-3', space.gap === 'gap-4' ? 'gap-3' : 'gap-2')}>
      {cards.map((card) => (
        <li key={card.id} data-card={knownValue(card.kind) ?? 'unsupported'} className={cn('flex flex-col gap-2 rounded-lg border border-stone-200 bg-white shadow-xs', space.card, isOneOf(card.kind, 'countBy') && '@2xl:col-span-2')}>
          <h4 className="text-xs font-medium text-stone-500">{card.title}</h4>
          <DashboardCardBody card={card} context={context} onOpenRow={onOpenRow} />
        </li>
      ))}
    </ul>
  )
}

function BigNumber({ value, unit, tone }: { value: string; unit?: string; tone?: string }) {
  return (
    <p className={cn('flex items-baseline gap-1', tone ?? 'text-stone-900')}>
      <span className="text-[26px] leading-none font-semibold tabular-nums">{value}</span>
      {unit ? <span className="text-xs text-stone-500">{unit}</span> : null}
    </p>
  )
}

function DashboardCardBody({ card, context, onOpenRow }: { card: DashboardCard; context: Context; onOpenRow?: (row: Row) => void }) {
  const { rows, fields, entity, theme } = context
  const field = card.field ? fields.get(card.field) : undefined
  switch (knownValue(card.kind)) {
    case undefined:
      return <p data-testid="excel2app-ui-preview-unsupported" className="text-xs text-stone-500">{text.unsupported}</p>
    case 'count': {
      const status = entity.workflow?.column
      const open = status ? rows.filter((row) => !context.done.has(cellText(row.values[status]))).length : undefined
      return (
        <>
          <BigNumber value={formatNumber(rows.length)} unit={text.countUnit} />
          {open !== undefined && rows.length ? (
            <div className="flex flex-col gap-1">
              <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-stone-100">
                <div className={cn('h-full rounded-full', theme.bar)} style={{ width: `${((rows.length - open) / rows.length) * 100}%` }} />
              </div>
              <p className="text-xs text-stone-500">{text.doneOf(rows.length - open, rows.length)}</p>
            </div>
          ) : null}
        </>
      )
    }
    case 'countBy': {
      const values = valuesOf(field, rows)
      const counts = values.map((value) => ({ value, count: rows.filter((row) => cellText(row.values[card.field ?? '']) === value).length }))
      const max = Math.max(1, ...counts.map((item) => item.count))
      return (
        <ul className="flex flex-col gap-1.5">
          {counts.map(({ value, count }) => (
            <li key={value} data-count={count} className="grid grid-cols-[6.5rem_1fr_2rem] items-center gap-2">
              <span className="truncate text-stone-700">{value}</span>
              <span aria-hidden className="h-2 overflow-hidden rounded-full bg-stone-100">
                <span className={cn('block h-full rounded-full', entity.workflow?.column === card.field ? toneOf(value, field, entity).bar : theme.bar)} style={{ width: `${(count / max) * 100}%` }} />
              </span>
              <span className="text-right font-medium text-stone-900 tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
      )
    }
    case 'sum': {
      const total = rows.reduce((sum, row) => sum + (numberOf(row.values[card.field ?? '']) ?? 0), 0)
      return (
        <>
          <BigNumber value={formatNumber(total)} unit={UNIT.exec(card.field ?? '')?.[1]} />
          <p className="text-xs text-stone-500">{text.sumOf(rows.length)}</p>
        </>
      )
    }
    case 'overdue': {
      const late = rows.map((row) => ({ row, days: overdueDays(row, context, card.field) })).filter((item) => item.days > 0).sort((a, b) => b.days - a.days)
      return (
        <>
          <BigNumber value={formatNumber(late.length)} unit={text.countUnit} tone={late.length ? 'text-rose-700' : undefined} />
          {late.length === 0 ? (
            <p className="text-xs text-stone-500">{text.overdueNone}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-stone-100">
              {late.slice(0, MAX_OVERDUE_ITEMS).map(({ row, days }) => {
                const title = context.titleField ? display(row.values[context.titleField], fields.get(context.titleField)) : ''
                const label = (
                  <>
                    <span className="min-w-0 flex-1 truncate text-stone-700">{title}</span>
                    <span className="shrink-0 text-xs font-medium text-rose-700">{text.overdueSince(days)}</span>
                  </>
                )
                return (
                  <li key={row.key}>
                    {onOpenRow ? (
                      <button type="button" onClick={() => onOpenRow(row)} className="flex w-full items-center gap-2 py-1 text-left hover:underline">{label}</button>
                    ) : (
                      <span className="flex items-center gap-2 py-1">{label}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )
    }
  }
}
