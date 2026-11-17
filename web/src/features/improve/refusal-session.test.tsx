// APT-1232: the improvement session's start admission follows Platform's (only a proposal being drafted or sent back
// for changes admits a run), and a refused start is taken back only when a read made after it shows the proposal
// changed and admitting a run again.
import { afterEach, beforeEach, expect, spyOn, test, type Mock } from 'bun:test'
import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { ORPCError } from '@orpc/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { preserveLanguage } from '../../../test/language'
import * as buildApi from '../../api/build'
import { getSourceChangeProposalContract } from '../../api/contracts/platform/proposal'
import { apiGateway } from '../../api/gateway'
import { buildDraftOptions } from '../../api/queries/build'
import { proposalKeys, proposalOptions } from '../../api/queries/proposal'
import { draftOf } from '../../api/testing/build-domain'
import { proposalOf, proposalWire } from '../../api/testing/proposal-domain'
import { POLL_INTERVAL_MS } from '../../api/queries/shared'
import type { BuildFailure } from '../../model/build/types'
import { setLanguage } from '../../shell/language'
import { useImproveSession } from './use-improve-session'

const at = '2026-11-17T00:00:00Z'
const tasks = [{ title: '一覧に絞り込みを足す', description: '状態で絞り込めるようにする。', acceptanceCriteria: ['絞り込める'] }]
const wire: ApplicationDraft = {
  id: 'draft-1', projectId: 'p1', kind: 'improvement', title: '見積作成', intent: '一覧に絞り込みを足したい', phase: 'created',
  specMarkdown: '', architectureMarkdown: '', creationPlanGenerations: [], conversationTurns: [], creationExecutions: [], implementationRuns: [], createdSourceRepositories: [],
  ownerUserId: 'owner', createdAt: at, updatedAt: at, createdApplicationId: 'mitsumori', createdApplicationStackId: 'mitsumori', proposalId: 'proposal-1',
  creationPlan: { summary: '絞り込み', markdown: '# 絞り込み', representation: ['ApplicationStack'], implementationHandoff: { summary: '絞り込み', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'existing-source-repository', tasks } },
}
const draft = draftOf(wire)
const sentBack = (count: number, updatedAt: string) => proposalWire({
  phase: 'ChangesRequested', updatedAt,
  decisions: Array.from({ length: count }, (_, index) => ({ subject: 'sub-yamada', decision: 'RequestChanges', comment: `直してほしいこと ${index + 1}`, at })),
})
const blocked = () => new ORPCError('CONFLICT', { status: 409, data: { body: { error: { code: 'source_change_proposal_run_blocked', message: 'source change proposal is awaiting review, applying, or closed' } } } })

let root: Root
let container: HTMLDivElement
let client: QueryClient
let restoreLanguage: () => void
let proposal: Record<string, unknown>
let proposalReads: number
let spies: Mock<(...args: never[]) => unknown>[]
/** What the tests read from the session. */
let session: { review?: string; reviewLocked: boolean; requestFailure?: BuildFailure; start(): void }

function Harness() {
  const value = useImproveSession('p1', draft)
  session = { review: value.review, reviewLocked: value.reviewLocked, requestFailure: value.implementation.requestFailure, start: value.start }
  return null
}

async function settle() {
  for (let index = 0; index < 8; index++) await act(async () => { await Bun.sleep(1) })
}

/** The next read of the proposal answers `next` (the page's poll, as the test drives it). */
async function nextRead(next: Record<string, unknown>) {
  proposal = next
  await act(async () => { await client.refetchQueries({ queryKey: proposalKeys.detail('p1', 'proposal-1') }) })
  await settle()
}

beforeEach(async () => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
  proposalReads = 0
  proposal = sentBack(1, '2026-11-17T00:01:00Z')
  spies = [
    spyOn(buildApi, 'createImplementationRun').mockRejectedValue(blocked()),
    spyOn(buildApi, 'getDraft').mockResolvedValue(draft),
    spyOn(apiGateway, 'platform').mockImplementation((async (contract: unknown) => {
      if (contract !== getSourceChangeProposalContract) throw new Error('unexpected Platform call')
      proposalReads++
      return proposalOf(proposal)
    }) as typeof apiGateway.platform),
  ] as unknown as Mock<(...args: never[]) => unknown>[]
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(buildDraftOptions('p1', draft.id).queryKey, draft)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>) })
  await settle()
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  client.clear()
  for (const spy of spies) spy.mockRestore()
  restoreLanguage()
})

test('a refusal is kept while reads show the same proposal, and taken back when a later read shows it sent back again', async () => {
  expect(session.reviewLocked).toBe(false)
  const before = proposalReads
  await act(async () => { session.start() })
  await settle()
  expect(session.requestFailure?.reasonCode).toBe('ProposalRunBlocked')
  // The refusal made the session read the proposal again; the same proposal keeps it (its submission is pending, say).
  expect(proposalReads).toBeGreaterThan(before)
  await nextRead(sentBack(1, '2026-11-17T00:01:00Z'))
  expect(session.requestFailure?.reasonCode).toBe('ProposalRunBlocked')
  // Reviewed and sent back for changes again between two reads: the same phase, but not the same proposal.
  await nextRead(sentBack(2, '2026-11-17T00:09:00Z'))
  expect(session.requestFailure).toBeUndefined()
  expect(session.reviewLocked).toBe(false)
})

test('the refusal is measured against the proposal as read when the start was requested, not when the refusal arrived', async () => {
  // The start goes out while the proposal reads as sent back once; its answer comes later.
  const answer = Promise.withResolvers<never>()
  spies[0]!.mockImplementationOnce((() => answer.promise) as never)
  await act(async () => { session.start() })
  await settle()
  // Meanwhile the owner reviewed it and sent it back again: Platform refused the start in between.
  await nextRead(sentBack(2, '2026-11-17T00:09:00Z'))
  await act(async () => { answer.reject(blocked()) })
  await settle()
  // The proposal is no longer the one the start was requested under, and it admits a run: the next read takes the refusal back.
  await nextRead(sentBack(2, '2026-11-17T00:09:00Z'))
  expect(session.requestFailure).toBeUndefined()
  expect(session.reviewLocked).toBe(false)
})

test('a proposal that could not be applied admits no start and says so, and keeps being read', async () => {
  await nextRead(proposalWire({ phase: 'ApplyFailed' }))
  expect(session.review).toBe('applyFailed')
  expect(session.reviewLocked).toBe(true)
  // Not closed: the page keeps reading it, as for a proposal awaiting review.
  const query = client.getQueryCache().find({ queryKey: proposalKeys.detail('p1', 'proposal-1') })!
  const interval = proposalOptions('p1', 'proposal-1').refetchInterval
  expect(typeof interval === 'function' ? interval(query as never) : interval).toBe(POLL_INTERVAL_MS)
})
