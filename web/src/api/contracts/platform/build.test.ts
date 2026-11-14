import { describe, expect, test } from 'bun:test'
import { validatePreparationPlan } from '../../../features/build/use-draft-creation'
import { planProposal } from '../../../model/build/messages'
import { deriveStage } from '../../../model/build/stage'
import { draftKind, excelSource, knownPlan, planOverview, type BuildDraft, type CreationPlanValidation } from '../../../model/contracts/build'
import { isImprovementDraft, pendingProposal } from '../../../model/improve'
import { decodeResponse } from '../../boundary'
import { assertWireContractCases, type WireContractCase } from '../../testing/wire-contract-cases'
import { draftFieldPolicies, getApplicationDraftContract, listApplicationDraftsContract, validateCreationPlanContract } from './build'

const SECRET = 'SENTINEL-draft-values-5e1a'
const at = '2026-11-15T00:00:00Z'
type Json = Record<string, unknown>

const draftWire = (patch: Json = {}): Json => ({ id: 'draft-1', projectId: 'project-1', title: '見積', intent: '見積を作る', phase: 'planned', specMarkdown: '', architectureMarkdown: '', ownerUserId: 'owner-1', createdAt: at, updatedAt: at, ...patch })
const without = (value: Json, key: string): Json => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))

const stackRequest = {
  templateId: 'nextjs-postgres', application: { name: 'mitsumori' }, source: { kind: 'sample-image', imageRef: 'ghcr.io/acme/mitsumori:1' },
  web: { componentName: 'web' }, database: { componentName: 'db' }, connection: { connectionName: 'db' },
}
const handoff = {
  summary: '見積の画面を作る', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'github-template',
  tasks: [{ title: '見積の一覧', description: '見積を一覧で見られる。', acceptanceCriteria: ['一覧が出る'] }],
}
const plan = { summary: '見積を管理する', representation: ['ApplicationStack'], markdown: '# 見積の計画', applicationStackRequest: stackRequest, implementationHandoff: handoff }
const planWith = (patch: Json) => draftWire({ creationPlan: { ...plan, ...patch } })
const stackWith = (patch: Json) => planWith({ applicationStackRequest: { ...stackRequest, ...patch } })
const workbook = { id: 'wb-0123456789ab', fileName: '見積.xlsx', sheetCount: 1, rowCount: 3, truncated: false, bytes: 10, digest: 'a'.repeat(64), addedAt: at }

const draftPolicyCases: WireContractCase<BuildDraft>[] = draftFieldPolicies.flatMap((policy) => {
  const key = policy.path.slice(1)
  return [
    { name: `${key} omitted is empty`, variant: 'absent' as const, path: policy.path, wire: without(draftWire(), key), expect: { accept: true as const } },
    { name: `${key} null is a failure`, variant: 'null' as const, path: policy.path, wire: draftWire({ [key]: null }), expect: { accept: false as const, issues: [{ path: policy.path, code: 'invalid_type' as const }] } },
  ]
})

const stageOf = (draft: BuildDraft) => deriveStage({ draft, published: false, now: Date.parse(at) })
const noSecret = (value: unknown) => expect(JSON.stringify(value)).not.toContain(SECRET)

describe('draft read (platformApiGetApplicationDraft): values a newer Platform adds', () => {
  test('a plan whose every value is known is the whole plan: shown, and the one the console may change and create from', () => {
    assertWireContractCases<BuildDraft>(getApplicationDraftContract, [
      ...draftPolicyCases,
      {
        name: 'the whole plan', variant: 'present', path: '/creationPlan', wire: draftWire({ creationPlan: plan }),
        expect: { accept: true, check: (draft) => {
          expect(knownPlan(draft)?.applicationStackRequest?.application?.name).toBe('mitsumori')
          expect(stageOf(draft).unsupported).toBeUndefined()
        } },
      },
    ])
  })

  test('a plan holding a value, tag or field this console does not know is shown (summary, markdown, tasks) but never created from', () => {
    const unsupported = (draft: BuildDraft) => {
      expect(draft.creationPlan?.kind).toBe('unsupported')
      expect(knownPlan(draft)).toBeUndefined()
      expect(planOverview(draft)).toEqual({ summary: plan.summary, markdown: plan.markdown, implementationHandoff: { summary: handoff.summary, tasks: handoff.tasks } })
      // What the user reads stays: the proposal's lead and tasks; only the address needs the whole plan.
      const proposal = planProposal(draft)
      expect([proposal?.lead, proposal?.tasks.map((task) => task.title), proposal?.url]).toEqual([plan.summary, ['見積の一覧'], undefined])
      // Creating, renaming, the default address and binding the app all start from the stage action: none is offered.
      const stage = stageOf(draft)
      expect([stage.unsupported, stage.primary.action, stage.primary.enabled]).toEqual([true, 'none', false])
      noSecret(draft)
    }
    const cases: [string, Json][] = [
      ['an unknown creation tool in the tool plan', planWith({ toolPlan: [{ tool: SECRET, approvalRequired: true }] })],
      ['an unknown representation', planWith({ representation: ['ApplicationStack', SECRET] })],
      ['an unknown handoff repository strategy', planWith({ implementationHandoff: { ...handoff, sourceRepositoryStrategy: SECRET } })],
      ['an unknown stack source kind (a discriminator tag)', stackWith({ source: { kind: SECRET, imageRef: 'x' } })],
      ['an unknown Postgres version', stackWith({ database: { componentName: 'db', postgresVersion: SECRET } })],
      ['a field the strict stack request does not declare', stackWith({ [SECRET]: true })],
    ]
    assertWireContractCases<BuildDraft>(getApplicationDraftContract, [
      ...draftPolicyCases,
      ...cases.map(([name, wire]) => ({ name, variant: 'unknown' as const, path: '/creationPlan', wire, expect: { accept: true as const, check: unsupported } })),
    ])
  })

  test('a broken plan is a failure, never unsupported, even next to an unknown value', () => {
    assertWireContractCases<BuildDraft>(getApplicationDraftContract, [
      ...draftPolicyCases,
      { name: 'a summary that is not a string', variant: 'unknown', path: '/creationPlan/summary', wire: planWith({ summary: 3 }), expect: { accept: false, issues: [{ path: '/creationPlan/summary', code: 'invalid_type' }] } },
      { name: 'an unknown value beside a missing markdown', variant: 'absent', path: '/creationPlan/markdown', wire: { ...draftWire(), creationPlan: { ...without(plan, 'markdown'), representation: [SECRET] } }, expect: { accept: false, issues: [{ path: '/creationPlan/markdown', code: 'missing' }] } },
      { name: 'a backup interval out of its numeric set (a number is not a later value)', variant: 'unknown', path: '/creationPlan', wire: stackWith({ database: { componentName: 'db', backupIntervalHours: 48 } }), expect: { accept: false } },
      { name: 'a representation that is not a string', variant: 'unknown', path: '/creationPlan/representation', wire: planWith({ representation: [7] }), expect: { accept: false } },
      { name: 'a handoff task without criteria', variant: 'absent', path: '/creationPlan', wire: planWith({ implementationHandoff: { ...handoff, tasks: [{ title: 't', description: 'd' }] } }), expect: { accept: false } },
      { name: 'a null plan', variant: 'null', path: '/creationPlan', wire: draftWire({ creationPlan: null }), expect: { accept: false } },
    ])
  })

  test('kind, share scope, source and build failure kinds added later', () => {
    assertWireContractCases<BuildDraft>(getApplicationDraftContract, [
      ...draftPolicyCases,
      { name: 'no kind is a new app', variant: 'absent', path: '/kind', wire: draftWire(), expect: { accept: true, check: (draft) => { expect(draftKind(draft)).toBe('creation'); expect(stageOf(draft).unsupported).toBeUndefined() } } },
      {
        name: 'an unknown kind is neither a new app nor an improvement: shown, nothing started from it', variant: 'unknown', path: '/kind', wire: draftWire({ kind: SECRET }),
        expect: { accept: true, check: (draft) => {
          expect([draftKind(draft), isImprovementDraft(draft)]).toEqual(['unknown', false])
          expect(stageOf(draft).primary.action).toBe('none')
          noSecret(draft)
        } },
      },
      { name: 'a kind that is not a string is broken', variant: 'unknown', path: '/kind', wire: draftWire({ kind: 1 }), expect: { accept: false, issues: [{ path: '/kind', code: 'invalid_type' }] } },
      {
        name: 'an unknown share scope is the explicit unknown value; the name stays', variant: 'unknown', path: '/publishPreferences/shareScope', wire: draftWire({ publishPreferences: { name: '見積', shareScope: SECRET } }),
        expect: { accept: true, check: (draft) => { expect(draft.publishPreferences).toEqual({ name: '見積', shareScope: { kind: 'unknown' } }); noSecret(draft) } },
      },
      { name: 'a known share scope', variant: 'present', path: '/publishPreferences/shareScope', wire: draftWire({ publishPreferences: { shareScope: 'group' } }), expect: { accept: true, check: (draft) => expect(draft.publishPreferences?.shareScope).toEqual({ kind: 'known', value: 'group' }) } },
      { name: 'the Excel source', variant: 'present', path: '/source', wire: draftWire({ source: { kind: 'excel', revision: at, workbooks: [workbook] } }), expect: { accept: true, check: (draft) => expect(excelSource(draft)?.workbooks.map((item) => item.fileName)).toEqual(['見積.xlsx']) } },
      {
        name: 'a source kind this console does not know is unsupported: no Excel workbook set is read from it', variant: 'unknown', path: '/source', wire: draftWire({ source: { kind: SECRET, sheetsUrl: SECRET } }),
        expect: { accept: true, check: (draft) => { expect(draft.source?.kind).toBe('unsupported'); expect(excelSource(draft)).toBeUndefined(); noSecret(draft) } },
      },
      { name: 'a broken Excel source is broken, never unsupported', variant: 'unknown', path: '/source/workbooks', wire: draftWire({ source: { kind: 'excel', revision: at, workbooks: [] } }), expect: { accept: false, issues: [{ path: '/source/workbooks', code: 'invalid_value' }] } },
      { name: 'a build failure of a kind added later still shows its lines', variant: 'unknown', path: '/buildFailure', wire: draftWire({ buildFailure: { lines: ['Cannot find module x'], kind: SECRET, observedAt: at, buildRef: 'run-1' } }), expect: { accept: true, check: (draft) => expect(draft.buildFailure).toEqual({ lines: ['Cannot find module x'] }) } },
      { name: 'a build failure without lines is broken', variant: 'absent', path: '/buildFailure/lines', wire: draftWire({ buildFailure: { kind: 'generic', observedAt: at, buildRef: 'run-1' } }), expect: { accept: false, issues: [{ path: '/buildFailure/lines', code: 'missing' }] } },
    ])
  })

  test('an execution with a creation tool, event or approved value added later', () => {
    const execution = { id: 'exec-1', attempt: 1, status: 'succeeded', startedAt: at, steps: [{ id: 's1', tool: SECRET, status: 'done' }] }
    assertWireContractCases<BuildDraft>(getApplicationDraftContract, [
      ...draftPolicyCases,
      {
        name: 'an unknown step tool is the explicit unknown value', variant: 'unknown', path: '/creationExecutions', wire: draftWire({ creationExecutions: [execution] }),
        expect: { accept: true, check: (draft) => { expect(draft.creationExecutions[0]?.steps[0]?.tool).toEqual({ kind: 'unknown' }); noSecret(draft) } },
      },
      {
        name: 'an event log with types and tools added later is not kept', variant: 'unknown', path: '/creationExecutions', wire: draftWire({ creationExecutions: [{ ...execution, events: [{ id: 'e1', type: SECRET, at, tool: SECRET }] }] }),
        expect: { accept: true, check: (draft) => expect(draft.creationExecutions[0]).not.toHaveProperty('events') },
      },
      {
        name: 'an approved snapshot with unknown values keeps its handoff and whether it publishes', variant: 'unknown', path: '/creationExecutions',
        wire: draftWire({ creationExecutions: [{ ...execution, approval: { toolPlan: [{ tool: SECRET, approvalRequired: true }], applicationStackRequest: { ...stackRequest, source: { kind: SECRET }, publish: { enabled: true, subdomain: 'm' } }, implementationHandoff: { ...handoff, workspaceMode: SECRET } } }] }),
        expect: { accept: true, check: (draft) => {
          expect(draft.creationExecutions[0]?.approval).toEqual({ implementationHandoff: { summary: handoff.summary, tasks: handoff.tasks }, publishRequested: true })
          noSecret(draft)
        } },
      },
      { name: 'an approved handoff without tasks is broken', variant: 'absent', path: '/creationExecutions', wire: draftWire({ creationExecutions: [{ ...execution, approval: { implementationHandoff: without(handoff, 'tasks') } }] }), expect: { accept: false, issues: [{ path: '/creationExecutions/*/approval/implementationHandoff/tasks', code: 'missing' }] } },
      { name: 'a step tool that is not a string is broken', variant: 'unknown', path: '/creationExecutions', wire: draftWire({ creationExecutions: [{ ...execution, steps: [{ id: 's1', tool: 4, status: 'done' }] }] }), expect: { accept: false, issues: [{ path: '/creationExecutions/*/steps/*/tool', code: 'invalid_type' }] } },
    ])
  })

  test('an improvement plan with an unknown value still proposes its tasks (the console never sends that plan back)', () => {
    const result = decodeResponse(getApplicationDraftContract, draftWire({ kind: 'improvement', creationPlan: { summary: '直す', representation: ['Component'], markdown: '# 直す', implementationHandoff: { ...handoff, sourceRepositoryStrategy: SECRET } } }))
    if (!result.ok) throw new Error('expected the improvement draft to be read')
    expect(pendingProposal(result.value).map((task) => task.title)).toEqual(['見積の一覧'])
  })
})

describe('draft list (platformApiListApplicationDrafts)', () => {
  test('one draft with values added later does not make the list unreadable; a broken one still does (the last good list stays)', () => {
    assertWireContractCases(listApplicationDraftsContract, [
      ...draftFieldPolicies.flatMap((policy) => {
        const key = policy.path.slice(1)
        return [
          { name: `${key} omitted is empty`, variant: 'absent' as const, path: `/data/*${policy.path}`, wire: { data: [without(draftWire(), key)] }, expect: { accept: true as const } },
          { name: `${key} null is a failure`, variant: 'null' as const, path: `/data/*${policy.path}`, wire: { data: [draftWire({ [key]: null })] }, expect: { accept: false as const } },
        ]
      }),
      {
        name: 'every draft is read, the one with new values as such', variant: 'unknown', path: '/data',
        wire: { data: [draftWire({ id: 'draft-old' }), draftWire({ id: 'draft-new', kind: SECRET, publishPreferences: { shareScope: SECRET }, source: { kind: SECRET }, creationPlan: { ...plan, representation: [SECRET] } })] },
        expect: { accept: true, check: (list) => {
          expect(list.data.map((draft) => [draft.id, draftKind(draft), draft.creationPlan?.kind ?? 'none'])).toEqual([['draft-old', 'creation', 'none'], ['draft-new', 'unknown', 'unsupported']])
          noSecret(list)
        } },
      },
      { name: 'a draft whose known structure is broken fails the list (no item is silently dropped)', variant: 'unknown', path: '/data', wire: { data: [draftWire({ id: 'draft-ok' }), draftWire({ id: 'draft-broken', title: 7 })] }, expect: { accept: false, issues: [{ path: '/data/*/title', code: 'invalid_type' }] } },
    ])
  })
})

describe('plan validation (platformApiValidateApplicationDraftCreationPlan)', () => {
  const operation = { id: 'op-1', type: 'application-draft.validate', state: 'succeeded', writeChannel: 'A', resource: { kind: 'ApplicationDraft', id: 'draft-1', projectId: 'project-1' }, createdAt: at, links: { self: '/api/v1/operations/op-1' } }
  const section = { valid: true, message: 'ok' }
  const gate = (patch: Json = {}) => ({ id: 'domain', label: 'Domain', state: 'ready', blocking: false, message: 'ok', ...patch })
  const resolvedBranch = { applicationId: 'mitsumori', branchId: 'production', state: 'pending', management: { source: 'applicationStack', mutableFields: [] } }
  const validation = (patch: Json = {}, publish: Json = { ...section, gates: [gate()] }) => {
    const resource = { valid: true, message: 'ok', creationPlanFingerprint: 'fp-1', applicationStackValidation: { valid: true, message: 'ok', source: section, runtime: section, publish, resolvedBranch }, ...patch }
    return { ...resource, operation, resource }
  }
  const read = (wire: unknown): CreationPlanValidation => {
    const result = decodeResponse(validateCreationPlanContract, wire)
    if (!result.ok) throw new Error(result.error.issues.map((issue) => `${issue.code} ${issue.path}`).join(', '))
    return result.value
  }

  test('wire variants', () => {
    assertWireContractCases(validateCreationPlanContract, [
      { name: 'the verdict and its messages', variant: 'present', path: '/resource', wire: validation(), expect: { accept: true, value: { valid: true, message: 'ok', creationPlanFingerprint: 'fp-1', applicationStackValidation: { valid: true, message: 'ok', source: section, runtime: section, publish: section } } } },
      { name: 'a gate id and state added later do not make the answer unreadable', variant: 'unknown', path: '/resource/applicationStackValidation/publish', wire: validation({}, { ...section, gates: [gate({ id: SECRET, state: SECRET })] }), expect: { accept: true, check: noSecret } },
      { name: 'branch values added later do not make the answer unreadable', variant: 'unknown', path: '/resource/applicationStackValidation', wire: validation({ applicationStackValidation: { valid: true, message: 'ok', source: section, runtime: section, resolvedBranch: { ...resolvedBranch, state: SECRET, management: { source: SECRET, mutableFields: [SECRET] } } } }), expect: { accept: true } },
      { name: 'Go omits resolvedBranch (a pointer, omitempty): still a verdict', variant: 'absent', path: '/resource/applicationStackValidation', wire: validation({ applicationStackValidation: { valid: false, message: 'no', source: { valid: false, message: 'source missing' }, runtime: section } }), expect: { accept: true } },
      { name: 'a verdict that is not a boolean is broken, never "valid"', variant: 'unknown', path: '/resource/valid', wire: validation({ valid: SECRET }), expect: { accept: false, issues: [{ path: '/resource/valid', code: 'invalid_type' }] } },
      { name: 'a section without its verdict is broken', variant: 'absent', path: '/resource/applicationStackValidation/runtime/valid', wire: validation({ applicationStackValidation: { valid: true, message: 'ok', source: section, runtime: { message: 'ok' } } }), expect: { accept: false, issues: [{ path: '/resource/applicationStackValidation/runtime/valid', code: 'missing' }] } },
      { name: 'no resource is unconfirmed, not a verdict', variant: 'absent', path: '/resource', wire: without(validation(), 'resource'), expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
    ])
  })

  test('a gate whose id or state this console does not know never lets an invalid plan through: creation stops with the server\'s message', async () => {
    const publish = { valid: false, message: 'The new gate is not ready.', gates: [gate({ id: SECRET, state: SECRET, blocking: true, message: 'The new gate is not ready.' })] }
    const blocked = validation({ valid: false, message: 'Launch needs changes before resources can be created.', creationPlanFingerprint: undefined, applicationStackValidation: { valid: false, message: 'no', source: section, runtime: section, publish, resolvedBranch } })
    const outcome = validatePreparationPlan('project-1', 'draft-1', async () => read(blocked)).then(() => 'created', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(await outcome).toBe('Launch needs changes before resources can be created.\nThe new gate is not ready.')
  })

  test('a plan the server accepts is created from even when a non-blocking gate has a state added later', async () => {
    const accepted = validation({}, { ...section, gates: [gate({ state: SECRET, blocking: false })] })
    expect(await validatePreparationPlan('project-1', 'draft-1', async () => read(accepted))).toBe('fp-1')
  })
})
