// 「画面の決定」: what the UI preview settled, as a check-marked list. The Excel → app
// 実装 step lists the exact `- ` items the build receives under 「9. 画面の決定」;
// the build page's spec panel shows the compact summary (screen order, how each
// list looks, required form fields, dashboard cards, notes).
import { Check } from 'lucide-react'
import { cn } from '../../ui'
import { decisionsText } from './decisions-copy'
import { uiDecisionsMarkdown, type UiDesign } from './ui-design'

export interface UiDecision {
  title: string
  detail?: string
}

/** The same `- ` items the build receives under 「9. 画面の決定」. */
export function uiDecisionItems(design: UiDesign): UiDecision[] {
  return uiDecisionsMarkdown(design).split('\n').filter((line) => line.startsWith('- ')).map((line) => ({ title: line.slice(2) }))
}

/** The decisions that shape the built screens; the app name and look stay with the preview. */
export function uiDecisionSummary(design: UiDesign): UiDecision[] {
  const t = decisionsText
  const items: UiDecision[] = []
  const shown = design.screens.filter((screen) => !screen.hidden)
  const hidden = design.screens.filter((screen) => screen.hidden)
  if (shown.length) items.push({ title: t.order, detail: shown.map((screen) => screen.title).join(t.orderSeparator) })
  if (hidden.length) items.push({ title: t.hidden, detail: hidden.map((screen) => screen.title).join(t.separator) })
  for (const [entity, list] of Object.entries(design.lists)) {
    const parts = [t.layouts[list.layout], list.columns.length ? t.columns(list.columns) : undefined, list.colorField ? t.colorBy(list.colorField) : undefined, list.groupBy ? t.groupBy(list.groupBy) : undefined]
    items.push({ title: t.list(entity), detail: parts.filter(Boolean).join(t.partSeparator) })
  }
  for (const [entity, form] of Object.entries(design.forms)) {
    if (form.required.length) items.push({ title: t.form(entity), detail: t.required(form.required) })
  }
  if (design.dashboard.cards.length) items.push({ title: t.dashboard, detail: design.dashboard.cards.map((card) => card.title).join(t.separator) })
  for (const note of design.notes) items.push({ title: note })
  return items
}

export function UiDecisions({ design, compact = false, className }: { design: UiDesign; compact?: boolean; className?: string }) {
  const items = compact ? uiDecisionSummary(design) : uiDecisionItems(design)
  return (
    <ul className={cn(compact ? 'space-y-1.5' : 'space-y-2 rounded-lg border border-stone-200 px-4 py-3', className)}>
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: free-form notes may repeat, and the list is rebuilt whole.
        <li key={index} className={cn('flex items-start text-sm break-words', compact ? 'gap-1.5 text-stone-900' : 'gap-2 text-stone-700')}>
          <Check aria-hidden className={cn('shrink-0 text-accent', compact ? 'mt-1 size-3.5' : 'mt-0.5 size-4')} />
          <span className="min-w-0">{item.title}{item.detail ? <span className="block text-xs text-stone-500">{item.detail}</span> : null}</span>
        </li>
      ))}
    </ul>
  )
}
