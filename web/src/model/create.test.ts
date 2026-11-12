import { describe, expect, test } from 'bun:test'
import type {
  ApplicationDraftCreationPlan,
  ApplicationStackDefinition,
  ApplicationTemplateSummary,
  Domain,
  GitHubSourceConnection,
  RegistryConnection,
} from '@appthrust/api-schema/platform-api'
import type { RepositoryDestinationResolution } from '../api/repository-destination'
import {
  adoptionConnectionsOf,
  appUrl,
  buildCreateStackRequest,
  buildExistingSourceRepositoryRequest,
  buildSourceRepositoryRequest,
  destinationImage,
  destinationMoved,
  destinationProblem,
  destinationRepository,
  isRepositoryDestinationReason,
  isValidAppName,
  missingPrerequisites,
  numberedUrlName,
  pickCreateEnvironment,
  pickPublishDomain,
  resolveCreateCatalog,
  resolvedDestination,
  suggestUrlName,
  summarizeCreationPlan,
  templatesFor,
  templateUsableFor,
  urlNameFromRepository,
  type ResolvedDestination,
} from './create'

const template: ApplicationTemplateSummary = {
  id: 'nextjs-postgres',
  displayName: 'Next.js + PostgreSQL',
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

const remix: ApplicationTemplateSummary = {
  ...template,
  id: 'remix-postgres',
  displayName: 'Remix + PostgreSQL',
  sourceKinds: ['github-template'],
  githubTemplate: undefined,
}

const definition: ApplicationStackDefinition = {
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

const sourceConnection: GitHubSourceConnection = {
  id: 'github-source-207cb7ce',
  displayName: 'Acme GitHub',
  account: { login: 'Acme', type: 'Organization' },
  capabilities: ['createRepositories', 'readTemplateRepositories'],
  status: 'ready',
  source: 'github-source-connection-cr',
}

const registryConnection: RegistryConnection = {
  id: 'ghcr-acme',
  displayName: 'GHCR',
  registryHost: 'ghcr.io',
  registryType: 'ghcr',
  status: 'ready',
  source: 'registry-connection-cr',
}

const craftsman: ResolvedDestination = {
  state: 'Resolved',
  source: 'Project',
  revision: 'rev-1',
  destination: {
    connectionId: 'github-source-729d7936',
    provider: 'github',
    displayName: 'Craftsman GitHub',
    repositoryNamespace: 'craftsman-software',
    registryNamespace: 'ghcr.io/craftsman-software',
    imageAccessId: 'registry-connection-81d27ee1',
  },
}

const ambiguous: RepositoryDestinationResolution = {
  state: 'Blocked',
  reason: 'Ambiguous',
  message: 'several source connections can create repositories',
  candidateIds: ['github-source-207cb7ce', 'github-source-729d7936'],
}

const seedDomain: Domain = {
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

const customDomain: Domain = {
  ...seedDomain,
  id: 'acme.dev',
  name: 'acme.dev',
  source: 'hostedZone',
  deletable: true,
}

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
    const imageOnly: ApplicationTemplateSummary = {
      ...template,
      availability: { available: true, sources: [{ kind: 'sample-image', available: true }, { kind: 'github-template', available: false }] },
    }
    expect(templateUsableFor(imageOnly, 'github-template')).toBe(false)
    expect(templateUsableFor(imageOnly, 'sample-image')).toBe(true)
    expect(templateUsableFor({ ...template, sourceKinds: ['sample-image'] }, 'github-template')).toBe(false)
    expect(templatesFor([imageOnly], 'github-template')).toEqual([])
    expect(resolveCreateCatalog([imageOnly], [definition], 'github-template', template.id)).toBeUndefined()
    expect(resolveCreateCatalog([imageOnly], [definition], 'sample-image')?.template).toBe(imageOnly)
  })

  test('marketplace definitions are never paired with a template, even when listed first with the same shape', () => {
    const marketplace: ApplicationStackDefinition = { ...definition, id: 'builder-console', catalogSource: 'appthrust' }
    expect(resolveCreateCatalog([template], [marketplace, definition], 'github-template')?.definitionRef?.name).toBe(definition.id)
    expect(resolveCreateCatalog([template], [marketplace], 'github-template')).toBeUndefined()
  })

  test('the destination is the platform resolution: list order, allowlists and the template never pick a connection', () => {
    // appthrust (sorted first, admits the template) and craftsman-software are both creatable; the Project default wins.
    const appthrust = { ...sourceConnection, id: 'github-source-207cb7ce', account: { login: 'appthrust', type: 'Organization' }, allowedRepositories: ['appthrust/template-nextjs'] }
    const declared = { ...sourceConnection, id: 'github-source-729d7936', account: { login: 'craftsman-software', type: 'Organization' }, allowedRepositories: ['appthrust/template-other'] }
    const environment = pickCreateEnvironment([appthrust, declared], [registryConnection], [seedDomain], craftsman)
    const catalog = resolveCreateCatalog([template], [definition], 'github-template')!
    expect(resolvedDestination(environment.destination)).toBe(craftsman)
    const request = buildSourceRepositoryRequest('my-app', catalog, resolvedDestination(environment.destination)!)
    expect(request.destinationRevision).toBe('rev-1')
    expect(request).not.toHaveProperty('sourceConnectionId')
    expect(request).not.toHaveProperty('registryConnectionRef')
    expect(request.image).not.toHaveProperty('imagePath')
    expect(destinationRepository(craftsman, 'my-app')).toBe('craftsman-software/my-app')
    expect(destinationImage(craftsman, 'my-app')).toBe('ghcr.io/craftsman-software/my-app')
  })

  test('a blocked or missing resolution is a destination problem; a resolved one is not', () => {
    expect(destinationProblem(craftsman)).toBeUndefined()
    expect(destinationProblem(ambiguous)).toEqual({ reason: 'Ambiguous', message: 'several source connections can create repositories' })
    expect(destinationProblem({ state: 'Blocked', reason: 'SomethingNew', message: 'server words' })).toEqual({ reason: 'SomethingNew', message: 'server words' })
    expect(destinationProblem(undefined)).toEqual({ reason: 'Unavailable', message: '' })
    expect(resolvedDestination(ambiguous)).toBeUndefined()
    expect(isRepositoryDestinationReason('DestinationChanged')).toBe(true)
    expect(isRepositoryDestinationReason('delivery_pending')).toBe(false)
    expect(isRepositoryDestinationReason(undefined)).toBe(false)
  })

  test('a destination moved only when its connection or namespaces changed, not on a new revision', () => {
    expect(destinationMoved(craftsman, { ...craftsman, revision: 'rev-2' })).toBe(false)
    expect(destinationMoved(craftsman, { ...craftsman, destination: { ...craftsman.destination, connectionId: 'github-source-207cb7ce', repositoryNamespace: 'appthrust', registryNamespace: 'ghcr.io/appthrust' } })).toBe(true)
    expect(destinationMoved(craftsman, undefined)).toBe(true)
  })

  test('honours an explicit template choice and pairs the definition structurally', () => {
    const catalog = resolveCreateCatalog([template, remix], [definition], 'github-template', 'remix-postgres')
    expect(catalog?.template.id).toBe('remix-postgres')
    expect(catalog?.definitionRef).toEqual({ name: 'web-postgres', version: 'v1' })
    expect(resolveCreateCatalog([remix], [definition], 'sample-image')).toBeUndefined()
  })

  test('作ったコードから adopts with the first ready connection that can create repositories and a ready registry', () => {
    const ready = pickCreateEnvironment([sourceConnection], [registryConnection], [seedDomain], craftsman)
    expect(ready).toEqual({ adoption: sourceConnection, registry: registryConnection, destination: craftsman, domain: seedDomain.name })
    expect(adoptionConnectionsOf(ready)).toEqual({ source: sourceConnection, registry: registryConnection })
    expect(pickCreateEnvironment([{ ...sourceConnection, status: 'incomplete' }], [registryConnection], []).adoption).toBeUndefined()
    expect(
      pickCreateEnvironment([{ ...sourceConnection, capabilities: ['readPackages'] }], [registryConnection], []).adoption
    ).toBeUndefined()
    expect(adoptionConnectionsOf(pickCreateEnvironment([sourceConnection], [], []))).toBeUndefined()
  })

  test('publish domain: usableForPublish only, the project seed domain preferred', () => {
    expect(pickPublishDomain([customDomain, seedDomain])).toBe('pj-eee7fa8eabbc.appthrust.ink')
    expect(pickPublishDomain([{ ...seedDomain, usableForPublish: false }, customDomain])).toBe('acme.dev')
    expect(pickPublishDomain([{ ...seedDomain, usableForPublish: false }])).toBeUndefined()
    expect(pickPublishDomain([])).toBeUndefined()
    expect(appUrl('mitsumori', 'pj-eee7fa8eabbc.appthrust.ink')).toBe('https://mitsumori.pj-eee7fa8eabbc.appthrust.ink')
  })

  test('missing prerequisites: adoption and image name their connections; new repositories rely on the destination', () => {
    expect(missingPrerequisites({}, 'existing')).toEqual(['github', 'registry', 'domain'])
    expect(missingPrerequisites({}, 'image')).toEqual(['registry', 'domain'])
    for (const entry of ['template', 'ai'] as const) expect(missingPrerequisites({}, entry)).toEqual(['domain'])
    const noRegistry = pickCreateEnvironment([sourceConnection], [{ ...registryConnection, status: 'incomplete' }], [seedDomain], craftsman)
    expect(missingPrerequisites(noRegistry, 'existing')).toEqual(['registry'])
    expect(missingPrerequisites(noRegistry, 'image')).toEqual(['registry'])
    expect(missingPrerequisites(noRegistry, 'template')).toEqual([])
    const ready = pickCreateEnvironment([sourceConnection], [registryConnection], [seedDomain], craftsman)
    expect(missingPrerequisites(ready, 'template')).toEqual([])
    expect(missingPrerequisites(ready, 'ai')).toEqual([])
    expect(missingPrerequisites({ ...ready, domain: undefined }, 'image')).toEqual(['domain'])
  })
})

describe('platform requests', () => {
  const catalog = resolveCreateCatalog([template], [definition], 'github-template')!

  test('ひな形: template, name, visibility and the seen destination revision; the platform derives owner and image path', () => {
    expect(buildSourceRepositoryRequest('mitsumori', catalog, craftsman)).toEqual({
      template: { repository: 'appthrust/template-nextjs', ref: 'main' },
      destination: { repositoryName: 'mitsumori', visibility: 'private' },
      destinationRevision: 'rev-1',
      image: { tagFilter: 'edge-', versioningScheme: 'Alphabetical' },
      build: { mode: 'observed-image', ref: 'main' },
    })
  })

  test('a template without githubTemplate falls back to the appthrust template repository', () => {
    const remixCatalog = resolveCreateCatalog([remix], [definition], 'github-template')!
    expect(buildSourceRepositoryRequest('a', remixCatalog, craftsman).template).toEqual({
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
    const advertised: ApplicationStackDefinition = {
      ...definition,
      components: [
        { id: 'web', definitionRef: { name: 'web-service', version: 'v1' }, defaultValues: { port: 3000 } },
        { id: 'database', definitionRef: { name: 'postgresql', version: 'v1' } },
      ],
    }
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
  const plan: ApplicationDraftCreationPlan = {
    summary: '見積書を作って PDF で出すアプリ',
    representation: ['SourceRepository', 'ApplicationStack'],
    markdown: '# plan',
    applicationSourceRepositoryRequest: buildSourceRepositoryRequest(
      'mitsumori-ai',
      resolveCreateCatalog([template], [definition], 'github-template')!,
      craftsman
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
