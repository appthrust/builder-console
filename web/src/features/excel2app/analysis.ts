// Mock runtime and offline fallback share the integrated business narrative.
// Production reads the narrative authored by the staged Excel analysis turn.
import type { ApplicationDraftWorkbookSummary, ExcelAnalysis } from '@appthrust/api-schema/platform-api'
import { text } from './copy'
import { designText } from './design-copy'
import type { AppPlan } from './model'

export const LIST_LIMIT = 3
export const DEADLINE_HEADER = /期限|予定|納期/
export const unique = <T,>(items: T[]) => [...new Set(items)]
export const quotedList = (names: string[]) => text.analysis.quoted(names.slice(0, LIST_LIMIT), names.length > LIST_LIMIT)

export function analysisNarrative(analysis: Omit<ExcelAnalysis, 'summary' | 'bullets'>, plan: AppPlan, workbooks: ApplicationDraftWorkbookSummary[]): { summary: string; bullets: string[] } {
  const s = text.analysis.summary
  const main = [...analysis.entities].sort((a, b) => Number(b.kind === 'records') - Number(a.kind === 'records') || b.importRows - a.importRows)[0]
  const summary = main ? designText.summary(workbooks.length, plan.entities.length, plan.totalImportRows) : designText.none
  const bullets: string[] = []
  if (main?.workflow && main.workflow.stages.length > 1) {
    const stages = main.workflow.stages
    bullets.push(s.workflow(main.workflow.field, stages[0], stages[stages.length - 1], stages.length))
  }
  const owner = main?.fields.find((field) => field.kind === 'person')
  const deadline = main?.fields.find((field) => field.kind === 'date' && DEADLINE_HEADER.test(field.name))
  if (owner && deadline) bullets.push(s.owners(text.analysis.quoted([owner.name, deadline.name])))
  const masters = unique(analysis.entities.flatMap((entity) => entity.fields.flatMap((field) => field.referenceEntity ? [field.referenceEntity] : [])))
  if (masters.length) bullets.push(s.lookup(quotedList(masters)))
  const calculated = unique(analysis.entities.flatMap((entity) => entity.rules.filter((rule) => rule.category !== 'aggregate').map((rule) => rule.column)))
  if (calculated.length) bullets.push(s.calculation(quotedList(calculated)))
  for (const finding of analysis.findings) bullets.push(finding.message)
  if (analysis.capabilities.includes('aggregate')) bullets.push(designText.aggregate)
  if (plan.entities.length) bullets.push(s.plan(plan.entities.length, plan.screens.length))
  return { summary: summary.slice(0, 400), bullets: bullets.slice(0, 8).map((bullet) => bullet.slice(0, 200)) }
}
