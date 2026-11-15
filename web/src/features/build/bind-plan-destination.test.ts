// 「この内容で作る」 binds the plan's new repository to the destination the proposal showed when it was pressed,
// before anything is validated or approved (use-draft-creation.ts bindPlanDestination).
import { describe, expect, mock, test } from 'bun:test'
import type * as api from '../../api/build'
import { draftOf } from '../../api/testing/build-domain'
import { destinationOf, resolvedDestinationOf } from '../../api/testing/catalog-domain'
import type { BuildDraft } from '../../model/contracts/build'
import type { RepositoryDestination } from '../../model/contracts/catalog'
import { bindPlanDestination, draftFailure, PlanDestinationError } from './use-draft-creation'

const at = '2026-11-14T00:00:00Z'
const newRepository = { template: { repository: 'appthrust/template-nextjs', ref: 'main' }, destination: { repositoryName: 'mitsumori', visibility: 'private' }, destinationRevision: 'rd-ghcr-1', build: { mode: 'observed-image', ref: 'main' } }
const planned = (applicationSourceRepositoryRequest: unknown) => draftOf({
  id: 'draft-1', projectId: 'pj', title: '見積', intent: '見積を作る', phase: 'planned', ownerUserId: 'owner', specMarkdown: '', architectureMarkdown: '',
  creationExecutions: [], createdAt: at, updatedAt: at,
  // A plan the Platform could answer: a stack built from the created repository, with its hand-off.
  creationPlan: {
    summary: '見積', markdown: '# 見積', representation: ['SourceRepository', 'ApplicationStack'], toolPlan: [], applicationSourceRepositoryRequest,
    applicationStackRequest: {
      templateId: 'web', web: { componentName: 'web' }, database: { componentName: 'db' }, connection: { connectionName: 'db' }, applicationName: 'mitsumori',
      source: { kind: 'application-source-repository', sourceRepositoryId: 'created-source-repository' },
    },
    implementationHandoff: { summary: '見積', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'created-source-repository', tasks: [{ title: '見積', description: '見積を作る', acceptanceCriteria: ['見積が作れる'] }] },
  },
})
const moved = { revision: 'rd-builtin-2', registryNamespace: 'registry.appthrust.test/commerce' }

function world(destination: RepositoryDestination) {
  const readDestination = mock(async () => destination)
  const updateDraft = mock(async (_projectId: string, _draftId: string, payload: Parameters<typeof api.updateDraft>[2]) => ({ ...planned(newRepository), creationPlan: payload.creationPlan }) as BuildDraft)
  const receive = mock(async (_next: BuildDraft) => {})
  const stop = mock(() => {})
  return { deps: { readDestination, updateDraft: updateDraft as unknown as typeof api.updateDraft, receive, stop }, readDestination, updateDraft, receive, stop }
}

const stopOf = (promise: Promise<void>) => promise.then(() => undefined, (error: unknown) => error)

describe('bindPlanDestination', () => {
  test('the destination shown is the current one and the one the plan carries: nothing is written and the approval goes on', async () => {
    const { deps, updateDraft, receive, stop } = world(resolvedDestinationOf())
    await bindPlanDestination('pj', planned(newRepository), 'rd-ghcr-1', deps)
    expect(updateDraft).not.toHaveBeenCalled()
    expect(receive).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  test('a destination that moved after it was shown rebinds the plan to the current revision and stops for the user to approve again', async () => {
    const { deps, updateDraft, receive, stop } = world(resolvedDestinationOf(moved))
    const stopped = await stopOf(bindPlanDestination('pj', planned(newRepository), 'rd-ghcr-1', deps))
    expect(stopped).toBeInstanceOf(PlanDestinationError)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(updateDraft.mock.calls.map((call) => call[2])).toEqual([{ creationPlan: expect.objectContaining({ applicationSourceRepositoryRequest: { ...newRepository, destinationRevision: 'rd-builtin-2' } }) }])
    expect(receive).toHaveBeenCalledTimes(1)
    // The stop reads as the fixed "changed" notice, never as a server message.
    expect(draftFailure(stopped, 'prepare', { draftId: 'draft-1', at })).toMatchObject({ kind: 'destination', destination: 'changed' })
  })

  test('the plan already carries the current revision but the user was shown another one: the approval stops, nothing is written', async () => {
    // Review finding 2: the plan and Platform agree (B), the proposal showed A. Comparing with the plan alone went on.
    const { deps, updateDraft, stop } = world(resolvedDestinationOf(moved))
    const stopped = await stopOf(bindPlanDestination('pj', planned({ ...newRepository, destinationRevision: 'rd-builtin-2' }), 'rd-ghcr-1', deps))
    expect(draftFailure(stopped, 'prepare', { draftId: 'draft-1', at })).toMatchObject({ kind: 'destination', destination: 'changed' })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(updateDraft).not.toHaveBeenCalled()
  })

  test('an approval without a shown destination is not one: it stops even when the plan matches Platform', async () => {
    const { deps, updateDraft, stop } = world(resolvedDestinationOf())
    const stopped = await stopOf(bindPlanDestination('pj', planned(newRepository), undefined, deps))
    expect(stopped).toBeInstanceOf(PlanDestinationError)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(updateDraft).not.toHaveBeenCalled()
  })

  test('no resolved destination approves nothing and writes nothing', async () => {
    for (const destination of [destinationOf({ state: 'Blocked', reason: 'NotConfigured' }), destinationOf({ state: 'Migrating' })]) {
      const { deps, updateDraft, stop } = world(destination)
      const stopped = await stopOf(bindPlanDestination('pj', planned(newRepository), 'rd-ghcr-1', deps))
      expect(draftFailure(stopped, 'prepare', { draftId: 'draft-1', at })).toMatchObject({ kind: 'destination', destination: 'blocked' })
      expect(stop).toHaveBeenCalledTimes(1)
      expect(updateDraft).not.toHaveBeenCalled()
    }
  })

  test('an adoption plan has no destination to bind and reads none', async () => {
    const { deps, readDestination } = world(resolvedDestinationOf())
    await bindPlanDestination('pj', planned({ sourceConnectionId: 'github-source-207cb7ce', existing: { repository: 'acme/shared' } }), undefined, deps)
    expect(readDestination).not.toHaveBeenCalled()
  })
})
