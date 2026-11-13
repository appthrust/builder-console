// 「画面の決定」: what the UI preview settled, as a check-marked list. The Excel → app
// 実装 step lists the exact `- ` items the build receives under 「9. 画面の決定」;
// the build page's spec panel shows the compact summary (screen order, how each
// list looks, required form fields, dashboard cards, notes). A design with a part
// this console cannot read shows the parts it can and says that more exist.
import { Check } from 'lucide-react'
import { knownValue } from '../../model/contracts/build'
import { completeUiDesign, partValue, type UiDesign } from '../../model/contracts/excel'
import { cn } from '../../ui'
import { decisionsText } from './decisions-copy'
import { uiDecisionLines } from './ui-design'

export interface UiDecision {
  title: string
  detail?: string
}

/** The same `- ` items the build receives under 「9. 画面の決定」 (those this console can read). */
export function uiDecisionItems(design: UiDesign): UiDecision[] {
  return uiDecisionLines(design).map((line) => ({ title: line.slice(2) }))
}

/** The decisions that shape the built screens; the app name and look stay with the preview. */
export function uiDecisionSummary(design: UiDesign): UiDecision[] {
  const t = decisionsText
  const items: UiDecision[] = []
  const shown = design.screens.filter((screen) => !screen.hidden)
  const hidden = design.screens.filter((screen) => screen.hidden)
  if (shown.length) items.push({ title: t.order, detail: shown.map((screen) => screen.title).join(t.orderSeparator) })
  if (hidden.length) items.push({ title: t.hidden, detail: hidden.map((screen) => screen.title).join(t.separator) })
  for (const [entity, part] of Object.entries(design.lists)) {
    const list = partValue(part)
    const layout = list && knownValue(list.layout)
    if (!list || !layout) continue
    const parts = [t.layouts[layout], list.columns.length ? t.columns(list.columns) : undefined, list.colorField ? t.colorBy(list.colorField) : undefined, list.groupBy ? t.groupBy(list.groupBy) : undefined]
    items.push({ title: t.list(entity), detail: parts.filter(Boolean).join(t.partSeparator) })
  }
  for (const [entity, part] of Object.entries(design.forms)) {
    const form = partValue(part)
    if (form?.required.length) items.push({ title: t.form(entity), detail: t.required(form.required) })
  }
  const cards = partValue(design.dashboard)
  if (cards?.length) items.push({ title: t.dashboard, detail: cards.map((card) => card.title).join(t.separator) })
  for (const note of design.notes) items.push({ title: note })
  return items
}

export function UiDecisions({ design, compact = false, className }: { design: UiDesign; compact?: boolean; className?: string }) {
  const items = compact ? uiDecisionSummary(design) : uiDecisionItems(design)
  const incomplete = !completeUiDesign(design)
  return (
    <div className={className}>
      <ul className={cn(compact ? 'space-y-1.5' : 'space-y-2 rounded-lg border border-stone-200 px-4 py-3')}>
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: free-form notes may repeat, and the list is rebuilt whole.
          <li key={index} className={cn('flex items-start text-sm break-words', compact ? 'gap-1.5 text-stone-900' : 'gap-2 text-stone-700')}>
            <Check aria-hidden className={cn('shrink-0 text-accent', compact ? 'mt-1 size-3.5' : 'mt-0.5 size-4')} />
            <span className="min-w-0">{item.title}{item.detail ? <span className="block text-xs text-stone-500">{item.detail}</span> : null}</span>
          </li>
        ))}
      </ul>
      {incomplete ? <p data-testid="ui-decisions-incomplete" className="mt-2 text-xs text-amber-800">{decisionsText.incomplete}</p> : null}
    </div>
  )
}
