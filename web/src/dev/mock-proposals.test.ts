import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SourceChangeProposal, SourceChangeProposalDiffResponse } from '@appthrust/api-schema/platform-api'
import { consoleRoutes } from './mock-console'
import { platformRoutes } from './mock-platform'

const project = '/api/v1/projects/commerce'
async function call(method: string, path: string, body?: unknown) {
  const url = new URL(path, 'http://mock.test')
  const request = new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const response = await platformRoutes(request, url) ?? await consoleRoutes(request, url)
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  return { status: response.status, body: await response.json() }
}
const caller = (personId: string) => call('POST', '/api/console/__mock/caller', { personId, role: 'Editor' })

beforeEach(async () => {
  await call('POST', '/api/console/__mock/reset')
  await call('POST', '/api/v1/__mock/reset')
})
afterEach(async () => { await call('POST', '/api/console/__mock/reset') })

async function propose() {
  const created = await call('POST', `${project}/application-drafts`, { kind: 'improvement', applicationStackId: 'mitsumori', title: '見積作成', intent: '一覧に絞り込みを足したい', reviewers: ['spoofed-reviewer'] })
  expect(created.status).toBe(201)
  const path = `${project}/application-drafts/${created.body.id}`
  for (const message of ['一覧に絞り込みを足したい', '状態で絞り込みたい']) {
    await call('POST', `${path}/conversation-turns`, { message })
    await call('POST', '/api/v1/__mock/advance')
  }
  await call('POST', `${path}/implementation-runs`)
  for (let i = 0; i < 4; i++) await call('POST', '/api/v1/__mock/advance')
  const inProgress = (await call('GET', path)).body
  expect((await call('GET', `${project}/source-change-proposals/${inProgress.proposalId}`)).body.phase).toBe('Drafting')
  for (let i = 0; i < 8; i++) await call('POST', '/api/v1/__mock/advance')
  const draft = (await call('GET', path)).body
  const proposal = SourceChangeProposal.parse((await call('GET', `${project}/source-change-proposals/${draft.proposalId}`)).body)
  expect(proposal.phase).toBe('Proposed')
  expect(draft.implementationRuns.at(-1).tasks.every((task: { versionLabel?: string }) => !task.versionLabel)).toBe(true)
  return { draft, proposal, path, proposalPath: `${project}/source-change-proposals/${proposal.id}` }
}

test('owner reviews another person’s proposal; accept alone publishes a version', async () => {
  await caller('p-sato')
  const { draft, proposal, path, proposalPath } = await propose()
  expect(proposal).toMatchObject({ proposer: 'sub-sato', reviewers: ['sub-yamada'], originDraftId: draft.id })
  expect((await call('GET', `${project}/source-change-proposals?proposer=me`)).body.data).toHaveLength(1)
  expect((await call('GET', `${project}/source-change-proposals?reviewer=me&phase=Proposed`)).body.data).toHaveLength(0)
  expect((await call('POST', `${proposalPath}/decisions`, { decision: 'Accept' })).status).toBe(403)
  expect((await call('POST', `${path}/conversation-turns`, { message: '追加の変更' })).status).toBe(409)
  expect((await call('POST', `${path}/implementation-runs`)).status).toBe(409)
  const diff = SourceChangeProposalDiffResponse.parse((await call('GET', `${proposalPath}/diff`)).body)
  expect(diff.unifiedDiff).toContain('diff --git')
  expect(diff.summary).toEqual({ files: 1, additions: 2, deletions: 1 })
  await caller('p-yamada')
  expect((await call('GET', `${project}/application-drafts`)).body.data).toHaveLength(0)
  expect((await call('GET', `${project}/source-change-proposals?applicationId=mitsumori&phase=Proposed&reviewer=me`)).body.data).toHaveLength(1)
  expect((await call('POST', `${proposalPath}/decisions`, { decision: 'Accept' })).body.resource.phase).toBe('Accepted')
  await call('POST', '/api/v1/__mock/advance')
  expect((await call('GET', proposalPath)).body.phase).toBe('Applying')
  await call('POST', '/api/v1/__mock/advance')
  const applied = (await call('GET', proposalPath)).body
  expect(applied).toMatchObject({ phase: 'Applied', appliedVia: 'Platform', appliedRevision: proposal.headRevision })
  expect((await call('POST', `${proposalPath}/decisions`, { decision: 'Reject' })).status).toBe(409)
  await caller('p-sato')
  expect((await call('GET', path)).body.implementationRuns.at(-1).tasks.at(-1).versionLabel).toMatch(/^v\d+$/)
})

test('request changes retains feedback and resubmits; rejection removes the review item without publishing', async () => {
  await caller('p-sato')
  const { path, proposalPath } = await propose()
  await caller('p-yamada')
  await call('POST', `${proposalPath}/decisions`, { decision: 'RequestChanges', comment: '担当者でも絞り込めるように' })
  expect((await call('GET', proposalPath)).body).toMatchObject({ phase: 'ChangesRequested', decisions: [{ comment: '担当者でも絞り込めるように' }] })
  await caller('p-sato')
  for (const message of ['担当者でも絞り込みたい', '一覧の担当者を選びたい']) {
    expect((await call('POST', `${path}/conversation-turns`, { message })).status).toBe(202)
    await call('POST', '/api/v1/__mock/advance')
  }
  expect((await call('POST', `${path}/implementation-runs`)).status).toBe(202)
  for (let i = 0; i < 12; i++) await call('POST', '/api/v1/__mock/advance')
  expect((await call('GET', proposalPath)).body.phase).toBe('Proposed')
  await caller('p-yamada')
  expect((await call('POST', `${proposalPath}/decisions`, { decision: 'Reject' })).body.resource.phase).toBe('Rejected')
  expect((await call('GET', `${project}/source-change-proposals?reviewer=me&phase=Proposed`)).body.data).toHaveLength(0)
  await call('POST', '/api/v1/__mock/advance')
  expect((await call('GET', path)).body.implementationRuns.at(-1).tasks.every((task: { versionLabel?: string }) => !task.versionLabel)).toBe(true)
})
