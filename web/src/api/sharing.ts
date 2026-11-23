import { queryOptions } from '@tanstack/react-query'
import { apiGateway } from './gateway'
import { assignOrganizationGroupsContract, removeOrganizationGroupsContract, shareAccessContract, shareDiffContract, startAccessCutoverContract } from './contracts/console/operations'

import type { ShareDiff } from './contracts/console/schema/share'
export type { ShareAccess, ShareDiff } from './contracts/console/schema/share'
export const readShareAccess = (appId: string) => apiGateway.console(shareAccessContract, appId)
export const readShareDiff = (appId: string) => apiGateway.console(shareDiffContract, appId)
export const shareAccessQuery = (appId: string) => queryOptions({ queryKey: ['console', 'share-access', appId], queryFn: () => readShareAccess(appId), retry: false })
export const assignOrganizationGroups = (appId: string, role: string, idempotencyKey: string) => apiGateway.console(assignOrganizationGroupsContract, { appId, role, idempotencyKey })
export const removeOrganizationGroups = (appId: string, binding: string, idempotencyKey: string) => apiGateway.console(removeOrganizationGroupsContract, { appId, binding, idempotencyKey })
export const startAccessCutover = (appId: string, diff: ShareDiff, idempotencyKey: string, previousDigest?: string) => apiGateway.console(startAccessCutoverContract, { appId, diff, idempotencyKey, previousDigest })
