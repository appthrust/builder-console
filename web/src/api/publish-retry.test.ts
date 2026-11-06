import { describe, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { createdAppAccessRetryDelay, retryAccess, retryCreatedAppAccess } from './access'
import { isPublishPreparationPending, publishPreparationRetryDelay } from './publish-retry'

function error(status: number, code: string, reason?: string) {
  return new ORPCError('UNKNOWN', { status, data: { body: { error: { code, message: 'external authorization app installation and its publish must be Ready', details: { reason } } } } })
}

describe('publish preparation retries', () => {
  test('only typed readiness conflicts and in-progress operations are temporary', () => {
    expect(isPublishPreparationPending(error(409, 'app_installation_not_ready'))).toBe(true)
    for (const reason of ['ApplicationBranchRuntimeMigrationInProgress', 'OrganizationRenameInProgress']) {
      expect(isPublishPreparationPending(error(412, 'failed_precondition', reason))).toBe(true)
      expect(isPublishPreparationPending(error(409, 'conflict', reason))).toBe(false)
      expect(isPublishPreparationPending(error(412, 'other', reason))).toBe(false)
    }
  })

  test('preserves other client/server failures even with matching diagnostic text', () => {
    for (const status of [400, 401, 403, 404, 412, 429, 500, 502, 503, 504]) {
      expect(isPublishPreparationPending(error(status, 'app_installation_not_ready'))).toBe(false)
    }
    for (const code of ['conflict', 'idempotency_conflict', 'policy_conflict']) {
      expect(isPublishPreparationPending(error(409, code))).toBe(false)
    }
    // These reasons also cover missing configuration or mismatched identity, not just waiting.
    for (const reason of [undefined, 'placement_zone_not_ready', 'placement_capability_missing', 'PortUnresolved', 'branch_identity_mismatch', 'default_branch_unresolved', 'backend_projection_unavailable', 'publish_identity_unresolved']) {
      expect(isPublishPreparationPending(error(412, 'failed_precondition', reason))).toBe(false)
    }
    expect(isPublishPreparationPending(error(409, 'conflict', 'publish_url_conflict'))).toBe(false)
    expect(isPublishPreparationPending(new Error('app_installation_not_ready'))).toBe(false)
    expect(isPublishPreparationPending(undefined)).toBe(false)
  })

  test('uses 30 seconds, one minute, two minutes, then five minutes without giving up', () => {
    expect([0, 1, 2, 3, 4, 100].map(publishPreparationRetryDelay)).toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000])
  })

  test('automatic access setup waits without changing manual sharing or delivery retry policy', () => {
    const pending = error(409, 'app_installation_not_ready')
    for (const attempt of [0, 1, 2, 3, 4, 20, 100]) {
      expect(retryCreatedAppAccess(attempt, pending)).toBe(true)
      expect(createdAppAccessRetryDelay(attempt, pending)).toBe(publishPreparationRetryDelay(attempt))
      expect(retryAccess(attempt, pending)).toBe(false)
    }
    const delivery = error(409, 'conflict', 'delivery_pending')
    expect(retryCreatedAppAccess(19, delivery)).toBe(true)
    expect(retryCreatedAppAccess(20, delivery)).toBe(false)
    expect(createdAppAccessRetryDelay(19, delivery)).toBe(3_000)
    for (const rejected of [error(403, 'forbidden'), error(409, 'policy_conflict'), error(500, 'internal')]) {
      expect(retryCreatedAppAccess(0, rejected)).toBe(false)
    }
  })
})
