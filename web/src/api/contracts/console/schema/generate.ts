import { z } from 'zod'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operations } from './operations'
import { schemas } from './schemas'

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
  return {
    openapi: '3.1.0',
    info: { title: 'Builder Console SPA API', version: '1.0.0', description: 'Generated from web/src/api/contracts/console/schema. Internal artifact; not served publicly.' },
    'x-appthrust-definition': 'builder-console',
    servers: [{ url: '/api/console' }], security: [{ bearerAuth: [] }], paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: responseSchemas() },
  }
}

if (import.meta.main) {
  const target = '../cmd/server/internal/api/console-spa.openapi.json'
  const generated = `${JSON.stringify(openAPIDocument(), null, 2)}\n`
  if (process.argv.includes('--check')) {
    const directory = await mkdtemp(join(tmpdir(), 'console-schema-'))
    try {
      const temporary = join(directory, 'console-spa.openapi.json')
      await Bun.write(temporary, generated)
      if (await Bun.file(temporary).text() !== await Bun.file(target).text()) {
        console.error('Console schema drift: run bun run generate:console-schema and review the generated artifact')
        process.exitCode = 1
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  } else {
    await Bun.write(target, generated)
  }
}
