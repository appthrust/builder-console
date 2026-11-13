// Person readers shared by Console contracts. The console server marshals a
// person it can no longer resolve as `{ id, displayName: "", unknown: true }`
// (cmd/server/internal/domain/model.go Person.MarshalJSON); that becomes the
// explicit UnknownPerson variant, never a person with an invented email.
import { z } from 'zod'
import { selectVariant } from '../../boundary'
import type { Person, PersonRef, UnknownPerson } from '../../../model/contracts/console'

export const personReader: z.ZodType<Person> = z.object({
  id: z.string().min(1),
  subject: z.string().nullable(),
  pending: z.boolean(),
  email: z.string(),
  displayName: z.string(),
  avatarVersion: z.string().nullable(),
})

const unknownPersonReader: z.ZodType<UnknownPerson> = z.object({ unknown: z.literal(true), id: z.string().min(1) })

/** A Console person reference: resolved, or the explicit unknown variant. */
export const personRefReader: z.ZodType<PersonRef> = selectVariant(
  [unknownPersonReader, personReader],
  (input) => (typeof input === 'object' && input !== null && 'unknown' in input && input.unknown === true ? unknownPersonReader : personReader),
)
