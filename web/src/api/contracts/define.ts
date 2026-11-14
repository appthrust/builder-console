// Operation contracts per transport: the response contract (boundary) plus
// what the transport needs to make the call. Adapters in ./platform and
// ./console build their contracts with these and nothing else.
import { platformApiRouter } from '@appthrust/api-schema/platform-api-router'
import type { z } from 'zod'
import { defineEmptyResponseContract, defineResponseContract, type FieldPolicy, type HttpMethod, type ResponseContract } from '../boundary'
import type { PlatformApiClient } from '../client'
import type { ConsoleRequest } from '../console'
import { workspaceHTTPSessionRouter } from './platform/workspace-http-wire'

/**
 * The Platform operations the transport can call: the published router plus
 * operations a Platform release has but the published package does not yet
 * (mirrored in ./platform/*-wire.ts, each with its follow-up to drop the mirror).
 */
export const platformRouter = { ...platformApiRouter, ...workspaceHTTPSessionRouter }

export type PlatformOperation = keyof PlatformApiClient & string
export type PlatformInput<Op extends PlatformOperation> = PlatformApiClient[Op] extends (...args: infer A) => unknown ? A[0] : never

/** A Platform API operation; `operationId` is the oRPC router key the transport calls. */
export interface PlatformOperationContract<Op extends PlatformOperation, D> extends ResponseContract<D> {
  readonly source: 'platform'
  readonly operationId: Op
}

/** A Console server operation (`/api/console/*`, or `/config` with source `config`). */
export interface ConsoleOperationContract<I, D> extends ResponseContract<D> {
  readonly source: 'console' | 'config'
  readonly request: (input: I) => ConsoleRequest
}

type Identity = { method: HttpMethod; routeTemplate: string; successStatuses: readonly number[] }

export function platformContract<Op extends PlatformOperation, D>(
  spec: Identity & { operationId: Op; reader: z.ZodType<D>; fieldPolicies?: readonly FieldPolicy[] },
): PlatformOperationContract<Op, D> {
  return { ...defineResponseContract({ ...spec, source: 'platform' }), source: 'platform', operationId: spec.operationId }
}

export function consoleContract<I, D>(
  spec: Identity & { operationId: string; source?: 'console' | 'config'; reader: z.ZodType<D>; request: (input: I) => ConsoleRequest },
): ConsoleOperationContract<I, D> {
  const source = spec.source ?? 'console'
  return { ...defineResponseContract({ ...spec, source }), source, request: spec.request }
}

/** A Console operation answering 204 without a body. */
export function consoleEmptyContract<I>(
  spec: Identity & { operationId: string; request: (input: I) => ConsoleRequest },
): ConsoleOperationContract<I, void> {
  return { ...defineEmptyResponseContract({ ...spec, source: 'console' }), source: 'console', request: spec.request }
}
