// The UI design of the planned app: what the preview step renders and what the
// user changes by talking to the assistant. Derived from an AppPlan; serialized
// into the specification as its final section before the build starts.
// Pure data + pure derivations; `ui-assistant.ts` mutates it from instructions,
// `ui-preview.tsx` renders it.
import type { AppPlan, PlannedEntity, ScreenKind } from './model'

export type Accent = 'teal' | 'blue' | 'violet' | 'amber' | 'rose' | 'stone'
export type Density = 'comfortable' | 'compact'
export type ListLayout = 'table' | 'cards'

/** One screen of the preview; `id` is `${kind}:${entity}` and is stable across edits. */
export interface ScreenDesign {
  id: string
  kind: ScreenKind
  entity: string
  /** Shown in the preview's navigation; the user may rename it. */
  title: string
  /** Hidden screens stay in the plan but are not built. */
  hidden: boolean
}

export interface ListDesign {
  layout: ListLayout
  /** Field names in display order; fields not listed are hidden from the list. */
  columns: string[]
  /** Status/choice field whose values get colored pills; undefined = none. */
  colorField?: string
  /** Field to group rows by (choice/person/reference), undefined = flat. */
  groupBy?: string
  /** Field for default sort, newest first for dates. */
  sortBy?: string
  searchable: boolean
  filters: string[]
}

export interface FormDesign {
  /** Field names in order; fields not listed are not editable in the form. */
  fields: string[]
  /** Fields required on save. */
  required: string[]
  /** Two-column layout for short fields. */
  twoColumns: boolean
}

export interface DashboardCard {
  id: string
  title: string
  /** `count` of rows, `countBy` a choice field, `sum` of a number field, `overdue` deadlines. */
  kind: 'count' | 'countBy' | 'sum' | 'overdue'
  field?: string
}

export interface UiDesign {
  appName: string
  accent: Accent
  density: Density
  /** Screens in navigation order. */
  screens: ScreenDesign[]
  /** Per records entity. */
  lists: Record<string, ListDesign>
  forms: Record<string, FormDesign>
  dashboard: { cards: DashboardCard[] }
  /** Free-form decisions the assistant recorded that have no structured slot (e.g. 「印刷用レイアウト」). */
  notes: string[]
}

export const screenId = (kind: ScreenKind, entity: string) => `${kind}:${entity}`

const mainEntity = (plan: AppPlan): PlannedEntity | undefined => plan.entities.find((entity) => entity.kind === 'records')

/** The preview the user sees before changing anything: everything the plan found, sensible defaults. */
export function defaultUiDesign(plan: AppPlan): UiDesign {
  const lists: Record<string, ListDesign> = {}
  const forms: Record<string, FormDesign> = {}
  for (const entity of plan.entities) {
    if (entity.kind !== 'records') continue
    const status = entity.workflow?.column
    const dateField = entity.fields.find((field) => field.kind === 'date')?.name
    // Keep the status and deadline columns even on wide sheets: the list is read by state and due date.
    const deadline = entity.fields.find((field) => field.kind === 'date' && /期限|予定|納期/.test(field.name))?.name
    const pinned = [status, deadline].filter((name): name is string => Boolean(name))
    const rest = entity.fields.filter((field) => field.kind !== 'longText' && field.kind !== 'attachment' && !pinned.includes(field.name)).map((field) => field.name)
    const columns = rest.slice(0, Math.max(0, 8 - pinned.length))
    for (const name of pinned) columns.splice(Math.min(columns.length, entity.fields.findIndex((field) => field.name === name)), 0, name)
    lists[entity.name] = {
      layout: 'table',
      columns,
      colorField: status,
      sortBy: dateField,
      searchable: true,
      filters: [status, ...entity.fields.filter((field) => field.kind === 'choice' || field.kind === 'reference' || field.kind === 'person').map((field) => field.name)].filter((name): name is string => Boolean(name)).filter((name, index, all) => all.indexOf(name) === index).slice(0, 3),
    }
    forms[entity.name] = {
      fields: entity.fields.filter((field) => field.kind !== 'id' && field.kind !== 'formula').map((field) => field.name),
      required: entity.fields.filter((field) => field.kind === 'date' || field.kind === 'reference' || field.kind === 'choice').map((field) => field.name).slice(0, 3),
      twoColumns: true,
    }
  }
  const main = mainEntity(plan)
  const cards: DashboardCard[] = []
  if (main) {
    cards.push({ id: 'count', title: `${main.name}の件数`, kind: 'count' })
    if (main.workflow) cards.push({ id: 'countBy', title: `${main.workflow.column}別`, kind: 'countBy', field: main.workflow.column })
    const amount = main.fields.find((field) => field.kind === 'number')
    if (amount) cards.push({ id: 'sum', title: `${amount.name}の合計`, kind: 'sum', field: amount.name })
    if (main.fields.some((field) => field.kind === 'date' && /期限|予定/.test(field.name))) cards.push({ id: 'overdue', title: '期限切れ', kind: 'overdue', field: main.fields.find((field) => field.kind === 'date' && /期限|予定/.test(field.name))?.name })
  }
  const screenTitles: Record<ScreenKind, (entity: string) => string> = {
    list: (entity) => `${entity}`,
    form: (entity) => `${entity}の登録`,
    detail: (entity) => `${entity}の詳細`,
    board: () => '進捗ボード',
    master: (entity) => entity,
    dashboard: () => 'ダッシュボード',
  }
  const ordered = [...plan.screens].sort((a, b) => (a.kind === 'dashboard' ? -1 : b.kind === 'dashboard' ? 1 : 0))
  return {
    appName: plan.name,
    accent: 'teal',
    density: 'comfortable',
    screens: ordered.map((screen) => ({ id: screenId(screen.kind, screen.entity), kind: screen.kind, entity: screen.entity, title: screenTitles[screen.kind](screen.entity), hidden: false })),
    lists,
    forms,
    dashboard: { cards },
    notes: [],
  }
}

export const ACCENT_LABEL_JA: Record<Accent, string> = { teal: '緑', blue: '青', violet: '紫', amber: '琥珀', rose: '赤', stone: 'グレー' }

/** `## 9. 画面の決定` for the specification handed to the build. */
export function uiDecisionsMarkdown(design: UiDesign): string {
  const lines = ['## 9. 画面の決定（UI プレビューで確認済み）', `- アプリ名: ${design.appName}`, `- 基調色: ${ACCENT_LABEL_JA[design.accent]}、密度: ${design.density === 'compact' ? 'コンパクト' : 'ゆったり'}`]
  lines.push(`- 画面の順番: ${design.screens.filter((screen) => !screen.hidden).map((screen) => screen.title).join(' → ')}`)
  for (const screen of design.screens.filter((item) => item.hidden)) lines.push(`- 「${screen.title}」は作らない`)
  for (const [entity, list] of Object.entries(design.lists)) {
    lines.push(`- 「${entity}」の一覧: ${list.layout === 'cards' ? 'カード表示' : '表'}、列は ${list.columns.join('、')}${list.colorField ? `、「${list.colorField}」を色分け` : ''}${list.groupBy ? `、「${list.groupBy}」でグループ化` : ''}${list.sortBy ? `、「${list.sortBy}」順` : ''}${list.filters.length ? `、絞り込み: ${list.filters.join('・')}` : ''}${list.searchable ? '、検索あり' : ''}`)
  }
  for (const [entity, form] of Object.entries(design.forms)) {
    lines.push(`- 「${entity}」の登録: 項目は ${form.fields.join('、')}${form.required.length ? `、必須: ${form.required.join('・')}` : ''}${form.twoColumns ? '、2 列レイアウト' : '、1 列レイアウト'}`)
  }
  if (design.dashboard.cards.length) lines.push(`- ダッシュボード: ${design.dashboard.cards.map((card) => card.title).join('、')}`)
  for (const note of design.notes) lines.push(`- ${note}`)
  return lines.join('\n')
}
