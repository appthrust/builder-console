// The single place where API responses are decoded (design §2). Queries,
// mutations and loaders call an operation through the gateway with its
// contract; the gateway returns the contract's domain value or rejects with a
// typed failure. Order: session check (transport) → HTTP error classification
// (transport: ORPCError / ConsoleApiError, unchanged) → success status →
// body format → domain parse. Contract failures go to `reportFailure` once
// here, with safe metadata only.
import { ORPCError } from '@orpc/client'
import {
  contractFailure,
  contractFailureReport,
  createConsoleWarnReporter,
  decodeResponse,
  ROOT_PATH,
  type ReportFailure,
  type ResponseContract,
  type ResponseContractError,
  type ResponseIssue,
} from './boundary'
import { client, type PlatformApiClient, type PlatformClientContext } from './client'
import { consoleTransport as defaultConsoleTransport, type ConsoleTransport } from './console'
import type { ConsoleOperationContract, PlatformInput, PlatformOperation, PlatformOperationContract } from './contracts/define'

export interface ApiGatewayDeps {
  platformTransport: PlatformApiClient
  consoleTransport: ConsoleTransport
  reportFailure: ReportFailure
}

export interface PlatformCallOptions {
  /** Reuse a caller-held key (resumable handoffs); otherwise the transport mints one per write. */
  idempotencyKey?: string
  signal?: AbortSignal
}

export interface ApiGateway {
  platform<Op extends PlatformOperation, D>(contract: PlatformOperationContract<Op, D>, input: PlatformInput<Op>, options?: PlatformCallOptions): Promise<D>
  console<I, D>(contract: ConsoleOperationContract<I, D>, input: I): Promise<D>
}

type PlatformCall = (input: unknown, options: { context: PlatformClientContext; signal?: AbortSignal }) => Promise<unknown>

export function createApiGateway({ platformTransport, consoleTransport, reportFailure }: ApiGatewayDeps): ApiGateway {
  const fail = (error: ResponseContractError): never => {
    try {
      reportFailure(contractFailureReport(error))
    } catch {
      // A broken sink must not turn a contract failure into something else.
    }
    throw error
  }
  const violation = (contract: ResponseContract<unknown>, issue: ResponseIssue): never => fail(contractFailure(contract, [issue]))
  const decode = <D>(contract: ResponseContract<D>, wire: unknown): D => {
    const result = decodeResponse(contract, wire)
    return result.ok ? result.value : fail(result.error)
  }

  return {
    async platform(contract, input, options = {}) {
      let status: number | undefined
      const context: PlatformClientContext = { idempotencyKey: options.idempotencyKey, onResponseStatus: (value) => { status = value } }
      // The router key is the operation; outputs are read as unknown and only the contract turns them into values.
      const call = (platformTransport as unknown as Record<string, PlatformCall>)[contract.operationId]!
      let output: unknown
      try {
        output = await call(input, { context, signal: options.signal })
      } catch (error) {
        // A 2xx whose body the link could not deserialize: the answer exists but is not JSON.
        if (status !== undefined && status >= 200 && status < 300 && !(error instanceof ORPCError)) {
          return violation(contract, { path: ROOT_PATH, code: 'invalid_json' })
        }
        throw error
      }
      if (status !== undefined && !contract.successStatuses.includes(status)) return violation(contract, { path: ROOT_PATH, code: 'unexpected_status' })
      return contract.body === 'empty' ? decode(contract, undefined) : decode(contract, output)
    },

    async console(contract, input) {
      const response = await consoleTransport.send(contract.request(input))
      if (!contract.successStatuses.includes(response.status)) return violation(contract, { path: ROOT_PATH, code: 'unexpected_status' })
      if (contract.body === 'empty') return decode(contract, undefined)
      if (response.body.kind === 'invalid') return violation(contract, { path: ROOT_PATH, code: 'invalid_json' })
      if (response.body.kind === 'empty') return violation(contract, { path: ROOT_PATH, code: 'missing' })
      return decode(contract, response.body.value)
    },
  }
}

/** The app's gateway: production transports and the console.warn reporter. */
export const apiGateway = createApiGateway({
  platformTransport: client,
  consoleTransport: defaultConsoleTransport,
  reportFailure: createConsoleWarnReporter(),
})
