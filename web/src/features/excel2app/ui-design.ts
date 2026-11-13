// The UI design of the planned app: what the preview step renders and what the
// user changes by talking to the assistant. Derived from an AppPlan; serialized
// into the specification as its final section before the build starts.
// Pure data + pure derivations; `ui-assistant.ts` changes a complete design
// from instructions, `ui-preview.tsx` renders a read one (`uiDesignOf`).
import { isOneOf, knownValue } from '../../model/contracts/build'
import { partValue, uiDesignOf, type CompleteCard, type CompleteForm, type CompleteList, type CompleteUiDesign, type ScreenKind, type UiDesign } from '../../model/contracts/excel'
import { textJa } from './copy'
import type { AppPlan, PlannedEntity } from './model'

/** One screen's id: `${kind}:${entity}`, stable across edits. */
export const screenId = (kind: ScreenKind, entity: string) => `${kind}:${entity}`

const mainEntity = (plan: AppPlan): PlannedEntity | undefined => plan.entities.find((entity) => isOneOf(entity.kind, 'records'))

/** The preview the user sees before changing anything: everything the plan found, sensible defaults. */
export function defaultUiDesign(plan: AppPlan): CompleteUiDesign {
  const lists: Record<string, CompleteList> = {}
  const forms: Record<string, CompleteForm> = {}
  for (const entity of plan.entities) {
    if (!isOneOf(entity.kind, 'records')) continue
    const status = entity.workflow?.column
    const dateField = entity.fields.find((field) => isOneOf(field.kind, 'date'))?.name
    // Keep the status and deadline columns even on wide sheets: the list is read by state and due date.
    const deadline = entity.fields.find((field) => isOneOf(field.kind, 'date') && /期限|予定|納期/.test(field.name))?.name
    const pinned = [status, deadline].filter((name): name is string => Boolean(name))
    const rest = entity.fields.filter((field) => !isOneOf(field.kind, 'longText', 'attachment') && !pinned.includes(field.name)).map((field) => field.name)
    const columns = rest.slice(0, Math.max(0, 8 - pinned.length))
    for (const name of pinned) columns.splice(Math.min(columns.length, entity.fields.findIndex((field) => field.name === name)), 0, name)
    lists[entity.name] = {
      layout: 'table',
      columns,
      colorField: status,
      sortBy: dateField,
      searchable: true,
      filters: [status, ...entity.fields.filter((field) => isOneOf(field.kind, 'choice', 'reference', 'person')).map((field) => field.name)].filter((name): name is string => Boolean(name)).filter((name, index, all) => all.indexOf(name) === index).slice(0, 3),
    }
    forms[entity.name] = {
      // A field of a kind this console does not know is never offered as an input.
      fields: entity.fields.filter((field) => knownValue(field.kind) !== undefined && !isOneOf(field.kind, 'id', 'formula')).map((field) => field.name),
      required: entity.fields.filter((field) => isOneOf(field.kind, 'date', 'reference', 'choice')).map((field) => field.name).slice(0, 3),
      twoColumns: true,
    }
  }
  const main = mainEntity(plan)
  const cards: CompleteCard[] = []
  if (main) {
    cards.push({ id: 'count', title: `${main.name}の件数`, kind: 'count' })
    if (main.workflow) cards.push({ id: 'countBy', title: `${main.workflow.column}別`, kind: 'countBy', field: main.workflow.column })
    const amount = main.fields.find((field) => isOneOf(field.kind, 'number'))
    if (amount) cards.push({ id: 'sum', title: `${amount.name}の合計`, kind: 'sum', field: amount.name })
    const due = main.fields.find((field) => isOneOf(field.kind, 'date') && /期限|予定/.test(field.name))
    if (due) cards.push({ id: 'overdue', title: '期限切れ', kind: 'overdue', field: due.name })
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

/**
 * The `- ` decisions of a design, in the order the build receives them under
 * 「9. 画面の決定」. A decision that depends on a part this console cannot read
 * (an unknown accent, density or list layout, a broken list, form or dashboard)
 * is left out here; callers that write never get such a design (`CompleteUiDesign`).
 */
export function uiDecisionLines(design: UiDesign): string[] {
  const lines = [`- アプリ名: ${design.appName}`]
  const accent = knownValue(design.accent)
  const density = knownValue(design.density)
  if (accent && density) lines.push(`- 基調色: ${textJa.accent[accent]}、密度: ${density === 'compact' ? 'コンパクト' : 'ゆったり'}`)
  lines.push(`- 画面の順番: ${design.screens.filter((screen) => !screen.hidden).map((screen) => screen.title).join(' → ')}`)
  for (const screen of design.screens.filter((item) => item.hidden)) lines.push(`- 「${screen.title}」は作らない`)
  for (const [entity, part] of Object.entries(design.lists)) {
    const list = partValue(part)
    const layout = list && knownValue(list.layout)
    if (!list || !layout) continue
    lines.push(`- 「${entity}」の一覧: ${layout === 'cards' ? 'カード表示' : '表'}、列は ${list.columns.join('、')}${list.colorField ? `、「${list.colorField}」を色分け` : ''}${list.groupBy ? `、「${list.groupBy}」でグループ化` : ''}${list.sortBy ? `、「${list.sortBy}」順` : ''}${list.filters.length ? `、絞り込み: ${list.filters.join('・')}` : ''}${list.searchable ? '、検索あり' : ''}`)
  }
  for (const [entity, part] of Object.entries(design.forms)) {
    const form = partValue(part)
    if (form) lines.push(`- 「${entity}」の登録: 項目は ${form.fields.join('、')}${form.required.length ? `、必須: ${form.required.join('・')}` : ''}${form.twoColumns ? '、2 列レイアウト' : '、1 列レイアウト'}`)
  }
  const cards = partValue(design.dashboard)
  if (cards?.length) lines.push(`- ダッシュボード: ${cards.map((card) => card.title).join('、')}`)
  for (const note of design.notes) lines.push(`- ${note}`)
  return lines
}

/** `## 9. 画面の決定` for the specification handed to the build (complete designs only: nothing is left out). */
export function uiDecisionsMarkdown(design: CompleteUiDesign): string {
  return ['## 9. 画面の決定（UI プレビューで確認済み）', ...uiDecisionLines(uiDesignOf(design))].join('\n')
}
