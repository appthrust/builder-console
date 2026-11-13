// Test seam: Excel → app domain values made from wire fixtures by the
// production readers (api/contracts/platform/excel.ts), never by casting a
// literal to a domain type. A fixture the reader rejects fails the test that
// uses it. Designs built in the browser (complete values) are read in tests
// the way production reads them: through `uiDesignOf` / `excelAnalysisOf`.
import type { z } from 'zod'
import type { ExcelAnalysis, UiDesign, WorkbookList, WorkbookReading } from '../../model/contracts/excel'
import { decodeResponse } from '../boundary'
import { excelAnalysisReader, listWorkbooksContract, uiDesignReader, workbookReadingReader } from '../contracts/platform/excel'

function read<D>(reader: z.ZodType<D>, wire: unknown, what: string): D {
  const result = reader.safeParse(wire)
  if (!result.success) throw new Error(`${what} fixture does not match its reader: ${result.error.issues.map((issue) => `${issue.code} /${issue.path.join('/')}`).join(', ')}`)
  return result.data
}

/** An integrated analysis as a draft carries it. */
export const analysisFrom = (wire: unknown): ExcelAnalysis => read(excelAnalysisReader, wire, 'analysis')
/** A UI design as a draft or a ui-design turn carries it. */
export const designFrom = (wire: unknown): UiDesign => read(uiDesignReader, wire, 'UI design')
/** One workbook's reading as the set's list carries it. */
export const readingFrom = (wire: unknown): WorkbookReading => read(workbookReadingReader, wire, 'reading')

/** The set's list answer. */
export function workbookListFrom(wire: unknown): WorkbookList {
  const result = decodeResponse(listWorkbooksContract, wire)
  if (!result.ok) throw new Error(`workbook list fixture does not match its contract: ${result.error.issues.map((issue) => `${issue.code} ${issue.path}`).join(', ')}`)
  return result.value
}
