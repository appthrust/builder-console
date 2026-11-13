// `GET /api/console/directory/groups`: the Directory group list through the
// console's same-origin proxy (appserver-go contract/directory GroupList).
// Directory people are always resolved; `items` is required.
import { z } from 'zod'
import { group } from './schema/schemas'
import { operations } from './schema/operations'
import type { Group } from '../../../model/contracts/console'
import { consoleContract } from '../define'
import { personReader } from './person'

const groupReader: z.ZodType<Group> = group.extend({ aboutUpdatedBy: personReader.nullable() })

export const groupsContract = consoleContract({
  ...operations.groups,
  reader: z.object({ items: z.array(groupReader) }).transform((list) => list.items),
  request: () => ({ method: 'GET', path: '/api/console/directory/groups' }),
})
