import { platformErrorEnvelope } from './platform-error'

const PUBLISH_RETRY_DELAYS = [30_000, 60_000, 120_000, 300_000] as const

/** Only typed, self-resolving publish prerequisites; never retry a generic 409/412. */
export function isPublishPreparationPending(error: unknown): boolean {
  const envelope = platformErrorEnvelope(error)
  if (envelope?.status === 409) return envelope.code === 'app_installation_not_ready'
  if (envelope?.status !== 412 || envelope.code !== 'failed_precondition') return false
  return envelope.details?.reason === 'ApplicationBranchRuntimeMigrationInProgress'
    || envelope.details?.reason === 'OrganizationRenameInProgress'
}

/** Zero-based retry index. Keep trying every five minutes while the page is open. */
export function publishPreparationRetryDelay(retryIndex: number): number {
  return PUBLISH_RETRY_DELAYS[Math.min(retryIndex, PUBLISH_RETRY_DELAYS.length - 1)]!
}
