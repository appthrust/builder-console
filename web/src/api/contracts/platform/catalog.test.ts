import { describe, expect, test } from 'bun:test'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import {
  createSourceRepositoryContract,
  createStackContract,
  getRepositoryDestinationContract,
  listSourceConnectionsContract,
  listTemplatesContract,
  putPublishAccessContract,
  validateSourceRepositoryContract,
  validateStackContract,
} from './catalog'

const SECRET = 'SENTINEL-catalog-contract-77e2'
const at = '2026-11-13T00:00:00Z'
const operation = { id: 'op-1', type: 'x.create', state: 'accepted', writeChannel: 'A', resource: { kind: 'X', id: 'x', projectId: 'pj' }, createdAt: at, links: { self: '/api/v1/operations/op-1' } }

const wireTemplate = {
  id: 'nextjs-postgres', displayName: 'Next.js + PostgreSQL', category: 'framework', generatedKind: 'ApplicationStack',
  sourceKinds: ['github-template'], components: [{ id: 'web', displayName: 'Web', kind: 'web' }],
  availability: { available: true, sources: [{ kind: 'github-template', available: true }] },
}
const templates = (template: unknown) => ({ data: [template], meta: { total: 1 } })
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))

describe('templates (platformApiListApplicationTemplates)', () => {
  test('wire variants', () => {
    assertWireContractCases(listTemplatesContract, [
      { name: 'the marshalled list is read', variant: 'present', path: '/', wire: templates(wireTemplate), expect: { accept: true, check: (value) => expect(value.data[0]?.sourceKinds).toEqual([{ kind: 'known', value: 'github-template' }]) } },
      { name: 'an empty catalog is an empty list', variant: 'empty', path: '/data', wire: { data: [], meta: { total: 0 } }, expect: { accept: true, value: { data: [] } } },
      { name: 'an absent list is broken, never an empty catalog', variant: 'absent', path: '/data', wire: { meta: { total: 0 } }, expect: { accept: false, issues: [{ path: '/data', code: 'missing' }] } },
      { name: 'a null list is broken', variant: 'null', path: '/data', wire: { data: null }, expect: { accept: false, issues: [{ path: '/data', code: 'invalid_type' }] } },
      { name: 'sourceKinds is required (Go never omits it)', variant: 'absent', path: '/data/*/sourceKinds', wire: templates(without(wireTemplate, 'sourceKinds')), expect: { accept: false, issues: [{ path: '/data/*/sourceKinds', code: 'missing' }] } },
      {
        name: 'an unknown source kind and category are kept unknown: never an available source, never business', variant: 'unknown', path: '/data/*/sourceKinds',
        wire: templates({ ...wireTemplate, category: SECRET, sourceKinds: [SECRET], availability: { available: true, sources: [{ kind: SECRET, available: true }] } }),
        expect: { accept: true, check: (value) => {
          expect(value.data[0]?.category).toEqual({ kind: 'unknown' })
          expect(value.data[0]?.sourceKinds).toEqual([{ kind: 'unknown' }])
          expect(JSON.stringify(value)).not.toContain(SECRET)
        } },
      },
      { name: 'a source kind that is not a string is broken', variant: 'unknown', path: '/data/*/sourceKinds', wire: templates({ ...wireTemplate, sourceKinds: [3] }), expect: { accept: false, issues: [{ path: '/data/*/sourceKinds/*', code: 'invalid_type' }] } },
      { name: 'unknown fields are dropped', variant: 'unknown', path: '/', wire: templates({ ...wireTemplate, internalToken: SECRET }), expect: { accept: true, check: (value) => expect(JSON.stringify(value)).not.toContain(SECRET) } },
    ])
  })
})

describe('source connections (platformApiListProjectGitHubSourceConnections)', () => {
  const wireSource = { id: 'gh', displayName: 'gh', account: { login: 'acme', type: 'Organization' }, capabilities: ['createRepositories'], status: 'ready', source: 'github-source-connection-cr' }
  test('wire variants', () => {
    assertWireContractCases(listSourceConnectionsContract, [
      // The allowlist and account no longer decide anything here (the destination does), so they are not read.
      { name: 'the template allowlist and account are not read', variant: 'unknown', path: '/data/*/allowedRepositories', wire: { data: [{ ...wireSource, allowedRepositories: null, account: null }] }, expect: { accept: true, value: { data: [{ id: 'gh', capabilities: [{ kind: 'known', value: 'createRepositories' }], status: { kind: 'known', value: 'ready' } }] } } },
      { name: 'capabilities are required', variant: 'absent', path: '/data/*/capabilities', wire: { data: [without(wireSource, 'capabilities')] }, expect: { accept: false, issues: [{ path: '/data/*/capabilities', code: 'missing' }] } },
      { name: 'an unknown status and capability never read as ready or able', variant: 'unknown', path: '/data/*/status', wire: { data: [{ ...wireSource, status: SECRET, capabilities: [SECRET] }] }, expect: { accept: true, check: (value) => expect([value.data[0]?.status, value.data[0]?.capabilities]).toEqual([{ kind: 'unknown' }, [{ kind: 'unknown' }]]) } },
    ])
  })
})

describe('repository destination (platformApiGetProjectRepositoryDestination)', () => {
  const destination = { connectionId: 'github-source-207cb7ce', provider: 'github', displayName: 'Acme GitHub', repositoryNamespace: 'acme', registryNamespace: 'ghcr.io/acme' }
  const resolved = { state: 'Resolved', source: 'Project', revision: 'rd-1', destination }
  const blocked = { state: 'Blocked', reason: 'NotConfigured', message: `No repository destination. ${SECRET}`, settingsUrl: '/projects/pj/settings' }
  const expected = { kind: 'resolved', revision: 'rd-1', connectionId: 'github-source-207cb7ce', repositoryNamespace: 'acme', registryNamespace: 'ghcr.io/acme' } as const

  test('wire variants', () => {
    assertWireContractCases(getRepositoryDestinationContract, [
      { name: 'a resolved GHCR destination', variant: 'present', path: '/', wire: resolved, expect: { accept: true, value: expected } },
      {
        name: 'a resolved built-in registry destination with its image access', variant: 'present', path: '/destination/registryNamespace',
        wire: { ...resolved, source: 'Environment', destination: { ...destination, registryNamespace: 'registry.appthrust.test/commerce', imageAccessId: 'platform-registry' } },
        expect: { accept: true, value: { ...expected, registryNamespace: 'registry.appthrust.test/commerce' } },
      },
      { name: 'an unknown source does not change where it goes', variant: 'unknown', path: '/source', wire: { ...resolved, source: SECRET }, expect: { accept: true, value: expected } },
      { name: 'blocked keeps neither reason nor message', variant: 'present', path: '/reason', wire: blocked, expect: { accept: true, check: (value) => { expect(value).toEqual({ kind: 'blocked' }); expect(JSON.stringify(value)).not.toContain(SECRET) } } },
      { name: 'an unknown blocked reason is blocked', variant: 'unknown', path: '/reason', wire: { ...blocked, reason: SECRET }, expect: { accept: true, value: { kind: 'blocked' } } },
      { name: 'an unknown state offers no create', variant: 'unknown', path: '/state', wire: { state: SECRET, revision: 'rd-1', destination }, expect: { accept: true, value: { kind: 'unknown' } } },
      { name: 'no state is broken, never blocked or resolved', variant: 'absent', path: '/state', wire: without(resolved, 'state'), expect: { accept: false, issues: [{ path: '/state', code: 'missing' }] } },
      { name: 'a null state is broken', variant: 'null', path: '/state', wire: { ...resolved, state: null }, expect: { accept: false, issues: [{ path: '/state', code: 'invalid_type' }] } },
      { name: 'a resolved answer without a revision is broken: nothing to bind a create to', variant: 'absent', path: '/revision', wire: without(resolved, 'revision'), expect: { accept: false, issues: [{ path: '/revision', code: 'missing' }] } },
      { name: 'an empty revision is broken: Platform would resolve again at create time', variant: 'empty', path: '/revision', wire: { ...resolved, revision: '' }, expect: { accept: false, issues: [{ path: '/revision', code: 'invalid_value' }] } },
      { name: 'a null revision is broken', variant: 'null', path: '/revision', wire: { ...resolved, revision: null }, expect: { accept: false, issues: [{ path: '/revision', code: 'invalid_type' }] } },
      { name: 'a resolved answer without its destination is broken', variant: 'absent', path: '/destination', wire: without(resolved, 'destination'), expect: { accept: false, issues: [{ path: '/destination', code: 'missing' }] } },
      { name: 'a destination without its registry namespace is broken', variant: 'absent', path: '/destination/registryNamespace', wire: { ...resolved, destination: without(destination, 'registryNamespace') }, expect: { accept: false, issues: [{ path: '/destination/registryNamespace', code: 'missing' }] } },
      { name: 'unknown fields are dropped', variant: 'unknown', path: '/', wire: { ...resolved, credential: SECRET, destination: { ...destination, token: SECRET } }, expect: { accept: true, check: (value) => expect(JSON.stringify(value)).not.toContain(SECRET) } },
    ])
  })

  test('validation reads the verdict and the image path Platform derived; the resolution it carries is not read', () => {
    assertWireContractCases(validateSourceRepositoryContract, [
      { name: 'an adoption validation with its derived image path', variant: 'present', path: '/imagePath', wire: { valid: true, message: 'ok', imagePath: 'ghcr.io/acme/app', tagFilter: 'edge-', versioningScheme: 'Alphabetical' }, expect: { accept: true, value: { valid: true, message: 'ok', imagePath: 'ghcr.io/acme/app' } } },
      { name: 'Go omits imagePath when nothing was derived', variant: 'absent', path: '/imagePath', wire: { valid: false, message: 'not visible' }, expect: { accept: true, value: { valid: false, message: 'not visible' } } },
      { name: 'an unknown versioning scheme or resolution state does not break the verdict', variant: 'unknown', path: '/versioningScheme', wire: { valid: true, versioningScheme: SECRET, repositoryDestination: { state: SECRET } }, expect: { accept: true, value: { valid: true } } },
      { name: 'a verdict that is not a boolean is broken', variant: 'unknown', path: '/valid', wire: { valid: SECRET }, expect: { accept: false, issues: [{ path: '/valid', code: 'invalid_type' }] } },
    ])
  })
})

describe('create writes', () => {
  const repository = { id: 'mitsumori-src', projectId: 'pj', image: { imagePath: 'ghcr.io/acme/mitsumori' }, status: 'pending', conditions: [] }
  const stack = { id: 'mitsumori', projectId: 'pj', templateId: 'nextjs-postgres', applicationName: 'mitsumori', sourceKind: 'sample-image', pendingSync: true }

  test('source repository create: the written resource is the value; a missing resource is unconfirmed, not success', () => {
    assertWireContractCases(createSourceRepositoryContract, [
      { name: 'the envelope resource', variant: 'present', path: '/resource', wire: { ...repository, operation, resource: repository }, expect: { accept: true, check: (value) => expect([value.id, value.status]).toEqual(['mitsumori-src', { kind: 'known', value: 'pending' }]) } },
      { name: 'no resource', variant: 'absent', path: '/resource', wire: { ...repository, operation }, expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
      { name: 'null conditions (a nil slice) are broken', variant: 'null', path: '/resource/conditions', wire: { operation, resource: { ...repository, conditions: null } }, expect: { accept: false, issues: [{ path: '/resource/conditions', code: 'invalid_type' }] } },
    ])
  })

  test('stack create and validation', () => {
    assertWireContractCases(createStackContract, [
      { name: 'the envelope resource identity', variant: 'present', path: '/resource', wire: { ...stack, operation, resource: stack }, expect: { accept: true, value: { id: 'mitsumori', templateId: 'nextjs-postgres', applicationName: 'mitsumori' } } },
      { name: 'a resource without its application name is broken', variant: 'absent', path: '/resource/applicationName', wire: { operation, resource: without(stack, 'applicationName') }, expect: { accept: false, issues: [{ path: '/resource/applicationName', code: 'missing' }] } },
    ])
    assertWireContractCases(validateStackContract, [
      { name: 'Go omits resolvedBranch and publish (pointers, omitempty): still a validation', variant: 'absent', path: '/publish', wire: { valid: true, message: 'ok', source: { valid: true, message: 'ok' }, runtime: { valid: true, message: 'ok' } }, expect: { accept: true } },
      { name: 'a required section is missing: broken, never "valid"', variant: 'absent', path: '/runtime', wire: { valid: true, message: 'ok', source: { valid: true, message: 'ok' } }, expect: { accept: false, issues: [{ path: '/runtime', code: 'missing' }] } },
      { name: 'valid that is not a boolean is broken', variant: 'unknown', path: '/valid', wire: { valid: SECRET, message: 'ok', source: { valid: true, message: 'ok' }, runtime: { valid: true, message: 'ok' } }, expect: { accept: false, issues: [{ path: '/valid', code: 'invalid_type' }] } },
    ])
  })

  test('publish access: the observed access; an unknown mode is unknown', () => {
    assertWireContractCases(putPublishAccessContract, [
      { name: 'the observed access', variant: 'present', path: '/resource', wire: { mode: 'Public', operation, resource: { mode: 'Public' } }, expect: { accept: true, value: { mode: { kind: 'known', value: 'Public' } } } },
      { name: 'an unknown mode', variant: 'unknown', path: '/resource/mode', wire: { operation, resource: { mode: SECRET } }, expect: { accept: true, value: { mode: { kind: 'unknown' } } } },
      { name: 'no resource is unconfirmed', variant: 'absent', path: '/resource', wire: { mode: 'Public', operation }, expect: { accept: false, issues: [{ path: '/resource', code: 'missing' }] } },
    ])
  })
})
