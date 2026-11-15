import { expect, test } from 'bun:test'
import { ApplicationDraftCreationApprovalSnapshot, ApplicationDraftCreationPlan } from '@appthrust/api-schema/platform-api'
import { summarizeCreationPlan } from '../../../model/create'
import { withDefaultPublish } from '../../../model/build/plan'
import type { BuildDraft } from '../../../model/contracts/build'
import { decodeResponse, type ContractFailureReport } from '../../boundary'
import { createTestGateway } from '../../testing/gateway'
import { storedDraftWire as draft, storedPlanWire as plan } from '../../testing/stored-plan'
import { assertWireContractCases, type WireContractCase } from '../../testing/wire-contract-cases'
import { draftFieldPolicies, getApplicationDraftContract, listApplicationDraftsContract } from './build'

const SECRET = 'SENTINEL-unreadable-plan'
const invalidPlans = [
  { ...plan, summary: SECRET, representation: ['future-kind'] },
  { ...plan, summary: SECRET, applicationStackRequest: {} },
  { ...plan, summary: SECRET, representation: null },
  { ...plan, summary: SECRET, applicationStackRequest: { ...plan.applicationStackRequest, database: { ...plan.applicationStackRequest.database, lifecycle: {} } } },
  { ...plan, summary: SECRET, applicationStackRequest: { ...plan.applicationStackRequest, runtimeProfileRef: { kind: 'PlacementProfile', name: 'shared' }, placement: { clusters: ['runtime-target'] } } },
  ...[null, {}, { enabled: 'false' }, { enabled: true, subdomain: 42 }].map((publish) => ({ ...plan, summary: SECRET, applicationStackRequest: { ...plan.applicationStackRequest, publish } })),
]
const execution = { id: 'exec', attempt: 1, status: 'succeeded', startedAt: draft.createdAt, steps: [] }
const invalidApprovals = [{ summary: '' }, { applicationStackRequest: {} }, null]
const longApproval = { summary: 'Saved plan '.padEnd(501, 'x'), toolPlan: Array.from({ length: 21 }, () => ({ tool: 'appthrust.applicationStack.observe' as const, payloadRef: 'applicationStackRequest' as const, approvalRequired: false })) }
const runtimeOnlyPlan = { ...plan, applicationStackRequest: { ...plan.applicationStackRequest, runtimeProfileRef: { kind: 'PlacementProfile', name: 'shared' } } }
const unreadable = (value: BuildDraft) => {
  expect(value).toMatchObject({ id: draft.id, title: draft.title, phase: { kind: 'known', value: 'planned' }, creationPlanUnreadable: true })
  expect(value.creationPlan).toBeUndefined()
  expect(JSON.stringify(value)).not.toContain(SECRET)
}
const readable = (value: BuildDraft) => {
  expect(value.creationPlanUnreadable).toBeUndefined()
  expect(value.creationPlan?.applicationStackRequest?.publish).toBeUndefined()
  expect(value.creationPlan?.applicationStackRequest?.applicationName).toBe('equipment-loan')
  expect(summarizeCreationPlan(value.creationPlan!).url).toBeUndefined()
  expect(withDefaultPublish(value.creationPlan!, { domain: 'example.test' }).applicationStackRequest?.publish?.enabled).toBe(true)
}

test('APT-1109: detail keeps disabled publish readable and discards every invalid plan completely', () => {
  const policies: WireContractCase<BuildDraft>[] = draftFieldPolicies.flatMap(({ path }) => [
    { name: `${path} omission`, path, variant: 'absent', wire: draft, expect: { accept: true } },
    { name: `${path} null`, path, variant: 'null', wire: { ...draft, [path.slice(1)]: null }, expect: { accept: false } },
  ])
  assertWireContractCases(getApplicationDraftContract, [
    ...policies,
    { name: 'real-shaped disabled publish', path: '/creationPlan', variant: 'present', wire: draft, expect: { accept: true, check: readable } },
    { name: 'no plan yet is distinct', path: '/creationPlan', variant: 'absent', wire: { ...draft, creationPlan: undefined }, expect: { accept: true, check: (value) => { expect(value.creationPlan).toBeUndefined(); expect(value.creationPlanUnreadable).toBeUndefined() } } },
    ...invalidPlans.map((creationPlan): WireContractCase<BuildDraft> => ({ name: 'unreadable stored plan', path: '/creationPlan', variant: 'unknown', wire: { ...draft, creationPlan }, expect: { accept: true, check: unreadable } })),
    { name: 'runtimeProfileRef without placement is already canonical', path: '/creationPlan', variant: 'present', wire: { ...draft, creationPlan: runtimeOnlyPlan }, expect: { accept: true, check: (value) => { readable(value); expect(value.creationPlan?.applicationStackRequest?.runtimeProfileRef).toEqual({ kind: 'PlacementProfile', name: 'shared' }) } } },
    { name: 'disabled publication in approval is absent', path: '/creationExecutions/*/approval', variant: 'present', wire: { ...draft, creationExecutions: [{ ...execution, approval: plan }] }, expect: { accept: true, check: (value) => { expect(value.creationExecutions[0]?.approval?.applicationStackRequest?.publish).toBeUndefined(); expect(value.creationExecutions[0]?.approval?.applicationStackRequest?.applicationName).toBe('equipment-loan'); expect(value.creationExecutions[0]?.approvalUnreadable).toBeUndefined() } } },
    { name: 'snapshot summary and tool-plan size follow the plan field schemas', path: '/creationExecutions/*/approval', variant: 'present', wire: { ...draft, creationExecutions: [{ ...execution, approval: longApproval }] }, expect: { accept: true, check: (value) => { expect(value.creationExecutions[0]?.approval).toEqual(longApproval); expect(value.creationExecutions[0]?.approvalUnreadable).toBeUndefined() } } },
    ...invalidApprovals.map((approval): WireContractCase<BuildDraft> => ({ name: 'invalid approval is discarded completely', path: '/creationExecutions/*/approval', variant: 'unknown', wire: { ...draft, creationExecutions: [{ ...execution, approval }] }, expect: { accept: true, check: (value) => { expect(value.creationExecutions[0]).toMatchObject({ id: 'exec', status: { kind: 'known', value: 'succeeded' }, approvalUnreadable: true }); expect(value.creationExecutions[0]?.approval).toBeUndefined(); expect(JSON.stringify(value)).not.toContain(SECRET) } } })),
    { name: 'unreadable approval preserves execution status', path: '/creationExecutions', variant: 'present', wire: { ...draft, creationExecutions: [{ id: 'exec', attempt: 1, status: 'succeeded', startedAt: draft.createdAt, steps: [], approval: { summary: SECRET, applicationStackRequest: {} } }] }, expect: { accept: true, check: (value) => {
      expect(value.creationExecutions[0]).toMatchObject({ id: 'exec', status: { kind: 'known', value: 'succeeded' }, approvalUnreadable: true })
      expect(value.creationExecutions[0]?.approval).toBeUndefined()
      expect(JSON.stringify(value)).not.toContain(SECRET)
    } } },
  ])
  // The response exception must not relax the canonical request contract.
  expect(ApplicationDraftCreationPlan.safeParse(plan).success).toBe(false)
  expect(ApplicationDraftCreationApprovalSnapshot.safeParse(longApproval).success).toBe(false)
})

test('APT-1109: list keeps normal and unreadable-plan drafts, isolating only rows broken elsewhere', () => {
  assertWireContractCases(listApplicationDraftsContract, [
    { name: 'disabled publish in list', path: '/data', variant: 'present', wire: { data: [draft] }, expect: { accept: true, check: (rows) => { readable(rows.data[0]!); expect(rows.unreadable).toEqual([]) } } },
    { name: 'unreadable approval is not an unreadable draft row', path: '/data/*/creationExecutions', variant: 'present', wire: { data: [{ ...draft, creationExecutions: [{ id: 'exec', attempt: 1, status: 'succeeded', startedAt: draft.createdAt, steps: [], approval: { applicationStackRequest: {} } }] }, { ...draft, id: 'normal' }] }, expect: { accept: true, check: (rows) => { expect(rows.data).toHaveLength(2); expect(rows.unreadable).toEqual([]); expect(rows.data[0]?.creationExecutions[0]).toMatchObject({ approvalUnreadable: true, status: { kind: 'known', value: 'succeeded' } }); expect(rows.data[0]?.creationExecutions[0]?.approval).toBeUndefined() } } },
    { name: 'disabled publication in a listed approval is absent', path: '/data/*/creationExecutions/*/approval', variant: 'present', wire: { data: [{ ...draft, creationExecutions: [{ ...execution, approval: plan }] }] }, expect: { accept: true, check: (rows) => { expect(rows.unreadable).toEqual([]); expect(rows.data[0]?.creationExecutions[0]?.approval?.applicationStackRequest?.publish).toBeUndefined(); expect(rows.data[0]?.creationExecutions[0]?.approvalUnreadable).toBeUndefined() } } },
    { name: 'long summary and tool plan remain readable in a listed snapshot', path: '/data/*/creationExecutions/*/approval', variant: 'present', wire: { data: [{ ...draft, creationExecutions: [{ ...execution, approval: longApproval }] }] }, expect: { accept: true, check: (rows) => { expect(rows.data[0]?.creationExecutions[0]?.approval).toEqual(longApproval); expect(rows.unreadable).toEqual([]) } } },
    ...invalidApprovals.map((approval) => ({ name: 'unreadable approval beside a normal draft', path: '/data/*/creationExecutions/*/approval', variant: 'unknown' as const, wire: { data: [{ ...draft, creationExecutions: [{ ...execution, approval }] }, { ...draft, id: 'normal' }] }, expect: { accept: true as const, check: (rows: { data: BuildDraft[]; unreadable: { id?: string }[] }) => { expect(rows.data).toHaveLength(2); expect(rows.unreadable).toEqual([]); expect(rows.data[0]?.creationExecutions[0]?.approvalUnreadable).toBe(true); expect(rows.data[0]?.creationExecutions[0]?.approval).toBeUndefined(); expect(JSON.stringify(rows)).not.toContain(SECRET) } } })),
    ...invalidPlans.map((creationPlan) => ({ name: 'one invalid plan beside a normal draft', path: '/data', variant: 'unknown' as const, wire: { data: [{ ...draft, creationPlan }, { ...draft, id: 'normal' }] }, expect: { accept: true as const, check: (rows: { data: BuildDraft[] }) => { expect(rows.data).toHaveLength(2); unreadable(rows.data[0]!); readable(rows.data[1]!) } } })),
    ...[{ createdAt: 'not-a-date' }, { kind: 'future-kind' }].map((bad) => ({ name: 'bad row isolated with only its id', path: '/data', variant: 'unknown' as const, wire: { data: [draft, { ...draft, ...bad, id: 'bad', title: SECRET }] }, expect: { accept: true as const, check: (rows: { data: BuildDraft[]; unreadable: { id?: string }[] }) => { expect(rows.data.map((row) => row.id)).toEqual([draft.id]); expect(rows.unreadable).toEqual([{ id: 'bad' }]); expect(JSON.stringify(rows)).not.toContain(SECRET) } } })),
    { name: 'id-less row remains explicit', path: '/data', variant: 'unknown', wire: { data: [null, { id: 42 }] }, expect: { accept: true, value: { data: [], unreadable: [{}, {}] } } },
    { name: 'every row rejected is not an empty list', path: '/data', variant: 'unknown', wire: { data: [{ ...draft, id: 'bad-one', createdAt: SECRET }, { ...draft, id: 'bad-two', kind: SECRET }] }, expect: { accept: true, value: { data: [], unreadable: [{ id: 'bad-one' }, { id: 'bad-two' }] } } },
    { name: 'null envelope fails', path: '/', variant: 'null', wire: null, expect: { accept: false } },
    { name: 'missing data fails', path: '/data', variant: 'absent', wire: {}, expect: { accept: false } },
    { name: 'null data fails', path: '/data', variant: 'null', wire: { data: null }, expect: { accept: false } },
  ])
})

test('recoveries reach the existing reporter without failing the read or leaking content', async () => {
  const reports: ContractFailureReport[] = []
  const gateway = createTestGateway({
    platformFetch: async () => Response.json({ data: [{ ...draft, creationPlan: invalidPlans[0] }, { ...draft, id: 'bad', createdAt: SECRET }] }),
    reportFailure: (report) => { reports.push(report); throw new Error('broken sink') },
  })
  const result = await gateway.platform(listApplicationDraftsContract, { projectId: 'commerce' })
  expect(result.data).toHaveLength(1)
  expect(result.unreadable).toEqual([{ id: 'bad' }])
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({ outcome: 'partial', issues: [{ path: '/data/*/createdAt', code: 'invalid_value' }, { path: '/data/*/creationPlan', code: 'invalid_value' }] })
  expect(JSON.stringify(reports)).not.toContain(SECRET)
  expect(JSON.stringify(reports)).not.toContain('draft-loans')
  expect(decodeResponse(getApplicationDraftContract, { ...draft, creationPlan: invalidPlans[0] })).toMatchObject({ ok: true, recovered: [{ path: '/creationPlan', code: 'invalid_value' }] })
})

test('per-draft recovery paths are deduplicated before reaching any reporter', async () => {
  const reports: ContractFailureReport[] = []
  const gateway = createTestGateway({
    platformFetch: async () => Response.json({ data: Array.from({ length: 40 }, (_, index) => ({ ...draft, id: `draft-${index}`, creationPlan: invalidPlans[0], creationExecutions: [{ ...execution, approval: invalidApprovals[1] }] })) }),
    reportFailure: (report) => reports.push(report),
  })
  expect((await gateway.platform(listApplicationDraftsContract, { projectId: 'commerce' })).data).toHaveLength(40)
  expect(reports[0]?.issues).toEqual([{ path: '/data/*/creationPlan', code: 'invalid_value' }, { path: '/data/*/creationExecutions/*/approval', code: 'invalid_value' }])
})
