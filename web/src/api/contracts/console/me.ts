// `GET /api/console/me` (cmd/server/internal/api/groups.go meResponse). The
// caller is always a resolved person with a subject; missing roles or group
// lists are failures, never an empty grant. An unknown view reads as `user`:
// the UI may widen it, never the wire.
import { z } from 'zod'
import { me } from './schema/schemas'
import { operations } from './schema/operations'
import type { Me } from '../../../model/contracts/console'
import { consoleContract } from '../define'
import { personReader } from './person'

const meReader: z.ZodType<Me> = me.strip().extend({
  person: personReader.and(z.object({ subject: z.string().min(1) })),
  migration: me.shape.migration.strip(),
  view: z.string().transform((value): Me['view'] => (value === 'maker' ? 'maker' : 'user')),
})

export const meContract = consoleContract({
  ...operations.me,
  reader: meReader,
  request: () => ({ method: 'GET', path: '/api/console/me' }),
})
