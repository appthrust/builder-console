// The mock's NEW-APP conversation setting follows the contract the SPA codes
// against: admin-only, strong ETag, 428/400/412 preconditions, validated body,
// and the dev `/config` flag computed per caller from it.
import { beforeEach, expect, test } from 'bun:test'
import { schemas } from '../api/contracts/console/schema/schemas'
import { consoleRoutes } from './mock-console'

const PATH = '/api/console/admin/conversation'

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(path, 'https://mock.test')
  const response = await consoleRoutes(new Request(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), url)
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  return response
}

const put = (body: unknown, ifMatch?: string) => call('PUT', PATH, body, ifMatch === undefined ? {} : { 'If-Match': ifMatch })
const caller = (personId: string, role: string) => call('POST', '/api/console/__mock/caller', { personId, role })
const flag = async () => ((await (await call('GET', '/api/console/__mock/config')).json()) as { newAppConversation: boolean }).newAppConversation

beforeEach(async () => {
  await call('POST', '/api/console/__mock/reset')
  await caller('p-yamada', 'Admin')
})

test('GET answers the seeded setting off at version 0 with its strong ETag, in the canonical wire', async () => {
  const response = await call('GET', PATH)
  expect(response.status).toBe(200)
  expect(response.headers.get('ETag')).toBe('"cs-0"')
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const body = await response.json()
  expect(body).toEqual({ mode: 'off', allowlist: [], version: 0 })
  expect(schemas.ConversationSetting.safeParse(body).success).toBe(true)
})

test('PUT needs If-Match: 428 without, 400 malformed, 412 version_conflict when stale; then saves with who and when', async () => {
  const body = { mode: 'allowlist', allowlist: [{ subject: 'sub-sato' }, { subject: 'sub-unknown' }] }
  expect((await put(body)).status).toBe(428)
  expect(await (await put(body)).json()).toMatchObject({ error: 'precondition_required' })
  expect((await put(body, 'cs-0')).status).toBe(400)
  const stale = await put(body, '"cs-7"')
  expect(stale.status).toBe(412)
  expect(await stale.json()).toMatchObject({ error: 'version_conflict', details: { currentVersion: 0 } })

  const saved = await put(body, '"cs-0"')
  expect(saved.status).toBe(200)
  expect(saved.headers.get('ETag')).toBe('"cs-1"')
  const wire = await saved.json()
  expect(schemas.ConversationSetting.safeParse(wire).success).toBe(true)
  expect(wire).toMatchObject({
    mode: 'allowlist', version: 1,
    // Names are resolved per answer; a subject the Directory does not know has none.
    allowlist: [{ subject: 'sub-sato', displayName: '佐藤 花子' }, { subject: 'sub-unknown' }],
    updatedBy: { id: 'p-yamada', displayName: '山田 太郎' },
  })
  expect(Date.parse(wire.updatedAt)).not.toBeNaN()
  expect((await put(body, '"cs-0"')).status).toBe(412)
})

test.each([
  ['an unknown mode', { mode: 'groups', allowlist: [] }],
  ['an extra field', { mode: 'on', allowlist: [], note: 'x' }],
  ['an entry with a name', { mode: 'allowlist', allowlist: [{ subject: 'sub-sato', displayName: '佐藤' }] }],
  ['a subject with a space', { mode: 'allowlist', allowlist: [{ subject: 'sub sato' }] }],
  ['201 entries', { mode: 'allowlist', allowlist: Array.from({ length: 201 }, (_, index) => ({ subject: `s-${index}` })) }],
  ['a subject listed twice', { mode: 'allowlist', allowlist: [{ subject: 'sub-sato' }, { subject: 'sub-suzuki' }, { subject: 'sub-sato' }] }],
])('PUT refuses %s with 400 and keeps the version', async (_, body) => {
  expect((await put(body, '"cs-0"')).status).toBe(400)
  expect((await (await call('GET', PATH)).json()).version).toBe(0)
})

test('only Console administrators read or write it (403 forbidden); a non-member gets not_project_member', async () => {
  await caller('p-yamada', 'Editor')
  expect((await call('GET', PATH)).status).toBe(403)
  expect(await (await put({ mode: 'on', allowlist: [] }, '"cs-0"')).json()).toMatchObject({ error: 'forbidden' })
  await caller('p-yamada', 'Admin')
  await call('POST', '/api/console/__mock/not-member', {})
  expect(await (await call('GET', PATH)).json()).toMatchObject({ error: 'not_project_member' })
})

test('/config follows the setting per caller: off, allowlist (listed or not), on', async () => {
  expect(await flag()).toBe(false)
  await put({ mode: 'allowlist', allowlist: [{ subject: 'sub-sato' }] }, '"cs-0"')
  expect(await flag()).toBe(false)
  await caller('p-sato', 'Editor')
  expect(await flag()).toBe(true)
  await caller('p-yamada', 'Admin')
  await put({ mode: 'on', allowlist: [{ subject: 'sub-sato' }] }, '"cs-1"')
  expect(await flag()).toBe(true)
  await put({ mode: 'off', allowlist: [{ subject: 'sub-sato' }] }, '"cs-2"')
  await caller('p-sato', 'Editor')
  expect(await flag()).toBe(false)
})
