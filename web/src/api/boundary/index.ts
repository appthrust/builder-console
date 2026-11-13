// Response boundary: decode a wire body into a domain value or a typed,
// payload-free failure. Depends on zod only (no React, app, auth or HTTP), so it
// can move to a shared package unchanged.
export {
  contractFailure,
  decodeResponse,
  defineEmptyResponseContract,
  defineResponseContract,
  type DecodeResult,
  type FieldPolicy,
  type FieldPresence,
  type ParseResult,
  type ResponseContract,
} from './contract'
export {
  isResponseContractError,
  RESPONSE_CONTRACT_MESSAGE,
  ResponseContractError,
  type HttpMethod,
  type ResponseOutcome,
  type ResponseSource,
} from './error'
export { MAX_ISSUES, ROOT_PATH, safePath, type ResponseIssue, type ResponseIssueCode } from './issues'
export { absentMeansEmpty, openEnum, openUnion, selectVariant, type OpenValue, type Supported } from './readers'
export { contractFailureReport, createConsoleWarnReporter, type ContractFailureReport, type ReportFailure } from './report'
