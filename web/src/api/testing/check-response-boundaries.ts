// check:response-boundaries (design §9). Feature and model code may read only
// domain values that came through the gateway. This check fails when code
// under features/** or model/** (except model/contracts/**; tests excluded):
//   raw-platform-client  imports the Platform transport (api/client)
//   raw-console-api      imports the unverified Console facade (api/console-unverified)
//                        or the Console transport factory/instance (api/console)
//   wire-schema-import   imports @appthrust/api-schema (wire input/output types or schemas)
//   direct-fetch         calls fetch() / window.fetch() / globalThis.fetch()
//   response-json        calls `.json()` on a response
//   wire-cast            asserts (`as` / `<T>`) to a type imported from the wire schema
// Type-only imports, `export … from` re-exports and src barrels that re-export
// any of the above count the same. Existing violations are listed per file and
// rule in response-boundary-allowlist.json, which may only shrink: a count
// above its entry fails (new violation), a count below it fails too (lower or
// delete the entry), so every migration also deletes its exemption.
//
// Run from web/: `bun src/api/testing/check-response-boundaries.ts`
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

export type Rule = 'raw-platform-client' | 'raw-console-api' | 'wire-schema-import' | 'direct-fetch' | 'response-json' | 'wire-cast'

export interface Violation {
  /** Path relative to web/src, `/`-separated. */
  file: string
  rule: Rule
  line: number
}

export type Allowlist = Record<string, Partial<Record<Rule, number>>>

/** src-relative module (no extension) → the rule importing it breaks. */
const RAW_MODULES: Record<string, Rule> = {
  'api/client': 'raw-platform-client',
  'api/console-unverified': 'raw-console-api',
}
/** Transport symbols of api/console; its error class and URL helpers stay importable. */
const RAW_CONSOLE_SYMBOLS: Record<string, true> = { createConsoleTransport: true, consoleTransport: true }
const WIRE_PACKAGE = '@appthrust/api-schema'
const FETCH_OWNERS: Record<string, true> = { window: true, globalThis: true, self: true }

export function inScope(file: string): boolean {
  if (/\.test\.tsx?$/.test(file)) return false
  if (file.startsWith('model/contracts/')) return false
  return file.startsWith('features/') || file.startsWith('model/')
}

const isWireSpecifier = (specifier: string) => specifier === WIRE_PACKAGE || specifier.startsWith(`${WIRE_PACKAGE}/`)

function resolveModule(files: ReadonlyMap<string, string>, from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = posix.normalize(posix.join(posix.dirname(from), specifier))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (files.has(candidate)) return candidate
  }
  return undefined
}

const moduleId = (file: string) => file.replace(/\.tsx?$/, '').replace(/\/index$/, '')

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

/** The rules a module breaks for its importers by re-exporting raw modules or the wire package (barrels, aliases). */
function reexportRules(files: ReadonlyMap<string, string>, file: string, seen = new Set<string>()): Set<Rule> {
  const rules = new Set<Rule>()
  if (moduleId(file).startsWith('api/contracts/console/schema/')) rules.add('wire-schema-import')
  if (seen.has(file)) return rules
  seen.add(file)
  const text = files.get(file)
  if (text === undefined) return rules
  for (const statement of parse(file, text).statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    for (const rule of specifierRules(files, file, statement.moduleSpecifier.text, exportedNames(statement), seen)) rules.add(rule)
  }
  return rules
}

function exportedNames(statement: ts.ExportDeclaration): string[] | undefined {
  const clause = statement.exportClause
  if (!clause || !ts.isNamedExports(clause)) return undefined
  return clause.elements.map((element) => (element.propertyName ?? element.name).text)
}

/** What importing `names` (undefined: everything) from `specifier` breaks. */
function specifierRules(files: ReadonlyMap<string, string>, from: string, specifier: string, names: string[] | undefined, seen = new Set<string>()): Set<Rule> {
  if (isWireSpecifier(specifier)) return new Set(['wire-schema-import'])
  const target = resolveModule(files, from, specifier)
  if (!target) return new Set()
  const id = moduleId(target)
  if (Object.hasOwn(RAW_MODULES, id)) return new Set([RAW_MODULES[id]!])
  if (id === 'api/console' && (names === undefined || names.some((name) => Object.hasOwn(RAW_CONSOLE_SYMBOLS, name)))) return new Set(['raw-console-api'])
  return reexportRules(files, target, seen)
}

function importedNames(clause: ts.ImportClause | undefined): string[] | undefined {
  if (!clause) return []
  const names: string[] = []
  if (clause.name) names.push('default')
  const bindings = clause.namedBindings
  if (bindings && ts.isNamespaceImport(bindings)) return undefined
  if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text)
  return names
}

/** Local names (and namespace aliases) bound to the wire package in this file, directly or through a barrel. */
function wireBindings(files: ReadonlyMap<string, string>, file: string, source: ts.SourceFile) {
  const names = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (!isWireSpecifier(specifier) && !reexportsWire(files, file, specifier)) continue
    const bindings = statement.importClause?.namedBindings
    if (statement.importClause?.name) names.add(statement.importClause.name.text)
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.add(element.name.text)
  }
  return { names, namespaces }
}

function reexportsWire(files: ReadonlyMap<string, string>, from: string, specifier: string): boolean {
  const target = resolveModule(files, from, specifier)
  return target !== undefined && reexportRules(files, target).has('wire-schema-import')
}

function referencesWire(node: ts.Node, wire: { names: Set<string>; namespaces: Set<string> }): boolean {
  let found = false
  const visit = (child: ts.Node) => {
    if (found) return
    if (ts.isTypeReferenceNode(child) || ts.isExpressionWithTypeArguments(child) || ts.isTypeQueryNode(child)) {
      const name = ts.isTypeReferenceNode(child) ? child.typeName : ts.isTypeQueryNode(child) ? child.exprName : child.expression
      let head: ts.Node = name
      while (ts.isQualifiedName(head) || ts.isPropertyAccessExpression(head)) head = ts.isQualifiedName(head) ? head.left : head.expression
      if (ts.isIdentifier(head) && (wire.names.has(head.text) || (head !== name && wire.namespaces.has(head.text)))) found = true
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

/** Every violation in the in-scope files of `files` (src-relative path → source text). */
export function findViolations(files: ReadonlyMap<string, string>): Violation[] {
  const violations: Violation[] = []
  for (const [file, text] of files) {
    if (!inScope(file)) continue
    const source = parse(file, text)
    const add = (rule: Rule, node: ts.Node) => violations.push({ file, rule, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
    const wire = wireBindings(files, file, source)
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const names = ts.isImportDeclaration(node) ? importedNames(node.importClause) : exportedNames(node)
        for (const rule of specifierRules(files, file, node.moduleSpecifier.text, names)) add(rule, node)
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          for (const rule of specifierRules(files, file, node.arguments[0].text, undefined)) add(rule, node)
        } else if (ts.isIdentifier(callee) && callee.text === 'fetch') {
          add('direct-fetch', node)
        } else if (ts.isPropertyAccessExpression(callee)) {
          if (callee.name.text === 'fetch' && ts.isIdentifier(callee.expression) && Object.hasOwn(FETCH_OWNERS, callee.expression.text)) add('direct-fetch', node)
          else if (callee.name.text === 'json' && node.arguments.length === 0) add('response-json', node)
        }
      } else if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && referencesWire(node.type, wire)) {
        add('wire-cast', node)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.line - b.line)
}

/** Per-file, per-rule counts, keys sorted: the allowlist shape. */
export function countViolations(violations: readonly Violation[]): Allowlist {
  const counts: Allowlist = {}
  for (const violation of violations) {
    const entry = (counts[violation.file] ??= {})
    entry[violation.rule] = (entry[violation.rule] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.keys(counts).sort().map((file) => [file, Object.fromEntries(Object.entries(counts[file]!).sort(([a], [b]) => a.localeCompare(b)))]),
  )
}

/** Problems of the tree against the allowlist; empty when the check passes. */
export function compareWithAllowlist(violations: readonly Violation[], allowlist: Allowlist): string[] {
  const problems: string[] = []
  const counts = countViolations(violations)
  for (const file of [...new Set([...Object.keys(counts), ...Object.keys(allowlist)])].sort()) {
    const rules = new Set([...Object.keys(counts[file] ?? {}), ...Object.keys(allowlist[file] ?? {})]) as Set<Rule>
    for (const rule of [...rules].sort()) {
      const found = counts[file]?.[rule] ?? 0
      const allowed = allowlist[file]?.[rule] ?? 0
      if (found > allowed) {
        const lines = violations.filter((violation) => violation.file === file && violation.rule === rule).map((violation) => violation.line)
        problems.push(`new violation: ${file} ${rule} (${found} found, ${allowed} allowed; lines ${lines.join(', ')})`)
      } else if (found < allowed) {
        problems.push(`stale allowlist entry: ${file} ${rule} is ${found} now (allowlist says ${allowed}); lower or delete the entry`)
      }
    }
  }
  return problems
}

/** web/src as a map of src-relative path → text (ts/tsx only). */
export function readSourceTree(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) files.set(relative(root, path).split(sep).join('/'), readFileSync(path, 'utf8'))
    }
  }
  walk(root)
  return files
}

export const SRC_ROOT = resolve(import.meta.dir, '../..')
export const ALLOWLIST_PATH = join(import.meta.dir, 'response-boundary-allowlist.json')

export function checkTree(root = SRC_ROOT, allowlistPath = ALLOWLIST_PATH): { violations: Violation[]; problems: string[] } {
  const violations = findViolations(readSourceTree(root))
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as Allowlist
  return { violations, problems: compareWithAllowlist(violations, allowlist) }
}

if (import.meta.main) {
  const { violations, problems } = checkTree()
  if (problems.length > 0) {
    console.error(`check:response-boundaries failed:\n- ${problems.join('\n- ')}`)
    process.exit(1)
  }
  console.log(`check:response-boundaries passed (${violations.length} allowlisted violations in ${Object.keys(countViolations(violations)).length} files; the allowlist may only shrink)`)
}
