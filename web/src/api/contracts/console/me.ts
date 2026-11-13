// `GET /api/console/me` (cmd/server/internal/api/groups.go meResponse). The
// caller is always a resolved person with a subject; missing roles or group
// lists are failures, never an empty grant.
import { z } from 'zod'
import type { Me } from '../../../model/contracts/console'
import { consoleContract } from '../define'
import { personReader } from './person'

const meReader: z.ZodType<Me> = z.object({
  person: personReader.and(z.object({ subject: z.string().min(1) })),
  effectiveGroupIds: z.array(z.string()),
  managedGroupIds: z.array(z.string()),
  isConsoleAdmin: z.boolean(),
  canCreateApps: z.boolean(),
  projectId: z.string().min(1),
  platformUnavailable: z.boolean().optional(),
  notMember: z.boolean().optional(),
  teamSlug: z.string().optional(),
  directoryPublicURL: z.string(),
  migration: z.object({ pending: z.boolean(), people: z.number(), groups: z.number(), memberships: z.number() }),
})

export const meContract = consoleContract({
  operationId: 'consoleGetMe',
  method: 'GET',
  routeTemplate: '/api/console/me',
  successStatuses: [200],
  reader: meReader,
  request: () => ({ method: 'GET', path: '/api/console/me' }),
})
