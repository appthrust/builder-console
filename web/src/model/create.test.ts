import { describe, expect, test } from 'bun:test'
import { definitionOf, domainOf, registryOf, resolvedDestinationOf, sourceConnectionOf, templateOf } from '../api/testing/catalog-domain'
import type { CreationPlan } from './contracts/build'
import {
  appUrl,
  buildCreateStackRequest,
  buildExistingSourceRepositoryRequest,
  buildSourceRepositoryRequest,
  destinationImage,
  destinationRepository,
  isValidAppName,
  missingPrerequisites,
  newRepositoryEntry,
  numberedUrlName,
  pickCreateEnvironment,
  pickPublishDomain,
  resolveCreateCatalog,
  suggestUrlName,
  summarizeCreationPlan,
  templatesFor,
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

// The Project's resolved repository destination: GHCR under the connection's account, or the built-in registry.
const ghcrDestination = resolvedDestinationOf()
const builtinDestination = resolvedDestinationOf({ revision: 'rd-builtin-2', registryNamespace: 'registry.appthrust.test/commerce', imageAccessId: 'platform-registry' })

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

  test('new repositories never come from the connection list: the connection catalog only serves adoption', () => {
    // Two ready connections in either order: no new-repository request can be built from them, only adoption.
    const other = sourceWith({ id: 'github-other' })
    expect(pickCreateEnvironment([other, sourceConnection], [registryConnection], [seedDomain]).adoption).toBe(other)
    expect(newRepositoryEntry('template')).toBe(true)
    expect(newRepositoryEntry('ai')).toBe(true)
    expect(newRepositoryEntry('existing')).toBe(false)
    expect(newRepositoryEntry('image')).toBe(false)
    expect(newRepositoryEntry(undefined)).toBe(false)
  })

  test('an unknown connection status or capability is never ready and never a capability', () => {
    expect(pickCreateEnvironment([sourceWith({ status: 'verified-later' })], [registryConnection], [seedDomain]).adoption).toBeUndefined()
    expect(pickCreateEnvironment([sourceWith({ capabilities: ['readEverything'] })], [registryConnection], [seedDomain]).adoption).toBeUndefined()
    expect(pickCreateEnvironment([sourceConnection], [registryOf({ ...wireRegistry, status: 'warming' })], [seedDomain]).registry).toBeUndefined()
    expect(templateUsableFor(templateWith({ sourceKinds: ['gitlab-template'], availability: { available: true, sources: [{ kind: 'gitlab-template', available: true }] } }), 'github-template')).toBe(false)
    expect(pickPublishDomain([customDomain, domainOf({ ...wireSeedDomain, source: 'future-source' })])).toBe('acme.dev')
  })

  test('only an explicitly served version is pinned (Platform omits served: false)', () => {
    const omitted = definitionOf({ ...wireDefinition, versions: [{ name: 'v2', default: true }, { name: 'v1', served: true }] })
    expect(resolveCreateCatalog([template], [omitted], 'github-template')?.definitionRef).toEqual({ name: 'web-postgres', version: 'v1' })
    expect(resolveCreateCatalog([template], [definitionOf({ ...wireDefinition, versions: [{ name: 'v2' }] })], 'github-template')?.definitionRef).toEqual({ name: 'web-postgres' })
  })

  test('where a new repository and its image go is the resolved destination, GHCR or the built-in registry', () => {
    expect(destinationRepository(ghcrDestination, 'mitsumori')).toBe('acme/mitsumori')
    expect(destinationImage(ghcrDestination, 'mitsumori')).toBe('ghcr.io/acme/mitsumori')
    expect(destinationRepository(builtinDestination, 'mitsumori')).toBe('acme/mitsumori')
    expect(destinationImage(builtinDestination, 'mitsumori')).toBe('registry.appthrust.test/commerce/mitsumori')
  })

  test('honours an explicit template choice and pairs the definition structurally', () => {
    const catalog = resolveCreateCatalog([template, remix], [definition], 'github-template', 'remix-postgres')
    expect(catalog?.template.id).toBe('remix-postgres')
    expect(catalog?.definitionRef).toEqual({ name: 'web-postgres', version: 'v1' })
    expect(resolveCreateCatalog([remix], [definition], 'sample-image')).toBeUndefined()
  })

  test('adoption needs a ready connection that can act on repositories; the image entry a ready registry', () => {
    const ready = pickCreateEnvironment([sourceConnection], [registryConnection], [seedDomain])
    expect(ready).toEqual({ adoption: sourceConnection, registry: registryConnection, domain: seedDomain.name })
    expect(pickCreateEnvironment([sourceWith({ status: 'incomplete' })], [registryConnection], []).adoption).toBeUndefined()
    expect(pickCreateEnvironment([sourceWith({ capabilities: ['readPackages'] })], [registryConnection], []).adoption).toBeUndefined()
  })

  test('publish domain: usableForPublish only, the project seed domain preferred', () => {
    expect(pickPublishDomain([customDomain, seedDomain])).toBe('pj-eee7fa8eabbc.appthrust.ink')
    expect(pickPublishDomain([domainOf({ ...wireSeedDomain, usableForPublish: false }), customDomain])).toBe('acme.dev')
    expect(pickPublishDomain([domainOf({ ...wireSeedDomain, usableForPublish: false })])).toBeUndefined()
    expect(pickPublishDomain([])).toBeUndefined()
    expect(appUrl('mitsumori', 'pj-eee7fa8eabbc.appthrust.ink')).toBe('https://mitsumori.pj-eee7fa8eabbc.appthrust.ink')
  })

  test('missing prerequisites: GitHub only for adoption, a registry only for an image; new repositories need the destination instead', () => {
    expect(missingPrerequisites({}, 'existing')).toEqual(['github', 'domain'])
    expect(missingPrerequisites({}, 'image')).toEqual(['registry', 'domain'])
    expect(missingPrerequisites({}, 'template')).toEqual(['domain'])
    expect(missingPrerequisites({}, 'ai')).toEqual(['domain'])
    const noRegistry = pickCreateEnvironment([sourceConnection], [registryOf({ ...wireRegistry, status: 'incomplete' })], [seedDomain])
    expect(missingPrerequisites(noRegistry, 'existing')).toEqual([])
    expect(missingPrerequisites(noRegistry, 'image')).toEqual(['registry'])
    const ready = pickCreateEnvironment([sourceConnection], [registryConnection], [seedDomain])
    for (const entry of ['template', 'existing', 'ai', 'image'] as const) expect(missingPrerequisites(ready, entry)).toEqual([])
    expect(missingPrerequisites({ ...ready, domain: undefined }, 'image')).toEqual(['domain'])
  })
})

describe('platform requests', () => {
  const catalog = resolveCreateCatalog([template], [definition], 'github-template')!

  test('ひな形: the request names the template, the name and the shown revision; never a connection, registry or image path', () => {
    const request = buildSourceRepositoryRequest('mitsumori', catalog, ghcrDestination)
    expect(request).toEqual({
      template: { repository: 'appthrust/template-nextjs', ref: 'main' },
      destination: { repositoryName: 'mitsumori', visibility: 'private' },
      destinationRevision: 'rd-ghcr-1',
      build: { mode: 'observed-image', ref: 'main' },
    })
    for (const field of ['sourceConnectionId', 'registryConnectionRef', 'registryProviderConnectionRef', 'gitProviderConnectionRef', 'image']) expect(request).not.toHaveProperty(field)
  })

  test('ひな形 at the built-in registry: the same request, bound to that destination’s revision', () => {
    const request = buildSourceRepositoryRequest('mitsumori', catalog, builtinDestination)
    expect(request.destinationRevision).toBe('rd-builtin-2')
    expect(request).not.toHaveProperty('image')
    expect(request).not.toHaveProperty('registryConnectionRef')
  })

  test('a template without githubTemplate falls back to the appthrust template repository', () => {
    const remixCatalog = resolveCreateCatalog([remix], [definition], 'github-template')!
    expect(buildSourceRepositoryRequest('a', remixCatalog, ghcrDestination).template).toEqual({
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

  test('adopts the repository on its default branch with its connection; Platform derives the image and its access', () => {
    const request = buildExistingSourceRepositoryRequest({ fullName: 'Acme/Claude-Mitsumori', defaultBranch: 'trunk' }, sourceConnection)
    expect(request).toEqual({
      sourceConnectionId: 'github-source-207cb7ce',
      existing: { repository: 'Acme/Claude-Mitsumori', ref: 'trunk' },
    })
    for (const field of ['registryConnectionRef', 'registryProviderConnectionRef', 'image', 'destinationRevision']) expect(request).not.toHaveProperty(field)
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
      ghcrDestination
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
