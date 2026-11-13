import type { z } from 'zod'
import { ResponseContractError, type HttpMethod, type ResponseSource } from './error'
import { ROOT_PATH, safeIssues, type ResponseIssue } from './issues'

/**
 * How the reader treats a field whose absence an older server version is known
 * to send. Only fields registered this way are normalized; a broken required
 * field is always a failure.
 */
export type FieldPresence = 'absent-means-empty'

export interface FieldPolicy {
  /** Safe schema path of the field (`/creationExecutions`). */
  readonly path: string
  readonly presence: FieldPresence
  /** Where the omission was observed (server source line, issue): the reason this field may be normalized. */
  readonly evidence: string
}

export type ParseResult<D> = { ok: true; value: D } | { ok: false; issues: readonly ResponseIssue[] }

/** One operation's response: where it comes from, what a success looks like, and how the wire becomes a domain value. */
export interface ResponseContract<D> {
  readonly operationId: string
  readonly source: ResponseSource
  readonly method: HttpMethod
  /** Route with placeholders (`/api/v1/projects/{projectId}/…`); never a concrete URL. */
  readonly routeTemplate: string
  readonly successStatuses: readonly number[]
  /** `empty`: a 204-style answer without a body (void). */
  readonly body: 'json' | 'empty'
  readonly fieldPolicies: readonly FieldPolicy[]
  /** Wire → domain. Must not throw; `decodeResponse` still contains a throwing transform. */
  readonly parse: (wire: unknown) => ParseResult<D>
}

export type DecodeResult<D> = { ok: true; value: D } | { ok: false; error: ResponseContractError }

type ContractIdentity = Pick<ResponseContract<unknown>, 'operationId' | 'source' | 'method' | 'routeTemplate' | 'successStatuses'>

/** A JSON-bodied contract whose reader is a zod schema (wire in, domain value out). */
export function defineResponseContract<D>(
  spec: ContractIdentity & { reader: z.ZodType<D>; fieldPolicies?: readonly FieldPolicy[] },
): ResponseContract<D> {
  const { reader, fieldPolicies = [], ...identity } = spec
  return {
    ...identity,
    body: 'json',
    fieldPolicies,
    parse: (wire) => {
      const result = reader.safeParse(wire)
      return result.success ? { ok: true, value: result.data } : { ok: false, issues: safeIssues(reader, result.error.issues, wire) }
    },
  }
}

/** A contract whose success carries no body (`204`). */
export function defineEmptyResponseContract(spec: ContractIdentity): ResponseContract<void> {
  return { ...spec, body: 'empty', fieldPolicies: [], parse: () => ({ ok: true, value: undefined }) }
}

/** The typed failure for `contract`; used for status and body-format violations found before parsing. */
export function contractFailure(contract: ResponseContract<unknown>, issues: readonly ResponseIssue[]): ResponseContractError {
  return new ResponseContractError({
    source: contract.source,
    operationId: contract.operationId,
    method: contract.method,
    routeTemplate: contract.routeTemplate,
    issues,
  })
}

/** Wire body → domain value or a typed failure. The only place a response body becomes a domain value. */
export function decodeResponse<D>(contract: ResponseContract<D>, wire: unknown): DecodeResult<D> {
  let result: ParseResult<D>
  try {
    result = contract.parse(wire)
  } catch {
    // A transform that threw: its message may quote the payload, so only the fact is kept.
    result = { ok: false, issues: [{ path: ROOT_PATH, code: 'invalid_value' }] }
  }
  return result.ok ? result : { ok: false, error: contractFailure(contract, result.issues) }
}
