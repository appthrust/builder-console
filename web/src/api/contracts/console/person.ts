// Person readers shared by Console contracts. The console server marshals a
// person it can no longer resolve as `{ id, displayName: "", unknown: true }`
// (cmd/server/internal/domain/model.go Person.MarshalJSON); that becomes the
// explicit UnknownPerson variant, never a person with an invented email.
import { z } from 'zod'
import { person, unknownPerson } from './schema/schemas'
import { selectVariant } from '../../boundary'
import type { Person, PersonRef, UnknownPerson } from '../../../model/contracts/console'

export const personReader: z.ZodType<Person> = person.extend({ unknown: z.literal(false).optional() })
  .transform(({ unknown: _unknown, ...value }) => value)

const unknownPersonReader: z.ZodType<UnknownPerson> = unknownPerson.strip().transform(({ id }) => ({ unknown: true as const, id }))

/** A Console person reference: resolved, or the explicit unknown variant. */
export const personRefReader: z.ZodType<PersonRef> = selectVariant(
  [unknownPersonReader, personReader],
  (input) => (typeof input === 'object' && input !== null && 'unknown' in input && input.unknown === true ? unknownPersonReader : personReader),
)
