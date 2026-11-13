// One shape in the app query cache: every writer (the app update, the build
// bind, the publish step's update and an approved access request) puts the
// decoded `BusinessApp` there through `writeAppCache`, the same value `appQuery`
// reads. A writer that stored its raw answer, a projection or the wizard's
// own form would differ from the next `appQuery` read of the same server state,
// and a write to the key that bypasses `writeAppCache` fails the source scan.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { Glob } from 'bun'
import { join } from 'node:path'
import { createApi } from '../create'
import { groupsQuery, appQuery, approveAccessRequest, updateApp, writeAppCache } from './console'
import { consoleRoutes } from '../../dev/mock-console'
import { platformRoutes } from '../../dev/mock-platform'
import { bindCreatedConsoleApp } from '../../features/build/bind-created-console-app'
import { canEditApp } from '../../features/app/permissions'
import { knownValue } from '../../model/contracts/build'
import type { BusinessApp } from '../../model/contracts/console'
import { shareSentence } from '../../model/share'

const originalFetch = globalThis.fetch
let client: QueryClient

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://console.test'), init)
  const url = new URL(request.url)
  const response = await (url.pathname.startsWith('/api/console/') ? consoleRoutes : platformRoutes)(request, url)
  return response ?? Response.json({ error: { message: 'unhandled' } }, { status: 404 })
}

beforeEach(async () => {
  globalThis.fetch = mockFetch as typeof globalThis.fetch
  for (const path of ['/api/console/__mock/reset', '/api/v1/__mock/reset']) await mockFetch(path, { method: 'POST' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  client.clear()
  globalThis.fetch = originalFetch
})

/** Writes `answered` as its writer does, then reads the same app through `appQuery`: both must be the same value. */
async function expectOneShape(answered: BusinessApp) {
  await writeAppCache(client, answered)
  const { queryKey } = appQuery(answered.id)
  const cached = client.getQueryData(queryKey)!
  const read = await client.fetchQuery({ ...appQuery(answered.id), staleTime: 0 })
  expect(cached).toEqual(read)
  // What appQuery's consumers read of it works on the cached value as written.
  expect(knownValue(cached.share.scope)).toBe(knownValue(read.share.scope))
  expect(shareSentence(cached.share, [], cached.group)).toBe(shareSentence(read.share, [], read.group))
  expect(canEditApp(cached, undefined)).toBe(false)
}

describe('the app query cache holds one shape', () => {
  test('the app update and the publish step (PATCH answer)', async () => {
    await expectOneShape(await updateApp('a-mitsumori', { displayName: '見積作成 v2' }))
  })

  test('an approved access request (the answer\'s app)', async () => {
    const approved = await approveAccessRequest('a-keihi', 'aar-keihi-suzuki')
    expect(approved.app.share.extraPersonIds).toContain('p-suzuki')
    await expectOneShape(approved.app)
  })

  test('the build bind (bind answer), whose created app the build page then reads through appQuery', async () => {
    const team = (await client.fetchQuery(groupsQuery)).find((group) => group.path === 'sales/east/team-a')!
    const bound = await bindCreatedConsoleApp(
      { projectId: 'commerce', displayName: '見積を管理', description: '', tags: [], groupId: team.id, urlName: 'quote-manager', share: { scope: 'private', groupIds: [], extraPersonIds: [] } },
      { stackId: 'quote-manager' },
      { api: createApi, onCreatedAppId: () => {} },
    )
    expect(bound.stackId).toBe('quote-manager')
    await expectOneShape(bound)
  })

  test('the wizard resume read decodes the same value (it keeps its own key, never the app cache)', async () => {
    const resumed = await createApi.app('a-mitsumori')
    expect(resumed).toEqual(await client.fetchQuery(appQuery('a-mitsumori')))
  })

  test('nothing writes the app key except writeAppCache', async () => {
    const root = join(import.meta.dir, '../..')
    const offenders: string[] = []
    for await (const file of new Glob('**/*.{ts,tsx}').scan(root)) {
      if (/\.test\.tsx?$/.test(file)) continue
      const source = await Bun.file(join(root, file)).text()
      for (const call of source.matchAll(/\.set(?:Query|Queries)Data(?:<[^>]*>)?\(([^\n]{0,160})/g)) {
        if (/consoleKeys\.app\(|appQuery\(|['"]console['"],\s*['"]app['"]/.test(call[1] ?? '')) offenders.push(`${file}: ${call[0]}`)
      }
    }
    const writer = await Bun.file(join(root, 'api/queries/console.ts')).text()
    expect(writer).toContain('queryClient.setQueryData(queryKey, app)')
    expect(offenders).toEqual([])
  })
})
