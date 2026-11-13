import { describe, expect, test } from 'bun:test'
import { decodeResponse } from '../../api/boundary'
import { listSourceConnectionsContract, listTemplatesContract } from '../../api/contracts/platform/catalog'
import { definitionOf, registryOf, sourceConnectionOf, templateOf } from '../../api/testing/catalog-domain'
import { MOCK_PROJECT_ID, platformRoutes } from '../../dev/mock-platform'
import { buildSourceRepositoryRequest, resolveCreateCatalog, templateSourceProblem, templateUsableFor } from '../../model/create'
import { businessTemplates, joinBusinessTemplates } from './templates'

const wireRows = businessTemplates.map((metadata, index) => ({
  id: metadata.id, displayName: metadata.name, category: 'business', generatedKind: 'ApplicationStack',
  sourceKinds: ['sample-image', 'github-template'], components: [{ id: 'web', displayName: 'Web app', kind: 'web' }],
  githubTemplate: { repository: `appthrust/template-biz-${metadata.id.split('-')[1]}`, repositoryUrl: `https://github.com/appthrust/template-biz-${metadata.id.split('-')[1]}`, branch: 'main' },
  availability: {
    available: true,
    sources: [
      { kind: 'sample-image', available: true },
      { kind: 'github-template', available: index !== 3, ...(index === 3 ? { reasons: ['repository not admitted'] } : {}) },
    ],
  },
}))
const rows = wireRows.map(templateOf)

describe('business template × platform catalog', () => {
  test('keeps known business ids only, in metadata order, with three included parts', () => {
    const cards = joinBusinessTemplates([...rows].reverse())
    expect(cards.map((card) => card.id)).toEqual(businessTemplates.map((item) => item.id))
    expect(cards.every((card) => card.includes.length === 3)).toBe(true)
    expect(cards[3]?.availability).toEqual(rows[3]?.availability)
    expect(cards[3]?.githubTemplate).toEqual(rows[3]?.githubTemplate)
    expect(templateUsableFor(cards[3]!, 'github-template')).toBe(false)
    expect(templateUsableFor(cards[0]!, 'github-template')).toBe(true)
    expect(joinBusinessTemplates(rows.slice(1))).toHaveLength(3)
    expect(joinBusinessTemplates([templateOf({ ...wireRows[0]!, category: 'framework' })])).toEqual([])
    expect(joinBusinessTemplates([templateOf({ ...wireRows[0]!, id: 'not-console-metadata' })])).toEqual([])
  })

  test('a business card needs the known business category: an unknown one is not offered', () => {
    expect(joinBusinessTemplates([templateOf({ ...wireRows[0]!, category: 'premium' })])).toEqual([])
  })

  test('the selected business template controls the source repository; unavailable ids never fall back', () => {
    const definitions = [definitionOf({ id: 'web', title: 'Web', category: 'application', components: [{ id: 'web', definitionRef: { name: 'web' } }] })]
    const catalog = resolveCreateCatalog(rows, definitions, 'github-template', 'biz-master-postgres')!
    const request = buildSourceRepositoryRequest('customer-book', catalog, {
      source: sourceConnectionOf({ id: 'github', displayName: 'GitHub', account: { login: 'acme', type: 'Organization' }, capabilities: ['createRepositories'], status: 'ready', source: 'github-source-connection-cr' }),
      registry: registryOf({ id: 'registry', displayName: 'Registry', registryHost: 'ghcr.io', registryType: 'ghcr', status: 'ready', source: 'registry-connection-cr' }),
    })
    expect(request.template).toEqual({ repository: 'appthrust/template-biz-master', ref: 'main' })
    expect(resolveCreateCatalog(rows, definitions, 'github-template', 'biz-reservation-postgres')).toBeUndefined()
    expect(resolveCreateCatalog(rows, definitions, 'github-template', 'not-a-template')).toBeUndefined()
  })

  test('the mock catalog exposes source availability and blocks approval but admits framework templates', async () => {
    const templatesUrl = new URL(`/api/v1/projects/${MOCK_PROJECT_ID}/application-templates`, 'http://mock.test')
    const sourcesUrl = new URL(`/api/v1/projects/${MOCK_PROJECT_ID}/source-connections`, 'http://mock.test')
    const templatesResponse = await platformRoutes(new Request(templatesUrl), templatesUrl)
    const sourcesResponse = await platformRoutes(new Request(sourcesUrl), sourcesUrl)
    const decodedTemplates = decodeResponse(listTemplatesContract, await templatesResponse!.json())
    const decodedSources = decodeResponse(listSourceConnectionsContract, await sourcesResponse!.json())
    if (!decodedTemplates.ok || !decodedSources.ok) throw new Error('the mock catalog does not match its contracts')
    const catalog = decodedTemplates.value.data
    const sources = decodedSources.value.data
    const approval = catalog.find((item) => item.id === 'biz-approval-postgres')!
    const framework = catalog.find((item) => item.id === 'nextjs-postgres')!
    expect(templateUsableFor(approval, 'github-template')).toBe(false)
    expect(templateSourceProblem(approval, sources)).toBe('not-admitted')
    expect(templateUsableFor(framework, 'github-template')).toBe(true)
    expect(templateSourceProblem(framework, sources)).toBeUndefined()
    for (const template of catalog) {
      expect(template.availability.sources.map((source) => source.kind)).toEqual(template.sourceKinds)
      expect(template.availability.available).toBe(template.availability.sources.some((source) => source.available))
    }
  })
})
