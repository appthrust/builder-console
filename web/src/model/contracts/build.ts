// Build domain values that arrive through the response boundary
// (api/contracts/platform/build.ts). Feature code reads these types.
import type { z } from 'zod'
import type { ApplicationDraft as CanonicalApplicationDraft } from '@appthrust/api-schema/platform-api'

/**
 * A draft read through the boundary: the canonical draft after parsing, so
 * `creationExecutions` is always an array (an older server's omission is read
 * as `[]`) and `architectureMarkdown` always a string. Enums are the
 * canonical closed sets for now: an unknown value is a contract failure, not a
 * guessed known value.
 */
export type BuildDraft = z.output<typeof CanonicalApplicationDraft>
