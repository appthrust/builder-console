import { expect, test } from 'bun:test'
import { platformRoutes } from './mock-platform'

const changes = '/api/v1/projects/commerce/databases/mitsumori-db/changes'
const pending = 'mitsumori-db-0002-create-estimates'
async function call(method: string, pathname: string, body?: unknown) {
  const url = new URL(pathname, 'http://mock.test')
  const response = await platformRoutes(new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), url)
  if (!response) throw new Error(`unhandled ${method} ${pathname}`)
  return { status: response.status, body: await response.json() }
}
const phases = async () => Object.fromEntries((await call('GET', changes)).body.data.map((change: { id: string; phase: string }) => [change.id, change.phase]))

test('mock database changes: one applied and one awaiting; approval reports ReadyToRun once, then Succeeded', async () => {
  await call('POST', '/api/v1/__mock/reset')
  expect(await phases()).toEqual({ 'mitsumori-db-0001-init': 'Succeeded', [pending]: 'AwaitingApproval' })
  expect((await call('POST', `${changes}/${pending}/approvals`, { decision: 'Maybe' })).status).toBe(400)
  expect(await call('POST', `${changes}/${pending}/approvals`, { decision: 'Approved' })).toMatchObject({ status: 202, body: { phase: 'ReadyToRun', approval: { approvedCount: 1 } } })
  expect((await call('POST', `${changes}/${pending}/approvals`, { decision: 'Approved' })).status).toBe(409)
  expect((await phases())[pending]).toBe('ReadyToRun')
  expect((await call('GET', changes)).body.data.find((change: { id: string }) => change.id === pending)).toMatchObject({ phase: 'Succeeded', latestRevision: { revision: 2 } })
  expect((await call('GET', '/api/v1/projects/commerce/databases/unknown-db/changes')).status).toBe(404)
  await call('POST', '/api/v1/__mock/data', { mode: 'forbidden' })
  expect((await call('GET', changes)).status).toBe(403)
  await call('POST', '/api/v1/__mock/reset')
})
