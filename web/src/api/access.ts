import { ORPCError } from '@orpc/client'
import type { ShareScope } from './console-unverified'
import { client } from './client'
import { platformErrorEnvelope } from './platform-error'
import { isPublishPreparationPending, publishPreparationRetryDelay } from './publish-retry'
import { sharingCopy } from '../copy/sharing'
import { accessRequest } from '../model/access'

export class AccessForbiddenError extends Error {
  constructor() { super(sharingCopy.forbidden) }
}

export function retryAccess(failureCount: number, error: unknown): boolean {
  return failureCount < 20 && platformErrorEnvelope(error)?.details?.reason === 'delivery_pending'
}

/** Automatic creation repair waits for rollout prerequisites; manual sharing keeps its existing policy. */
export function retryCreatedAppAccess(failureCount: number, error: unknown): boolean {
  return isPublishPreparationPending(error) || retryAccess(failureCount, error)
}

export function createdAppAccessRetryDelay(failureCount: number, error: unknown): number {
  return isPublishPreparationPending(error) ? publishPreparationRetryDelay(failureCount) : 3_000
}

export async function putAppAccess(projectId: string, publishId: string, scope: ShareScope, idempotencyKey: string) {
  try {
    return await client.platformApiPutPublishAccess({
      params: { projectId, publishId },
      headers: { 'Idempotency-Key': idempotencyKey },
      body: accessRequest(scope),
    })
  } catch (error) {
    if (error instanceof ORPCError && error.status === 403) throw new AccessForbiddenError()
    throw error
  }
}
