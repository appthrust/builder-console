// APT-1232: a 409 to an implementation start is either another tab's start (its run shows in the draft read back,
// never reported) or a refusal of this start: Platform's typed refusal (said once, never retried) or an untyped
// conflict after which the draft read back shows no new run.
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
let reads: Mock<typeof buildApi.getDraft>
/** What the tests read from the hook: the start, its request failure, confirming it, and taking a refusal back. */
let implementation: { requestFailure?: BuildFailure; startPending(): void; confirm(): void; dismissRefusal(): void }

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
  // The draft read back after an untyped conflict: unchanged unless a test says another tab started a run.
  reads = spyOn(buildApi, 'getDraft').mockResolvedValue(draft)
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
  reads.mockRestore()
  restoreLanguage()
})

/** The draft as another tab left it: its run, finished, is the latest. */
const startedElsewhere = (id: string) => draftOf({ ...wire, implementationRuns: [{ id, status: 'succeeded', startedAt: at, finishedAt: at, devWorkspaceId: 'ws', taskIds: [], tasks: [] }] })

test('another tab\'s start is read back and never reported', async () => {
  const cases: { code?: string; details?: Record<string, unknown> }[] = [{ code: 'conflict' }, { code: 'idempotency_in_progress' }, {}, { code: 'conflict', details: { reason: 'idempotency_in_progress', retryable: true } }]
  for (const [index, { code, details }] of cases.entries()) {
    created.mockRejectedValueOnce(conflict(code, 'implementation run is running', details))
    reads.mockResolvedValueOnce(startedElsewhere(`run-elsewhere-${index}`))
    await startOnce()
    expect(reads).toHaveBeenCalledTimes(index + 1)
    expect(client.getQueryData<typeof draft>(buildDraftOptions('p1', draft.id).queryKey)?.implementationRuns.at(-1)?.id).toBe(`run-elsewhere-${index}`)
    expect(implementation.requestFailure).toBeUndefined()
  }
  expect(created).toHaveBeenCalledTimes(4)
})

test('an untyped conflict after which no other start shows is a refusal of this start, with a reference', async () => {
  created.mockRejectedValueOnce(conflict('conflict', 'source change proposal is being withdrawn'))
  await startOnce()
  expect(reads).toHaveBeenCalledTimes(1)
  expect(implementation.requestFailure).toMatchObject({ kind: 'failed', reasonCode: 'StartRefused', title: buildCopy.failure.failed.implement, reason: buildCopy.failure.retry, reference: { draftId: draft.id } })
  expect(created).toHaveBeenCalledTimes(1)
})

test('a draft read already in flight when the conflict comes back is not the read-back: a new read shows the other tab\'s run', async () => {
  // A poll that started before the start, and answers (without the other tab's run) only after the conflict.
  const early = Promise.withResolvers<typeof draft>()
  reads.mockImplementationOnce(() => early.promise)
  const poll = client.fetchQuery({ ...buildDraftOptions('p1', draft.id), staleTime: 0 }).catch(() => undefined)
  created.mockRejectedValueOnce(conflict('conflict', 'implementation run is running'))
  reads.mockResolvedValueOnce(startedElsewhere('run-elsewhere'))
  await startOnce()
  await act(async () => { early.resolve(draft) })
  await act(async () => { await poll })
  for (let index = 0; index < 5; index++) await act(async () => { await Bun.sleep(0) })
  expect(reads).toHaveBeenCalledTimes(2)
  expect(implementation.requestFailure).toBeUndefined()
  expect(created).toHaveBeenCalledTimes(1)
})

test('a read-back that fails after an untyped conflict is said as unconfirmed, never as a refusal', async () => {
  created.mockRejectedValueOnce(conflict('conflict', 'implementation run is running'))
  reads.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  await startOnce()
  expect(implementation.requestFailure).toMatchObject({ kind: 'unconfirmed', ...buildCopy.failure.unconfirmed })
  expect(implementation.requestFailure?.reasonCode).toBeUndefined()
  expect(failureOffers(implementation.requestFailure!).retry).toBe(false)
})

test('confirming a plain conflict whose read-back failed reads again and decides it: no new run is a refusal, a new run is observed', async () => {
  const confirmOnce = async () => {
    await act(async () => { implementation.confirm() })
    for (let index = 0; index < 5; index++) await act(async () => { await Bun.sleep(0) })
  }
  created.mockRejectedValueOnce(conflict('conflict', 'source change proposal is being withdrawn'))
  reads.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  await startOnce()
  expect(implementation.requestFailure?.kind).toBe('unconfirmed')
  // The read now answers, without another start: Platform refused this one.
  reads.mockResolvedValueOnce(draft)
  await confirmOnce()
  expect(implementation.requestFailure).toMatchObject({ kind: 'failed', reasonCode: 'StartRefused', title: buildCopy.failure.failed.implement })

  // Again, and this time the read shows another tab's run: it is observed, nothing is reported.
  created.mockRejectedValueOnce(conflict('conflict', 'implementation run is running'))
  reads.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  await startOnce()
  expect(implementation.requestFailure?.kind).toBe('unconfirmed')
  reads.mockResolvedValueOnce(startedElsewhere('run-elsewhere'))
  await confirmOnce()
  expect(implementation.requestFailure).toBeUndefined()
  // Confirming never sends the start again.
  expect(created).toHaveBeenCalledTimes(2)
  expect(reads).toHaveBeenCalledTimes(4)
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
