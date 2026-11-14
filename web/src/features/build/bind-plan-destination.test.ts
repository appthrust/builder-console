// 「この内容で作る」 binds the plan's new repository to the destination the proposal shows before
// anything is validated or approved (use-draft-creation.ts bindPlanDestination).
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

function world(destination: RepositoryDestination) {
  const readDestination = mock(async () => destination)
  const updateDraft = mock(async (_projectId: string, _draftId: string, payload: Parameters<typeof api.updateDraft>[2]) => ({ ...planned(newRepository), creationPlan: payload.creationPlan }) as BuildDraft)
  const receive = mock(async (_next: BuildDraft) => {})
  return { deps: { readDestination, updateDraft: updateDraft as unknown as typeof api.updateDraft, receive }, readDestination, updateDraft, receive }
}

describe('bindPlanDestination', () => {
  test('the destination shown is the one the plan carries: nothing is written and the approval goes on', async () => {
    const { deps, updateDraft, receive } = world(resolvedDestinationOf())
    await bindPlanDestination('pj', planned(newRepository), deps)
    expect(updateDraft).not.toHaveBeenCalled()
    expect(receive).not.toHaveBeenCalled()
  })

  test('a destination that moved rebinds the plan to the current revision and stops for the user to approve again', async () => {
    const { deps, updateDraft, receive } = world(resolvedDestinationOf({ revision: 'rd-builtin-2', registryNamespace: 'registry.appthrust.test/commerce' }))
    const stop = await bindPlanDestination('pj', planned(newRepository), deps).then(() => undefined, (error: unknown) => error)
    expect(stop).toBeInstanceOf(PlanDestinationError)
    expect(updateDraft.mock.calls.map((call) => call[2])).toEqual([{ creationPlan: expect.objectContaining({ applicationSourceRepositoryRequest: { ...newRepository, destinationRevision: 'rd-builtin-2' } }) }])
    expect(receive).toHaveBeenCalledTimes(1)
    // The stop reads as the fixed "changed" notice, never as a server message.
    expect(draftFailure(stop, 'prepare', { draftId: 'draft-1', at })).toMatchObject({ kind: 'destination', destination: 'changed' })
  })

  test('no resolved destination approves nothing and writes nothing', async () => {
    for (const destination of [destinationOf({ state: 'Blocked', reason: 'NotConfigured' }), destinationOf({ state: 'Migrating' })]) {
      const { deps, updateDraft } = world(destination)
      const stop = await bindPlanDestination('pj', planned(newRepository), deps).then(() => undefined, (error: unknown) => error)
      expect(draftFailure(stop, 'prepare', { draftId: 'draft-1', at })).toMatchObject({ kind: 'destination', destination: 'blocked' })
      expect(updateDraft).not.toHaveBeenCalled()
    }
  })

  test('an adoption plan has no destination to bind and reads none', async () => {
    const { deps, readDestination } = world(resolvedDestinationOf())
    await bindPlanDestination('pj', planned({ sourceConnectionId: 'github-source-207cb7ce', existing: { repository: 'acme/shared' } }), deps)
    expect(readDestination).not.toHaveBeenCalled()
  })
})
