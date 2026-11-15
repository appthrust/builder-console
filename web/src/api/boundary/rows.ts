import { z } from 'zod'
import { appendResponseIssues, registerDelegates, safeIssues, type ResponseIssue } from './issues'

/** A rejected row keeps only its independently validated identity, never a partial row. */
export type UnreadableRow = { id?: string }
export type IndependentRows<T> = { data: T[]; unreadable: UnreadableRow[] }
const rowRecoveries = new WeakMap<object, ResponseIssue[]>()

/** The envelope is still strict; one rejected row cannot discard its readable neighbours. */
export function independentRows<T>(reader: z.ZodType<T>, idReader: z.ZodType<string>): z.ZodType<IndependentRows<T>> {
  const rowIdentity = z.object({ id: idReader.optional() })
  const rows = z.array(z.unknown()).transform((wire): IndependentRows<T> => {
    const data: T[] = []
    const unreadable: UnreadableRow[] = []
    const issues: ResponseIssue[] = []
    for (const row of wire) {
      const parsed = reader.safeParse(row)
      if (parsed.success) data.push(parsed.data)
      else {
        const identity = rowIdentity.safeParse(row)
        unreadable.push(identity.success ? identity.data : {})
        appendResponseIssues(issues, safeIssues(reader, parsed.error.issues, row), '/data/*')
      }
    }
    const value = { data, unreadable }
    if (issues.length) rowRecoveries.set(value, issues)
    return value
  })
  registerDelegates(rows, [z.array(reader)])
  return z.object({ data: rows }).transform(({ data }) => data)
}

/** Schema-only diagnostics: no identity, payload, or rejected field value reaches the sink. */
export function unreadableRowIssues(rows: IndependentRows<unknown>): ResponseIssue[] {
  return rowRecoveries.get(rows) ?? []
}
