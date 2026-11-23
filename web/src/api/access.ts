import type { BusinessApp } from '../model/contracts/console'
import { syncShareContract } from './contracts/console/operations'
import { apiGateway } from './gateway'
import { platformErrorEnvelope } from './platform-error'
import { isPublishPreparationPending, publishPreparationRetryDelay } from './publish-retry'
import { sharingCopy } from '../copy/sharing'
import { isConsoleError } from './console'

export class AccessForbiddenError extends Error {
  constructor() { super(sharingCopy.forbidden) }
}

export function retryAccess(failureCount: number, error: unknown): boolean {
  return failureCount < 20 && (isConsoleError(error, 'share_policy_pending') || platformErrorEnvelope(error)?.details?.reason === 'delivery_pending')
}

export function isCreatedAppSharePending(error: unknown): boolean {
  return isConsoleError(error, 'share_publish_pending') || isConsoleError(error, 'share_policy_pending') || isPublishPreparationPending(error)
}

/** Automatic creation repair waits for rollout prerequisites; manual sharing keeps its existing policy. */
export function retryCreatedAppAccess(failureCount: number, error: unknown): boolean {
  return (failureCount < 20 && isCreatedAppSharePending(error)) || retryAccess(failureCount, error)
}

export function createdAppAccessRetryDelay(failureCount: number, error: unknown): number {
  return isPublishPreparationPending(error) ? publishPreparationRetryDelay(failureCount) : 3_000
}

/** The server owns the legacy-policy → fixed-binding write and divergence state. */
export async function applyAppShare(appId: string, idempotencyKey: string): Promise<BusinessApp> {
  try {
    return await apiGateway.console(syncShareContract, { appId, idempotencyKey })
  } catch (error) {
    if (isConsoleError(error) && error.status === 403) throw new AccessForbiddenError()
    throw error
  }
}
