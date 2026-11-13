// The specification document (Markdown in the console's subset) written from a
// integrated analysis and its AppPlan: sections 1–8, reviewed before implementation.
// The excel-analysis turn writes this document on the server; the mock runtime
// and the 「AI なしで続ける」 fallback write it here. Section 9 (画面の決定) comes
// from the UI design: the ui-design turn writes it on the server, the fallback
// replaces it with `withUiDecisions` at hand-off. Only complete values are
// written: a document never silently leaves out a part this console cannot read.
import { serializeSpec } from '../../model/build/spec'
import type { BuildSpec } from '../../model/build/types'
import type { CompleteExcelAnalysis, CompleteUiDesign, WorkbookSummary } from '../../model/contracts/excel'
import { text } from './copy'
import { designText } from './design-copy'
import type { AppPlan } from './model'
import { uiDecisionsMarkdown } from './ui-design'

/** The specification with the front-matter the build reads (`parseSpec`): name, screens, records, rules. */
export function excelSpecMarkdown(analysis: CompleteExcelAnalysis, plan: AppPlan, workbooks: WorkbookSummary[]): string {
  const t = text.document
  const spec: BuildSpec = {
    name: plan.name,
    oneLine: designText.oneLine(workbooks.length),
    users: [...t.users],
    screens: plan.screens.map((screen) => t.screen(screen.entity, text.screen[screen.kind])),
    records: plan.entities.map((entity) => ({ name: entity.name, fields: entity.fields.map((field) => field.name) })),
    rules: [
      ...analysis.entities.flatMap((entity) => entity.rules.map((rule) => t.rule(rule.column, rule.expression, text.ruleCategory[rule.category]))),
      ...plan.entities.flatMap((entity) => (entity.workflow ? [t.workflow(entity.name, entity.workflow.column, entity.workflow.stages.join(' → '))] : [])),
    ],
    importFrom: 'excel',
  }
  return serializeSpec(spec, specMarkdown(analysis, plan, workbooks))
}

/** 「## 9.」 up to the next `## ` heading or the end, also when the document starts with it. */
const SECTION_9 = /(^|\n)## 9\.[^\n]*(?:\n(?!## )[^\n]*)*/

/** The specification with its 「9. 画面の決定」 section replaced by (or extended with) the design's decisions. */
export function withUiDecisions(specMarkdown: string, design: CompleteUiDesign): string {
  const section = uiDecisionsMarkdown(design)
  if (!SECTION_9.test(specMarkdown)) return `${specMarkdown.trimEnd()}\n\n${section}\n`
  return specMarkdown.replace(SECTION_9, (_match, lead: string) => `${lead}${section}\n`)
}

export function specMarkdown(analysis: CompleteExcelAnalysis, plan: AppPlan, workbooks: WorkbookSummary[]): string {
  const t = text.document
  const lines: string[] = [`# ${t.title(plan.name)}`, '']
  lines.push(`## ${t.overview}`, designText.overview(workbooks.length, workbooks.reduce((sum, workbook) => sum + workbook.sheetCount, 0), plan.totalImportRows), '')

  lines.push(`## ${t.current}`)
  for (const workbook of analysis.workbooks) {
    const fileName = workbooks.find((member) => member.id === workbook.workbookId)?.fileName ?? ''
    lines.push(`- ${designText.fileRole(fileName, designText.roles[workbook.role], workbook.summary)}`)
  }
  for (const flow of analysis.flows) lines.push(`- ${designText.flow(flow.name, flow.steps.join(' → '))}`)
  for (const capability of analysis.capabilities) lines.push(`- **${text.capability[capability].title}**: ${text.capability[capability].body}`)
  lines.push('')

  lines.push(`## ${t.data}`)
  for (const entity of analysis.entities) {
    lines.push(`### ${t.entity(entity.name, text.role[entity.kind], entity.importRows)}`)
    const files = [...new Set(entity.sources.map((source) => workbooks.find((workbook) => workbook.id === source.workbookId)?.fileName).filter((name): name is string => name !== undefined))]
    lines.push(designText.sources(files.join(' / ')))
    for (const field of entity.fields) {
      if (field.kind === 'choice' && field.options) lines.push(`- ${t.fieldChoice(field.name, field.options.join(' / '))}`)
      else if (field.kind === 'reference' && field.referenceEntity) lines.push(`- ${t.fieldReference(field.name, field.referenceEntity)}`)
      else lines.push(`- ${t.field(field.name, text.kind[field.kind])}`)
    }
    lines.push('')
  }

  lines.push(`## ${t.rules}`)
  const rules = analysis.entities.flatMap((entity) => entity.rules.map((rule) => ({ rule })))
  for (const { rule } of rules) lines.push(`- ${t.rule(rule.column, rule.expression, text.ruleCategory[rule.category])}`)
  for (const entity of plan.entities) if (entity.workflow) lines.push(`- ${t.workflow(entity.name, entity.workflow.column, entity.workflow.stages.join(' → '))}`)
  if (rules.length === 0 && !plan.entities.some((entity) => entity.workflow)) lines.push(`- ${t.noRules}`)
  lines.push('')

  lines.push(`## ${t.screens}`)
  const byEntity = new Map<string, string[]>()
  for (const screen of plan.screens) byEntity.set(screen.entity, [...(byEntity.get(screen.entity) ?? []), text.screen[screen.kind]])
  for (const [entity, screens] of byEntity) lines.push(`- ${t.screen(entity, screens.join(' / '))}`)
  lines.push('')

  lines.push(`## ${t.access}`, ...t.accessBody.map((item) => `- ${item}`), '')
  lines.push(`## ${t.migration}`, ...t.migrationBody(plan.totalImportRows).map((item) => `- ${item}`), '')
  lines.push(`- ${designText.mapping}`, `- ${designText.preserve}`)
  for (const entity of plan.entities) if (entity.key?.length) lines.push(`- ${designText.dedupe(entity.name, entity.key.join(' / '))}`)
  for (const finding of analysis.findings) lines.push(`- ${finding.message}`)
  lines.push('')
  lines.push(`## ${t.stack}`, ...t.stackBody.map((item) => `- ${item}`))
  return lines.join('\n')
}
