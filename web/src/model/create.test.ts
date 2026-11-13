import { describe, expect, test } from 'bun:test'
import { definitionOf, domainOf, registryOf, sourceConnectionOf, templateOf } from '../api/testing/catalog-domain'
import type { CreationPlan } from './contracts/build'
import {
  appUrl,
  buildCreateStackRequest,
  buildExistingSourceRepositoryRequest,
  buildSourceRepositoryRequest,
  isValidAppName,
  missingPrerequisites,
  numberedUrlName,
  pickCreateEnvironment,
  pickPublishDomain,
  pickSourceConnection,
  resolveCreateCatalog,
  sourceConnectionsOf,
  suggestUrlName,
  summarizeCreationPlan,
  templatesFor,
  templateSourceProblem,
  templateUsableFor,
  urlNameFromRepository,
} from './create'

// Wire fixtures as Platform answers them; tests read them through the production readers.
const wireTemplate = {
  id: 'nextjs-postgres',
  displayName: 'Next.js + PostgreSQL',
  category: 'framework',
  generatedKind: 'ApplicationStack',
  sourceKinds: ['sample-image', 'github-template'],
  defaultPort: 3000,
  githubTemplate: {
    repository: 'appthrust/template-nextjs',
    repositoryUrl: 'https://github.com/appthrust/template-nextjs',
    branch: 'main',
  },
  components: [
    { id: 'web', displayName: 'Web', kind: 'web' },
    { id: 'postgres', displayName: 'PostgreSQL', kind: 'database' },
  ],
  availability: { available: true, sources: [{ kind: 'sample-image', available: true }, { kind: 'github-template', available: true }] },
}
const templateWith = (patch: Record<string, unknown>) => templateOf({ ...wireTemplate, ...patch })
const template = templateOf(wireTemplate)
const remix = templateWith({ id: 'remix-postgres', displayName: 'Remix + PostgreSQL', sourceKinds: ['github-template'], githubTemplate: undefined })

const wireDefinition = {
  id: 'web-postgres',
  title: 'Web + PostgreSQL',
  category: 'application',
  versions: [{ name: 'v1', served: true, default: true }],
  components: [
    { id: 'web', definitionRef: { name: 'web-service', version: 'v1' } },
    { id: 'database', definitionRef: { name: 'postgresql', version: 'v1' } },
  ],
  connections: [{ name: 'database', from: 'web', to: 'database' }],
}
const definition = definitionOf(wireDefinition)

const wireSourceConnection = {
  id: 'github-source-207cb7ce',
  displayName: 'Acme GitHub',
  account: { login: 'Acme', type: 'Organization' },
  capabilities: ['createRepositories', 'readTemplateRepositories'],
  status: 'ready',
  source: 'github-source-connection-cr',
}
const sourceWith = (patch: Record<string, unknown>) => sourceConnectionOf({ ...wireSourceConnection, ...patch })
const sourceConnection = sourceConnectionOf(wireSourceConnection)

const wireRegistry = {
  id: 'ghcr-acme',
  displayName: 'GHCR',
  registryHost: 'ghcr.io',
  registryType: 'ghcr',
  status: 'ready',
  source: 'registry-connection-cr',
}
const registryConnection = registryOf(wireRegistry)

const wireSeedDomain = {
  id: 'pj-eee7fa8eabbc.appthrust.ink',
  projectId: 'pj-eee7fa8eabbc',
  name: 'pj-eee7fa8eabbc.appthrust.ink',
  source: 'seed',
  dnsManagement: 'platform',
  configuration: { state: 'valid', expectedRecords: [] },
  usableForPublish: true,
  deletable: false,
  delegationReady: true,
  publishDnsManaged: true,
  externalDnsManaged: true,
  usedBy: [],
}
const seedDomain = domainOf(wireSeedDomain)
const customDomain = domainOf({ ...wireSeedDomain, id: 'acme.dev', name: 'acme.dev', source: 'hostedZone', deletable: true })

describe('URL name', () => {
  test('follows the DNS label rule and rejects console reserved words', () => {
    expect(isValidAppName('my-shop')).toBe(true)
    expect(isValidAppName('My Shop')).toBe(false)
    expect(isValidAppName('-shop')).toBe(false)
    expect(isValidAppName('a'.repeat(64))).toBe(false)
    expect(isValidAppName('new')).toBe(false)
  })

  test('suggests from kana, latin and full-width text; kanji-only takes the fallback', () => {
    const fallback = () => 'app-a1b2c3'
    expect(suggestUrlName('みつもり', fallback)).toBe('mitsumori')
    expect(suggestUrlName('キントウン', fallback)).toBe('kintoun')
    expect(suggestUrlName('ちゃっと きょうゆう', fallback)).toBe('chatto-kyouyuu')
    expect(suggestUrlName('Sales Report 2026', fallback)).toBe('sales-report-2026')
    expect(suggestUrlName('ＡＢＣ', fallback)).toBe('abc')
    expect(suggestUrlName('見積作成', fallback)).toBe('app-a1b2c3')
    expect(suggestUrlName('見積 v2', fallback)).toBe('v2')
    expect(suggestUrlName('help', fallback)).toBe('help-app')
    expect(isValidAppName(suggestUrlName('x'.repeat(80) + 'ー', fallback))).toBe(true)
  })

  test('the default fallback is app-<6 hex>; a template word wins over it and only for unreadable names', () => {
    expect(suggestUrlName('見積作成')).toMatch(/^app-[0-9a-f]{6}$/)
    expect(suggestUrlName('在庫管理', () => 'inventory')).toBe('inventory')
    expect(suggestUrlName('ざいこ', () => 'inventory')).toBe('zaiko')
    expect(numberedUrlName(suggestUrlName('在庫管理', () => 'inventory'), 2)).toBe('inventory-2')
  })

  test('numbered variants replace an existing number and stay within 63 characters', () => {
    expect(numberedUrlName('mitsumori', 2)).toBe('mitsumori-2')
    expect(numberedUrlName('mitsumori-2', 3)).toBe('mitsumori-3')
    expect(numberedUrlName('test2', 2)).toBe('test2-2')
    const long = numberedUrlName(`${'a'.repeat(61)}-b`, 12)
    expect(long).toBe(`${'a'.repeat(60)}-12`)
    expect(isValidAppName(long)).toBe(true)
  })
})

describe('catalog', () => {
  test('default template first for the github-template path; image path only sees image templates', () => {
    expect(templatesFor([remix, template], 'github-template').map((item) => item.id)).toEqual([
      'nextjs-postgres',
      'remix-postgres',
    ])
    expect(templatesFor([remix, template], 'sample-image').map((item) => item.id)).toEqual(['nextjs-postgres'])
  })

  test('source availability, not the aggregate, gates templates and explicit catalog choices', () => {
    const imageOnly = templateWith({
      availability: { available: true, sources: [{ kind: 'sample-image', available: true }, { kind: 'github-template', available: false }] },
    })
    expect(templateUsableFor(imageOnly, 'github-template')).toBe(false)
    expect(templateUsableFor(imageOnly, 'sample-image')).toBe(true)
    expect(templateUsableFor(templateWith({ sourceKinds: ['sample-image'] }), 'github-template')).toBe(false)
    expect(templatesFor([imageOnly], 'github-template')).toEqual([])
    expect(resolveCreateCatalog([imageOnly], [definition], 'github-template', template.id)).toBeUndefined()
    expect(resolveCreateCatalog([imageOnly], [definition], 'sample-image')?.template).toBe(imageOnly)
  })

  test('marketplace definitions are never paired with a template, even when listed first with the same shape', () => {
    const marketplace = definitionOf({ ...wireDefinition, id: 'builder-console', catalogSource: 'appthrust' })
    expect(resolveCreateCatalog([template], [marketplace, definition], 'github-template')?.definitionRef?.name).toBe(definition.id)
    expect(resolveCreateCatalog([template], [marketplace], 'github-template')).toBeUndefined()
  })

  test('template allowlists trim and ignore case like the Platform validator; empty allowlists admit all templates', () => {
    const blocked = sourceWith({ allowedRepositories: ['appthrust/template-other'] })
    expect(templateSourceProblem(template, [blocked])).toBe('not-admitted')
    expect(pickSourceConnection([blocked], template)).toBeUndefined()
    expect(templateSourceProblem(template, [sourceWith({ allowedRepositories: [] })])).toBeUndefined()
    expect(templateSourceProblem(template, [sourceConnection])).toBeUndefined()
    expect(templateSourceProblem(template, [sourceWith({ allowedRepositories: [' AppThrust/Template-Nextjs '] })])).toBeUndefined()
    expect(templateSourceProblem(templateWith({
      githubTemplate: { ...wireTemplate.githubTemplate, repository: ' APPTHRUST/template-nextjs ' },
    }), [sourceWith({ allowedRepositories: ['appthrust/template-nextjs'] })])).toBeUndefined()
    expect(templateSourceProblem(template, [])).toBe('no-connection')
    expect(templateSourceProblem(template, [sourceWith({ status: 'incomplete' })])).toBe('no-connection')
    expect(templateSourceProblem(template, [sourceWith({ capabilities: ['createRepositories'] })])).toBe('no-connection')
    expect(pickSourceConnection([blocked])).toBe(blocked)
  })

  test('an unknown connection status or capability is never ready and never a capability', () => {
    expect(pickSourceConnection([sourceWith({ status: 'verified-later' })])).toBeUndefined()
    expect(templateSourceProblem(template, [sourceWith({ capabilities: ['createRepositories', 'readEverything'] })])).toBe('no-connection')
    expect(pickCreateEnvironment([sourceConnection], [registryOf({ ...wireRegistry, status: 'warming' })], [seedDomain]).registry).toBeUndefined()
    expect(templateUsableFor(templateWith({ sourceKinds: ['gitlab-template'], availability: { available: true, sources: [{ kind: 'gitlab-template', available: true }] } }), 'github-template')).toBe(false)
    expect(pickPublishDomain([customDomain, domainOf({ ...wireSeedDomain, source: 'future-source' })])).toBe('acme.dev')
  })

  test('only an explicitly served version is pinned (Platform omits served: false)', () => {
    const omitted = definitionOf({ ...wireDefinition, versions: [{ name: 'v2', default: true }, { name: 'v1', served: true }] })
    expect(resolveCreateCatalog([template], [omitted], 'github-template')?.definitionRef).toEqual({ name: 'web-postgres', version: 'v1' })
    expect(resolveCreateCatalog([template], [definitionOf({ ...wireDefinition, versions: [{ name: 'v2' }] })], 'github-template')?.definitionRef).toEqual({ name: 'web-postgres' })
  })

  test('a later admitting connection supplies the source repository request id', () => {
    const blocked = sourceWith({ allowedRepositories: ['appthrust/template-other'] })
    const admitted = sourceWith({ id: 'github-admitted', allowedRepositories: ['appthrust/template-nextjs'] })
    const sources = [blocked, admitted]
    expect(pickSourceConnection(sources, template)).toBe(admitted)
    expect(templateSourceProblem(template, sources)).toBeUndefined()
    const environment = pickCreateEnvironment(sources, [registryConnection], [seedDomain], template)
    const connections = sourceConnectionsOf(environment)!
    const catalog = resolveCreateCatalog([template], [definition], 'github-template')!
    expect(buildSourceRepositoryRequest('my-app', catalog, connections).sourceConnectionId).toBe(admitted.id)
    expect(pickSourceConnection([sourceWith({ id: 'github-admitted', allowedRepositories: ['appthrust/template-nextjs'], capabilities: ['createRepositories'] }), admitted], template)).toBe(admitted)
  })

  test('honours an explicit template choice and pairs the definition structurally', () => {
    const catalog = resolveCreateCatalog([template, remix], [definition], 'github-template', 'remix-postgres')
    expect(catalog?.template.id).toBe('remix-postgres')
    expect(catalog?.definitionRef).toEqual({ name: 'web-postgres', version: 'v1' })
    expect(resolveCreateCatalog([remix], [definition], 'sample-image')).toBeUndefined()
  })

  test('the ひな形 path needs a ready source connection that can create repositories and a ready registry connection', () => {
    const ready = pickCreateEnvironment([sourceConnection], [registryConnection], [seedDomain])
    expect(ready).toEqual({ source: sourceConnection, registry: registryConnection, domain: seedDomain.name })
    expect(sourceConnectionsOf(ready)).toEqual({ source: sourceConnection, registry: registryConnection })
    expect(pickCreateEnvironment([sourceWith({ status: 'incomplete' })], [registryConnection], []).source).toBeUndefined()
    expect(
      pickCreateEnvironment([sourceWith({ capabilities: ['readPackages'] })], [registryConnection], []).source
    ).toBeUndefined()
    expect(sourceConnectionsOf(pickCreateEnvironment([sourceConnection], [], []))).toBeUndefined()
  })

  test('publish domain: usableForPublish only, the project seed domain preferred', () => {
    expect(pickPublishDomain([customDomain, seedDomain])).toBe('pj-eee7fa8eabbc.appthrust.ink')
    expect(pickPublishDomain([domainOf({ ...wireSeedDomain, usableForPublish: false }), customDomain])).toBe('acme.dev')
    expect(pickPublishDomain([domainOf({ ...wireSeedDomain, usableForPublish: false })])).toBeUndefined()
    expect(pickPublishDomain([])).toBeUndefined()
    expect(appUrl('mitsumori', 'pj-eee7fa8eabbc.appthrust.ink')).toBe('https://mitsumori.pj-eee7fa8eabbc.appthrust.ink')
  })

  test('missing prerequisites name each piece; only the image entry works without GitHub', () => {
    for (const entry of ['template', 'existing', 'ai'] as const) {
      expect(missingPrerequisites({}, entry)).toEqual(['github', 'registry', 'domain'])
    }
    expect(missingPrerequisites({}, 'image')).toEqual(['registry', 'domain'])
    const noRegistry = pickCreateEnvironment([sourceConnection], [registryOf({ ...wireRegistry, status: 'incomplete' })], [seedDomain])
    expect(missingPrerequisites(noRegistry, 'existing')).toEqual(['registry'])
    expect(missingPrerequisites(noRegistry, 'image')).toEqual(['registry'])
    const ready = pickCreateEnvironment([sourceConnection], [registryConnection], [seedDomain])
    expect(missingPrerequisites(ready, 'template')).toEqual([])
    expect(missingPrerequisites(ready, 'ai')).toEqual([])
    expect(missingPrerequisites({ ...ready, domain: undefined }, 'image')).toEqual(['domain'])
  })
})

describe('platform requests', () => {
  const catalog = resolveCreateCatalog([template], [definition], 'github-template')!
  const connections = { source: sourceConnection, registry: registryConnection }

  test('ひな形: source repository mirrors the Dashboard github-template submission', () => {
    expect(buildSourceRepositoryRequest('mitsumori', catalog, connections)).toEqual({
      sourceConnectionId: 'github-source-207cb7ce',
      registryConnectionRef: 'ghcr-acme',
      template: { repository: 'appthrust/template-nextjs', ref: 'main' },
      destination: { repositoryName: 'mitsumori', visibility: 'private' },
      image: { imagePath: 'ghcr.io/acme/mitsumori', tagFilter: 'edge-', versioningScheme: 'Alphabetical' },
      build: { mode: 'observed-image', ref: 'main' },
    })
  })

  test('a template without githubTemplate falls back to the appthrust template repository', () => {
    const remixCatalog = resolveCreateCatalog([remix], [definition], 'github-template')!
    expect(buildSourceRepositoryRequest('a', remixCatalog, connections).template).toEqual({
      repository: 'appthrust/template-remix',
      ref: 'main',
    })
  })

  test('ひな形: the stack consumes the created source repository and publishes on the project domain', () => {
    const request = buildCreateStackRequest(
      'mitsumori',
      { kind: 'application-source-repository', sourceRepositoryId: 'mitsumori-src' },
      catalog,
      'pj-eee7fa8eabbc.appthrust.ink'
    )
    expect(request.source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: 'mitsumori-src' })
    expect(request.application).toEqual({ name: 'mitsumori' })
    // https://mitsumori.pj-eee7fa8eabbc.appthrust.ink (gateway: customDomain + wildcard + subdomain).
    expect(request.publish).toEqual({
      enabled: true,
      customDomain: 'pj-eee7fa8eabbc.appthrust.ink',
      hostnamePattern: 'wildcard',
      subdomain: 'mitsumori',
    })
  })

  test('イメージ: the sample-image request', () => {
    const imageCatalog = resolveCreateCatalog([template], [definition], 'sample-image')!
    expect(
      buildCreateStackRequest('my-shop', { kind: 'sample-image', imageRef: ' ghcr.io/a/b:1 ' }, imageCatalog, 'acme.dev')
    ).toEqual({
      templateId: 'nextjs-postgres',
      definitionRef: { name: 'web-postgres', version: 'v1' },
      application: { name: 'my-shop' },
      branch: { id: 'production', role: 'production', createIfMissing: true },
      source: { kind: 'sample-image', imageRef: 'ghcr.io/a/b:1' },
      web: { componentName: 'web' },
      database: { componentName: 'db' },
      connection: { connectionName: 'database' },
      publish: { enabled: true, customDomain: 'acme.dev', hostnamePattern: 'wildcard', subdomain: 'my-shop' },
    })
  })

  test('no create path sends a port, even when the catalog still advertises one', () => {
    const advertised = definitionOf({
      ...wireDefinition,
      components: [
        { id: 'web', definitionRef: { name: 'web-service', version: 'v1' }, defaultValues: { port: 3000 } },
        { id: 'database', definitionRef: { name: 'postgresql', version: 'v1' } },
      ],
    })
    const sources = [
      { kind: 'application-source-repository', sourceRepositoryId: 'mitsumori-src' },
      { kind: 'sample-image', imageRef: 'ghcr.io/a/b:1' },
    ] as const
    for (const sourceKind of ['github-template', 'sample-image'] as const) {
      const resolved = resolveCreateCatalog([template], [advertised], sourceKind)!
      expect(resolved).not.toHaveProperty('port')
      for (const source of sources) {
        expect(buildCreateStackRequest('mitsumori', source, resolved, 'acme.dev').web).toEqual({ componentName: 'web' })
      }
    }
  })
})

describe('作ったコードから', () => {
  test('the URL name follows the repository name', () => {
    expect(urlNameFromRepository('acme/Mitsumori_App')).toBe('mitsumori-app')
    expect(urlNameFromRepository('acme/help')).toBe('help-app')
  })

  test('adopts the repository on its default branch; edge-* images under the registry, build left to the platform', () => {
    expect(
      buildExistingSourceRepositoryRequest(
        { fullName: 'Acme/Claude-Mitsumori', defaultBranch: 'trunk' },
        { source: sourceConnection, registry: registryConnection }
      )
    ).toEqual({
      sourceConnectionId: 'github-source-207cb7ce',
      registryConnectionRef: 'ghcr-acme',
      existing: { repository: 'Acme/Claude-Mitsumori', ref: 'trunk' },
      image: { imagePath: 'ghcr.io/acme/claude-mitsumori', tagFilter: 'edge-', versioningScheme: 'Alphabetical' },
    })
  })
})

describe('AI の計画', () => {
  const stackRequest = buildCreateStackRequest(
    'mitsumori-ai',
    { kind: 'application-source-repository', sourceRepositoryId: 'mitsumori-ai-src' },
    resolveCreateCatalog([template], [definition], 'github-template')!,
    'pj.appthrust.test'
  )
  const plan: CreationPlan = {
    summary: '見積書を作って PDF で出すアプリ',
    representation: ['SourceRepository', 'ApplicationStack'],
    markdown: '# plan',
    applicationSourceRepositoryRequest: buildSourceRepositoryRequest(
      'mitsumori-ai',
      resolveCreateCatalog([template], [definition], 'github-template')!,
      { source: sourceConnection, registry: registryConnection }
    ),
    applicationStackRequest: stackRequest,
  }

  test('summarizes parts, ひな形, platform name and URL', () => {
    expect(summarizeCreationPlan(plan)).toEqual({
      summary: '見積書を作って PDF で出すアプリ',
      parts: ['source', 'web', 'database'],
      templateId: 'nextjs-postgres',
      appName: 'mitsumori-ai',
      url: 'https://mitsumori-ai.pj.appthrust.test',
    })
  })

  test('the deprecated applicationName and an apex publish are understood; no stack means nothing to show', () => {
    const { application: _application, ...legacy } = stackRequest
    expect(
      summarizeCreationPlan({
        ...plan,
        applicationStackRequest: { ...legacy, applicationName: 'legacy', publish: { enabled: true, customDomain: 'shop.acme.dev', hostnamePattern: 'apex' } },
      })
    ).toMatchObject({ appName: 'legacy', url: 'https://shop.acme.dev' })
    expect(summarizeCreationPlan({ summary: 's', representation: ['Application'], markdown: 'm' })).toEqual({ summary: 's', parts: [] })
    // appthrust.ink 2026-10-10: a draft whose plan was restored by creation cleanup serialises `representation: null`
    // and crashed the whole build page (「情報を読み込めませんでした」).
    expect(summarizeCreationPlan({ ...plan, representation: null as unknown as typeof plan.representation })).toMatchObject({ parts: ['source', 'web', 'database'] })
  })
})
