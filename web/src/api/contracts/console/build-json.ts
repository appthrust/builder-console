import { buildSchemas, type BuildSchemaName } from './schema/build-sessions'

export class BuildContractError extends Error {
  constructor(readonly path: string) { super(`Invalid build contract at ${path}`) }
}
const pointer = (parts: readonly PropertyKey[]) => parts.length ? `/${parts.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}` : '/'

/** Reject duplicate keys before JSON.parse can discard their evidence. No repair,
 * trimming, Markdown fallback, or content-dependent error text crosses this API. */
export function parseBuildContract(name: BuildSchemaName, bytes: Uint8Array): unknown {
  if (name === 'BuildReply' && bytes.length > 32768) throw new BuildContractError('/')
  let text: string
  let value: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    value = JSON.parse(text)
  } catch { throw new BuildContractError('/') }
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? []
  let cursor = 0
  function visit(path: PropertyKey[], depth: number) {
    const token = tokens[cursor++]
    if (token !== '{' && token !== '[') return
    if (depth > 8) throw new BuildContractError(pointer(path))
    const end = token === '{' ? '}' : ']'
    const keys = new Set<string>()
    let index = 0
    while (tokens[cursor] !== end) {
      let key: string | number = index++
      if (token === '{') {
        key = JSON.parse(tokens[cursor++]!) as string
        if (keys.has(key)) throw new BuildContractError(pointer([...path, key]))
        keys.add(key)
        cursor++ // colon (syntax was checked by JSON.parse)
      }
      visit([...path, key], depth + 1)
      if (tokens[cursor] === ',') cursor++
    }
    cursor++
  }
  visit([], 1)
  const result = buildSchemas[name].safeParse(value)
  if (!result.success) {
    const paths = result.error.issues.flatMap((issue) => issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => pointer([...issue.path, key]))
      : [pointer(issue.path)])
    // Prefer an actionable field over a simultaneous whole-Reply text-budget error.
    throw new BuildContractError(paths.sort((a, b) => Number(a === '/') - Number(b === '/') || (a < b ? -1 : a > b ? 1 : 0))[0] ?? '/')
  }
  return result.data
}
