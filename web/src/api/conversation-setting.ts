// NEW-APP conversation setting client (APT-753): the Console administrator
// setting that decides whether `/new` starts the console-v1 conversation,
// stored in the Console database and edited on 基盤の設定. `GET`/`PUT
// /api/console/admin/conversation` go through the gateway and their canonical
// response contracts. The contract fixes the ETag to `"cs-<version>"`, so
// `If-Match` is formatted from the verified `version` in one place
// (`conversationSettingETag`) instead of being read from a response header.
import type { ResponseContract } from './boundary'
import { isConsoleError, type ConsoleApiError, type ConsoleRequest } from './console'
import { conversationSettingContracts } from './contracts/console/conversation-setting'
import { conversationSettingOperations } from './contracts/console/schema/conversation-setting-operations'
import type { ConsoleOperationContract } from './contracts/define'
import { apiGateway, type ApiGateway } from './gateway'
import type { ConversationSetting, ConversationSettingInput } from '../model/contracts/console'

const PATH = conversationSettingOperations.get.routeTemplate

/** The strong validator for `version`: the only place this setting's `If-Match` is formatted. */
export function conversationSettingETag(version: number): string {
  return `"cs-${version}"`
}

/** 412 `version_conflict`: another administrator saved since this read; re-read, never resend blindly. */
export function isConversationSettingConflict(error: unknown): error is ConsoleApiError {
  return isConsoleError(error, 'version_conflict') && error.status === 412
}

function operation<I, D>(contract: ResponseContract<D>, request: (input: I) => ConsoleRequest): ConsoleOperationContract<I, D> {
  return { ...contract, source: 'console', request }
}

const contracts = {
  get: operation(conversationSettingContracts.get, () => ({ method: 'GET', path: PATH, cache: 'no-store' })),
  put: operation(conversationSettingContracts.put, ({ body, version }: { body: ConversationSettingInput; version: number }) =>
    ({ method: 'PUT', path: PATH, body, headers: { 'If-Match': conversationSettingETag(version) } })),
}

export interface ConversationSettingApi {
  /** Console administrators only. */
  get(): Promise<ConversationSetting>
  /** `version` is the one the decision was made on: 428 without it, 412 `version_conflict` when stale. */
  put(body: ConversationSettingInput, version: number): Promise<ConversationSetting>
}

export function createConversationSettingApi(gateway: Pick<ApiGateway, 'console'> = apiGateway): ConversationSettingApi {
  return {
    get: () => gateway.console(contracts.get, undefined),
    put: (body, version) => gateway.console(contracts.put, { body, version }),
  }
}

export const conversationSettingApi = createConversationSettingApi()
