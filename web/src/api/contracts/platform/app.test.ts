// X2/X4 wire variants for the Platform operations behind the app screens
// (contracts/platform/app.ts). Fixtures are the shapes the Platform marshals
// (the in-memory mock answers the same); each case varies one field. Every
// rejection is also checked for redaction by assertWireContractCases; accepted
// unknown values are checked not to carry the sentinel into the domain value.
import { describe, expect, test } from 'bun:test'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import {
  deleteApplicationSourceRepositoryContract,
  deleteApplicationStackContract,
  getComponentConfigContract,
  getComponentLogsContract,
  getReleaseStateContract,
  listApplicationReleasesContract,
  listApplicationsContract,
  listApplicationStacksContract,
  listComponentSummariesContract,
  listProjectPublishesContract,
  rollbackComponentContract,
  updateComponentConfigContract,
} from './app'

const SECRET = 'SENTINEL-app-contract-41c9'
const at = '2026-11-13T00:00:00Z'
const operation = { id: 'op-1', type: 'x.update', state: 'accepted', writeChannel: 'A', resource: { kind: 'X', id: 'x', projectId: 'commerce' }, createdAt: at, links: { self: '/api/v1/operations/op-1' } }
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
const leaksNothing = (value: unknown) => expect(JSON.stringify(value)).not.toContain(SECRET)

const application = { id: 'mitsumori', projectId: 'commerce', name: 'mitsumori', defaultBranchId: 'production', status: { phase: 'healthy', conditions: [] }, sourceKind: 'applicationStack', sourceId: 'mitsumori', pendingSync: false }
const stack = {
  id: 'mitsumori', projectId: 'commerce', templateId: 'nextjs-postgres', applicationName: 'mitsumori', sourceKind: 'application-source-repository',
  sourceRepositoryRefName: 'mitsumori-src', imageRef: 'ghcr.io/acme/mitsumori:edge-v3', applicationId: 'mitsumori', branchId: 'production',
  webComponentId: 'mitsumori-web', databaseComponentId: 'mitsumori-db', pendingSync: false,
}
const publish = { id: 'mitsumori-web', projectId: 'commerce', applicationId: 'mitsumori', branchId: 'production', componentId: 'mitsumori-web', phase: 'succeeded', publicUrl: 'https://mitsumori.commerce.appthrust.test/', pendingSync: false, access: { mode: 'Public' } }
const summary = { id: 'mitsumori-web', projectId: 'commerce', applicationId: 'mitsumori', name: 'mitsumori-web', kindKey: 'Container', pendingSync: false, statusKey: 'Ready', reasonKey: 'ComponentReady' }
const release = {
  id: 'rel-edgev3', applicationId: 'mitsumori', branchId: 'production', componentId: 'mitsumori-web', version: 'edge-v3', phase: 'Succeeded',
  environmentState: 'Present', rollbackEligible: false, createdAt: at, placements: [], conditions: [], canaryTasks: [], executionSteps: [],
}
const overview = (component: Record<string, unknown>) => ({ projectId: 'commerce', applicationId: 'mitsumori', branchId: 'production', generatedAt: at, components: [component] })
const component = { id: 'mitsumori-web', name: 'mitsumori-web', canaries: [], latestRelease: release, releases: [release] }
const candidate = { transitionId: 'tr-edgev2', imageTag: 'edge-v2', imageDigest: 'sha256:edgev2000000', createdAt: at }
const releaseState = {
  projectId: 'commerce', applicationId: 'mitsumori', branchId: 'production', componentId: 'mitsumori-web', mode: 'AutoLatest', pinned: false,
  targetImageTag: 'edge-v3', targetImageDigest: 'sha256:edgev3000000', scaleToZeroConfigured: false, rollbackCandidates: [candidate],
}
const variable = { key: 'APP_TITLE', state: 'configured', source: 'user', sensitive: false, value: 'mitsumori' }
const config = { projectId: 'commerce', applicationId: 'mitsumori', branchId: 'production', componentId: 'mitsumori-web', revision: 'rev-128-8', variables: [variable] }
const logs = { clusterId: 'mock', namespace: 'commerce', service: 'mitsumori-web', pods: [{ name: 'mitsumori-web-0', phase: 'Running', ready: true, containers: ['web'] }], containers: ['web'], lines: [{ timestamp: at, text: '> next start' }], fetchedAt: at }

describe('applications (platformApiListApplications)', () => {
  test('wire variants', () => {
    assertWireContractCases(listApplicationsContract, [
      { name: 'the marshalled list', variant: 'present', path: '/data', wire: { data: [application] }, expect: { accept: true, value: [{ id: 'mitsumori', name: 'mitsumori', defaultBranchId: 'production', sourceId: 'mitsumori', sourceKind: { kind: 'known', value: 'applicationStack' }, status: {} }] } },
      { name: 'an empty project is an empty list', variant: 'empty', path: '/data', wire: { data: [] }, expect: { accept: true, value: [] } },
      { name: 'an absent list is broken, never "no applications"', variant: 'absent', path: '/data', wire: {}, expect: { accept: false, issues: [{ path: '/data', code: 'missing' }] } },
      { name: 'a null list is broken', variant: 'null', path: '/data', wire: { data: null }, expect: { accept: false, issues: [{ path: '/data', code: 'invalid_type' }] } },
      { name: 'a status without its object is broken (Go always writes status)', variant: 'absent', path: '/data/*/status', wire: { data: [without(application, 'status')] }, expect: { accept: false, issues: [{ path: '/data/*/status', code: 'missing' }] } },
      { name: 'an id that is not a DNS label is broken', variant: 'unknown', path: '/data/*/id', wire: { data: [{ ...application, id: SECRET }] }, expect: { accept: false } },
      {
        name: 'an unknown source kind and projection reason stay unknown: the item is kept, never read as working', variant: 'unknown', path: '/data/*/status/reason',
        wire: { data: [{ ...application, sourceKind: SECRET, status: { ...application.status, reason: SECRET } }] },
        expect: { accept: true, check: (value) => {
          expect(value[0]?.sourceKind).toEqual({ kind: 'unknown' })
          expect(value[0]?.status.reason).toEqual({ kind: 'unknown' })
          leaksNothing(value)
        } },
      },
      { name: 'unknown fields are dropped', variant: 'unknown', path: '/', wire: { data: [{ ...application, internalToken: SECRET }], nextToken: SECRET }, expect: { accept: true, check: (value) => leaksNothing(value) } },
    ])
  })
})

describe('application stacks (platformApiListApplicationStacks)', () => {
  test('wire variants', () => {
    assertWireContractCases(listApplicationStacksContract, [
      { name: 'the marshalled list', variant: 'present', path: '/data', wire: { data: [stack] }, expect: { accept: true, check: (value) => expect([value[0]?.id, value[0]?.sourceKind, value[0]?.webComponentId]).toEqual(['mitsumori', { kind: 'known', value: 'application-source-repository' }, 'mitsumori-web']) } },
      { name: 'an empty list', variant: 'empty', path: '/data', wire: { data: [] }, expect: { accept: true, value: [] } },
      { name: 'a null list is broken', variant: 'null', path: '/data', wire: { data: null }, expect: { accept: false, issues: [{ path: '/data', code: 'invalid_type' }] } },
      { name: 'the source kind is required', variant: 'absent', path: '/data/*/sourceKind', wire: { data: [without(stack, 'sourceKind')] }, expect: { accept: false, issues: [{ path: '/data/*/sourceKind', code: 'missing' }] } },
      { name: 'a null build failure is broken', variant: 'null', path: '/data/*/buildFailure', wire: { data: [{ ...stack, buildFailure: null }] }, expect: { accept: false, issues: [{ path: '/data/*/buildFailure', code: 'invalid_type' }] } },
      { name: 'an unknown source kind never joins a source repository', variant: 'unknown', path: '/data/*/sourceKind', wire: { data: [{ ...stack, sourceKind: SECRET }] }, expect: { accept: true, check: (value) => { expect(value[0]?.sourceKind).toEqual({ kind: 'unknown' }); leaksNothing(value) } } },
    ])
  })
})

describe('publishes (platformApiListProjectPublishes)', () => {
  test('wire variants', () => {
    assertWireContractCases(listProjectPublishesContract, [
      { name: 'the marshalled list', variant: 'present', path: '/data', wire: { data: [publish] }, expect: { accept: true, check: (value) => expect([value[0]?.phase, value[0]?.access?.mode]).toEqual([{ kind: 'known', value: 'succeeded' }, { kind: 'known', value: 'Public' }]) } },
      { name: 'an empty list', variant: 'empty', path: '/data', wire: { data: [] }, expect: { accept: true, value: [] } },
      { name: 'an absent list is broken, never "nothing published"', variant: 'absent', path: '/data', wire: {}, expect: { accept: false, issues: [{ path: '/data', code: 'missing' }] } },
      { name: 'a null list is broken', variant: 'null', path: '/data', wire: { data: null }, expect: { accept: false, issues: [{ path: '/data', code: 'invalid_type' }] } },
      { name: 'an omitted phase and access keep "not observed"', variant: 'absent', path: '/data/*/phase', wire: { data: [without(without(publish, 'phase'), 'access')] }, expect: { accept: true, check: (value) => expect([value[0]?.phase, value[0]?.access]).toEqual([undefined, undefined]) } },
      { name: 'a publish without its component is broken', variant: 'absent', path: '/data/*/componentId', wire: { data: [without(publish, 'componentId')] }, expect: { accept: false, issues: [{ path: '/data/*/componentId', code: 'missing' }] } },
      {
        name: 'an unknown phase and access mode are never succeeded or Public', variant: 'unknown', path: '/data/*/phase',
        wire: { data: [{ ...publish, phase: SECRET, access: { mode: SECRET } }] },
        expect: { accept: true, check: (value) => { expect([value[0]?.phase, value[0]?.access?.mode]).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }]); leaksNothing(value) } },
      },
      { name: 'a phase that is not a string is broken', variant: 'unknown', path: '/data/*/phase', wire: { data: [{ ...publish, phase: 7 }] }, expect: { accept: false, issues: [{ path: '/data/*/phase', code: 'invalid_type' }] } },
    ])
  })
})

describe('component summaries (platformApiListComponentSummaries)', () => {
  test('wire variants', () => {
    assertWireContractCases(listComponentSummariesContract, [
      { name: 'one page', variant: 'present', path: '/items', wire: { items: [summary] }, expect: { accept: true, value: { items: [{ id: 'mitsumori-web', applicationId: 'mitsumori', status: { kind: 'known', value: 'Ready' }, reason: { kind: 'known', value: 'ComponentReady' } }] } } },
      { name: 'an empty page', variant: 'empty', path: '/items', wire: { items: [] }, expect: { accept: true, value: { items: [] } } },
      { name: 'absent items are broken', variant: 'absent', path: '/items', wire: { nextCursor: 'c1' }, expect: { accept: false, issues: [{ path: '/items', code: 'missing' }] } },
      { name: 'null items are broken', variant: 'null', path: '/items', wire: { items: null }, expect: { accept: false, issues: [{ path: '/items', code: 'invalid_type' }] } },
      { name: 'a summary without its status is broken', variant: 'absent', path: '/items/*/statusKey', wire: { items: [without(summary, 'statusKey')] }, expect: { accept: false, issues: [{ path: '/items/*/statusKey', code: 'missing' }] } },
      {
        name: 'an unknown status and reason are never Ready', variant: 'unknown', path: '/items/*/statusKey',
        wire: { items: [{ ...summary, statusKey: SECRET, reasonKey: SECRET, extra: SECRET }] },
        expect: { accept: true, check: (value) => { expect([value.items[0]?.status, value.items[0]?.reason]).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }]); leaksNothing(value) } },
      },
    ])
  })
})

describe('release overview (platformApiListApplicationReleases)', () => {
  test('wire variants', () => {
    assertWireContractCases(listApplicationReleasesContract, [
      { name: 'the overview', variant: 'present', path: '/components', wire: overview(component), expect: { accept: true, check: (value) => expect(value.components[0]?.releases.map((item) => [item.version, item.phase])).toEqual([['edge-v3', { kind: 'known', value: 'Succeeded' }]]) } },
      { name: 'no components yet', variant: 'empty', path: '/components', wire: { ...overview(component), components: [] }, expect: { accept: true, value: { applicationId: 'mitsumori', branchId: 'production', components: [] } } },
      { name: 'absent components are broken', variant: 'absent', path: '/components', wire: without(overview(component), 'components'), expect: { accept: false, issues: [{ path: '/components', code: 'missing' }] } },
      { name: 'null releases (a nil slice) are broken, never "no releases"', variant: 'null', path: '/components/*/releases', wire: overview({ ...component, releases: null }), expect: { accept: false, issues: [{ path: '/components/*/releases', code: 'invalid_type' }] } },
      { name: 'a release without its version is broken', variant: 'absent', path: '/components/*/releases/*/version', wire: overview({ ...component, latestRelease: undefined, releases: [without(release, 'version')] }), expect: { accept: false, issues: [{ path: '/components/*/releases/*/version', code: 'missing' }] } },
      { name: 'no latest release yet', variant: 'absent', path: '/components/*/latestRelease', wire: overview(without(component, 'latestRelease')), expect: { accept: true, check: (value) => expect(value.components[0]?.latestRelease).toBeUndefined() } },
      {
        name: 'an unknown phase is neither succeeded nor failed', variant: 'unknown', path: '/components/*/releases/*/phase',
        wire: overview({ ...component, latestRelease: { ...release, phase: SECRET }, releases: [{ ...release, phase: SECRET, failureDetail: SECRET }] }),
        expect: { accept: true, check: (value) => { expect(value.components[0]?.releases[0]?.phase).toEqual({ kind: 'unknown' }); leaksNothing(value) } },
      },
    ])
  })
})

describe('release state (platformApiGetApplicationBranchComponentReleaseState)', () => {
  test('wire variants', () => {
    assertWireContractCases(getReleaseStateContract, [
      { name: 'the state with its candidates', variant: 'present', path: '/rollbackCandidates', wire: releaseState, expect: { accept: true, value: { targetImageTag: 'edge-v3', targetImageDigest: 'sha256:edgev3000000', rollbackCandidates: [candidate] } } },
      { name: 'Go omits an empty candidate list (omitempty): nothing to roll back to', variant: 'absent', path: '/rollbackCandidates', wire: without(releaseState, 'rollbackCandidates'), expect: { accept: true, check: (value) => expect(value.rollbackCandidates).toEqual([]) } },
      { name: 'an empty candidate list', variant: 'empty', path: '/rollbackCandidates', wire: { ...releaseState, rollbackCandidates: [] }, expect: { accept: true, check: (value) => expect(value.rollbackCandidates).toEqual([]) } },
      { name: 'null candidates are broken, not "none"', variant: 'null', path: '/rollbackCandidates', wire: { ...releaseState, rollbackCandidates: null }, expect: { accept: false, issues: [{ path: '/rollbackCandidates', code: 'invalid_type' }] } },
      { name: 'a candidate without its transition is broken', variant: 'absent', path: '/rollbackCandidates/*/transitionId', wire: { ...releaseState, rollbackCandidates: [without(candidate, 'transitionId')] }, expect: { accept: false, issues: [{ path: '/rollbackCandidates/*/transitionId', code: 'missing' }] } },
      { name: 'unknown fields are dropped', variant: 'unknown', path: '/', wire: { ...releaseState, mode: SECRET, debug: SECRET }, expect: { accept: true, check: (value) => leaksNothing(value) } },
    ])
  })
})

describe('rollback (platformApiRollbackApplicationBranchComponent)', () => {
  const started = { transitionId: 'tr-rollback-1', targetTransitionId: 'tr-edgev2', targetImageTag: 'edge-v2', targetImageDigest: 'sha256:edgev2000000' }
  test('the accepted transition is the value; a missing resource is unconfirmed, never success', () => {
    assertWireContractCases(rollbackComponentContract, [
      { name: 'the envelope resource', variant: 'present', path: '/resource', wire: { ...started, operation, resource: started }, expect: { accept: true, value: { transitionId: 'tr-rollback-1', targetTransitionId: 'tr-edgev2' } } },
      { name: 'no resource', variant: 'absent', path: '/resource', wire: { ...started, operation }, expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
      { name: 'a null resource', variant: 'null', path: '/resource', wire: { operation, resource: null }, expect: { accept: false, issues: [{ path: '/resource', code: 'invalid_type' }] } },
      { name: 'a resource without its transition', variant: 'absent', path: '/resource/transitionId', wire: { operation, resource: without(started, 'transitionId') }, expect: { accept: false, issues: [{ path: '/resource/transitionId', code: 'missing' }] } },
      { name: 'unknown fields are dropped', variant: 'unknown', path: '/resource', wire: { operation, resource: { ...started, note: SECRET } }, expect: { accept: true, check: (value) => leaksNothing(value) } },
    ])
  })
})

describe('env vars (platformApiGetApplicationBranchComponentConfig / Update…)', () => {
  test('read: wire variants', () => {
    assertWireContractCases(getComponentConfigContract, [
      { name: 'the configuration', variant: 'present', path: '/variables', wire: config, expect: { accept: true, value: { revision: 'rev-128-8', variables: [{ key: 'APP_TITLE', state: { kind: 'known', value: 'configured' }, source: { kind: 'known', value: 'user' }, sensitive: false, value: 'mitsumori' }] } } },
      { name: 'no variables', variant: 'empty', path: '/variables', wire: { ...config, variables: [] }, expect: { accept: true, value: { revision: 'rev-128-8', variables: [] } } },
      { name: 'absent variables are broken, never "no settings" (a save would wipe them)', variant: 'absent', path: '/variables', wire: without(config, 'variables'), expect: { accept: false, issues: [{ path: '/variables', code: 'missing' }] } },
      { name: 'null variables are broken', variant: 'null', path: '/variables', wire: { ...config, variables: null }, expect: { accept: false, issues: [{ path: '/variables', code: 'invalid_type' }] } },
      { name: 'the revision is required', variant: 'absent', path: '/revision', wire: without(config, 'revision'), expect: { accept: false, issues: [{ path: '/revision', code: 'missing' }] } },
      { name: 'a variable without sensitive is broken (never guessed "not secret")', variant: 'absent', path: '/variables/*/sensitive', wire: { ...config, variables: [without(variable, 'sensitive')] }, expect: { accept: false, issues: [{ path: '/variables/*/sensitive', code: 'missing' }] } },
      {
        name: 'an unknown state and source are never "user owned"', variant: 'unknown', path: '/variables/*/source',
        wire: { ...config, variables: [{ ...variable, state: SECRET, source: SECRET, origin: SECRET }] },
        expect: { accept: true, check: (value) => { expect([value.variables[0]?.state, value.variables[0]?.source]).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }]); leaksNothing(value) } },
      },
    ])
  })

  test('write: the saved configuration is the value; a missing resource is unconfirmed', () => {
    assertWireContractCases(updateComponentConfigContract, [
      { name: 'the envelope resource', variant: 'present', path: '/resource', wire: { ...config, operation, resource: config }, expect: { accept: true, check: (value) => expect(value.revision).toBe('rev-128-8') } },
      { name: 'no resource', variant: 'absent', path: '/resource', wire: { ...config, operation }, expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
      { name: 'null variables in the resource', variant: 'null', path: '/resource/variables', wire: { operation, resource: { ...config, variables: null } }, expect: { accept: false, issues: [{ path: '/resource/variables', code: 'invalid_type' }] } },
      { name: 'a resource that is a string', variant: 'unknown', path: '/resource', wire: { operation, resource: SECRET }, expect: { accept: false, issues: [{ path: '/resource', code: 'invalid_type' }] } },
    ])
  })
})

describe('logs (platformApiGetComponentLogs)', () => {
  test('wire variants', () => {
    assertWireContractCases(getComponentLogsContract, [
      { name: 'the lines', variant: 'present', path: '/lines', wire: logs, expect: { accept: true, value: { pods: [{ name: 'mitsumori-web-0' }], lines: [{ timestamp: at, text: '> next start' }] } } },
      { name: 'no lines yet', variant: 'empty', path: '/lines', wire: { ...logs, lines: [] }, expect: { accept: true, check: (value) => expect(value.lines).toEqual([]) } },
      { name: 'absent lines are broken, never "the app printed nothing"', variant: 'absent', path: '/lines', wire: without(logs, 'lines'), expect: { accept: false, issues: [{ path: '/lines', code: 'missing' }] } },
      { name: 'null pods are broken', variant: 'null', path: '/pods', wire: { ...logs, pods: null }, expect: { accept: false, issues: [{ path: '/pods', code: 'invalid_type' }] } },
      { name: 'a line without text is broken', variant: 'absent', path: '/lines/*/text', wire: { ...logs, lines: [{ timestamp: at }] }, expect: { accept: false, issues: [{ path: '/lines/*/text', code: 'missing' }] } },
      { name: 'unknown fields are dropped', variant: 'unknown', path: '/', wire: { ...logs, namespace: SECRET, token: SECRET }, expect: { accept: true, check: (value) => leaksNothing(value) } },
    ])
  })
})

describe('app deletes (platformApiDeleteApplicationStack / …SourceRepository)', () => {
  test('the accepted deletion names the resource; anything else is unconfirmed', () => {
    for (const contract of [deleteApplicationStackContract, deleteApplicationSourceRepositoryContract]) {
      assertWireContractCases(contract, [
        { name: 'the envelope resource', variant: 'present', path: '/resource', wire: { id: 'mitsumori', operation, resource: { id: 'mitsumori', projectId: 'commerce' } }, expect: { accept: true, value: { id: 'mitsumori' } } },
        { name: 'no resource', variant: 'absent', path: '/resource', wire: { id: 'mitsumori', operation }, expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
        { name: 'a null resource', variant: 'null', path: '/resource', wire: { operation, resource: null }, expect: { accept: false, issues: [{ path: '/resource', code: 'invalid_type' }] } },
        { name: 'an empty resource', variant: 'empty', path: '/resource/id', wire: { operation, resource: {} }, expect: { accept: false, issues: [{ path: '/resource/id', code: 'missing' }] } },
        { name: 'an id that is not a DNS label', variant: 'unknown', path: '/resource/id', wire: { operation, resource: { id: SECRET } }, expect: { accept: false } },
      ])
    }
  })
})
