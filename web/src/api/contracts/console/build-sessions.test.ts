import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { BuildContractError, parseBuildContract } from './build-json'
import { buildSessionContracts, buildSessionReader, buildTurnReader } from './build-sessions'
import { buildSchemas } from './schema/build-sessions'
import { buildSessionOperations } from './schema/build-session-operations'
import { openAPIDocument, replyJSONSchema } from './schema/generate'
import { decodeResponse, type ResponseContract } from '../../boundary'

const fixtureSchema = z.strictObject({ name: z.string(), schema: z.enum(Object.keys(buildSchemas) as [keyof typeof buildSchemas, ...Array<keyof typeof buildSchemas>]), raw: z.string(), expected: z.discriminatedUnion('accept', [z.strictObject({ accept: z.literal(true) }), z.strictObject({ accept: z.literal(false), path: z.string() })]) })
const fixtures = z.array(fixtureSchema).parse(JSON.parse(readFileSync(new URL('../../../../../cmd/server/internal/api/testdata/build-conversation.json', import.meta.url), 'utf8')))
const encoder = new TextEncoder()

test('the shared corpus covers every conversation schema with unique cases', () => {
  expect(new Set(fixtures.map((item) => item.name)).size).toBe(fixtures.length)
  const covered: string[] = [...new Set(fixtures.map((item) => item.schema))]
  expect(covered.sort()).toEqual(Object.keys(buildSchemas).sort())
})
for (const fixture of fixtures) test(`shared build contract: ${fixture.name}`, () => {
  if (fixture.expected.accept) expect(parseBuildContract(fixture.schema, encoder.encode(fixture.raw))).toEqual(JSON.parse(fixture.raw))
  else {
    let error: unknown
    try { parseBuildContract(fixture.schema, encoder.encode(fixture.raw)) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(BuildContractError)
    expect((error as BuildContractError).path).toBe(fixture.expected.path)
  }
})

test('the AgentTurn schema is derived, format-bearing, and within its input budget', () => {
  const raw = readFileSync(new URL('../../../../../cmd/server/internal/domain/build-reply.schema.json', import.meta.url), 'utf8')
  expect(JSON.parse(raw)).toEqual(replyJSONSchema())
  expect(encoder.encode(raw).length).toBeLessThanOrEqual(8192)
  expect(JSON.parse(raw).properties.turnId.format).toBe('uuid')
})

test('unknown session and progress values remain unknown, not actionable defaults', () => {
  const session = fixtures.find((item) => item.name === 'session-reader-future-lifecycle')!
  expect(buildSessionReader.parse(JSON.parse(session.raw)).lifecycle).toEqual({ kind: 'unknown' })
  const turn = fixtures.find((item) => item.name === 'turn-stage-unknown-reader')!
  expect(buildTurnReader.parse(JSON.parse(turn.raw)).progress?.stage).toEqual({ kind: 'unknown' })
  const future = fixtures.find((item) => item.name === 'turn-state-unknown-reader')!
  expect(buildTurnReader.parse(JSON.parse(future.raw)).nextAction).toEqual({ kind: 'unknown' })
})

test('all twelve internal operations have decodable resources and exact request preconditions', () => {
  const paths = openAPIDocument().paths
  expect(Object.keys(buildSessionOperations)).toHaveLength(12)
  for (const [key, operation] of Object.entries(buildSessionOperations)) {
    const contract: ResponseContract<unknown> = buildSessionContracts[key as keyof typeof buildSessionContracts]
    const fixture = fixtures.find((item) => item.expected.accept && item.schema === operation.schema)!
    expect(fixture).toBeDefined()
    expect(() => decodeResponse(contract, JSON.parse(fixture.raw))).not.toThrow()
    expect(contract.successStatuses).toEqual(operation.successStatuses)
    const declaration = paths[operation.routeTemplate.replace('/api/console', '')]![operation.method.toLowerCase()] as {
      parameters: Array<{ in: string; name: string; required: boolean }>
      requestBody?: { content: { 'application/json': { schema: { $ref: string } } } }
      responses: Record<string, { headers: Record<string, unknown> }>
    }
    expect(declaration.parameters.filter((p) => p.in === 'header').map((p) => [p.name, p.required])).toEqual(operation.method === 'GET' ? [] : key === 'create' ? [['Idempotency-Key', true]] : [['Idempotency-Key', true], ['If-Match', true]])
    if ('requestSchema' in operation) expect(declaration.requestBody?.content['application/json'].schema.$ref).toBe(`#/components/schemas/${operation.requestSchema}`)
    for (const status of operation.successStatuses) expect(declaration.responses[status]!.headers['Cache-Control']).toEqual({ required: true, schema: { type: 'string', const: 'no-store' } })
  }
})
