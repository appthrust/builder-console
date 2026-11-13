import type { HttpMethod, ResponseContractError, ResponseOutcome, ResponseSource } from './error'
import type { ResponseIssue } from './issues'

/** What a contract failure may tell a log or collector: metadata only, never payload. */
export interface ContractFailureReport {
  readonly code: 'response_contract_invalid'
  readonly source: ResponseSource
  readonly operationId: string
  readonly method: HttpMethod
  readonly routeTemplate: string
  readonly issues: readonly ResponseIssue[]
  readonly outcome: ResponseOutcome
}

/** Injected failure sink. Must not throw into the caller (the gateway guards it anyway). */
export type ReportFailure = (report: ContractFailureReport) => void

export function contractFailureReport(error: ResponseContractError): ContractFailureReport {
  return {
    code: error.code,
    source: error.source,
    operationId: error.operationId,
    method: error.method,
    routeTemplate: error.routeTemplate,
    issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    outcome: error.outcome,
  }
}

/**
 * The default sink: one `console.warn` per (operation, schema path) for the
 * reporter's lifetime, so a polling query that keeps receiving the same broken
 * answer does not flood the console.
 */
export function createConsoleWarnReporter(warn: (message: string, report: ContractFailureReport) => void = (message, report) => console.warn(message, report)): ReportFailure {
  const reported = new Set<string>()
  return (report) => {
    const fresh = report.issues.filter((issue) => {
      const key = `${report.operationId}\u0000${issue.path}`
      if (reported.has(key)) return false
      reported.add(key)
      return true
    })
    if (fresh.length > 0) warn('[response-contract]', { ...report, issues: fresh })
  }
}
