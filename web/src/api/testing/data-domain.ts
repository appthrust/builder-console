// Test seam: app data domain values made from wire fixtures by the production
// readers (contracts/platform/data.ts), never by casting a literal to a domain
// type. A fixture the reader rejects fails the test that uses it.
import type { z } from 'zod'
import type { DatabaseChange, DatabaseRowsPage, DatabaseTable, DatabaseTableRef } from '../../model/contracts/data'
import { changeReader, rowsPageReader, tableReader, tableRefReader } from '../contracts/platform/data'

function read<D>(reader: z.ZodType<D>, wire: unknown, what: string): D {
  const result = reader.safeParse(wire)
  if (!result.success) throw new Error(`${what} fixture does not match its reader: ${result.error.issues.map((issue) => `${issue.code} /${issue.path.join('/')}`).join(', ')}`)
  return result.data
}

export const tableOf = (wire: unknown): DatabaseTable => read(tableReader, wire, 'database table')
export const tableRefOf = (wire: unknown): DatabaseTableRef => read(tableRefReader, wire, 'database table ref')
export const rowsPageOf = (wire: unknown): DatabaseRowsPage => read(rowsPageReader, wire, 'rows page')
export const changeOf = (wire: unknown): DatabaseChange => read(changeReader, wire, 'database change')
