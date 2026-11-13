import type { ResponseIssue } from './issues'

export type ResponseSource = 'platform' | 'console' | 'config'
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
/** A read that failed, or a write whose answer could not be read (it may still have happened: never resend blindly). */
export type ResponseOutcome = 'read_failed' | 'write_unconfirmed'

export const RESPONSE_CONTRACT_MESSAGE = 'API response does not match its contract'

export interface ResponseContractErrorInit {
  source: ResponseSource
  operationId: string
  method: HttpMethod
  routeTemplate: string
  issues: readonly ResponseIssue[]
}

/**
 * A 2xx answer that is not a value of its contract. Carries only safe metadata
 * (operation, route template, schema paths, issue codes): no payload, no
 * parser message, no cause. Never transient, never a session expiry.
 */
export class ResponseContractError extends Error {
  readonly code = 'response_contract_invalid' as const
  readonly retryable = false as const
  readonly source: ResponseSource
  readonly operationId: string
  readonly method: HttpMethod
  readonly routeTemplate: string
  readonly issues: readonly ResponseIssue[]
  readonly outcome: ResponseOutcome

  constructor(init: ResponseContractErrorInit) {
    super(RESPONSE_CONTRACT_MESSAGE)
    this.name = 'ResponseContractError'
    this.source = init.source
    this.operationId = init.operationId
    this.method = init.method
    this.routeTemplate = init.routeTemplate
    this.issues = Object.freeze(init.issues.map((issue) => Object.freeze({ path: issue.path, code: issue.code })))
    this.outcome = init.method === 'GET' ? 'read_failed' : 'write_unconfirmed'
  }
}

export function isResponseContractError(error: unknown): error is ResponseContractError {
  return error instanceof ResponseContractError
}
