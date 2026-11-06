// Deterministic design for the mock runtime and explicit offline fallback only.
import type { ApplicationDraftWorkbookSummary, ExcelAnalysis, ExcelAnalysisEntity, ExcelAnalysisSheet, ExcelAnalysisWorkbookRole, ExcelWorkbookReading } from '@appthrust/api-schema/platform-api'
import { analysisNarrative } from './analysis'
import { designText } from './design-copy'
import { cellText, entityRows, planApp, readingCapabilities, readWorkbook, type WorkbookGrid } from './model'

export interface DesignInput {
  summary: ApplicationDraftWorkbookSummary
  grid: WorkbookGrid
}

const label = (value: string) => value.slice(0, 200)
const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const fileStem = (name: string) => name.replace(/\.(xlsx|xlsm|xls|csv)$/i, '')

export function readingOf(input: DesignInput): ExcelWorkbookReading {
  const reading = readWorkbook(input.grid)
  return {
    workbookId: input.summary.id,
    summary: designText.reading(reading.sheets.length, reading.sheets.reduce((sum, sheet) => sum + (sheet.role === 'records' || sheet.role === 'master' ? sheet.dataRows : 0), 0)),
    sheets: reading.sheets.map((sheet) => ({
      ...sheet,
      name: label(sheet.name),
      columns: sheet.columns.map((column) => ({
        ...column, header: label(column.header), samples: column.samples.map(label),
        ...(column.options ? { options: column.options.slice(0, 200).map(label) } : {}),
        ...(column.referenceSheet ? { referenceSheet: label(column.referenceSheet) } : {}),
      })),
      rules: sheet.rules.slice(0, 200).map((rule) => ({ ...rule, column: label(rule.column), expression: rule.expression.slice(0, 1000) })),
      ...(sheet.workflow ? { workflow: { column: label(sheet.workflow.column), stages: sheet.workflow.stages.slice(0, 100).map(label) } } : {}),
    })),
  }
}

interface Member { input: DesignInput; sheet: ExcelAnalysisSheet }
interface Group { members: Member[]; headers: Set<string>; entity: ExcelAnalysisEntity }

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0
  for (const header of a) if (b.has(header)) shared += 1
  return shared / Math.max(a.size, b.size)
}

function workbookRole(sheets: ExcelAnalysisSheet[]): ExcelAnalysisWorkbookRole {
  const roles = new Set<ExcelAnalysisWorkbookRole>()
  for (const sheet of sheets) if (sheet.role !== 'empty') roles.add(sheet.role === 'summary' ? 'report' : sheet.role)
  if (roles.size > 1) return 'mixed'
  return [...roles][0] ?? 'unused'
}

export function designFromReadings(inputs: DesignInput[], readings?: ReadonlyMap<string, ExcelWorkbookReading>): ExcelAnalysis {
  const members = inputs.map((input) => ({ input, reading: readings?.get(input.summary.id) ?? readingOf(input) }))
  const groups: Group[] = []
  const omitted = new Set<string>()
  for (const { input, reading } of members) {
    for (const sheet of reading.sheets) {
      if (sheet.role !== 'records' && sheet.role !== 'master') continue
      const headers = new Set(sheet.columns.map((column) => normalized(column.header)).filter(Boolean))
      if (!headers.size) continue
      // Compare with the original header set, not an ever-growing union that makes
      // the outcome depend on how many monthly files preceded the current file.
      let group = groups.find((candidate) => candidate.entity.kind === sheet.role
        && !candidate.members.some((member) => member.input.summary.id === input.summary.id)
        && candidate.members.length < 50 && overlap(candidate.headers, headers) >= 0.8
        && new Set([...candidate.entity.fields.map((field) => normalized(field.name)), ...headers]).size <= 200)
      if (!group) {
        if (groups.length === 50) { omitted.add(input.summary.id); continue }
        group = { members: [], headers, entity: { name: sheet.name, kind: sheet.role, fields: [], sources: [], rules: [], importRows: 0 } }
        groups.push(group)
      }
      group.members.push({ input, sheet })
      const entity = group.entity
      const fieldNames = new Map(entity.fields.map((field) => [normalized(field.name), field.name]))
      const columns: ExcelAnalysisEntity['sources'][number]['columns'] = []
      for (const column of sheet.columns) {
        const header = normalized(column.header)
        if (!header) continue
        let name = fieldNames.get(header)
        if (name === undefined) {
          name = column.header
          fieldNames.set(header, name)
          // Resolve all references after entity names have been made unique.
          entity.fields.push({ name, kind: column.kind === 'reference' ? 'text' : column.kind, ...(column.options ? { options: [...column.options] } : {}) })
        } else if (column.options) {
          const field = entity.fields.find((item) => item.name === name)!
          field.options = [...new Set([...(field.options ?? []), ...column.options])].slice(0, 200)
        }
        if (!columns.some((mapped) => mapped.field === name)) columns.push({ index: column.index, field: name })
      }
      entity.sources.push({ workbookId: input.summary.id, sheet: sheet.name, headerRow: sheet.headerRow, dataRows: sheet.dataRows, truncated: sheet.truncated, columns })
      for (const rule of sheet.rules) {
        const column = fieldNames.get(normalized(rule.column))
        if (column === undefined) continue
        const existing = entity.rules.find((item) => item.column === column && item.expression === rule.expression && item.category === rule.category)
        if (existing) existing.rows += rule.rows
        else if (entity.rules.length < 200) entity.rules.push({ ...rule, column })
      }
      if (sheet.workflow) {
        const field = fieldNames.get(normalized(sheet.workflow.column))
        if (field !== undefined && (!entity.workflow || entity.workflow.field === field)) {
          entity.workflow = { field, stages: [...new Set([...(entity.workflow?.stages ?? []), ...sheet.workflow.stages])].slice(0, 100) }
        }
      }
    }
  }

  const used = new Set<string>()
  const baseNames = groups.map((group) => group.entity.name)
  for (const group of groups) {
    const base = group.entity.name
    let name = baseNames.filter((name) => name === base).length > 1
      ? label(`${fileStem(group.members[0]!.input.summary.fileName)}・${base}`) : base
    // Repeated file names and long qualified names can still collide.
    const qualified = name
    let suffix = 2
    while (used.has(name)) { const ending = `・${suffix++}`; name = `${qualified.slice(0, 200 - ending.length)}${ending}` }
    used.add(name)
    group.entity.name = name
  }

  const grids = new Map(inputs.map((input) => [input.summary.id, input.grid]))
  const rows = new Map(groups.map((group) => [group.entity, entityRows(group.entity, grids)]))
  const masters = groups.filter((group) => group.entity.kind === 'master').map((group) => ({
    entity: group.entity,
    keys: new Set(rows.get(group.entity)!.flatMap((row) => group.entity.fields.slice(0, 2).map((field) => cellText(row.values[field.name])).filter(Boolean))),
  }))
  for (const group of groups) {
    const entity = group.entity
    const body = rows.get(entity)!
    entity.importRows = body.length
    for (const field of entity.fields) {
      if (field.kind === 'formula') continue
      const values = new Set(body.map((row) => cellText(row.values[field.name])).filter(Boolean))
      for (const { sheet } of group.members) {
        const column = sheet.columns.find((item) => normalized(item.header) === normalized(field.name))
        for (const option of column?.options ?? []) values.add(option)
      }
      if (!values.size) continue
      const target = masters.find((master) => master.entity !== entity && [...values].every((value) => master.keys.has(value)))
      if (target) {
        field.kind = 'reference'
        field.referenceEntity = target.entity.name
        delete field.options
      }
    }
  }

  const capabilities = readingCapabilities(members.flatMap(({ reading }) => reading.sheets))
  if (groups.some((group) => group.entity.fields.some((field) => field.referenceEntity)) && !capabilities.includes('lookup')) capabilities.push('lookup')
  const findings: ExcelAnalysis['findings'] = groups.filter((group) => group.members.length > 1).map((group) => ({
    kind: 'merged', message: label(designText.merged(group.entity.name, group.members.length)), workbookIds: [...new Set(group.members.map((member) => member.input.summary.id))],
  }))
  for (const { summary, grid } of inputs) {
    if (summary.truncated || grid.sheets.some((sheet) => sheet.truncated)) findings.push({ kind: 'truncated', message: label(designText.truncated(summary.fileName)), workbookIds: [summary.id] })
  }
  if (omitted.size) findings.unshift({ kind: 'unused', message: designText.entityLimit, workbookIds: [...omitted] })
  const design: Omit<ExcelAnalysis, 'summary' | 'bullets'> = {
    capabilities,
    workbooks: members.map(({ input, reading }) => ({ workbookId: input.summary.id, role: workbookRole(reading.sheets), summary: reading.summary })),
    entities: groups.map((group) => group.entity), flows: [], findings: findings.slice(0, 20),
  }
  return { ...design, ...analysisNarrative(design, planApp(design, fileStem(inputs[0]?.summary.fileName ?? '')), inputs.map((input) => input.summary)) }
}
