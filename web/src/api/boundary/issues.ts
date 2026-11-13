// Safe schema issues. A response issue names where a response broke its
// contract and how, never what it contained: object keys appear only when the
// reader schema declares them as fixed fields; array indexes, record keys and
// anything the schema does not name become `*`. Messages, inputs and values of
// the underlying ZodError are dropped here and never leave this module.
import type { z } from 'zod'

export type ResponseIssueCode = 'missing' | 'invalid_type' | 'invalid_value' | 'invalid_json' | 'unexpected_status'

export interface ResponseIssue {
  /** JSON-pointer-like schema path with `*` for every index or dynamic key; `/` is the whole body. */
  readonly path: string
  readonly code: ResponseIssueCode
}

/** Bounds on what a single failure carries, whatever the payload looked like. */
export const MAX_ISSUES = 10
const MAX_PATH_SEGMENTS = 24
const MAX_UNWRAP_DEPTH = 32
const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/

export const ROOT_PATH = '/'

type AnySchema = z.core.$ZodType
type Def = { type: string; [key: string]: unknown }

const def = (schema: AnySchema): Def => schema._zod.def as unknown as Def

/** Readers built from transforms (open unions) register the schemas they delegate to, so paths through them stay named. */
const delegates = new WeakMap<AnySchema, readonly AnySchema[]>()

export function registerDelegates(schema: AnySchema, children: readonly AnySchema[]): void {
  delegates.set(schema, children)
}

/** The concrete container schemas a value at this position may be validated against. */
function unwrap(schema: AnySchema, depth = 0): AnySchema[] {
  if (depth > MAX_UNWRAP_DEPTH) return []
  const registered = delegates.get(schema)
  if (registered) return registered.flatMap((child) => unwrap(child, depth + 1))
  const d = def(schema)
  switch (d.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return unwrap(d.innerType as AnySchema, depth + 1)
    case 'pipe':
      return [...unwrap(d.in as AnySchema, depth + 1), ...unwrap(d.out as AnySchema, depth + 1)]
    case 'lazy':
      return unwrap((d.getter as () => AnySchema)(), depth + 1)
    case 'union':
      return (d.options as AnySchema[]).flatMap((option) => unwrap(option, depth + 1))
    case 'intersection':
      return [...unwrap(d.left as AnySchema, depth + 1), ...unwrap(d.right as AnySchema, depth + 1)]
    default:
      return [schema]
  }
}

/** One path step: the safe segment text and the schemas that validate the child. */
function step(schemas: readonly AnySchema[], segment: PropertyKey): { text: string; next: AnySchema[] } {
  const containers = schemas.flatMap((schema) => unwrap(schema))
  if (typeof segment === 'string') {
    const fields = containers.flatMap((schema) => {
      const d = def(schema)
      if (d.type !== 'object') return []
      const shape = d.shape as Record<string, AnySchema>
      return Object.hasOwn(shape, segment) ? [shape[segment]!] : []
    })
    if (fields.length > 0 && FIELD_NAME.test(segment)) return { text: segment, next: fields }
  }
  const next = containers.flatMap((schema) => {
    const d = def(schema)
    if (d.type === 'array') return [d.element as AnySchema]
    if (d.type === 'record' || d.type === 'map') return [d.valueType as AnySchema]
    if (d.type === 'set') return [d.valueType as AnySchema]
    if (d.type === 'tuple') {
      const items = d.items as AnySchema[]
      const item = typeof segment === 'number' ? items[segment] : undefined
      return item ? [item] : d.rest ? [d.rest as AnySchema] : []
    }
    return []
  })
  return { text: '*', next }
}

/** The safe rendering of a raw issue path against the reader schema. */
export function safePath(schema: AnySchema, path: readonly PropertyKey[]): string {
  if (path.length === 0) return ROOT_PATH
  let schemas: AnySchema[] = [schema]
  const parts: string[] = []
  for (const segment of path.slice(0, MAX_PATH_SEGMENTS)) {
    const { text, next } = step(schemas, segment)
    parts.push(text)
    schemas = next
  }
  if (path.length > MAX_PATH_SEGMENTS) parts.push('…')
  return `/${parts.join('/')}`
}

/** Whether nothing is present at `path` in the wire value (the key, or one of its parents, is absent). */
function absentAt(wire: unknown, path: readonly PropertyKey[]): boolean {
  let current: unknown = wire
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || typeof segment === 'symbol') return true
    if (!Object.hasOwn(current, segment)) return true
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current === undefined
}

function codeOf(issue: z.core.$ZodIssue, wire: unknown): ResponseIssueCode {
  if (issue.code === 'invalid_type' || issue.code === 'invalid_union') {
    if (absentAt(wire, issue.path)) return 'missing'
    return issue.code === 'invalid_type' ? 'invalid_type' : 'invalid_value'
  }
  return 'invalid_value'
}

/** Bounded, deduplicated safe issues for a failed parse; the ZodError itself is not kept. */
export function safeIssues(schema: AnySchema, issues: readonly z.core.$ZodIssue[], wire: unknown): ResponseIssue[] {
  const seen = new Set<string>()
  const result: ResponseIssue[] = []
  for (const issue of issues) {
    const safe: ResponseIssue = { path: safePath(schema, issue.path), code: codeOf(issue, wire) }
    const key = `${safe.code} ${safe.path}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(safe)
    if (result.length >= MAX_ISSUES) break
  }
  return result.length > 0 ? result : [{ path: ROOT_PATH, code: 'invalid_value' }]
}
