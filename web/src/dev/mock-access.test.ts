import { expect, test } from 'bun:test'
import { platformRoutes } from './mock-platform'

const path = '/api/v1/projects/commerce/publishes/mitsumori-web/access'
async function call(method: string, pathname: string, body?: unknown, key?: string) {
  const url = new URL(pathname, 'http://mock.test')
  const response = await platformRoutes(new Request(url, { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), url)
  if (!response) throw new Error(`unhandled ${method} ${pathname}`)
  return { status: response.status, body: await response.json() }
}

test('mock access writes enforce keys and permission; one pending read then readiness and idempotent replay', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const input = { mode: 'Authenticated', externalAuthorization: { appInstallation: 'builder-console' } }
  expect((await call('PUT', path, input)).status).toBe(400)
  expect(await call('GET', path)).toEqual({ status: 200, body: { mode: 'Public' } })
  expect(await call('PUT', path, input, 'limited')).toMatchObject({ status: 200, body: { authorization: { external: { appInstallation: 'builder-console', path: '/authz' } }, pending: { reason: 'PolicyReferencesPending' } } })
  expect((await call('GET', path)).body.pending).toBeDefined()
  expect((await call('GET', path)).body.pending).toBeUndefined()
  await call('PUT', path, input, 'limited')
  expect((await call('GET', path)).body.pending).toBeUndefined()
  const before = await call('GET', path)
  await call('POST', '/api/v1/__mock/access-forbidden', { forbidden: true })
  expect((await call('PUT', path, { mode: 'Public' }, 'public')).status).toBe(403)
  expect(await call('GET', path)).toEqual(before)
  await call('POST', '/api/v1/__mock/reset')
})
