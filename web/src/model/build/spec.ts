import { parseDocument, stringify } from 'yaml'
import type { BuildSpec, BuildSpecRecord } from './types'

export function emptySpec(): BuildSpec {
  return { users: [], screens: [], records: [], rules: [] }
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Missing or invalid front matter stays visible as body; never discard the user's text. */
export function parseSpec(specMarkdown: string): { spec: BuildSpec; body: string } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(specMarkdown)
  if (!match) return { spec: emptySpec(), body: specMarkdown }
  try {
    const document = parseDocument(match[1]!, { schema: 'core' })
    if (document.errors.length) return { spec: emptySpec(), body: specMarkdown }
    const data: unknown = document.toJS({ maxAliasCount: 100 })
    if (!isMap(data) || !isMap(data.spec)) return { spec: emptySpec(), body: specMarkdown }
    const source = data.spec
    const records: BuildSpecRecord[] = []
    if (Array.isArray(source.records)) {
      for (const record of source.records) {
        if (isMap(record) && typeof record.name === 'string') records.push({ name: record.name, fields: strings(record.fields) })
      }
    }
    const spec: BuildSpec = { users: strings(source.users), screens: strings(source.screens), records, rules: strings(source.rules) }
    if (typeof source.name === 'string') spec.name = source.name
    if (typeof source.oneLine === 'string') spec.oneLine = source.oneLine
    if (source.approval === 'none' || source.approval === 'one-step' || source.approval === 'two-step' || source.approval === 'notify-only') spec.approval = source.approval
    if (source.importFrom === 'none' || source.importFrom === 'csv' || source.importFrom === 'excel') spec.importFrom = source.importFrom
    return { spec, body: specMarkdown.slice(match[0].length) }
  } catch {
    return { spec: emptySpec(), body: specMarkdown }
  }
}

export function serializeSpec(spec: BuildSpec, body: string): string {
  return `---\n${stringify({ spec }, { lineWidth: 0 })}---\n${body}`
}
