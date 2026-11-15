import { z } from 'zod'
import { registerDelegates, type ResponseIssue } from './issues'

/** A rejected row keeps only its independently read string identity, never a partial row. */
export type UnreadableRow = { id?: string }
export type IndependentRows<T> = { data: T[]; unreadable: UnreadableRow[] }
const rowIdentity = z.object({ id: z.string().optional() })

/** The envelope is still strict; one rejected row cannot discard its readable neighbours. */
export function independentRows<T>(reader: z.ZodType<T>): z.ZodType<IndependentRows<T>> {
  const rows = z.array(z.unknown()).transform((wire): IndependentRows<T> => {
    const data: T[] = []
    const unreadable: UnreadableRow[] = []
    for (const row of wire) {
      const parsed = reader.safeParse(row)
      if (parsed.success) data.push(parsed.data)
      else {
        const identity = rowIdentity.safeParse(row)
        unreadable.push(identity.success ? identity.data : {})
      }
    }
    return { data, unreadable }
  })
  registerDelegates(rows, [z.array(reader)])
  return z.object({ data: rows }).transform(({ data }) => data)
}

/** Schema-only diagnostics: no identity, payload, or rejected field value reaches the sink. */
export function unreadableRowIssues(rows: IndependentRows<unknown>): ResponseIssue[] {
  return rows.unreadable.length ? [{ path: '/data/*', code: 'invalid_value' }] : []
}
