// `GET /api/console/directory/groups`: the Directory group list through the
// console's same-origin proxy (appserver-go contract/directory GroupList).
// Directory people are always resolved; `items` is required.
import { z } from 'zod'
import type { Group } from '../../../model/contracts/console'
import { consoleContract } from '../define'
import { personReader } from './person'

const groupReader: z.ZodType<Group> = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  name: z.string(),
  slug: z.string(),
  path: z.string(),
  description: z.string(),
  about: z.string(),
  aboutUpdatedBy: personReader.nullable(),
  aboutUpdatedAt: z.string().nullable(),
  subgroupCount: z.number().int(),
  memberCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const groupsContract = consoleContract({
  operationId: 'consoleListDirectoryGroups',
  method: 'GET',
  routeTemplate: '/api/console/directory/groups',
  successStatuses: [200],
  reader: z.object({ items: z.array(groupReader) }).transform((list) => list.items),
  request: () => ({ method: 'GET', path: '/api/console/directory/groups' }),
})
