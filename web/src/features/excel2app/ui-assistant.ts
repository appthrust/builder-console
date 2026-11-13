// Client-side UI decisions for the offline fallback and the mock runtime. It
// changes a complete design (every part known), so nothing it writes back can
// drop a part; plan fields of a kind this console does not know are never made
// editable inputs.
import { isOneOf, knownValue } from '../../model/contracts/build'
import type { Accent, CompleteCard, CompleteForm, CompleteList, CompleteScreen, CompleteUiDesign, ScreenKind } from '../../model/contracts/excel'
import { text } from './assistant-copy'
import type { AppPlan, PlannedEntity, PlannedField } from './model'
import { screenId } from './ui-design'

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s「」『』“”"'`]/g, '')
const removal = /いらない|要らない|不要|非表示|隠|削除|除外|外して|取り除|消して|しない|やめ|解除|無効|オフ|なし|無し|disable|remove|hide|without|\boff\b|don't/i
const addition = /追加|表示|戻|復活|見せ|有効|オン|付け|つけ|入れ|出して|show|add|restore|enable/i
const formWords = /フォーム|登録|入力|form/i
const listWords = /一覧|リスト|テーブル|list|table/i
const screenAliases: Record<ScreenKind, readonly string[]> = {
  list: ['一覧', 'リスト', 'list'], form: ['登録フォーム', '登録画面', 'フォーム', 'form'],
  detail: ['詳細画面', '詳細', 'detail'], board: ['進捗ボード', 'ボード', 'board'],
  master: ['マスタ', 'master'], dashboard: ['ダッシュボード', 'dashboard'],
}

function fieldAliases(field: PlannedField): string[] {
  const name = normalize(field.name)
  const stem = name.replace(/\([^)]*\)/g, '')
  const aliases = [name, stem]
  if (/担当者$/.test(stem)) aliases.push(stem.replace(/者$/, ''))
  if (/状態|ステータス/i.test(stem)) aliases.push('状態', 'ステータス', 'status')
  if (/写真/.test(stem)) aliases.push('写真', 'photo')
  return aliases
}

// Header normalization and unique stems let people use 「担当」 for 「担当者」
// or omit units, without inventing a new field or guessing between two headers.
function mentionedFields(entity: PlannedEntity | undefined, instruction: string): PlannedField[] {
  if (!entity) return []
  const source = normalize(instruction)
  const matches = entity.fields.flatMap((field) => {
    const name = normalize(field.name)
    const exact = fieldAliases(field).filter((alias) => alias.length > 0 && source.includes(alias))
    if (!exact.length) return []
    const alias = exact.sort((a, b) => b.length - a.length)[0]
    return [{ field, alias, index: source.indexOf(alias), exact: alias === name }]
  })
  return matches
    .filter((match) => !matches.some((other) => other !== match && other.index <= match.index && other.index + other.alias.length >= match.index + match.alias.length && other.alias.length > match.alias.length))
    .filter((match) => match.exact || matches.filter((other) => other.alias === match.alias).length === 1)
    .sort((a, b) => a.index - b.index)
    .map((match) => match.field)
}

function mentionedScreens(design: CompleteUiDesign, instruction: string, entity?: string): CompleteScreen[] {
  const source = normalize(instruction)
  return design.screens.flatMap((screen) => {
    const labels = [screen.title, ...(entity && screen.entity !== entity ? [] : screenAliases[screen.kind])]
    const matches = labels.map(normalize).filter((label) => label && source.includes(label))
    if (!matches.length) return []
    const label = matches.sort((a, b) => source.indexOf(a) - source.indexOf(b) || b.length - a.length)[0]
    return [{ screen, index: source.indexOf(label), length: label.length }]
  }).sort((a, b) => a.index - b.index || b.length - a.length).map(({ screen }) => screen)
}

/** Whether a form may offer the field as an input: ID and formula fields are computed, an unknown kind cannot be rendered. */
function editable(field: PlannedField): boolean {
  return knownValue(field.kind) !== undefined && !isOneOf(field.kind, 'id', 'formula')
}

interface Position {
  edge?: 'first' | 'last'
  index?: number
  relative?: string
  after?: boolean
  label: string
}

function requestedPosition(instruction: string, anchors: string[]): Position | undefined {
  const source = normalize(instruction)
  if (/先頭|最初|一番前|一番上|first|top/i.test(source)) return { edge: 'first', label: text.position.first }
  if (/最後|末尾|一番後|一番下|last|bottom/i.test(source)) return { edge: 'last', label: text.position.last }
  const numbered = source.match(/([1-9]\d*)番目|position([1-9]\d*)/)
  if (numbered) {
    const index = Number(numbered[1] ?? numbered[2]) - 1
    return { index, label: text.position.numbered(index + 1) }
  }
  for (const anchor of anchors) {
    const name = normalize(anchor)
    if (source.includes(`${name}の前`) || source.includes(`before${name}`)) return { relative: anchor, label: text.position.before(anchor) }
    if (source.includes(`${name}の後`) || source.includes(`after${name}`)) return { relative: anchor, after: true, label: text.position.after(anchor) }
  }
  return undefined
}

function moveName(names: string[], name: string, position: Position): string[] {
  const next = names.filter((item) => item !== name)
  const index = position.edge === 'first' ? 0 : position.edge === 'last' ? next.length : position.relative ? next.indexOf(position.relative) + (position.after ? 1 : 0) : position.index ?? 0
  next.splice(Math.max(0, Math.min(index, next.length)), 0, name)
  return next
}

function newName(value: string): string {
  const quoted = value.trim().match(/^[「“"'](.+?)[」”"']/)
  if (quoted) return quoted[1].trim()
  return value.replace(/(?:に(?:変更|改名|して|する|変えて)?(?:して)?(?:ください|下さい)?|と(?:呼んで|して)(?:ください)?)\s*[。.!！]?$/, '').trim()
}

function nextClause(design: CompleteUiDesign, plan: AppPlan, input: string): { clause: string; rest: string } {
  // Consume names and quoted labels before looking for joins. In particular,
  // punctuation and words such as "and" inside a header are data, not syntax.
  const names = [
    ...plan.entities.flatMap((entity) => [entity.name, ...entity.fields.flatMap((field) => [field.name, ...fieldAliases(field)])]),
    ...design.screens.flatMap((screen) => [screen.title, ...screenAliases[screen.kind]]),
  ]
  const protectedNames = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const quoted = '「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|(?<![a-z0-9])\'[^\'\\r\\n]*\''
  const separator = '[、。，,\\r\\n]+|それから|あと|\\b(?:and|then)\\b'
  // Keep the verb ending on its clause; do not cut polite request suffixes.
  const join = 'してから|して(?!ください|下さい|ほしい|欲しい|いただ|頂|もら|貰|い[るたてま]|お[くいて])|し(?=[、，,])'
  const tokens = new RegExp(`${protectedNames ? `${protectedNames}|` : ''}${quoted}|(?<separator>${separator})|(?<join>${join})`, 'gi')
  for (const match of input.matchAll(tokens)) {
    if (!match.groups?.separator && !match.groups?.join) continue
    const end = match.index + (match.groups.join ? match[0].replace(/から$/, '').length : 0)
    return { clause: input.slice(0, end).trim(), rest: input.slice(match.index + match[0].length).trim() }
  }
  return { clause: input.trim(), rest: '' }
}

/**
 * Client-side, deterministic UI decisions; no model call and no mutation of the
 * caller's design. Explicit list/column or form/field wording limits the scope;
 * a bare field applies to both. Removing a form field also removes requiredness.
 * Compound clauses run in order against the evolving design, with names protected
 * from splitting and negations confined to each clause. Replies share one message;
 * focus follows the last screen-targeting clause and changed is true if any changed.
 * Unsupported clauses stay in build notes; mixed replies identify each saved note
 * rather than claiming the whole preview is unchanged. No-ops keep undo history clean.
 */
export function applyInstruction(design: CompleteUiDesign, plan: AppPlan, instruction: string): { design: CompleteUiDesign; reply: string; changed: boolean; focusScreenId?: string } {
  let rest = instruction.trim()
  if (!rest) return { design: { ...design }, reply: text.reply.empty, changed: false }
  let next = design
  let changed = false
  let focusScreenId: string | undefined
  const results: { clause: string; reply: string; matched: boolean }[] = []
  while (rest) {
    const part = nextClause(next, plan, rest)
    rest = part.rest
    if (!part.clause) continue
    const result = applyClause(next, plan, part.clause)
    next = result.design
    changed ||= result.changed
    focusScreenId = result.focusScreenId ?? focusScreenId
    results.push({ clause: part.clause, reply: result.reply, matched: result.matched })
  }
  const matched = results.some((result) => result.matched)
  const reply = matched ? results.map((result) => result.matched ? result.reply : text.reply.noteClause(result.clause)).join('\n') : results.length ? text.reply.note : text.reply.empty
  return { design: next === design ? { ...design } : next, reply, changed, ...(focusScreenId ? { focusScreenId } : {}) }
}

interface ClauseResult {
  design: CompleteUiDesign
  reply: string
  changed: boolean
  focusScreenId?: string
  matched: boolean
}

function applyClause(design: CompleteUiDesign, plan: AppPlan, instruction: string): ClauseResult {
  const input = instruction.trim()
  const source = normalize(input)
  const records = plan.entities.filter((entity) => isOneOf(entity.kind, 'records'))
  const namedEntity = records.filter((entity) => source.includes(normalize(entity.name))).sort((a, b) => b.name.length - a.name.length)[0]
  const entity = namedEntity ?? records.find((candidate) => mentionedFields(candidate, input).length > 0) ?? records[0]
  const fields = mentionedFields(entity, input)
  const field = fields[0]
  const screens = mentionedScreens(design, input, entity?.name)
  const screen = screens[0]
  const list = entity ? design.lists[entity.name] : undefined
  const form = entity ? design.forms[entity.name] : undefined
  const removing = removal.test(input)

  const finish = (next: CompleteUiDesign, reply: string, changed: boolean, focusScreenId?: string) => ({ design: next, reply: changed ? reply : text.reply.unchanged(reply), changed, matched: true, ...(focusScreenId ? { focusScreenId } : {}) })
  const note = () => ({ design: { ...design, notes: [...design.notes, input] }, reply: text.reply.note, changed: true, matched: false })
  const updateList = (patch: Partial<CompleteList>, reply: string) => {
    if (!entity || !list) return note()
    const next = { ...list, ...patch }
    return finish({ ...design, lists: { ...design.lists, [entity.name]: next } }, reply, JSON.stringify(list) !== JSON.stringify(next), screenId('list', entity.name))
  }
  const updateForm = (patch: Partial<CompleteForm>, reply: string) => {
    if (!entity || !form) return note()
    const next = { ...form, ...patch }
    return finish({ ...design, forms: { ...design.forms, [entity.name]: next } }, reply, JSON.stringify(form) !== JSON.stringify(next), screenId('form', entity.name))
  }

  // Names are parsed first so a requested name such as 「青いカード」 is data.
  const appRename = input.match(/(?:アプリ名|アプリの名前)\s*(?:を|は|[:：])\s*(.+)$/i) ?? input.match(/(?:rename (?:the )?app to|app name(?: to| is|:))\s+(.+)$/i)
  if (appRename) {
    const name = newName(appRename[1])
    return name ? finish({ ...design, appName: name }, text.reply.appName(name), design.appName !== name) : note()
  }
  const screenRename = input.match(/(?:の名前|の名称|画面名)\s*(?:を|は)\s*(.+)$/) ?? input.match(/を\s*([「“"'].+?[」”"'])\s*に(?:変更|改名|して)/) ?? input.match(/rename .+? to\s+(.+)$/i)
  if (screenRename && screen) {
    const name = newName(screenRename[1])
    if (!name) return note()
    return finish({ ...design, screens: design.screens.map((item) => item.id === screen.id ? { ...item, title: name } : item) }, text.reply.screenName(screen.title, name), name !== screen.title, screen.id)
  }

  if (screen && !fields.length) {
    const position = requestedPosition(input, screens.slice(1).flatMap((item) => [item.title, ...screenAliases[item.kind]]))
    if (position) {
      // Relative screen names may be generic aliases rather than current titles.
      const anchor = screens.find((item) => item.id !== screen.id && (item.title === position.relative || screenAliases[item.kind].includes(position.relative ?? '')))
      const ids = moveName(design.screens.map((item) => item.id), screen.id, { ...position, relative: anchor?.id })
      const byId = new Map(design.screens.map((item) => [item.id, item]))
      const next = ids.map((id) => byId.get(id)!)
      return finish({ ...design, screens: next }, text.reply.screenOrder(screen.title, position.label), ids.some((id, index) => id !== design.screens[index].id), screen.hidden ? undefined : screen.id)
    }
    // A layout request such as 「一覧をカード表示に」 is not a show-screen command.
    if (removing || (addition.test(input) && !/カード|表(?:形式|示に|に)|table|cards?/i.test(input))) {
      const next = design.screens.map((item) => item.id === screen.id ? { ...item, hidden: removing } : item)
      const focus = removing ? next.find((item) => !item.hidden)?.id : screen.id
      return finish({ ...design, screens: next }, text.reply.screenVisible(screen.title, !removing), screen.hidden !== removing, focus)
    }
  }

  // Dashboard cards represent the primary records entity in the shared contract.
  const main = records[0]
  const dashboardScreen = design.screens.find((item) => item.kind === 'dashboard' && item.entity === main?.name)
  if (main && dashboardScreen && /件数|合計|count|total|sum/i.test(input) && !removing) {
    const dashboardField = mentionedFields(main, input)[0]
    let card: CompleteCard | undefined
    if (/期限切れ|期限超過|overdue/i.test(input)) {
      const deadline = main.fields.find((item) => isOneOf(item.kind, 'date') && /期限|予定|deadline|due/i.test(item.name))
      if (deadline) card = { id: `overdue:${deadline.name}`, title: text.card.overdue, kind: 'overdue', field: deadline.name }
    } else if (dashboardField && /別|ごと|count\s*by/i.test(input)) {
      card = { id: `countBy:${dashboardField.name}`, title: text.card.countBy(dashboardField.name), kind: 'countBy', field: dashboardField.name }
    } else if (isOneOf(dashboardField?.kind, 'number') && /合計|total|sum/i.test(input)) {
      card = { id: `sum:${dashboardField.name}`, title: text.card.sum(dashboardField.name), kind: 'sum', field: dashboardField.name }
    } else if (!dashboardField && /^(?:全体の|全|すべての)?件数(?:を出して|を表示|を追加)?$|total\s*count/i.test(input)) {
      card = { id: 'count', title: text.card.count(main.name), kind: 'count' }
    }
    if (card) {
      const exists = design.dashboard.cards.some((item) => item.kind === card.kind && item.field === card.field)
      return finish({ ...design, dashboard: { cards: exists ? design.dashboard.cards : [...design.dashboard.cards, card] } }, text.reply.card(card.title), !exists, dashboardScreen.id)
    }
    return note()
  }

  if (entity && form && /(?:1|2|一|二)\s*列|(?:one|two|1|2)[ -]column/i.test(input.normalize('NFKC')) && formWords.test(input)) {
    const twoColumns = /2\s*列|二\s*列|(?:two|2)[ -]column/i.test(input.normalize('NFKC'))
    return updateForm({ twoColumns }, text.reply.formColumns(entity.name, twoColumns))
  }
  if (entity && form && /必須|任意|required|optional/i.test(input)) {
    if (!field || !editable(field)) return note()
    const required = !removing && !/任意|optional/i.test(input)
    return updateForm({
      fields: required && !form.fields.includes(field.name) ? [...form.fields, field.name] : form.fields,
      required: required ? [...new Set([...form.required, field.name])] : form.required.filter((name) => name !== field.name),
    }, text.reply.required(entity.name, field.name, required))
  }
  if (entity && list && /色分け|色づけ|color[ -]?cod/i.test(input)) {
    if (!field && !removing) return note()
    return updateList({ colorField: removing ? undefined : field?.name }, text.reply.color(entity.name, removing ? undefined : field?.name))
  }
  if (entity && list && /グループ|まとめ|group\s*by|ungroup/i.test(input)) {
    if (!field && !removing && !/ungroup/i.test(input)) return note()
    const groupBy = removing || /ungroup/i.test(input) ? undefined : field?.name
    return updateList({ groupBy }, text.reply.group(entity.name, groupBy))
  }
  if (entity && list && /並べ替|並び替|ソート|順|sort\s*by/i.test(input)) {
    // There is no direction slot: never silently turn "oldest first" into newest.
    if (!field || /昇順|古い順|ascending|oldest/i.test(input) || removing) return note()
    return updateList({ sortBy: field.name }, text.reply.sort(entity.name, field.name))
  }
  if (entity && list && /検索|search/i.test(input)) {
    return updateList({ searchable: !removing }, text.reply.search(entity.name, !removing))
  }
  if (entity && list && /フィルタ|絞り込|絞込|filter/i.test(input)) {
    if (!field) return note()
    const filters = removing ? list.filters.filter((name) => name !== field.name) : [...new Set([...list.filters, field.name])]
    return updateList({ filters }, text.reply.filter(entity.name, field.name, !removing))
  }
  if (entity && list && !fields.length && !formWords.test(input) && /カード|テーブル|表(?:形式|表示|に|で)|cards?|table/i.test(input)) {
    const layout = /カード|cards?/i.test(input) ? 'cards' : 'table'
    return updateList({ layout }, text.reply.layout(entity.name, layout))
  }

  if (entity && field && (list || form)) {
    const formOnly = formWords.test(input) || /項目|field/i.test(input)
    const listOnly = !formOnly && (listWords.test(input) || /列|column/i.test(input))
    const scope = formOnly ? 'form' : listOnly ? 'list' : 'both'
    const position = requestedPosition(input, fields.slice(1).map((item) => item.name))
    if (position || removing || addition.test(input)) {
      const names = (position ? [field] : fields).map((item) => item.name)
      // Formula/ID fields cannot be edited. Requests to expose them in forms
      // remain notes rather than creating a misleading editable preview.
      if (scope !== 'list' && !removing && fields.some((item) => !editable(item))) return note()
      const nextList = list && scope !== 'form' ? { ...list, columns: position ? moveName(list.columns, field.name, position) : removing ? list.columns.filter((name) => !names.includes(name)) : [...new Set([...list.columns, ...names])] } : list
      const nextForm = form && scope !== 'list' ? {
        ...form,
        fields: position ? moveName(form.fields, field.name, position) : removing ? form.fields.filter((name) => !names.includes(name)) : [...new Set([...form.fields, ...names])],
        required: removing ? form.required.filter((name) => !names.includes(name)) : form.required,
      } : form
      const changed = JSON.stringify(list) !== JSON.stringify(nextList) || JSON.stringify(form) !== JSON.stringify(nextForm)
      const formChanged = JSON.stringify(form) !== JSON.stringify(nextForm)
      const next = { ...design, lists: nextList ? { ...design.lists, [entity.name]: nextList } : design.lists, forms: nextForm ? { ...design.forms, [entity.name]: nextForm } : design.forms }
      const reply = position ? text.reply.fieldOrder(entity.name, text.scope[scope], field.name, position.label) : text.reply.fields(entity.name, text.scope[scope], names, !removing)
      return finish(next, reply, changed, screenId(scope === 'form' || (scope === 'both' && removing && formChanged) ? 'form' : 'list', entity.name))
    }
  }

  const accents: [Accent, RegExp][] = [
    ['teal', /緑|グリーン|\b(?:green|teal)\b/i], ['blue', /青|ブルー|\bblue\b/i],
    ['violet', /紫|パープル|\b(?:purple|violet)\b/i], ['amber', /琥珀|アンバー|\bamber\b/i],
    ['rose', /赤|レッド|\b(?:red|rose)\b/i], ['stone', /グレー|灰色|\b(?:gr[ae]y|stone)\b/i],
  ]
  const accent = accents.find(([, pattern]) => pattern.test(input))?.[0]
  if (accent && !fields.length) return finish({ ...design, accent }, text.reply.accent(text.accent[accent]), accent !== design.accent)
  if (!fields.length && /コンパクト|詰め|密度|ゆったり|余白|compact|comfortable|density/i.test(input)) {
    const density = /ゆったり|広|comfortable/i.test(input) ? 'comfortable' : 'compact'
    return finish({ ...design, density }, text.reply.density(density), density !== design.density)
  }
  return note()
}

/** Three to five actionable chips, derived from the current design, not history. */
export function suggestedInstructions(design: CompleteUiDesign, plan: AppPlan): string[] {
  const entity = plan.entities.find((item) => isOneOf(item.kind, 'records'))
  const list = entity ? design.lists[entity.name] : undefined
  const form = entity ? design.forms[entity.name] : undefined
  const suggestions: string[] = []
  const status = entity?.fields.find((field) => field.name === entity.workflow?.column) ?? entity?.fields.find((field) => isOneOf(field.kind, 'choice'))
  if (list && !list.colorField && status) suggestions.push(text.suggest.color(status.name))
  if (list) suggestions.push(text.suggest.layout(list.layout === 'table' ? 'cards' : 'table'))
  if (form) suggestions.push(text.suggest.formColumns(!form.twoColumns))
  const group = entity?.fields.find((field) => field.name !== list?.groupBy && isOneOf(field.kind, 'choice', 'person', 'reference'))
  if (list && !list.groupBy && group) suggestions.push(text.suggest.group(group.name))
  const dashboard = design.screens.find((screen) => screen.kind === 'dashboard' && !screen.hidden)
  if (dashboard && design.screens.find((screen) => !screen.hidden)?.id !== dashboard.id) suggestions.push(text.suggest.dashboardFirst)
  if (dashboard && group && !design.dashboard.cards.some((card) => card.kind === 'countBy' && card.field === group.name)) suggestions.push(text.suggest.countBy(group.name))
  if (dashboard && entity?.fields.some((field) => isOneOf(field.kind, 'date') && /期限|予定|deadline|due/i.test(field.name)) && !design.dashboard.cards.some((card) => card.kind === 'overdue')) suggestions.push(text.suggest.overdue)
  suggestions.push(text.suggest.accent(design.accent === 'blue' ? 'teal' : 'blue'), text.suggest.density(design.density === 'compact' ? 'comfortable' : 'compact'))
  const hidden = design.screens.find((screen) => screen.hidden)
  if (hidden) suggestions.push(text.suggest.showScreen(hidden.title))
  if (suggestions.length < 3) suggestions.push(text.suggest.accent(design.accent === 'violet' ? 'amber' : 'violet'))
  return [...new Set(suggestions)].slice(0, 5)
}
