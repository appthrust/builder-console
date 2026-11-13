import { describe, expect, test } from 'bun:test'
import { checkTree, compareWithAllowlist, countViolations, findViolations, type Rule } from './check-response-boundaries'

const api = {
  'api/client.ts': 'export const client = {}\nexport type PlatformApiClient = {}\n',
  'api/console.ts': 'export class ConsoleApiError extends Error {}\nexport const consoleTransport = {}\nexport function createConsoleTransport() {}\nexport const screenshotUrl = () => ""\n',
  'api/console-unverified.ts': 'export const consoleApi = {}\nexport type BusinessApp = {}\n',
  'api/gateway.ts': 'export const apiGateway = {}\n',
  'api/barrel.ts': "export { client } from './client'\nexport * from './gateway'\n",
  'api/wire-barrel.ts': "export type { ApplicationDraft } from '@appthrust/api-schema/platform-api'\n",
}

function rulesOf(file: string, text: string): Rule[] {
  return findViolations(new Map(Object.entries({ ...api, [file]: text }))).filter((violation) => violation.file === file).map((violation) => violation.rule)
}

describe('findViolations', () => {
  test.each<[string, string, Rule[]]>([
    ['raw Platform client', "import { client } from '../../api/client'", ['raw-platform-client']],
    ['type-only Platform client', "import type { PlatformApiClient } from '../../api/client'", ['raw-platform-client']],
    ['unverified Console facade', "import { consoleApi, type BusinessApp } from '../../api/console-unverified'", ['raw-console-api']],
    ['Console transport symbols', "import { consoleTransport } from '../../api/console'", ['raw-console-api']],
    ['Console namespace import', "import * as consoleModule from '../../api/console'", ['raw-console-api']],
    ['Console error class and URL helpers are fine', "import { ConsoleApiError, screenshotUrl } from '../../api/console'", []],
    ['the gateway is fine', "import { apiGateway } from '../../api/gateway'", []],
    ['a barrel re-exporting the client', "import { client } from '../../api/barrel'", ['raw-platform-client']],
    ['a re-export of the client from feature code', "export { client } from '../../api/client'", ['raw-platform-client']],
    ['wire types', "import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'", ['wire-schema-import']],
    ['wire root package', "import { platformApiRouter } from '@appthrust/api-schema'", ['wire-schema-import']],
    ['wire types through a barrel', "import type { ApplicationDraft } from '../../api/wire-barrel'", ['wire-schema-import']],
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

  test('scope: features and model, not model/contracts, api or tests', () => {
    const raw = "import { client } from '../api/client'"
    expect(rulesOf('model/app.ts', raw)).toEqual(['raw-platform-client'])
    expect(rulesOf('model/contracts/build.ts', "import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'")).toEqual([])
    expect(rulesOf('features/x/file.test.ts', "import { client } from '../../api/client'")).toEqual([])
    expect(rulesOf('api/queries/x.ts', "import { client } from '../client'")).toEqual([])
  })
})

describe('allowlist', () => {
  const violations = findViolations(new Map(Object.entries({ ...api, 'features/a.ts': "import { client } from '../api/client'\nawait fetch('/x')", 'features/b.ts': 'export const ok = 1' })))

  test('the counts per file and rule are the allowlist shape', () => {
    expect(countViolations(violations)).toEqual({ 'features/a.ts': { 'direct-fetch': 1, 'raw-platform-client': 1 } })
  })

  test('passes at the listed counts, fails on a new violation and on a stale entry', () => {
    expect(compareWithAllowlist(violations, { 'features/a.ts': { 'direct-fetch': 1, 'raw-platform-client': 1 } })).toEqual([])
    expect(compareWithAllowlist(violations, { 'features/a.ts': { 'raw-platform-client': 1 } })).toEqual([
      'new violation: features/a.ts direct-fetch (1 found, 0 allowed; lines 2)',
    ])
    expect(compareWithAllowlist(violations, { 'features/a.ts': { 'direct-fetch': 1, 'raw-platform-client': 2 }, 'features/gone.ts': { 'wire-cast': 1 } })).toEqual([
      'stale allowlist entry: features/a.ts raw-platform-client is 1 now (allowlist says 2); lower or delete the entry',
      'stale allowlist entry: features/gone.ts wire-cast is 0 now (allowlist says 1); lower or delete the entry',
    ])
  })

  test('the source tree matches the committed allowlist', () => {
    expect(checkTree().problems).toEqual([])
  })
})
