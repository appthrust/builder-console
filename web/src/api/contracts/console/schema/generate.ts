import { z } from 'zod'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operations } from './operations'
import { schemas } from './schemas'
import { buildReply } from './build-sessions'
import { buildSessionOperations, type BuildOperation } from './build-session-operations'

export function responseSchemas() {
  return Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]))
}

/** Internal SPA artifact. The SDK-owned public OpenAPI document is unchanged. */
export function openAPIDocument() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const operation of Object.values(operations)) {
    if (operation === operations.directoryApps) continue
    const path = operation.routeTemplate.replace(/^\/api\/console/, '')
    const responseSchema = { $ref: `#/components/schemas/${operation.schema}` }
    const responses = Object.fromEntries(operation.successStatuses.map((status) => [String(status), {
      description: status === 204 ? 'No content' : 'Successful response',
      ...(operation.schema ? { content: { 'application/json': { schema: responseSchema } } } : {}),
    }]))
    responses.default = { description: 'HTTP error; never a success', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
    const parameters = Array.from(path.matchAll(/\{([^}]+)\}/g), ([, name]) => ({ name, in: 'path', required: true, schema: { type: 'string' } }))
    if (operation === operations.apps) {
      parameters.push(...['q', 'group'].map((name) => ({ name, in: 'query', required: false, schema: { type: 'string' } })))
    }
    const link = operation === operations.apps || operation === operations.app
    const declaration = {
      operationId: operation === operations.apps ? 'listApps' : operation === operations.app ? 'getApp' : operation.operationId,
      'x-console-operation-id': operation.operationId,
      ...(link ? { 'x-appthrust-link': true } : {}),
      ...(operation === operations.apps ? {
        'x-appthrust-result-path': 'items',
        'x-console-response-variants': [{ operationId: operations.directoryApps.operationId, query: { scope: 'directory' }, schema: { $ref: '#/components/schemas/DirectoryEntryList' } }],
      } : {}),
      ...(operation === operations.config ? { servers: [{ url: '/' }], security: [] } : {}),
      parameters,
      ...('multipart' in operation ? { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, caption: { type: 'string' } } } } } } } : {}),
      responses,
    }
    paths[path] ??= {}
    paths[path]![operation.method.toLowerCase()] = declaration
  }
  for (const operation of Object.values(buildSessionOperations) as BuildOperation[]) {
    const path = operation.routeTemplate.replace(/^\/api\/console/, '')
    const parameters: unknown[] = Array.from(path.matchAll(/\{([^}]+)\}/g), ([, name]) => ({
      name, in: 'path', required: true, schema: name === 'n' ? { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } : { type: 'string', format: 'uuid' },
    }))
    if (operation.headersSchema) {
      const headers = z.toJSONSchema(schemas[operation.headersSchema], { io: 'input' })
      for (const [name, schema] of Object.entries(headers.properties ?? {})) parameters.push({ name, in: 'header', required: true, schema })
    }
    if (operation.query === 'page') parameters.push(
      { name: 'cursor', in: 'query', required: false, schema: z.toJSONSchema(schemas.BuildListQuery.shape.cursor, { io: 'input' }) },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
    )
    if (operation.query === 'draft') parameters.push({ name: 'draftId', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 512 } })
    const headers = {
      'Cache-Control': { required: true, schema: { type: 'string', const: 'no-store' } },
      ...(operation.etag ? { ETag: { required: true, schema: { $ref: '#/components/schemas/BuildETag' } } } : {}),
      ...(operation.location ? { Location: { required: true, schema: { type: 'string', pattern: '^/api/console/v1/build-sessions/[^/]+/turns/[^/]+$' } } } : {}),
    }
    const responses: Record<string, unknown> = Object.fromEntries(operation.successStatuses.map((status) => [status, {
      description: 'Successful response', headers, content: { 'application/json': { schema: { $ref: `#/components/schemas/${operation.schema}` } } },
    }]))
    for (const status of [400, 401, 403, 404, 408, 409, 412, 413, 428, 429, 503, 507]) responses[status] = {
      description: 'Console error; never a success',
      headers: { 'Cache-Control': headers['Cache-Control'], ...([429, 503].includes(status) ? { 'Retry-After': { required: true, description: 'Integer delay in seconds, clamped to 1–300; defaults to 2 when absent or invalid upstream. A non-retryable failure still requires intervention.', schema: { type: 'integer', minimum: 1, maximum: 300 } } } : {}) },
      content: { 'application/json': { schema: { $ref: '#/components/schemas/BuildError' } } },
    }
    paths[path] ??= {}
    paths[path]![operation.method.toLowerCase()] = {
      operationId: operation.operationId, parameters, responses,
      ...(operation.requestSchema ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${operation.requestSchema}` } } } } } : {}),
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Builder Console SPA API', version: '1.0.0', description: 'Generated from web/src/api/contracts/console/schema. Internal artifact; not served publicly.' },
    'x-appthrust-definition': 'builder-console',
    servers: [{ url: '/api/console' }], security: [{ bearerAuth: [] }], paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: responseSchemas() },
  }
}

/** The exact compact schema supplied as an AgentTurn input; never handwritten. */
export function replyJSONSchema() {
  return { ...z.toJSONSchema(buildReply, { io: 'input' }), $id: 'urn:appthrust:builder-console:reply:1' }
}

if (import.meta.main) {
  const reply = `${JSON.stringify(replyJSONSchema())}\n`
  if (new TextEncoder().encode(reply).length > 8192) throw new Error('AgentTurn Reply schema exceeds the 8 KiB input budget')
  const artifacts = {
    'api/console-spa.openapi.json': `${JSON.stringify(openAPIDocument(), null, 2)}\n`,
    'domain/build-reply.schema.json': reply,
  }
  const directory = process.argv.includes('--check') ? await mkdtemp(join(tmpdir(), 'console-schema-')) : undefined
  try {
    for (const [name, generated] of Object.entries(artifacts)) {
      const target = `../cmd/server/internal/${name}`
      if (directory) {
        const temporary = join(directory, name)
        await Bun.write(temporary, generated)
        if (await Bun.file(temporary).text() !== await Bun.file(target).text()) {
          console.error(`Console schema drift in ${name}: run bun run generate:console-schema and review the generated artifacts`)
          process.exitCode = 1
        }
      } else await Bun.write(target, generated)
    }
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true })
  }
}
