// Shared wire-variant checker for response contracts (design §9, §10; the seam
// the verification design's fixture replay also uses). A case varies one
// field of a valid base answer (absent / empty / present / null / unknown, the
// verification design's variant names) and states whether the contract must
// accept it (optionally with the exact domain value) or reject it (optionally
// with the safe issues). Every rejection is also checked for redaction: no
// string from the wire may appear in the error or its report.
import { contractFailureReport, decodeResponse, RESPONSE_CONTRACT_MESSAGE, type ResponseContract, type ResponseIssue } from '../boundary'

export type WireVariant = 'absent' | 'empty' | 'present' | 'null' | 'unknown'

export interface WireContractCase<D> {
  name: string
  variant: WireVariant
  /** Safe schema path of the varied field (`/creationExecutions`); `/` for the whole body. */
  path: string
  wire: unknown
  expect:
    | { accept: true; value?: D; check?: (value: D) => void }
    | { accept: false; issues?: readonly ResponseIssue[] }
}

const MIN_SECRET_LENGTH = 4

/** String values and object keys of the wire, each long enough to be recognizable if it leaked. */
function wireStrings(value: unknown, into: { values: Set<string>; keys: Set<string> }, depth = 0) {
  if (depth > 64) return into
  if (typeof value === 'string') {
    if (value.length >= MIN_SECRET_LENGTH) into.values.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) wireStrings(item, into, depth + 1)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key.length >= MIN_SECRET_LENGTH) into.keys.add(key)
      wireStrings(item, into, depth + 1)
    }
  }
  return into
}

/**
 * Runs every case through `decodeResponse` and throws one error listing all
 * mismatches. Each registered field policy must have an `absent` case
 * (accepted) and a `null` case (rejected) at its path.
 */
export function assertWireContractCases<D>(contract: ResponseContract<D>, cases: readonly WireContractCase<D>[]): void {
  const problems: string[] = []
  for (const policy of contract.fieldPolicies) {
    const at = cases.filter((item) => item.path === policy.path)
    if (!at.some((item) => item.variant === 'absent' && item.expect.accept)) problems.push(`${policy.path}: registered ${policy.presence} field has no accepted 'absent' case`)
    if (!at.some((item) => item.variant === 'null' && !item.expect.accept)) problems.push(`${policy.path}: registered ${policy.presence} field has no rejected 'null' case`)
  }
  for (const item of cases) {
    const label = `${contract.operationId} [${item.variant} ${item.path}] ${item.name}`
    const result = decodeResponse(contract, item.wire)
    if (item.expect.accept) {
      if (!result.ok) {
        problems.push(`${label}: rejected (${result.error.issues.map((issue) => `${issue.code} ${issue.path}`).join(', ')}), expected accept`)
        continue
      }
      if (item.expect.value !== undefined && !Bun.deepEquals(result.value, item.expect.value)) problems.push(`${label}: decoded value differs from the expected domain value`)
      try {
        item.expect.check?.(result.value)
      } catch (error) {
        problems.push(`${label}: check failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }
    if (result.ok) {
      problems.push(`${label}: accepted, expected reject`)
      continue
    }
    const actual = result.error.issues
    for (const expected of item.expect.issues ?? []) {
      if (!actual.some((issue) => issue.path === expected.path && issue.code === expected.code)) {
        problems.push(`${label}: missing issue ${expected.code} ${expected.path} (got ${actual.map((issue) => `${issue.code} ${issue.path}`).join(', ')})`)
      }
    }
    if (result.error.message !== RESPONSE_CONTRACT_MESSAGE) problems.push(`${label}: error message is not the fixed contract message`)
    // Free-text slots of the report; code, source, method and outcome are closed sets. Object keys that are
    // reported path segments are schema field names (safe paths name declared fields only); values never are.
    const report = contractFailureReport(result.error)
    const slots = [report.operationId, report.routeTemplate, ...report.issues.map((issue) => issue.path)]
    const segments = new Set(report.issues.flatMap((issue) => issue.path.split('/')))
    const secrets = wireStrings(item.wire, { values: new Set(), keys: new Set() })
    const leaked = [...secrets.values, ...[...secrets.keys].filter((key) => !segments.has(key))]
      .filter((text) => !contract.operationId.includes(text) && !contract.routeTemplate.includes(text))
      .filter((text) => slots.some((slot) => slot.includes(text)))
    if (leaked.length > 0) problems.push(`${label}: ${leaked.length} wire string(s) leaked into the error report`)
  }
  if (problems.length > 0) throw new Error(`Wire contract cases failed:\n- ${problems.join('\n- ')}`)
}
