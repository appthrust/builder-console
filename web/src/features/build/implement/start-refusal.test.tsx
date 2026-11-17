// APT-1232: a 409 to an implementation start is either another tab's start (read back, never reported) or Platform's
// typed refusal of this start (said once, never retried).
import { afterEach, beforeEach, expect, spyOn, test, type Mock } from 'bun:test'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { ORPCError } from '@orpc/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { preserveLanguage } from '../../../../test/language'
import * as buildApi from '../../../api/build'
import { buildDraftOptions } from '../../../api/queries/build'
import { draftOf } from '../../../api/testing/build-domain'
import { buildCopy } from '../../../model/build/copy'
import { failureOffers } from '../../../model/build/failure'
import type { BuildFailure } from '../../../model/build/types'
import { setLanguage } from '../../../shell/language'
import { useImplementation } from './use-implementation'

const at = '2026-11-17T00:00:00Z'
const tasks = [{ title: '一覧に絞り込みを足す', description: '状態で絞り込めるようにする。', acceptanceCriteria: ['絞り込める'] }]
const wire: ApplicationDraft = {
  id: 'draft-1', projectId: 'p1', kind: 'improvement', title: '見積作成', intent: '一覧に絞り込みを足したい', phase: 'created',
  specMarkdown: '', architectureMarkdown: '', creationPlanGenerations: [], conversationTurns: [], creationExecutions: [], implementationRuns: [], createdSourceRepositories: [],
  ownerUserId: 'owner', createdAt: at, updatedAt: at, createdApplicationId: 'mitsumori', createdApplicationStackId: 'mitsumori', proposalId: 'proposal-1',
  creationPlan: { summary: '絞り込み', markdown: '# 絞り込み', representation: ['ApplicationStack'], implementationHandoff: { summary: '絞り込み', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'existing-source-repository', tasks } },
}
const draft = draftOf(wire)
const conflict = (code: string | undefined, message: string, details?: Record<string, unknown>) =>
  new ORPCError('CONFLICT', { status: 409, data: { body: { error: { ...(code ? { code } : {}), message, ...(details ? { details } : {}) } } } })

let root: Root
let container: HTMLDivElement
let client: QueryClient
let restoreLanguage: () => void
let created: Mock<typeof buildApi.createImplementationRun>
/** What the tests read from the hook: the start, its request failure, and taking a refusal back. */
let implementation: { requestFailure?: BuildFailure; startPending(): void; dismissRefusal(): void }

function Harness() {
  implementation = useImplementation({ projectId: 'p1', draft, handoff: draft.creationPlan?.implementationHandoff, enabled: true })
  return null
}

async function startOnce() {
  await act(async () => { implementation.startPending() })
  for (let index = 0; index < 5; index++) await act(async () => { await Bun.sleep(0) })
}

beforeEach(async () => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
  created = spyOn(buildApi, 'createImplementationRun')
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(buildDraftOptions('p1', draft.id).queryKey, draft)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>) })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  client.clear()
  created.mockRestore()
  restoreLanguage()
})

test('another tab\'s start is read back and never reported', async () => {
  const cases: { code?: string; details?: Record<string, unknown> }[] = [{ code: 'conflict' }, { code: 'idempotency_in_progress' }, {}, { code: 'conflict', details: { reason: 'idempotency_in_progress', retryable: true } }]
  for (const { code, details } of cases) {
    created.mockRejectedValueOnce(conflict(code, 'implementation run is running', details))
    await startOnce()
    expect(implementation.requestFailure).toBeUndefined()
  }
  expect(created).toHaveBeenCalledTimes(4)
})

test('a generic conflict whose reason names a refusal is that refusal, never another tab\'s start', async () => {
  created.mockRejectedValueOnce(conflict('conflict', 'source change proposal is awaiting review, applying, or closed', { reason: 'source_change_proposal_run_blocked' }))
  await startOnce()
  expect(implementation.requestFailure).toMatchObject({ kind: 'blocked', reasonCode: 'ProposalRunBlocked', ...buildCopy.failure.run.proposalPending })
  expect(failureOffers(implementation.requestFailure!).retry).toBe(false)

  await act(async () => { implementation.dismissRefusal() })
  created.mockRejectedValueOnce(conflict('conflict', 'the start is not admitted', { reason: 'StartNotAdmitted' }))
  await startOnce()
  expect(implementation.requestFailure).toMatchObject({ kind: 'blocked', title: buildCopy.failure.failed.implement, reason: buildCopy.failure.run.blocked, reference: { draftId: draft.id } })
  expect(implementation.requestFailure?.reasonCode).toBeUndefined()
  expect(failureOffers(implementation.requestFailure!).retry).toBe(false)
  expect(created).toHaveBeenCalledTimes(2)
})

test('a start refused because of the proposal is said once in the proposal\'s words, offers no retry, and is taken back when the proposal moves on', async () => {
  created.mockRejectedValueOnce(conflict('source_change_proposal_run_blocked', 'source change proposal is awaiting review, applying, or closed'))
  await startOnce()
  const failure = implementation.requestFailure
  expect(failure).toMatchObject({ kind: 'blocked', reasonCode: 'ProposalRunBlocked', ...buildCopy.failure.run.proposalPending })
  expect(failureOffers(failure!)).toEqual({ retry: false, skip: false, change: false })
  expect(failure?.reference).toBeUndefined()
  expect(created).toHaveBeenCalledTimes(1)

  await act(async () => { implementation.dismissRefusal() })
  expect(implementation.requestFailure).toBeUndefined()
})

test('any other typed refusal is said as a stopped start with its reference, never retried', async () => {
  created.mockRejectedValueOnce(conflict('idempotency_conflict', 'Idempotency-Key was already used with a different request'))
  await startOnce()
  const failure = implementation.requestFailure
  expect(failure).toMatchObject({ kind: 'blocked', title: buildCopy.failure.failed.implement, reason: buildCopy.failure.run.blocked, reference: { draftId: draft.id } })
  expect(failureOffers(failure!).retry).toBe(false)
  // Only a refusal because of the proposal is taken back by the proposal moving on.
  await act(async () => { implementation.dismissRefusal() })
  expect(implementation.requestFailure).toBeDefined()
})
