import { expect, test } from 'bun:test'
import { consoleRoutes } from '../../../dev/mock-console'
import { mockScreenPng } from '../../../dev/mock-images'
import { createTestGateway } from '../../testing/gateway'
import type { ConsoleOperationContract } from '../define'
import { consoleContracts as contracts } from './operations'
import { operations } from './schema/operations'
import { schemas } from './schema/schemas'

async function control(path: string, body?: unknown) {
  const url = new URL(`/api/console/__mock/${path}`, 'https://mock.test')
  const response = await consoleRoutes(new Request(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), url)
  expect(response?.status).toBe(200)
}

test('the in-memory Console API emits canonical wires for every supported SPA operation', async () => {
  const originalRole = process.env.MOCK_ROLE
  process.env.MOCK_ROLE = 'Admin'
  await control('reset')
  const seen = new Set<string>()
  async function call<I, D>(contract: ConsoleOperationContract<I, D>, input: I): Promise<D> {
    const operation = Object.values(operations).find((operation) => operation.operationId === contract.operationId)!
    const gateway = createTestGateway({ consoleFetch: async (path, init) => {
      const url = new URL(path, 'https://mock.test')
      const response = await consoleRoutes(new Request(url, init), url)
      if (!response) throw new Error(`Unhandled mock operation: ${contract.operationId}`)
      expect(contract.successStatuses, contract.operationId).toContain(response.status)
      if (operation.schema) {
        const wire: unknown = await response.clone().json()
        const result = schemas[operation.schema].safeParse(wire)
        expect(result.success, `${contract.operationId}: ${result.success ? '' : result.error.message}`).toBe(true)
      } else expect(await response.clone().text()).toBe('')
      seen.add(contract.operationId)
      return response
    } })
    return gateway.console(contract, input)
  }
  try {
    await call(contracts.me, undefined)
    await call(contracts.groups, undefined)
    await call(contracts.people, { ids: ['p-yamada'] })
    await call(contracts.person, 'p-yamada')
    await call(contracts.createPerson, { email: 'wire-parity@example.test', displayName: 'Wire parity' })
    await call(contracts.members, 'g-team-a')
    await call(contracts.directoryUsers, '高橋')
    await call(contracts.resolve, '/sales/east/team-a/mitsumori')
    await call(contracts.apps, {})
    await call(contracts.app, 'a-mitsumori')
    await call(contracts.appByPath, { groupPath: 'sales/east/team-a', slug: 'mitsumori' })
    await call(contracts.directoryApps, {})
    await call(contracts.directoryEntry, 'a-mitsumori')
    for (const state of ['list', 'empty', 'pending', 'unavailable', 'absent']) {
      await control('tools', { appId: 'a-mitsumori', state })
      await call(contracts.tools, 'a-mitsumori')
    }
    await call(contracts.settings, undefined)
    await call(contracts.migrateDirectory, undefined)
    await call(contracts.migrateDirectory, undefined)
    const app = await call(contracts.createApp, { displayName: 'Wire parity', groupId: 'g-team-a', slug: 'wire-parity', share: { scope: 'private', groupIds: [], extraPersonIds: [] } })
    await call(contracts.updateApp, { appId: app.id, input: { description: 'Updated' } })
    await call(contracts.bindApp, { appId: app.id, stackId: 'wire-parity-stack', appName: app.appName! })
    await call(contracts.comments, app.id)
    const comment = await call(contracts.postComment, { appId: app.id, body: 'Wire comment' })
    await call(contracts.removeComment, { appId: app.id, commentId: comment.id })
    const screenshot = await call(contracts.uploadScreenshot, { appId: app.id, file: new File([mockScreenPng([10, 20, 30], 0, 2, 3)], 'screen.png', { type: 'image/png' }) })
    await call(contracts.reorderScreenshots, { appId: app.id, order: [screenshot.id] })
    await call(contracts.removeScreenshot, { appId: app.id, screenshotId: screenshot.id })
    await control('caller', { personId: 'p-tanaka' })
    await call(contracts.myAccessRequest, app.appName!)
    await call(contracts.createAccessRequest, { appName: app.appName!, message: 'Please grant access' })
    await call(contracts.myAccessRequest, app.appName!)
    await control('caller', { personId: 'p-yamada', role: 'Admin' })
    await call(contracts.pendingAccessRequests, undefined)
    const requests = await call(contracts.appAccessRequests, app.id)
    const request = requests.find((request) => request.status.kind === 'known' && request.status.value === 'pending')!
    await call(contracts.declineAccessRequest, { appId: app.id, requestId: request.id })
    await control('caller', { personId: 'p-tanaka' })
    await call(contracts.myAccessRequest, app.appName!)
    await call(contracts.createAccessRequest, { appName: app.appName!, message: 'Please reconsider' })
    await control('caller', { personId: 'p-yamada', role: 'Admin' })
    const next = (await call(contracts.appAccessRequests, app.id)).find((request) => request.status.kind === 'known' && request.status.value === 'pending')!
    await call(contracts.approveAccessRequest, { appId: app.id, requestId: next.id })
    await call(contracts.removeApp, app.id)
    // /config is provided by Vite, not consoleRoutes; its actual Go handler and
    // bootstrap reader are exercised separately, without a made-up mock echo.
    expect([...seen].sort()).toEqual(Object.values(operations).filter((operation) => operation !== operations.config).map((operation) => operation.operationId).sort())
  } finally {
    if (originalRole === undefined) delete process.env.MOCK_ROLE
    else process.env.MOCK_ROLE = originalRole
    await control('reset')
  }
})
