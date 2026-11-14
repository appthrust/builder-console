import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkTree, findViolations, type Rule } from './check-response-boundaries'

const api = {
  'api/client.ts': 'export function createPlatformTransport() {}\nexport type PlatformApiClient = {}\n',
  'api/console.ts': 'export class ConsoleApiError extends Error {}\nexport function createConsoleTransport() {}\nexport const screenshotUrl = () => ""\n',
  'api/gateway.ts': 'export const apiGateway = {}\n',
  'api/barrel.ts': "export { createPlatformTransport as transport } from './client'\nexport * from './gateway'\n",
  'api/wire-barrel.ts': "export type { ApplicationDraft } from '@appthrust/api-schema/platform-api'\n",
  'api/contracts/console/schema/schemas.ts': 'export const app = {}\nexport type SchemaName = string\n',
  'api/console-wire-barrel.ts': "export * from './contracts/console/schema/schemas'\n",
  'api/contracts/console/schema/build-sessions.ts': 'export const buildSchemas = {}\n',
  'model/contracts/wire.ts': "export type { ApplicationDraft } from '@appthrust/api-schema/platform-api'\n",
}

function rulesOf(file: string, text: string): Rule[] {
  return findViolations(new Map(Object.entries({ ...api, [file]: text }))).filter((violation) => violation.file === file).map((violation) => violation.rule)
}

describe('findViolations', () => {
  test.each<[string, string, Rule[]]>([
    ['raw Platform client', "import { createPlatformTransport } from '../../api/client'", ['raw-platform-client']],
    ['type-only Platform client', "import type { PlatformApiClient } from '../../api/client'", ['raw-platform-client']],
    ['Console transport symbols', "import { createConsoleTransport } from '../../api/console'", ['raw-console-api']],
    ['Console namespace import', "import * as consoleModule from '../../api/console'", ['raw-console-api']],
    ['Console transport types', "import type { ConsoleTransport } from '../../api/console'", ['raw-console-api']],
    ['Console error class and URL helpers are fine', "import { ConsoleApiError, screenshotUrl } from '../../api/console'", []],
    ['the gateway is fine', "import { apiGateway } from '../../api/gateway'", []],
    ['a barrel re-exporting the client', "import { transport as raw } from '../../api/barrel'", ['raw-platform-client']],
    ['a re-export of the client from feature code', "export { createPlatformTransport } from '../../api/client'", ['raw-platform-client']],
    ['wire types', "import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'", ['wire-schema-import']],
    ['wire root package', "import { platformApiRouter } from '@appthrust/api-schema'", ['wire-schema-import']],
    ['wire types through a barrel', "import type { ApplicationDraft } from '../../api/wire-barrel'", ['wire-schema-import']],
    ['wire types re-exported by domain declarations', "import type { ApplicationDraft } from '../../model/contracts/wire'", ['wire-schema-import']],
    ['Console canonical schema', "import { app } from '../../api/contracts/console/schema/schemas'", ['wire-schema-import']],
    ['Console schema through a barrel', "import { app } from '../../api/console-wire-barrel'", ['wire-schema-import']],
    ['conversation canonical schema', "import { buildSchemas } from '../../api/contracts/console/schema/build-sessions'", ['wire-schema-import']],
    ['Console schema type assertion', "import type { SchemaName } from '../../api/contracts/console/schema/schemas'\nconst name = value as SchemaName", ['wire-cast', 'wire-schema-import']],
    ['dynamic import of the client', "const load = () => import('../../api/client')", ['raw-platform-client']],
    ['fetch', "await fetch('/api/v1/x')", ['direct-fetch']],
    ['window.fetch', "await window.fetch('/api/v1/x')", ['direct-fetch']],
    ['response.json()', 'const body = await response.json()', ['response-json']],
    ['Response.json(value) builds a response, it does not read one', 'const response = Response.json({})', []],
    [
      'cast to a wire type',
      "import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'\nconst draft = value as ApplicationDraft",
      ['wire-cast', 'wire-schema-import'],
    ],
    [
      'cast to a wire type through a namespace',
      "import type * as wire from '@appthrust/api-schema/platform-api'\nconst draft = value as wire.ApplicationDraft['phase']",
      ['wire-cast', 'wire-schema-import'],
    ],
    ['cast to a local type is fine', 'type Local = { a: string }\nconst local = value as Local', []],
  ])('%s', (_name, text, expected) => {
    expect(rulesOf('features/x/file.ts', text).sort()).toEqual(expected)
  })

  test('screens, models, routes and copy obey the same rules; tests and adapters own wire access', () => {
    for (const file of ['model/app.ts', 'routes/root.tsx', 'copy/build.ts', 'copy.ts', 'router.tsx', 'features/build/console-session-state.ts']) {
      const path = file.includes('/') ? '../'.repeat(file.split('/').length - 1) : './'
      expect(rulesOf(file, `import { createPlatformTransport } from '${path}api/client'`)).toEqual(['raw-platform-client'])
    }
    expect(rulesOf('model/contracts/build.ts', "import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'")).toEqual([])
    expect(rulesOf('model/contracts/build.ts', "export type { ApplicationDraft } from '@appthrust/api-schema/platform-api'")).toEqual(['wire-schema-import'])
    expect(rulesOf('model/contracts/console.ts', "import { buildSchemas } from '../../api/contracts/console/schema/build-sessions'")).toEqual(['wire-schema-import'])
    expect(rulesOf('model/contracts/console.ts', "import type { ConsoleTransport } from '../../api/console'")).toEqual(['raw-console-api'])
    expect(rulesOf('features/x/file.test.ts', "import { createPlatformTransport } from '../../api/client'")).toEqual([])
    expect(rulesOf('api/build-sessions.ts', "import { createConsoleTransport } from './console'")).toEqual([])
  })
})

describe('checkTree', () => {
  test.each<[Rule, string]>([
    ['raw-platform-client', "import { createPlatformTransport } from '../api/client'"],
    ['raw-console-api', "import { createConsoleTransport } from '../api/console'"],
    ['wire-schema-import', "import { buildSchemas } from '../api/contracts/console/schema/build-sessions'"],
    ['direct-fetch', "await globalThis.fetch('/api/console/v1/build-sessions')"],
    ['response-json', 'await response.json()'],
    ['wire-cast', "import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'\nconst draft = value as ApplicationDraft"],
  ])('a fixture breaking %s fails without any exemptions', (rule, text) => {
    const root = mkdtempSync(join(tmpdir(), 'response-boundaries-'))
    try {
      for (const [file, source] of Object.entries({ ...api, 'features/broken.ts': text })) {
        const path = join(root, file)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, source)
      }
      const result = checkTree(root)
      expect(result.violations.some((violation) => violation.rule === rule)).toBe(true)
      expect(result.problems).toContain(`features/broken.ts:${rule === 'wire-cast' ? 2 : 1} ${rule}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the source tree has no violations', () => {
    expect(checkTree().problems).toEqual([])
  })
})
