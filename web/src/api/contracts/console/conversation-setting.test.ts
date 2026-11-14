import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { schemas } from './schema/schemas'
import { conversationSettingContracts, conversationSettingReader } from './conversation-setting'
import { conversationSettingOperations } from './schema/conversation-setting-operations'
import { openAPIDocument } from './schema/generate'
import { decodeResponse } from '../../boundary'

const fixtures = z.array(z.strictObject({
  name: z.string(), schema: z.enum(Object.keys(schemas) as [keyof typeof schemas, ...Array<keyof typeof schemas>]), raw: z.string(),
  expected: z.discriminatedUnion('accept', [
    z.strictObject({ accept: z.literal(true) }),
    z.strictObject({ accept: z.literal(false), path: z.string() }),
  ]),
})).parse(JSON.parse(readFileSync(new URL('../../../../../cmd/server/internal/api/testdata/conversation-setting.json', import.meta.url), 'utf8')))

for (const fixture of fixtures) test(`shared conversation setting contract: ${fixture.name}`, () => {
  const parsed = schemas[fixture.schema].safeParse(JSON.parse(fixture.raw))
  expect(parsed.success).toBe(fixture.expected.accept)
  if (!parsed.success) {
    if (fixture.expected.accept) throw new Error(`Valid fixture rejected: ${fixture.name}`)
    expect('/' + parsed.error.issues[0]!.path.join('/')).toBe(fixture.expected.path)
  } else expect(parsed.data).toEqual(JSON.parse(fixture.raw))
})

test('unknown mode retains known fields without granting a mode', () => {
  const wire = { mode: 'future', allowlist: [{ subject: 'unknown' }], version: 2 }
  expect(conversationSettingReader.parse(wire)).toEqual({ ...wire, mode: { kind: 'unknown' } })
  for (const contract of Object.values(conversationSettingContracts)) {
    const decoded = decodeResponse(contract, wire)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.value.mode).toEqual({ kind: 'unknown' })
  }
})

test('both admin operations publish the strong version precondition and shared response', () => {
  const paths = openAPIDocument().paths
  for (const operation of Object.values(conversationSettingOperations)) {
    const declaration = paths['/admin/conversation']![operation.method.toLowerCase()] as {
      parameters: Array<{ name: string; required: boolean }>
      requestBody?: { content: { 'application/json': { schema: { $ref: string } } } }
      responses: Record<string, { headers?: Record<string, unknown> }>
    }
    expect(declaration.parameters.map(({ name, required }) => [name, required])).toEqual(operation.method === 'PUT' ? [['If-Match', true]] : [])
    expect(declaration.responses[200]!.headers!.ETag).toEqual({ required: true, schema: { $ref: '#/components/schemas/ConversationSettingETag' } })
    expect(declaration.responses[412]).toBeDefined()
    expect(declaration.responses[428]).toBeDefined()
    if (operation.method === 'PUT') expect(declaration.requestBody!.content['application/json'].schema.$ref).toBe('#/components/schemas/ConversationSettingInput')
  }
  expect(new Set(fixtures.map(({ name }) => name)).size).toBe(fixtures.length)
  const covered = new Set(fixtures.map(({ schema }) => schema))
  for (const name of Object.keys(schemas).filter((name) => name.startsWith('ConversationSetting'))) expect(covered.has(name as keyof typeof schemas)).toBe(true)
})
