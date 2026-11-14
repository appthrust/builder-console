// Reader helpers for forward compatibility (design §4, §5). A reader validates
// the known structure strictly and drops unknown fields (zod objects strip
// them). These helpers cover the three tolerated differences: a string enum
// value this client does not know, a union variant this client does not know,
// and a collection an older server omits when empty.
import { z } from 'zod'
import type { FieldPolicy } from './contract'
import { registerDelegates } from './issues'

/** An enum value: one this client knows, or explicitly not (never mapped onto a known one). */
export type OpenValue<K extends string> = { kind: 'known'; value: K } | { kind: 'unknown' }

/**
 * A string enum that tolerates values added later. A string outside `values`
 * becomes `{ kind: 'unknown' }` (the value itself is not kept); absent, null and
 * non-string values still fail unless the surrounding schema allows them.
 */
export function openEnum<const V extends readonly [string, ...string[]]>(values: V): z.ZodType<OpenValue<V[number]>> {
  const known = new Set<string>(values)
  return z.string().transform((value): OpenValue<V[number]> => (known.has(value) ? { kind: 'known', value: value as V[number] } : { kind: 'unknown' }))
}

/** A union variant: one this client implements, or one it does not (with its validated identity, so lists keep the item). */
export type Supported<T, I> = { kind: 'supported'; value: T } | { kind: 'unsupported'; identity: I }

/**
 * A discriminated union that tolerates variants added later. The discriminator
 * and the common identity are always validated. A known tag is validated
 * strictly against its variant: a broken known variant is a failure, never
 * `unsupported`. An unknown tag with a valid identity becomes `unsupported`.
 */
export function openUnion<I extends z.ZodObject, V extends Record<string, z.ZodType>>(spec: {
  discriminator: string
  identity: I
  variants: V
}): z.ZodType<Supported<z.output<V[keyof V]>, z.output<I>>> {
  const head = spec.identity.extend({ [spec.discriminator]: z.string() })
  const schema = z.unknown().transform((input, ctx): Supported<z.output<V[keyof V]>, z.output<I>> => {
    const identity = head.safeParse(input)
    if (!identity.success) {
      for (const issue of identity.error.issues) ctx.addIssue(issue as never)
      return z.NEVER
    }
    const tag = (identity.data as Record<string, unknown>)[spec.discriminator] as string
    const variant = Object.hasOwn(spec.variants, tag) ? spec.variants[tag] : undefined
    if (!variant) return { kind: 'unsupported', identity: spec.identity.parse(input) as z.output<I> }
    const parsed = variant.safeParse(input)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue(issue as never)
      return z.NEVER
    }
    return { kind: 'supported', value: parsed.data as z.output<V[keyof V]> }
  })
  registerDelegates(schema, [head, ...Object.values(spec.variants)])
  return schema
}

/** The wire value at `path`, or undefined when a step is missing. */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current = input
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || typeof segment === 'symbol' || !Object.hasOwn(current, segment)) return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

/**
 * Whether an issue is only something added later: a string outside a closed
 * enum or literal, a discriminator tag this client has no variant for, or a
 * field a strict object does not declare. A number, boolean or null out of set,
 * a missing or mistyped field and a failed refinement are not additions.
 */
function isAddition(issue: z.core.$ZodIssue, input: unknown): boolean {
  if (issue.code === 'unrecognized_keys') return true
  if (issue.code === 'invalid_value') return typeof valueAt(input, issue.path) === 'string'
  // zod reports a tag outside a discriminated union's variants with this note on the discriminator's path.
  if (issue.code === 'invalid_union') return 'note' in issue && issue.note === 'No matching discriminator' && typeof valueAt(input, issue.path) === 'string'
  return false
}

/**
 * A value this client can only act on whole (it sends it back, or every part
 * of it decides an action), validated against its canonical schema `full`.
 * When the only differences are additions (`isAddition`: a newer server's
 * values, tags or fields) it is `unsupported`, carrying the part this client
 * can still show, validated strictly by `overview`. Anything else broken is a
 * failure, never `unsupported`.
 */
export function supportedIfKnown<T, O>(full: z.ZodType<T>, overview: z.ZodType<O>): z.ZodType<Supported<T, O>> {
  const schema = z.unknown().transform((input, ctx): Supported<T, O> => {
    const parsed = full.safeParse(input)
    if (parsed.success) return { kind: 'supported', value: parsed.data }
    const broken = parsed.error.issues.filter((issue) => !isAddition(issue, input))
    const shown = overview.safeParse(input)
    if (broken.length === 0 && shown.success) return { kind: 'unsupported', identity: shown.data }
    for (const issue of broken.length ? broken : shown.error?.issues ?? []) ctx.addIssue(issue as never)
    return z.NEVER
  })
  registerDelegates(schema, [full, overview])
  return schema
}

/**
 * A closed union whose variant is chosen from the raw value (a flag rather
 * than a tag string). The chosen variant is validated strictly and its issues
 * keep their field paths; a value never falls through to another variant.
 */
export function selectVariant<V extends readonly [z.ZodType, ...z.ZodType[]]>(variants: V, select: (input: unknown) => V[number]): z.ZodType<z.output<V[number]>> {
  const schema = z.unknown().transform((input, ctx): z.output<V[number]> => {
    const parsed = select(input).safeParse(input)
    if (parsed.success) return parsed.data as z.output<V[number]>
    for (const issue of parsed.error.issues) ctx.addIssue(issue as never)
    return z.NEVER
  })
  registerDelegates(schema, variants)
  return schema
}

/**
 * A collection an older server omits when it is empty (Go `omitempty`):
 * absent becomes `[]`; null, a non-array or a broken element still fail.
 * Only for fields with recorded evidence; the policy must be listed in the
 * operation's contract (`fieldPolicies`) so its absent/null cases are tested.
 */
export function absentMeansEmpty<A extends z.ZodArray<z.ZodType>>(array: A, policy: { path: string; evidence: string }) {
  const fieldPolicy: FieldPolicy = { path: policy.path, presence: 'absent-means-empty', evidence: policy.evidence }
  return {
    schema: array.optional().transform((value): z.output<A> => value ?? ([] as z.output<A>)),
    policy: fieldPolicy,
  }
}
