import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { responseSchemas } from './schema/generate'
import { operations } from './schema/operations'
import { decodeResponse, type ResponseContract } from '../../boundary'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import { consoleContracts } from './operations'

interface Schema {
  type?: string | string[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  anyOf?: Schema[]
  enum?: unknown[]
  const?: unknown
  presence?: 'total' | 'optionalObservation'
}
interface Fixture { name: string; schema: string; body: unknown }
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL('../../../../../cmd/server/internal/api/testdata/console-wire.json', import.meta.url), 'utf8'))
const schemaMap: Record<string, Schema> = JSON.parse(JSON.stringify(responseSchemas()))
const SECRET = 'SENTINEL-field-policy-861a'

function acceptsNull(schema: Schema): boolean {
  return schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')) || !!schema.anyOf?.some(acceptsNull)
}
function branchMatches(schema: Schema, value: unknown): boolean {
  if (schema.const !== undefined) return schema.const === value
  if (schema.enum) return schema.enum.includes(value)
  if (schema.anyOf) return schema.anyOf.some((branch) => branchMatches(branch, value))
  if (schema.type === 'null') return value === null
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return (schema.required ?? []).every((key) => Object.hasOwn(record, key)) && Object.entries(schema.properties ?? {}).every(([key, child]) => !Object.hasOwn(record, key) || branchMatches(child, record[key]))
  }
  if (schema.type === 'array') return Array.isArray(value)
  if (schema.type === 'integer') return Number.isInteger(value)
  return !schema.type || typeof value === schema.type
}
function optionalSample(schema: Schema): unknown {
  if (schema.const !== undefined) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.anyOf) return optionalSample(schema.anyOf.find((branch) => branch.type !== 'null')!)
  if (schema.type === 'boolean') return true
  if (schema.type === 'number' || schema.type === 'integer') return 1
  return 'https://optional.example.test/'
}
function changed(root: unknown, path: (string | number)[], key: string, value: unknown, omit = false): unknown {
  const result = structuredClone(root)
  let parent = result as Record<string | number, unknown>
  for (const segment of path) parent = parent[segment] as Record<string | number, unknown>
  if (omit) delete parent[key]
  else parent[key] = value
  return result
}

for (const [name, operation] of Object.entries(operations)) {
  if (!operation.schema) continue
  const contract: ResponseContract<unknown> = consoleContracts[name as keyof typeof consoleContracts]
  test(`${operation.operationId}: every declared field and nested collection obeys its presence policy`, () => {
    let exercised = 0
    for (const fixture of fixtures.filter((item) => item.schema === operation.schema)) {
      const accepted = decodeResponse(contract, fixture.body)
      expect(accepted.ok).toBe(true)
      function visit(schema: Schema, value: unknown, path: (string | number)[] = []) {
        if (schema.anyOf) {
          for (const branch of schema.anyOf) if (branchMatches(branch, value)) visit(branch, value, path)
          return
        }
        if (schema.type === 'array' && Array.isArray(value) && schema.items) {
          value.forEach((item, index) => visit(schema.items!, item, [...path, index]))
          return
        }
        if (!schema.properties || !value || typeof value !== 'object') return
        const object = value as Record<string, unknown>
        // Unknown fields at every object depth must be discarded, not retained
        // as contact data, write intent or diagnostic text.
        expect(decodeResponse(contract, changed(fixture.body, path, SECRET, SECRET))).toEqual(accepted)
        for (const [key, child] of Object.entries(schema.properties)) {
          const safePath = `/${[...path, key].map((part) => typeof part === 'number' ? '*' : part).join('/')}`
          const required = schema.required?.includes(key) ?? false
          const absent = changed(fixture.body, path, key, undefined, true)
          // Config deliberately drops an unvouched optional navigation URL.
          const nullAccepted = acceptsNull(child) || (operation.schema === 'Config' && key === 'dashboardUrl')
          assertWireContractCases(contract, [
            { name: `${fixture.name}: absent`, variant: 'absent', path: safePath, wire: absent, expect: { accept: !required } },
            { name: `${fixture.name}: null`, variant: 'null', path: safePath, wire: changed(fixture.body, path, key, null), expect: { accept: nullAccepted } },
          ])
          exercised += 2
          if (!required) {
            expect(child.presence).toBe('optionalObservation')
            assertWireContractCases(contract, [{ name: `${fixture.name}: observation present`, variant: 'present', path: safePath, wire: changed(fixture.body, path, key, optionalSample(child)), expect: { accept: true } }])
          }
          if (child.type === 'array') {
            expect(child.presence).toBe('total')
            assertWireContractCases(contract, [
              { name: 'observed empty', variant: 'empty', path: safePath, wire: changed(fixture.body, path, key, []), expect: { accept: true } },
              { name: 'object is not a list', variant: 'unknown', path: safePath, wire: changed(fixture.body, path, key, { [SECRET]: SECRET }), expect: { accept: false } },
              { name: 'broken list element', variant: 'unknown', path: safePath, wire: changed(fixture.body, path, key, [null]), expect: { accept: false } },
            ])
          }
          if (Object.hasOwn(object, key)) visit(child, object[key], [...path, key])
        }
      }
      visit(schemaMap[operation.schema]!, fixture.body)
    }
    expect(exercised).toBeGreaterThan(0)
  })
}

test('unknown membership roles, request states and tool errors cannot become known grants', () => {
  assertWireContractCases(consoleContracts.members, [{ name: 'new role', variant: 'unknown', path: '/items/*/role', wire: { items: [{ groupId: 'group', person: { id: 'person', subject: null, pending: true, email: '', displayName: '', avatarVersion: null }, role: SECRET, inheritedFrom: null }] }, expect: { accept: true, check: (value) => expect(value[0]!.role).toEqual({ kind: 'unknown' }) } }])
  assertWireContractCases(consoleContracts.myAccessRequest, [{ name: 'new state', variant: 'unknown', path: '/state', wire: { exists: true, appName: 'app', state: SECRET }, expect: { accept: true, check: (value) => { expect(value.exists && value.state).toEqual({ kind: 'unknown' }) } } }])
  assertWireContractCases(consoleContracts.tools, [{ name: 'new tool failure', variant: 'unknown', path: '/error', wire: { available: true, tools: [], error: SECRET }, expect: { accept: true, check: (value) => { expect(value.available && value.error).toEqual({ kind: 'unknown' }) } } }])
})
