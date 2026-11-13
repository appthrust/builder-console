import { describe, expect, test } from 'bun:test'
import { assertWireContractCases } from '../../testing/wire-contract-cases'
import {
  createSourceRepositoryContract,
  createStackContract,
  listSourceConnectionsContract,
  listTemplatesContract,
  putPublishAccessContract,
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
      { name: 'an omitted allowlist keeps its meaning (every repository)', variant: 'absent', path: '/data/*/allowedRepositories', wire: { data: [wireSource] }, expect: { accept: true, check: (value) => expect(value.data[0]?.allowedRepositories).toBeUndefined() } },
      { name: 'a null allowlist is broken, not "every repository"', variant: 'null', path: '/data/*/allowedRepositories', wire: { data: [{ ...wireSource, allowedRepositories: null }] }, expect: { accept: false, issues: [{ path: '/data/*/allowedRepositories', code: 'invalid_type' }] } },
      { name: 'capabilities are required', variant: 'absent', path: '/data/*/capabilities', wire: { data: [without(wireSource, 'capabilities')] }, expect: { accept: false, issues: [{ path: '/data/*/capabilities', code: 'missing' }] } },
      { name: 'an unknown status and capability never read as ready or able', variant: 'unknown', path: '/data/*/status', wire: { data: [{ ...wireSource, status: SECRET, capabilities: [SECRET] }] }, expect: { accept: true, check: (value) => expect([value.data[0]?.status, value.data[0]?.capabilities]).toEqual([{ kind: 'unknown' }, [{ kind: 'unknown' }]]) } },
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
