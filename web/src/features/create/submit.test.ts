// The create sequence over the real create calls, gateway and contracts; only
// the network is in memory. Every answer is a wire literal as Platform / the
// Console send it, so each step's success is read by its production reader.
import { describe, expect, test } from 'bun:test'
import { createCreateApi, type CreateApi } from '../../api/create'
import { decodeResponse } from '../../api/boundary'
import { getRepositoryDestinationContract } from '../../api/contracts/platform/catalog'
import { appOf, appWireDefaults, definitionOf, resolvedDestinationOf, sourceConnectionOf, templateOf } from '../../api/testing/catalog-domain'
import { createTestGateway } from '../../api/testing/gateway'
import { copy } from '../../copy'
import { MOCK_PROJECT_ID, platformRoutes } from '../../dev/mock-platform'
import { resolveCreateCatalog } from '../../model/create'
import { text } from './copy'
import {
  abandonUnsettled,
  acceptCandidate,
  CREATED_BEFORE_HINT_MS,
  createdBeforeSent,
  confirmCreate,
  CreateFailed,
  keptElsewhere,
  keptSource,
  reconsiderCandidate,
  rejectCandidate,
  rejectedCandidate,
  submitCreate,
  type CreateDeps,
  type CreateProgress,
  type CreateRequest,
} from './submit'

const SECRET = 'SENTINEL-create-submit-51b7'

const wireTemplate = {
  id: 'nextjs-postgres',
  displayName: 'Next.js + PostgreSQL',
  category: 'framework',
  generatedKind: 'ApplicationStack',
  sourceKinds: ['sample-image', 'github-template'],
  defaultPort: 3000,
  components: [
    { id: 'web', displayName: 'Web', kind: 'web' },
    { id: 'postgres', displayName: 'PostgreSQL', kind: 'database' },
  ],
  availability: { available: true, sources: [{ kind: 'sample-image', available: true }, { kind: 'github-template', available: true }] },
}
const template = templateOf(wireTemplate)
const definition = definitionOf({
  id: 'web-postgres',
  title: 'Web + PostgreSQL',
  category: 'application',
  components: [
    { id: 'web', definitionRef: { name: 'web-service' } },
    { id: 'database', definitionRef: { name: 'postgresql' } },
  ],
})
/** The destination the wizard showed (GHCR under `acme`), and the connection a picked repository is adopted with. */
const destination = resolvedDestinationOf()
const adoption = sourceConnectionOf({ id: 'gh', displayName: 'gh', account: { login: 'acme', type: 'Organization' }, capabilities: ['createRepositories'], status: 'ready', source: 'github-source-connection-cr' })

const person = { id: 'p1', subject: 's', pending: false, email: 'a@example.test', displayName: '山田', avatarVersion: null }
/** The console app as the Console server answers it. */
const wireDraft = {
  id: 'app-1', slug: 'mitsumori', displayName: '見積作成', description: '', icon: '', tags: [], guide: '', capabilities: [], screenshots: [],
  group: { id: 'g1', path: 'sales/east', name: '営業1課' }, owners: [person], stackId: null, appName: 'mitsumori',
  share: { scope: 'group', groupIds: ['g1'], extraPersonIds: [] }, createdBy: person,
  createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z', ...appWireDefaults,
}
const draft = appOf(wireDraft)

const request: CreateRequest = {
  projectId: 'pj',
  path: { kind: 'template' },
  displayName: '見積作成',
  description: '',
  tags: [],
  groupId: 'g1',
  urlName: 'mitsumori',
  share: { scope: 'group', groupIds: ['g1'], extraPersonIds: [] },
}
const templateOrigin = { appName: 'mitsumori', kind: 'template' as const, templateId: 'nextjs-postgres' }
/** Where the ひな形 repository is made at the destination shown (GHCR under `acme`), as progress keeps it. */
const templateBinding = { repository: 'acme/mitsumori', image: 'ghcr.io/acme/mitsumori', revision: 'rd-ghcr-1', connectionId: 'github-source-207cb7ce' }
const madeSource = { sourceRepositoryId: 'mitsumori-src', sourceRepositoryOrigin: templateOrigin, sourceRepositoryBinding: templateBinding, sourceRepositoryProvenance: 'created' as const }
/** The same repository, chosen by the user from a readback (never deleted by the console). */
const foundSource = { ...madeSource, sourceRepositoryProvenance: 'found' as const }

const json = (body: unknown, status = 200) => Response.json(body, { status })
const operation = (kind: string, id: string) => ({ id: `op-${id}`, type: `${kind}.create`, state: 'accepted', writeChannel: 'A', resource: { kind, id, projectId: 'pj' }, createdAt: '2026-10-06T00:00:00Z', links: { self: `/api/v1/operations/op-${id}` } })
/** A Platform mutation answer: the read model, the receipt and the written `resource`. */
const mutation = (kind: string, resource: { id: string }, status = 202) => json({ ...resource, operation: operation(kind, resource.id), resource }, status)
const platformError = (status: number, code: string, message: string, details?: Record<string, unknown>) => json({ error: { code, message, ...(details ? { details } : {}) } }, status)
const wireRepository = (body: { destination?: { repositoryName: string }; existing?: { repository: string }; sourceConnectionId?: string }, id: string, createdAt?: string) => ({
  id, projectId: 'pj', ...(body.sourceConnectionId ? { sourceConnectionId: body.sourceConnectionId } : {}),
  ...(body.destination ? { destination: { repositoryName: body.destination.repositoryName, visibility: 'private' } } : {}),
  ...(body.existing ? { existing: { repository: body.existing.repository } } : {}),
  image: { imagePath: `ghcr.io/acme/${body.destination?.repositoryName ?? body.existing?.repository.split('/')[1]?.toLowerCase() ?? 'x'}`, tagFilter: 'edge-', versioningScheme: 'Alphabetical' }, status: 'pending', conditions: [],
  ...(createdAt ? { createdAt } : {}),
})
const wireStack = (id: string, applicationName: string, sourceRepositoryRefName?: string) => ({
  id, projectId: 'pj', templateId: 'nextjs-postgres', applicationName, sourceKind: sourceRepositoryRefName ? 'application-source-repository' : 'sample-image',
  ...(sourceRepositoryRefName ? { sourceRepositoryRefName } : {}), pendingSync: true,
})
const ok = { valid: true, message: 'ok' }

type Op =
  | 'createApp' | 'updateApp' | 'bindApp' | 'removeApp' | 'myApps' | 'app'
  | 'validateSource' | 'createSource' | 'deleteSource' | 'validateStack' | 'createStack' | 'sources' | 'stacks'
type Answer = (body: Record<string, unknown>, request: Request) => Response | Promise<Response>

/** Which operation a request is, by method and route (the contract's route templates). */
function operationOf(method: string, path: string): { op: Op; id?: string } | undefined {
  const app = /^\/api\/console\/apps\/([^/]+)(\/bind)?$/.exec(path)
  if (path === '/api/console/apps') return { op: method === 'POST' ? 'createApp' : 'myApps' }
  if (app) return { op: app[2] ? 'bindApp' : method === 'PATCH' ? 'updateApp' : method === 'DELETE' ? 'removeApp' : 'app', id: app[1] }
  const platform = /^\/api\/v1\/projects\/[^/]+\/(application-source-repositories|application-stacks)(?:\/([^/]+))?$/.exec(path)
  if (!platform) return undefined
  const [, collection, rest] = platform
  if (collection === 'application-source-repositories') {
    return rest === 'validate' ? { op: 'validateSource' } : method === 'DELETE' ? { op: 'deleteSource', id: rest } : { op: method === 'POST' ? 'createSource' : 'sources' }
  }
  return rest === 'validate' ? { op: 'validateStack' } : { op: method === 'POST' ? 'createStack' : 'stacks' }
}

function deps(answers: Partial<Record<Op, Answer>> = {}, state: { apps?: unknown[]; repositories?: unknown[]; stacks?: unknown[] } = {}) {
  const calls: string[] = []
  const bodies: Partial<Record<Op, Array<Record<string, unknown>>>> = {}
  const keys: Partial<Record<Op, Array<string | null>>> = {}
  const defaults: Record<Op, Answer> = {
    createApp: () => json(wireDraft, 201),
    updateApp: () => json(wireDraft),
    bindApp: (body) => json({ ...wireDraft, stackId: body.stackId }),
    removeApp: () => new Response(null, { status: 204 }),
    myApps: () => json({ items: state.apps ?? [] }),
    app: () => json(wireDraft),
    validateSource: () => json({ valid: true }),
    createSource: (body) => mutation('ApplicationSourceRepository', wireRepository(body, `${(body.destination as { repositoryName?: string } | undefined)?.repositoryName ?? 'mitsumori'}-src`)),
    deleteSource: (_body, request) => mutation('ApplicationSourceRepository', { id: new URL(request.url).pathname.split('/').at(-1)! }),
    validateStack: () => json({ valid: true, message: 'ok', source: ok, runtime: ok }),
    createStack: () => mutation('ApplicationStack', wireStack('mitsumori', 'mitsumori')),
    sources: () => json({ data: state.repositories ?? [], meta: { total: 0 } }),
    stacks: () => json({ data: state.stacks ?? [], meta: { total: 0 } }),
  }
  const answer = async (request: Request) => {
    const url = new URL(request.url)
    const route = operationOf(request.method, url.pathname)
    if (!route) return platformError(404, 'not_found', `unhandled ${request.method} ${url.pathname}`)
    const body = request.method === 'GET' || request.method === 'DELETE' ? {} : ((await request.clone().json()) as Record<string, unknown>)
    calls.push(route.op === 'bindApp' ? `bindApp:${String(body.stackId)}:${String(body.appName)}` : route.op === 'deleteSource' ? `deleteSource:${route.id}` : route.op)
    ;(bodies[route.op] ??= []).push(body)
    ;(keys[route.op] ??= []).push(request.headers.get('Idempotency-Key'))
    return (answers[route.op] ?? defaults[route.op])(body, request)
  }
  const gateway = createTestGateway({
    consoleFetch: (path, init) => answer(new Request(new URL(path, 'http://console.test'), init)),
    platformFetch: answer,
  })
  const api = createCreateApi(gateway)
  const value: CreateDeps & { api: CreateApi } = {
    api,
    catalog: resolveCreateCatalog([template], [definition], 'github-template')!,
    domain: 'pj.appthrust.test',
    destination,
    adoption,
    onPhase: () => {},
  }
  return { value, api, calls, bodies, keys }
}

const fail = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a failure') }, (error: unknown) => error as CreateFailed)

describe('submitCreate', () => {
  test('ひな形: draft → source repository → stack → bind, in that order', async () => {
    const { value, calls } = deps()
    const app = await submitCreate(request, {}, value)
    expect(app.stackId).toBe('mitsumori')
    // A ひな形 attempt first reads Platform's list: a same-named repository where it would go means the name is taken.
    expect(calls).toEqual(['createApp', 'sources', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
  })

  test('the template path reports its loading phase synchronously before waiting for the draft', async () => {
    const pending = Promise.withResolvers<Response>()
    const { value } = deps({ createApp: () => pending.promise })
    const phases: string[] = []
    value.onPhase = (phase) => { phases.push(phase) }
    const result = submitCreate(request, {}, value)
    expect(phases).toEqual(['draft'])
    pending.resolve(json(wireDraft, 201))
    await result
  })

  test.each([
    ['template.repository', 0],
    ['existing.repository', 1],
    ['destination.repositoryName', 1],
  ] as const)('invalid_argument for %s belongs to step %s', async (path, step) => {
    const message = `'${path}' is not allowed by the selected source connection`
    const { value } = deps({ createSource: () => platformError(400, 'invalid_argument', message) })
    const failure = await fail(submitCreate(request, {}, value))
    expect(failure.field).toEqual({ path, step })
    expect(failure.data?.message).toBe(message)
    expect(failure.nameTaken).toBe(false)
    expect(failure.unconfirmed).toBe(false)
    expect(failure.progress.draft).toEqual(draft)
  })

  test('a stale catalog reaches the mock allowlist rejection and returns to the template step', async () => {
    const viaMock: Answer = (_body, request) => platformRoutes(request, new URL(request.url)).then((response) => response!)
    const { value } = deps({ validateSource: viaMock, createSource: viaMock })
    // The mock resolves the same GHCR destination the fixture shows, so only the template allowlist refuses.
    value.catalog = {
      ...value.catalog,
      template: templateOf({
        id: 'biz-approval-postgres', displayName: 'Approval', category: 'business', generatedKind: 'ApplicationStack', sourceKinds: ['github-template'],
        components: [{ id: 'web', displayName: 'Web', kind: 'web' }, { id: 'postgres', displayName: 'PostgreSQL', kind: 'database' }],
        githubTemplate: { repository: 'appthrust/template-biz-approval', repositoryUrl: 'https://github.com/appthrust/template-biz-approval' },
        availability: { available: true, sources: [{ kind: 'github-template', available: true }] },
      }),
    }
    const failure = await fail(submitCreate({ ...request, projectId: MOCK_PROJECT_ID, urlName: 'blocked-template-test' }, {}, value))
    expect(failure.field).toEqual({ path: 'template.repository', step: 0 })
    expect(failure.data?.message).toBe("'template.repository' is not allowed by the selected source connection")
    expect(failure.progress).toEqual({ draft })
  })

  test('publishes completed resource ids before the next phase, so reload can resume', async () => {
    const { value } = deps()
    const saved: CreateProgress[] = []
    value.onProgress = (progress) => { saved.push(progress) }
    await submitCreate(request, {}, value)
    // Each create's key is saved before it is sent, so a reload mid-create resends with the same key.
    expect(saved.map((item) => [item.draft?.id, item.sourceRepositoryId, item.stackId, Boolean(item.attempts?.source), Boolean(item.attempts?.stack)])).toEqual([
      ['app-1', undefined, undefined, false, false], ['app-1', undefined, undefined, true, false], ['app-1', 'mitsumori-src', undefined, false, false],
      ['app-1', 'mitsumori-src', undefined, false, true], ['app-1', 'mitsumori-src', 'mitsumori', false, false],
    ])
  })

  test('changing a business template after a failed attempt uses the newly chosen source', async () => {
    const { value, calls, bodies } = deps()
    value.catalog = { ...value.catalog, template: templateOf({ ...wireTemplate, id: 'biz-master-postgres', category: 'business', githubTemplate: { repository: 'appthrust/template-biz-master', repositoryUrl: 'https://github.com/appthrust/template-biz-master', branch: 'main' } }) }
    await submitCreate(request, { draft, sourceRepositoryId: 'old-src', sourceRepositoryOrigin: { appName: 'mitsumori', kind: 'template', templateId: 'biz-inventory-postgres' }, sourceRepositoryProvenance: 'created' }, value)
    expect(calls).toContain('deleteSource:old-src')
    expect(calls).toContain('createSource')
    expect(bodies.createSource?.[0]).toMatchObject({ template: { repository: 'appthrust/template-biz-master' } })
  })

  test.each([
    ['found by a readback and chosen by the user', 'found'],
    ['kept without how it was learned (older progress)', undefined],
  ] as const)('a kept repository %s is never deleted on a template or name change; it is left where it is', async (_label, provenance) => {
    const kept: CreateProgress = { draft, sourceRepositoryId: 'other-src', sourceRepositoryOrigin: { appName: 'mitsumori', kind: 'template', templateId: 'biz-inventory-postgres' }, sourceRepositoryBinding: templateBinding, ...(provenance ? { sourceRepositoryProvenance: provenance } : {}) }
    // The confirm step says it stays (keptElsewhere); a `created` one is not reported so, as it is removed.
    expect(keptElsewhere(kept, templateOrigin)).toEqual({ binding: templateBinding })
    expect(keptElsewhere({ ...kept, sourceRepositoryProvenance: 'created' }, templateOrigin)).toBeUndefined()
    for (const next of [request, { ...request, urlName: 'mitsumori-2' }]) {
      const { value, calls, bodies } = deps()
      await submitCreate(next, kept, value)
      expect(calls.some((call) => call.startsWith('deleteSource'))).toBe(false)
      expect(bodies.createStack?.[0]?.source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: `${next.urlName}-src` })
    }
  })

  test('イメージ: no source repository calls', async () => {
    const { value, calls } = deps()
    await submitCreate({ ...request, path: { kind: 'image', imageRef: 'ghcr.io/a/b:1' } }, {}, value)
    expect(calls).toEqual(['createApp', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
  })

  test('platform 403 deletes the draft and reports forbidden', async () => {
    const { value, calls } = deps({ validateSource: () => platformError(403, 'permission_denied', 'team role Viewer') })
    const failure = await fail(submitCreate(request, {}, value))
    expect(failure).toBeInstanceOf(CreateFailed)
    expect(failure.forbidden).toBe(true)
    expect(failure.progress).toEqual({})
    expect(calls).toEqual(['createApp', 'sources', 'validateSource', 'removeApp'])
  })

  test('other failures keep the draft and what was created; the retry resumes', async () => {
    const first = deps({ createStack: () => platformError(409, 'conflict', 'name taken') })
    const failure = await fail(submitCreate(request, {}, first.value))
    expect(failure.forbidden).toBe(false)
    expect(failure.data).toEqual({ message: 'name taken' })
    expect(failure.progress).toEqual({ draft, ...madeSource })
    expect(first.calls).not.toContain('removeApp')

    const retry = deps()
    await submitCreate(request, failure.progress, retry.value)
    expect(retry.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
  })

  test('a 409 is classified by its details.reason: delivery_pending is retryable, not a taken name', async () => {
    const message = 'Platform delivery is converging; retry the same request in a few seconds.'
    const first = deps({ createStack: () => platformError(409, 'conflict', message, { reason: 'delivery_pending', retryAfterSeconds: 5 }) })
    const failure = await fail(submitCreate(request, {}, first.value))
    expect([failure.retryable, failure.nameTaken, failure.data]).toEqual([true, false, { message }])
    expect(failure.progress).toEqual({ draft, ...madeSource })

    const retry = deps()
    await submitCreate(request, failure.progress, retry.value)
    expect(retry.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])

    const stopped = await fail(submitCreate(request, {}, deps({ createStack: () => platformError(409, 'conflict', 'blocked', { reason: 'delivery_blocked' }) }).value))
    expect([stopped.retryable, stopped.nameTaken]).toEqual([false, false])
    const taken = await fail(submitCreate(request, {}, deps({ createStack: () => platformError(409, 'conflict', 'publish endpoint is already owned by another publish', { reason: 'publish_url_conflict' }) }).value))
    expect([taken.retryable, taken.nameTaken]).toEqual([false, true])
  })

  test('a console answer without a contract envelope (gateway 500) is transient and retryable', async () => {
    const { value } = deps({ createApp: () => new Response('upstream connect error', { status: 500, headers: { 'Content-Type': 'text/plain' } }) })
    const failure = await fail(submitCreate(request, {}, value))
    expect([failure.transient, failure.retryable, failure.nameTaken, failure.unconfirmed]).toEqual([true, true, false, false])
    expect(failure.message).toBe(copy.errors.transient)
    expect(failure.data).toBeUndefined()
  })

  test('a validation answer of valid=false stops before creating anything on the platform', async () => {
    const { value, calls } = deps({ validateStack: () => json({ valid: false, message: 'quota exceeded', source: ok, runtime: ok }) })
    const failure = await fail(submitCreate({ ...request, path: { kind: 'image', imageRef: 'x' } }, {}, value))
    expect(failure.data).toEqual({ message: 'quota exceeded' })
    expect(calls).toEqual(['createApp', 'validateStack'])
  })

  test('the stack request publishes https://<urlName>.<domain>', async () => {
    const { value, bodies } = deps()
    await submitCreate(request, {}, value)
    expect(bodies.validateStack?.[0]?.publish).toEqual({ enabled: true, customDomain: 'pj.appthrust.test', hostnamePattern: 'wildcard', subdomain: 'mitsumori' })
  })

  test('a rejected stack validation carries each failing section message, in source → runtime → publish order', async () => {
    const { value, calls } = deps({
      validateStack: () => json({
        valid: false,
        message: 'Launch needs changes before resources can be created.',
        publish: { valid: false, message: "'customDomain' is required for gateway publish" },
        runtime: ok,
        source: { valid: false, message: 'sample-image ApplicationStack source requires a ready credentialed ContainerRepository' },
      }),
    })
    const failure = await fail(submitCreate({ ...request, path: { kind: 'image', imageRef: 'x' } }, {}, value))
    expect(failure.issues).toEqual([
      { section: 'source', message: 'sample-image ApplicationStack source requires a ready credentialed ContainerRepository' },
      { section: 'publish', message: "'customDomain' is required for gateway publish" },
    ])
    expect(failure.data).toEqual({ message: 'Launch needs changes before resources can be created.' })
    expect(calls).toEqual(['createApp', 'validateStack'])
  })

  test('a rejected source repository validation is reported as the source section; other failures have no sections', async () => {
    const failure = await fail(submitCreate(request, {}, deps({ validateSource: () => json({ valid: false, message: 'repository already exists' }) }).value))
    expect(failure.issues).toEqual([{ section: 'source', message: 'repository already exists' }])
    const other = await fail(submitCreate(request, {}, deps({ createStack: () => platformError(409, 'conflict', 'taken') }).value))
    expect(other.issues).toEqual([])
  })

  test('a retry after changing the URL name updates the kept draft first', async () => {
    const { value, calls } = deps()
    await submitCreate({ ...request, urlName: 'mitsumori2' }, { draft }, value)
    expect(calls[0]).toBe('updateApp')
    expect(calls.at(-1)).toBe('bindApp:mitsumori:mitsumori2')
  })

  test('a kept draft whose share scope this console does not know is rewritten with the chosen share, never assumed equal', async () => {
    const { value, calls } = deps()
    await submitCreate(request, { draft: appOf({ ...wireDraft, share: { scope: 'partners-only', groupIds: ['g1'], extraPersonIds: [] } }) }, value)
    expect(calls[0]).toBe('updateApp')
  })

  test('a rename after the stack failed replaces the kept repository with one named after the new URL name', async () => {
    const first = deps({ createStack: () => platformError(409, 'conflict', 'publish endpoint is already owned by another publish', { reason: 'publish_url_conflict' }) })
    const failure = await fail(submitCreate({ ...request, urlName: 'test' }, {}, first.value))
    expect(failure.nameTaken).toBe(true)
    expect(failure.progress).toMatchObject({ sourceRepositoryId: 'test-src', sourceRepositoryOrigin: { appName: 'test', kind: 'template' } })

    const retry = deps()
    await submitCreate({ ...request, urlName: 'test2' }, failure.progress, retry.value)
    expect(retry.calls).toEqual(['updateApp', 'deleteSource:test-src', 'sources', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:test2'])
    expect(retry.bodies.createSource?.[0]).toMatchObject({ destination: { repositoryName: 'test2' }, destinationRevision: 'rd-ghcr-1' })
    expect(retry.bodies.createSource?.[0]).not.toHaveProperty('image')
    expect(retry.bodies.createStack?.[0]?.source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: 'test2-src' })
  })

  test('a failed delete of the orphaned repository does not block the renamed attempt', async () => {
    const { value, calls } = deps({ deleteSource: () => platformError(409, 'conflict', 'referenced', { reason: 'referenced_by_stack' }) })
    const app = await submitCreate({ ...request, urlName: 'test2' }, { draft, sourceRepositoryId: 'test-src', sourceRepositoryOrigin: { appName: 'test', kind: 'template' }, sourceRepositoryProvenance: 'created' }, value)
    expect(calls).toContain('deleteSource:test-src')
    expect(app.stackId).toBe('mitsumori')
    expect(calls).toContain('createSource')
    expect(calls.at(-1)).toBe('bindApp:mitsumori:test2')
  })

  test('a kept stack is only bound under the name it was created with', async () => {
    const kept = { draft, sourceRepositoryId: 'test-src', sourceRepositoryOrigin: { appName: 'test', kind: 'template' as const }, stackId: 'test', stackAppName: 'test' }
    const same = deps()
    await submitCreate({ ...request, urlName: 'test' }, kept, same.value)
    expect(same.calls).toEqual(['updateApp', 'bindApp:test:test'])

    const renamed = deps()
    const failure = await fail(submitCreate({ ...request, urlName: 'test2' }, kept, renamed.value))
    expect(failure).toBeInstanceOf(CreateFailed)
    expect(failure.message).toContain('already created as "test"')
    expect(failure.progress).toEqual(kept)
    expect(renamed.calls).toEqual([])
  })

  test('作ったコードから: draft → adopt the picked repository → stack → bind', async () => {
    const { value, calls, bodies } = deps()
    const repository = { fullName: 'acme/claude-mitsumori', defaultBranch: 'main' }
    await submitCreate({ ...request, urlName: 'claude-mitsumori', path: { kind: 'existing', repository } }, {}, value)
    expect(calls).toEqual(['createApp', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:claude-mitsumori'])
    const body = bodies.validateSource?.[0]
    // Adoption keeps its connection; Platform derives the image path and its registry access.
    expect(body).toMatchObject({ sourceConnectionId: 'gh', existing: { repository: 'acme/claude-mitsumori', ref: 'main' } })
    for (const field of ['image', 'registryConnectionRef', 'registryProviderConnectionRef', 'destinationRevision', 'template', 'destination']) expect(body).not.toHaveProperty(field)
  })

  test('same URL name with a different existing repository deletes the orphan and adopts the new repository', async () => {
    const firstRequest: CreateRequest = { ...request, path: { kind: 'existing', repository: { fullName: 'acme/old-app', defaultBranch: 'main' } } }
    const failure = await fail(submitCreate(firstRequest, {}, deps({ createStack: () => platformError(409, 'conflict', 'name taken') }).value))
    expect(failure.progress.sourceRepositoryOrigin).toEqual({ appName: 'mitsumori', kind: 'existing', repository: 'acme/old-app' })

    const retry = deps({ createSource: (body) => mutation('ApplicationSourceRepository', wireRepository(body, 'new-app-src')) })
    await submitCreate({ ...request, path: { kind: 'existing', repository: { fullName: 'acme/new-app', defaultBranch: 'develop' } } }, failure.progress, retry.value)
    expect(retry.calls).toEqual(['deleteSource:mitsumori-src', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(retry.bodies.createSource).toHaveLength(1)
    expect(retry.bodies.createSource?.[0]).toMatchObject({ existing: { repository: 'acme/new-app', ref: 'develop' } })
    expect(retry.bodies.createStack?.[0]?.source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: 'new-app-src' })
  })

  test('same URL name switching template to existing deletes the orphan and adopts the picked repository', async () => {
    const failure = await fail(submitCreate(request, {}, deps({ createStack: () => platformError(409, 'conflict', 'name taken') }).value))
    const retry = deps({ createSource: (body) => mutation('ApplicationSourceRepository', wireRepository(body, 'picked-src')) })
    await submitCreate({ ...request, path: { kind: 'existing', repository: { fullName: 'acme/picked-app', defaultBranch: 'main' } } }, failure.progress, retry.value)
    expect(retry.calls).toEqual(['deleteSource:mitsumori-src', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(retry.bodies.createSource?.[0]).toMatchObject({ existing: { repository: 'acme/picked-app', ref: 'main' } })
    expect(retry.bodies.createSource?.[0]?.template).toBeUndefined()
    expect(retry.bodies.createStack?.[0]?.source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: 'picked-src' })
  })

  test('an identical existing repository origin reuses the source without deleting or creating', async () => {
    const existingRequest: CreateRequest = { ...request, path: { kind: 'existing', repository: { fullName: 'acme/picked-app', defaultBranch: 'main' } } }
    const failure = await fail(submitCreate(existingRequest, {}, deps({ createStack: () => platformError(409, 'conflict', 'name taken') }).value))
    const retry = deps()
    await submitCreate(existingRequest, failure.progress, retry.value)
    expect(retry.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(retry.bodies.createStack?.[0]?.source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: 'mitsumori-src' })
  })

  test('same URL name switching existing to template deletes the orphan and creates the template repository', async () => {
    const failure = await fail(submitCreate({ ...request, path: { kind: 'existing', repository: { fullName: 'acme/picked-app', defaultBranch: 'main' } } }, {}, deps({ createStack: () => platformError(409, 'conflict', 'name taken') }).value))
    const retry = deps()
    await submitCreate(request, failure.progress, retry.value)
    expect(retry.calls).toEqual(['deleteSource:mitsumori-src', 'sources', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(retry.bodies.createSource?.[0]).toMatchObject({ destination: { repositoryName: 'mitsumori' } })
    expect(retry.bodies.createSource?.[0]?.existing).toBeUndefined()
  })

  test('before the first send, a repository Platform already lists with this name where it would go is a taken name: nothing is validated or created', async () => {
    const existing = wireRepository({ destination: { repositoryName: 'mitsumori' }, sourceConnectionId: 'github-source-207cb7ce' }, 'someone-src', '2026-10-01T00:00:00Z')
    const { value, calls } = deps({}, { repositories: [existing] })
    const failure = await fail(submitCreate(request, {}, value))
    expect(failure.nameTaken).toBe(true)
    expect(calls).toEqual(['createApp', 'sources'])
    expect(failure.progress).toEqual({ draft })
    // The same name elsewhere (another image path) is not this destination's.
    const elsewhere = deps({}, { repositories: [{ ...existing, image: { imagePath: 'registry.appthrust.test/commerce/mitsumori' } }] })
    await submitCreate(request, {}, elsewhere.value)
    expect(elsewhere.calls).toContain('createSource')
  })
})

describe('an unreadable 2xx answer to a create step (X5: no resend, readback only, no duplicate)', () => {
  const malformed = () => json({ resource: { id: 42, name: SECRET } }, 202)

  /** The failure carries no payload: no wire string, no parser text, no detail. */
  function expectSafe(failure: CreateFailed) {
    expect(failure.unconfirmed).toBe(true)
    expect([failure.nameTaken, failure.retryable, failure.forbidden, failure.transient]).toEqual([false, false, false, false])
    expect(failure.data).toBeUndefined()
    expect(JSON.stringify({ message: failure.message, data: failure.data, issues: failure.issues, progress: failure.progress })).not.toContain(SECRET)
  }

  test('console app: the attempt stops, the next submit sends nothing, and the readback adopts the app the create made', async () => {
    const first = deps({ createApp: () => json({ id: 'app-1', slug: SECRET }, 201) })
    const failure = await fail(submitCreate(request, {}, first.value))
    expectSafe(failure)
    expect(failure.progress).toEqual({ unconfirmed: 'draft' })
    expect(first.calls).toEqual(['createApp'])

    // A resend before the readback is refused without a request.
    const blocked = deps()
    const refused = await fail(submitCreate(request, failure.progress, blocked.value))
    expect(refused.message).toBe(text.unconfirmed.title)
    expect(blocked.calls).toEqual([])

    // Only a same-slug app in the requested group, not yet bound, is this attempt's.
    const otherGroup = { ...wireDraft, id: 'app-9', group: { id: 'g2', path: 'sales/west', name: '営業2課' } }
    const readback = deps({}, { apps: [otherGroup, wireDraft] })
    const confirmed = await confirmCreate(request, failure.progress, readback.value)
    expect(readback.calls).toEqual(['myApps'])
    expect(confirmed).toEqual({ progress: { draft } })

    const retry = deps()
    await submitCreate(request, confirmed.progress, retry.value)
    expect(retry.calls).toEqual(['sources', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
  })

  test('console app: when the readback finds nothing, the next attempt creates it once', async () => {
    const failure = await fail(submitCreate(request, {}, deps({ createApp: () => json({ junk: SECRET }, 201) }).value))
    const readback = deps({}, { apps: [{ ...wireDraft, group: { id: 'g2', path: 'x', name: 'x' } }] })
    const confirmed = await confirmCreate(request, failure.progress, readback.value)
    expect(confirmed).toEqual({ progress: {} })
    const retry = deps()
    await submitCreate(request, confirmed.progress, retry.value)
    expect(retry.calls.filter((call) => call === 'createApp')).toHaveLength(1)
  })

  test('source repository: the readback offers the same-named repository where it was sent; once the user says it is theirs the retry does not create it again', async () => {
    const first = deps({ createSource: malformed })
    const failure = await fail(submitCreate(request, {}, first.value))
    expectSafe(failure)
    expect(failure.progress).toMatchObject({ draft, unconfirmed: 'source', attempts: { source: { key: first.keys.createSource?.[0] } } })
    expect(failure.progress.sourceRepositoryId).toBeUndefined()
    expect(first.calls).toEqual(['createApp', 'sources', 'validateSource', 'createSource'])

    const readback = deps({}, { repositories: [wireRepository({ destination: { repositoryName: 'other' } }, 'other-src'), wireRepository({ destination: { repositoryName: 'mitsumori' } }, 'mitsumori-src')] })
    const confirmed = await confirmCreate(request, failure.progress, readback.value)
    expect(readback.calls).toEqual(['app', 'sources'])
    // A candidate, not adopted: the attempt and its key stay, and nothing is sent until the user chooses.
    expect(confirmed.progress).toMatchObject({ candidate: { step: 'source', id: 'mitsumori-src', binding: templateBinding }, attempts: { source: { key: first.keys.createSource?.[0] } } })
    expect(confirmed.progress.sourceRepositoryId).toBeUndefined()
    const waiting = deps()
    await fail(submitCreate(request, confirmed.progress, waiting.value))
    expect(waiting.calls).toEqual([])

    const chosen = acceptCandidate(confirmed.progress)
    expect(chosen).toEqual({ draft, ...foundSource })
    const retry = deps()
    await submitCreate(request, chosen, retry.value)
    expect(retry.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
  })

  test('作ったコードから: the adopted repository is offered by the picked repository', async () => {
    const existing: CreateRequest = { ...request, path: { kind: 'existing', repository: { fullName: 'Acme/Picked-App', defaultBranch: 'main' } } }
    const failure = await fail(submitCreate(existing, {}, deps({ createSource: malformed }).value))
    const readback = deps({}, { repositories: [wireRepository({ existing: { repository: 'acme/picked-app' } }, 'picked-app-src')] })
    const confirmed = await confirmCreate(existing, failure.progress, readback.value)
    expect(confirmed.progress.candidate).toMatchObject({ step: 'source', id: 'picked-app-src' })
    expect(acceptCandidate(confirmed.progress)).toMatchObject({ sourceRepositoryId: 'picked-app-src', sourceRepositoryOrigin: { kind: 'existing', repository: 'Acme/Picked-App' }, sourceRepositoryProvenance: 'found' })
  })

  test('stack: the readback offers only the stack made from this attempt\'s source; once chosen, the retry only binds', async () => {
    const first = deps({ createStack: malformed })
    const failure = await fail(submitCreate(request, {}, first.value))
    expectSafe(failure)
    expect(failure.progress).toMatchObject({ draft, sourceRepositoryId: 'mitsumori-src', sourceRepositoryOrigin: templateOrigin, unconfirmed: 'platform', attempts: { stack: { key: first.keys.createStack?.[0] } } })

    const foreign = deps({}, { stacks: [wireStack('mitsumori-other', 'mitsumori', 'someone-else-src')] })
    const none = (await confirmCreate(request, failure.progress, foreign.value)).progress
    expect([none.stackId, none.candidate]).toEqual([undefined, undefined])

    const readback = deps({}, { stacks: [wireStack('mitsumori', 'mitsumori', 'mitsumori-src')] })
    const confirmed = await confirmCreate(request, failure.progress, readback.value)
    expect(readback.calls).toEqual(['app', 'stacks'])
    expect(confirmed.progress.candidate).toEqual({ step: 'stack', id: 'mitsumori', appName: 'mitsumori' })
    expect(confirmed.progress.stackId).toBeUndefined()
    expect(acceptCandidate(confirmed.progress)).toEqual({ draft, ...madeSource, stackId: 'mitsumori', stackAppName: 'mitsumori', stackProvenance: 'found' })

    const retry = deps()
    const app = await submitCreate(request, acceptCandidate(confirmed.progress), retry.value)
    expect(retry.calls).toEqual(['bindApp:mitsumori:mitsumori'])
    expect(app.stackId).toBe('mitsumori')
  })

  test('bind: the readback finds the bound app and finishes without binding again', async () => {
    const first = deps({ bindApp: () => json({ ...wireDraft, stackId: 7 }) })
    const failure = await fail(submitCreate(request, {}, first.value))
    expectSafe(failure)
    expect(failure.progress).toMatchObject({ stackId: 'mitsumori', stackAppName: 'mitsumori', unconfirmed: 'bind' })

    const readback = deps({ app: () => json({ ...wireDraft, stackId: 'mitsumori' }) })
    const confirmed = await confirmCreate(request, failure.progress, readback.value)
    expect(readback.calls).toEqual(['app'])
    expect(confirmed.app?.stackId).toBe('mitsumori')
    expect(confirmed.progress.unconfirmed).toBeUndefined()
  })

  test('a validation answer that cannot be read made nothing: the readback clears it and the retry validates again', async () => {
    const first = deps({ validateStack: () => json({ valid: 'yes', message: SECRET }) })
    const failure = await fail(submitCreate(request, {}, first.value))
    expectSafe(failure)
    expect(failure.progress.unconfirmed).toBe('checking')
    const confirmed = await confirmCreate(request, failure.progress, deps().value)
    expect(confirmed.progress).toEqual({ draft, ...madeSource })
    const retry = deps()
    await submitCreate(request, confirmed.progress, retry.value)
    expect(retry.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
  })

  test('a readback that cannot read rejects; the step stays unconfirmed for the caller', async () => {
    const failure = await fail(submitCreate(request, {}, deps({ createStack: malformed }).value))
    const broken = deps({ stacks: () => json({ data: null }) })
    await expect(confirmCreate(request, failure.progress, broken.value)).rejects.toMatchObject({ code: 'response_contract_invalid', outcome: 'read_failed' })
    expect(failure.progress.unconfirmed).toBe('platform')
  })

  test('any unreadable stack row keeps the readback unconfirmed, even beside a matching candidate', async () => {
    const failure = await fail(submitCreate(request, {}, deps({ createStack: malformed }).value))
    for (const bad of [{ id: 'bad' }, {}]) {
      const readback = deps({ stacks: () => json({ data: [wireStack('mitsumori', 'mitsumori', 'mitsumori-src'), bad] }) })
      const result = await confirmCreate(request, failure.progress, readback.value)
      expect(result).toEqual({ progress: failure.progress })
      expect(result.progress.candidate).toBeUndefined()
      expect(result.progress.unconfirmed).toBe('platform')
    }
  })

  test('a source repository the readback cannot see yet is not created twice: the resend reuses the first attempt\'s key', async () => {
    const first = deps({ createSource: malformed })
    const failure = await fail(submitCreate(request, {}, first.value))
    const firstKey = first.keys.createSource?.[0]
    expect(firstKey).toBeTruthy()
    expect(failure.progress.attempts?.source?.key).toBe(firstKey!)

    // Accepted but not listed yet: the empty list is not proof that nothing was made.
    const confirmed = await confirmCreate(request, failure.progress, deps().value)
    expect(confirmed.progress.sourceRepositoryId).toBeUndefined()
    expect(confirmed.progress.attempts?.source?.key).toBe(firstKey!)

    const retry = deps()
    await submitCreate(request, confirmed.progress, retry.value)
    expect(retry.keys.createSource).toEqual([firstKey!])
  })

  test('a stack the readback cannot see yet is not created twice: the resend reuses the first attempt\'s key', async () => {
    const first = deps({ createStack: malformed })
    const failure = await fail(submitCreate(request, {}, first.value))
    const firstKey = first.keys.createStack?.[0]
    const confirmed = await confirmCreate(request, failure.progress, deps().value)
    expect(confirmed.progress.stackId).toBeUndefined()
    const retry = deps()
    await submitCreate(request, confirmed.progress, retry.value)
    expect(retry.keys.createStack).toEqual([firstKey!])
    // The unsettled create is resent first, exactly as it was sent; no validation precedes it.
    expect(retry.calls).toEqual(['createStack', 'bindApp:mitsumori:mitsumori'])
  })

  test('a call nothing answered keeps its key; an answer that refused the write ends the attempt', async () => {
    const lost = deps({ createStack: () => new Response('upstream connect error', { status: 503, headers: { 'Content-Type': 'text/plain' } }) })
    const transient = await fail(submitCreate(request, {}, lost.value))
    expect(transient.progress.attempts?.stack?.key).toBe(lost.keys.createStack?.at(-1)!)
    const refused = await fail(submitCreate(request, {}, deps({ createStack: () => platformError(409, 'conflict', 'taken') }).value))
    expect(refused.progress.attempts).toBeUndefined()
  })

  test('another owner\'s repository of the same name is never offered', async () => {
    const failure = await fail(submitCreate(request, {}, deps({ createSource: malformed }).value))
    const otherOwner = { ...wireRepository({ destination: { repositoryName: 'mitsumori' } }, 'other-src'), image: { imagePath: 'ghcr.io/someone-else/mitsumori' } }
    const otherConnection = wireRepository({ destination: { repositoryName: 'mitsumori' }, sourceConnectionId: 'github-other' }, 'other-connection-src')
    const readback = deps({}, { repositories: [otherOwner, otherConnection] })
    const confirmed = await confirmCreate(request, failure.progress, readback.value)
    expect([confirmed.progress.sourceRepositoryId, confirmed.progress.candidate]).toEqual([undefined, undefined])
    const same = deps({}, { repositories: [wireRepository({ destination: { repositoryName: 'mitsumori' }, sourceConnectionId: 'github-source-207cb7ce' }, 'mitsumori-src')] })
    expect((await confirmCreate(request, failure.progress, same.value)).progress.candidate?.id).toBe('mitsumori-src')
  })
})

describe('the repository destination at submit', () => {
  const mockCall = async (method: string, path: string, body?: unknown) => {
    const url = new URL(path, 'http://mock.test')
    const response = await platformRoutes(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), url)
    return response!.json()
  }
  /** The destination the mock Platform resolves now, read through the production contract. */
  const mockDestination = async (state: string) => {
    await mockCall('POST', '/api/v1/__mock/repository-destination', { state })
    const decoded = decodeResponse(getRepositoryDestinationContract, await mockCall('GET', `/api/v1/projects/${MOCK_PROJECT_ID}/repository-destination`))
    if (!decoded.ok || decoded.value.kind !== 'resolved') throw new Error('the mock destination did not read as resolved')
    return decoded.value
  }
  const viaMock: Answer = (_body, request) => platformRoutes(request, new URL(request.url)).then((response) => response!)

  test.each([
    ['ghcr', 'ghcr.io/acme'],
    ['builtin', 'registry.appthrust.test/commerce'],
  ] as const)('a resolved %s destination makes a valid create through Platform’s checks (mock)', async (state, namespace) => {
    const shown = await mockDestination(state)
    expect(shown.registryNamespace).toBe(namespace)
    const { value, bodies } = deps({ validateSource: viaMock, createSource: viaMock })
    value.destination = shown
    const urlName = `dest-${state}`
    const app = await submitCreate({ ...request, projectId: MOCK_PROJECT_ID, urlName }, {}, value)
    expect(app.stackId).toBe('mitsumori')
    expect(bodies.createSource?.[0]).toMatchObject({ destinationRevision: shown.revision, destination: { repositoryName: urlName } })
    const made = (await mockCall('GET', `/api/v1/projects/${MOCK_PROJECT_ID}/application-source-repositories/${urlName}-src`)) as { image: { imagePath: string }; sourceConnectionId: string }
    expect(made.image.imagePath).toBe(`${namespace}/${urlName}`)
    expect(made.sourceConnectionId).toBe('github-source-207cb7ce')
    await mockCall('POST', '/api/v1/__mock/reset')
  })

  test('a destination that moved after it was shown: 409 DestinationChanged, nothing created or resent, never a taken name', async () => {
    const changed = () => platformError(409, 'conflict', `The repository destination changed. ${SECRET}`, { reason: 'DestinationChanged' })
    const { value, calls } = deps({ validateSource: changed })
    const failure = await fail(submitCreate(request, {}, value))
    expect(failure.destination).toBe('changed')
    expect(failure.nameTaken).toBe(false)
    expect(failure.forbidden).toBe(false)
    expect(failure.data).toBeUndefined()
    expect(calls).toEqual(['createApp', 'sources', 'validateSource'])
    expect(failure.progress).toEqual({ draft })
  })

  test('the moved destination answered at the create itself ends the attempt without a resend', async () => {
    const { value, calls } = deps({ createSource: () => platformError(409, 'conflict', 'changed', { reason: 'DestinationChanged' }) })
    const failure = await fail(submitCreate(request, {}, value))
    expect(failure.destination).toBe('changed')
    expect(calls).toEqual(['createApp', 'sources', 'validateSource', 'createSource'])
    // The refused write did not happen: its key is not kept for a replay.
    expect(failure.progress.attempts).toBeUndefined()
  })

  test('DestinationMismatch is a typed failure, not a retry and not a taken name', async () => {
    const { value } = deps({ validateSource: () => platformError(409, 'conflict', SECRET, { reason: 'DestinationMismatch' }) })
    const failure = await fail(submitCreate(request, {}, value))
    expect([failure.destination, failure.nameTaken, failure.retryable, failure.data]).toEqual(['mismatch', false, false, undefined])
  })

  test.each([
    [412, 'failed_precondition', 'NotConfigured'],
    [412, 'failed_precondition', 'Ambiguous'],
    [412, 'failed_precondition', 'NotReady'],
    [403, 'forbidden', 'NotVisible'],
  ] as const)('a destination blocked at submit (%s %s %s) is no permission and keeps the draft', async (status, code, reason) => {
    const { value, calls } = deps({ validateSource: () => platformError(status, code, SECRET, { reason }) })
    const failure = await fail(submitCreate(request, {}, value))
    expect([failure.destination, failure.forbidden, failure.data]).toEqual(['blocked', false, undefined])
    expect(calls).not.toContain('removeApp')
    expect(failure.progress.draft).toEqual(draft)
  })

  test('without a resolved destination the ひな形 path sends nothing to Platform', async () => {
    const { value, calls } = deps()
    value.destination = undefined
    const failure = await fail(submitCreate(request, {}, value))
    expect(failure.message).toBe(text.destinationUnavailable)
    expect(calls).toEqual(['createApp'])
  })
})

describe('a create whose outcome is unknown is settled before anything else (review finding 1)', () => {
  /** An administrator moved the Project default to the built-in registry after the user confirmed GHCR (A → B). */
  const movedDestination = resolvedDestinationOf({ revision: 'rd-builtin-2', registryNamespace: 'registry.appthrust.test/commerce' })
  const lost = () => new Response('upstream connect error', { status: 502, headers: { 'Content-Type': 'text/plain' } })
  const changed = () => platformError(409, 'conflict', 'The repository destination changed.', { reason: 'DestinationChanged' })

  /** POST with key K for A gets no answer: the attempt keeps K, the exact request and where it goes. */
  async function lostCreate() {
    const first = deps({ createSource: lost })
    const failure = await fail(submitCreate(request, {}, first.value))
    expect(first.calls).toEqual(['createApp', 'sources', 'validateSource', 'createSource'])
    const key = first.keys.createSource![0]!
    const sent = first.bodies.createSource![0]!
    expect(failure.progress.attempts?.source).toEqual({ key, origin: templateOrigin, request: sent as never, binding: templateBinding, sentAt: expect.any(String) })
    return { progress: failure.progress, key, sent }
  }

  test('the resend of K is refused: K is held unsettled and nothing more is sent, not even for B (a refusal is no proof K failed)', async () => {
    const { progress, key, sent } = await lostCreate()
    // The wizard shows the earlier attempt's destination, not B, while K is unknown.
    expect(keptSource(progress, templateOrigin)).toEqual({ state: 'pending', binding: templateBinding })

    // Retry while B is the default: K's own request (A's revision) is resent first, with no validation; Platform refuses it.
    const retry = deps({ validateSource: changed, createSource: changed })
    retry.value.destination = movedDestination
    const refused = await fail(submitCreate(request, progress, retry.value))
    expect(retry.calls).toEqual(['createSource'])
    expect(retry.keys.createSource).toEqual([key])
    expect(retry.bodies.createSource).toEqual([sent])
    expect(sent).toMatchObject({ destinationRevision: 'rd-ghcr-1' })
    // Not read as "the destination moved, confirm B": K could still be (or have been) applied at A.
    expect(refused.destination).toBeUndefined()
    expect(refused.message).toBe(text.unsettled.title)
    expect(refused.progress).toMatchObject({ unsettled: 'source', attempts: { source: { key, request: sent, binding: templateBinding } } })
    expect(refused.progress.unsettledSearched).toBeUndefined()

    // Every further 作る sends nothing at all, and giving K up is refused before a readback has looked for it.
    const again = deps()
    again.value.destination = movedDestination
    await fail(submitCreate(request, refused.progress, again.value))
    expect(again.calls).toEqual([])
    expect(abandonUnsettled(refused.progress)).toBe(refused.progress)
  })

  test('held K, the readback finds a same-named repository where it was sent (A): offered, not adopted; once chosen, the app goes on at A', async () => {
    const { progress, key } = await lostCreate()
    const refused = await fail(submitCreate(request, progress, deps({ createSource: changed }).value))
    const atA = wireRepository({ destination: { repositoryName: 'mitsumori' }, sourceConnectionId: 'github-source-207cb7ce' }, 'mitsumori-src')
    const readback = deps({}, { repositories: [atA] })
    const confirmed = await confirmCreate(request, refused.progress, { api: readback.api, catalog: readback.value.catalog })
    expect(readback.calls).toEqual(['app', 'sources'])
    expect(confirmed.progress).toMatchObject({ candidate: { step: 'source', id: 'mitsumori-src' }, attempts: { source: { key } } })

    const next = deps()
    next.value.destination = movedDestination
    await submitCreate(request, acceptCandidate(confirmed.progress), next.value)
    expect(next.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(next.bodies.createStack![0]).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: 'mitsumori-src' } })
  })

  test('held K, the readback does not find it at A: still nothing is sent; only the user\'s explicit give-up drops K, and the next 作る is a new attempt at B', async () => {
    const { progress, key } = await lostCreate()
    const refused = await fail(submitCreate(request, progress, deps({ createSource: changed }).value))
    // A same-named repository at B is not K's.
    const atB = { ...wireRepository({ destination: { repositoryName: 'mitsumori' } }, 'other-src'), image: { imagePath: 'registry.appthrust.test/commerce/mitsumori' } }
    const readback = deps({}, { repositories: [atB] })
    const searched = await confirmCreate(request, refused.progress, { api: readback.api, catalog: readback.value.catalog })
    expect(searched.progress).toMatchObject({ unsettled: 'source', unsettledSearched: true, attempts: { source: { key } } })
    expect(searched.progress.sourceRepositoryId).toBeUndefined()

    const held = deps()
    held.value.destination = movedDestination
    await fail(submitCreate(request, searched.progress, held.value))
    expect(held.calls).toEqual([])

    const givenUp = abandonUnsettled(searched.progress)
    expect([givenUp.unsettled, givenUp.unsettledSearched, givenUp.attempts]).toEqual([undefined, undefined, undefined])
    const fresh = deps()
    fresh.value.destination = movedDestination
    await submitCreate(request, givenUp, fresh.value)
    expect(fresh.calls).toEqual(['sources', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(fresh.keys.createSource![0]).not.toBe(key)
    expect(fresh.bodies.createSource![0]).toMatchObject({ destinationRevision: 'rd-builtin-2' })
  })

  test('a refused first send still ends its own attempt: no earlier send exists under its fresh key', async () => {
    const { value, calls } = deps({ createSource: changed })
    const failure = await fail(submitCreate(request, {}, value))
    expect(calls).toEqual(['createApp', 'sources', 'validateSource', 'createSource'])
    expect([failure.destination, failure.progress.attempts, failure.progress.unsettled]).toEqual(['changed', undefined, undefined])
  })

  test('K was accepted at A: the resend replays A\'s repository, which the app goes on with; nothing is created at B', async () => {
    const { progress, key, sent } = await lostCreate()
    // Platform replays the accepted write for K (handler/application_source_repository.go:1101-1114) even though the default moved.
    const replay = deps({ validateSource: changed, createSource: () => mutation('ApplicationSourceRepository', wireRepository({ destination: { repositoryName: 'mitsumori' } }, 'mitsumori-src')) })
    replay.value.destination = movedDestination
    const app = await submitCreate(request, progress, replay.value)
    expect(replay.calls).toEqual(['createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(replay.keys.createSource).toEqual([key])
    expect(replay.bodies.createSource).toEqual([sent])
    expect(replay.bodies.createStack![0]).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: 'mitsumori-src' } })
    expect(app.stackId).toBe('mitsumori')
  })

  test('another unknown answer to the resend (a 5xx, no answer) keeps K and its request; nothing else is sent', async () => {
    const { progress, key } = await lostCreate()
    for (const answer of [lost, () => platformError(500, 'internal', 'idempotency store unavailable'), () => platformError(503, 'unavailable', 'repository destination could not be read')]) {
      const retry = deps({ createSource: answer })
      retry.value.destination = movedDestination
      const failure = await fail(submitCreate(request, progress, retry.value))
      expect(retry.calls).toEqual(['createSource'])
      expect(retry.keys.createSource).toEqual([key])
      expect(failure.progress.attempts?.source?.key).toBe(key)
    }
  })

  test('a changed URL name does not drop K: K\'s own request is resent first, and its refusal holds everything', async () => {
    const { progress, key } = await lostCreate()
    const renamed: CreateRequest = { ...request, urlName: 'mitsumori-2' }
    const retry = deps({ createSource: changed })
    retry.value.destination = movedDestination
    const refused = await fail(submitCreate(renamed, progress, retry.value))
    // Nothing for the new name: K's own request (A's revision, the old name) is resent first.
    expect(retry.calls).toEqual(['createSource'])
    expect(retry.keys.createSource).toEqual([key])
    expect(retry.bodies.createSource?.[0]).toMatchObject({ destination: { repositoryName: 'mitsumori' }, destinationRevision: 'rd-ghcr-1' })
    expect(refused.progress.unsettled).toBe('source')
    const next = deps()
    await fail(submitCreate(renamed, refused.progress, next.value))
    expect(next.calls).toEqual([])
  })

  test('progress saved before requests were kept: K is not rebuilt against today\'s destination; it is held unsent, and given up only after a readback', async () => {
    const legacy: CreateProgress = { draft, attempts: { source: { key: 'legacy-key', origin: templateOrigin } } }
    const first = deps()
    const held = await fail(submitCreate(request, legacy, first.value))
    expect(first.calls).toEqual([])
    expect(held.progress).toMatchObject({ unsettled: 'source', attempts: { source: { key: 'legacy-key' } } })
    // Without where it was sent, the readback cannot adopt anything; it records that it looked.
    const readback = deps({}, { repositories: [wireRepository({ destination: { repositoryName: 'mitsumori' } }, 'mitsumori-src')] })
    const searched = await confirmCreate(request, held.progress, { api: readback.api, catalog: readback.value.catalog })
    expect(searched.progress).toMatchObject({ unsettled: 'source', unsettledSearched: true })
    expect(searched.progress.sourceRepositoryId).toBeUndefined()
    expect(abandonUnsettled(searched.progress).attempts).toBeUndefined()
  })

  test('a refused resend of an unknown stack create is held the same way: nothing more is sent', async () => {
    const first = deps({ createStack: lost })
    const lostStack = await fail(submitCreate(request, {}, first.value))
    const key = first.keys.createStack![0]!
    const retry = deps({ createStack: () => platformError(409, 'conflict', 'publish endpoint is already owned by another publish', { reason: 'publish_url_conflict' }) })
    const refused = await fail(submitCreate(request, lostStack.progress, retry.value))
    expect(retry.calls).toEqual(['createStack'])
    expect(retry.keys.createStack).toEqual([key])
    expect(refused.progress).toMatchObject({ unsettled: 'stack', attempts: { stack: { key } } })
    expect(refused.nameTaken).toBe(false)
    const again = deps()
    await fail(submitCreate(request, refused.progress, again.value))
    expect(again.calls).toEqual([])
  })

  test('the readback after an unreadable 2xx looks for the repository where the attempt sent it, not at the default now', async () => {
    const failure = await fail(submitCreate(request, {}, deps({ createSource: () => json({ resource: { id: 42 } }, 202) }).value))
    expect(failure.progress.unconfirmed).toBe('source')
    const atA = wireRepository({ destination: { repositoryName: 'mitsumori' }, sourceConnectionId: 'github-source-207cb7ce' }, 'mitsumori-src')
    const atB = { ...wireRepository({ destination: { repositoryName: 'mitsumori' } }, 'other-src'), image: { imagePath: 'registry.appthrust.test/commerce/mitsumori' } }
    const readback = deps({}, { repositories: [atB, atA] })
    // confirmCreate no longer reads the current destination at all: only the attempt's own binding decides.
    const confirmed = await confirmCreate(request, failure.progress, { api: readback.api, catalog: readback.value.catalog })
    expect(confirmed.progress.candidate).toMatchObject({ step: 'source', id: 'mitsumori-src', binding: templateBinding })
    // Only the repository at B (where the attempt was not sent) is listed: nothing is offered, K stays to be resent.
    const onlyB = deps({}, { repositories: [atB] })
    const none = await confirmCreate(request, failure.progress, { api: onlyB.api, catalog: onlyB.value.catalog })
    expect([none.progress.sourceRepositoryId, none.progress.candidate]).toEqual([undefined, undefined])
    expect(none.progress.attempts?.source?.key).toBe(failure.progress.attempts!.source!.key)
  })
})

describe('a readback hit is a candidate, never adopted or deleted silently (re-review P1)', () => {
  const lost = () => new Response('upstream connect error', { status: 502, headers: { 'Content-Type': 'text/plain' } })
  const changed = () => platformError(409, 'conflict', 'The repository destination changed.', { reason: 'DestinationChanged' })

  /** K for A got no answer and its resend was refused: K is held, its first send's time kept. */
  async function heldK() {
    const first = deps({ createSource: lost })
    const lostK = await fail(submitCreate(request, {}, first.value))
    const refused = await fail(submitCreate(request, lostK.progress, deps({ createSource: changed }).value))
    expect(refused.progress.unsettled).toBe('source')
    const attempt = refused.progress.attempts!.source!
    expect(Date.parse(attempt.sentAt!)).toBeGreaterThan(Date.now() - 60_000)
    return { progress: refused.progress, key: attempt.key, sentAt: attempt.sentAt! }
  }
  /** Another attempt's repository with the same name at A (made by someone else, or an earlier abandoned attempt). */
  const anotherAtA = (createdAt?: string) => wireRepository({ destination: { repositoryName: 'mitsumori' }, sourceConnectionId: 'github-source-207cb7ce' }, 'source-0f1e2d3c4b5a', createdAt)

  test('another attempt\'s same-named repository at A is offered as a candidate: K is not settled and nothing is sent', async () => {
    const { progress, key, sentAt } = await heldK()
    const readback = deps({}, { repositories: [anotherAtA()] })
    const { progress: offered } = await confirmCreate(request, progress, { api: readback.api, catalog: readback.value.catalog })
    expect(readback.calls).toEqual(['app', 'sources'])
    expect(offered.candidate).toEqual({ step: 'source', id: 'source-0f1e2d3c4b5a', binding: templateBinding, sentAt })
    expect(offered.attempts?.source?.key).toBe(key)
    expect([offered.sourceRepositoryId, offered.sourceRepositoryProvenance]).toEqual([undefined, undefined])
    // While it is shown: no create, no resend, no other readback.
    const blocked = deps()
    expect((await fail(submitCreate(request, offered, blocked.value))).message).toBe(text.candidate.title)
    expect(blocked.calls).toEqual([])
    const again = deps({}, { repositories: [anotherAtA()] })
    expect((await confirmCreate(request, offered, { api: again.api, catalog: again.value.catalog })).progress).toBe(offered)
    expect(again.calls).toEqual([])
  })

  test('the user says it is theirs: the app goes on with that id, kept as found', async () => {
    const { progress } = await heldK()
    const readback = deps({}, { repositories: [anotherAtA(new Date().toISOString())] })
    const chosen = acceptCandidate((await confirmCreate(request, progress, { api: readback.api, catalog: readback.value.catalog })).progress)
    expect(chosen).toMatchObject({ sourceRepositoryId: 'source-0f1e2d3c4b5a', sourceRepositoryProvenance: 'found', sourceRepositoryOrigin: templateOrigin, sourceRepositoryBinding: templateBinding })
    expect([chosen.candidate, chosen.attempts, chosen.unsettled]).toEqual([undefined, undefined, undefined])
    const next = deps()
    await submitCreate(request, chosen, next.value)
    expect(next.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(next.bodies.createStack![0]).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: 'source-0f1e2d3c4b5a' } })
  })

  test('the user says it is not theirs: K stays held, nothing is sent, a readback does not offer it again, and only the explicit give-up moves on', async () => {
    const { progress, key } = await heldK()
    const readback = deps({}, { repositories: [anotherAtA()] })
    const rejected = rejectCandidate((await confirmCreate(request, progress, { api: readback.api, catalog: readback.value.catalog })).progress)
    expect(rejected).toMatchObject({ unsettled: 'source', unsettledSearched: true, notMine: [{ key, candidate: { step: 'source', id: 'source-0f1e2d3c4b5a' } }], attempts: { source: { key } } })
    expect(rejected.candidate).toBeUndefined()
    const held = deps()
    await fail(submitCreate(request, rejected, held.value))
    expect(held.calls).toEqual([])
    // Checking again does not offer it again: K is still not found where it was sent.
    const recheck = deps({}, { repositories: [anotherAtA()] })
    const searched = (await confirmCreate(request, rejected, { api: recheck.api, catalog: recheck.value.catalog })).progress
    expect(searched).toMatchObject({ unsettled: 'source', unsettledSearched: true })
    expect(searched.candidate).toBeUndefined()
    // Giving up is the user's explicit choice; the next attempt then finds the name taken at A and sends no create.
    const givenUp = abandonUnsettled(searched)
    expect(givenUp.attempts).toBeUndefined()
    const fresh = deps({}, { repositories: [anotherAtA()] })
    const taken = await fail(submitCreate(request, givenUp, fresh.value))
    expect(taken.nameTaken).toBe(true)
    expect(fresh.calls).toEqual(['sources'])
  })

  test('a repository created long before K\'s first send (by this browser\'s clock) is still a candidate with both choices and a hint, and can be chosen', async () => {
    const { progress, sentAt } = await heldK()
    const anHourBefore = new Date(Date.parse(sentAt) - 3_600_000).toISOString()
    const readback = deps({}, { repositories: [anotherAtA(anHourBefore)] })
    const { progress: offered } = await confirmCreate(request, progress, { api: readback.api, catalog: readback.value.catalog })
    expect(offered.candidate).toEqual({ step: 'source', id: 'source-0f1e2d3c4b5a', binding: templateBinding, createdAt: anHourBefore, sentAt })
    expect(createdBeforeSent(offered.candidate!)).toBe(true)
    expect(rejectCandidate(offered)).toMatchObject({ unsettled: 'source', unsettledSearched: true })
    expect(acceptCandidate(offered)).toMatchObject({ sourceRepositoryId: 'source-0f1e2d3c4b5a', sourceRepositoryProvenance: 'found' })
    // The hint is display only, past its 1-minute threshold; no hint for times within it or unknown.
    const near = { step: 'source' as const, id: 'source-0f1e2d3c4b5a', binding: templateBinding, sentAt }
    expect([createdBeforeSent({ ...near, createdAt: new Date(Date.parse(sentAt) - CREATED_BEFORE_HINT_MS + 1_000).toISOString() }), createdBeforeSent(near)]).toEqual([false, false])
  })

  test('the browser clock is 10 minutes ahead of the cluster and K really made the repository: it is chosen and creation goes on with its id', async () => {
    const { progress, sentAt } = await heldK()
    // K's own repository, stamped by a cluster clock 10 minutes behind this browser's.
    const stamped = new Date(Date.parse(sentAt) - 10 * 60_000).toISOString()
    const readback = deps({}, { repositories: [wireRepository({ destination: { repositoryName: 'mitsumori' }, sourceConnectionId: 'github-source-207cb7ce' }, 'mitsumori-src', stamped)] })
    const { progress: offered } = await confirmCreate(request, progress, { api: readback.api, catalog: readback.value.catalog })
    expect(offered.candidate).toMatchObject({ step: 'source', id: 'mitsumori-src', createdAt: stamped, sentAt })
    expect(createdBeforeSent(offered.candidate!)).toBe(true)
    const chosen = acceptCandidate(offered)
    expect(chosen).toMatchObject({ draft, ...foundSource })
    expect([chosen.candidate, chosen.attempts, chosen.unsettled]).toEqual([undefined, undefined, undefined])
    const next = deps()
    await submitCreate(request, chosen, next.value)
    expect(next.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(next.bodies.createStack![0]).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: 'mitsumori-src' } })
  })

  test('after "not mine" the held attempt can look at the hit again; choosing it then goes on with its id', async () => {
    const { progress, key, sentAt } = await heldK()
    const readback = deps({}, { repositories: [anotherAtA()] })
    const offered = (await confirmCreate(request, progress, { api: readback.api, catalog: readback.value.catalog })).progress
    const rejected = rejectCandidate(offered)
    expect(rejectedCandidate(rejected)).toEqual(offered.candidate)
    const again = reconsiderCandidate(rejected)
    expect(again).toMatchObject({ candidate: { step: 'source', id: 'source-0f1e2d3c4b5a', binding: templateBinding, sentAt }, attempts: { source: { key } } })
    expect([again.unsettled, again.unsettledSearched, again.notMine]).toEqual([undefined, undefined, undefined])
    // Nothing is sent while it is offered again.
    const blocked = deps()
    expect((await fail(submitCreate(request, again, blocked.value))).message).toBe(text.candidate.title)
    expect(blocked.calls).toEqual([])
    const next = deps()
    await submitCreate(request, acceptCandidate(again), next.value)
    expect(next.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(next.bodies.createStack![0]).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: 'source-0f1e2d3c4b5a' } })
  })

  test('two hits were both rejected: looking again walks through both, so the first one can still be chosen', async () => {
    const { progress } = await heldK()
    const readback = deps({}, { repositories: [anotherAtA()] })
    const offeredA = (await confirmCreate(request, progress, { api: readback.api, catalog: readback.value.catalog })).progress
    const a = offeredA.candidate!
    const b = { ...a, id: 'source-second-hit' }
    // A is rejected, a later readback offers B, and B is rejected too.
    const bothRejected = rejectCandidate({ ...rejectCandidate(offeredA), candidate: b, unsettled: undefined, unsettledSearched: undefined })
    expect(bothRejected.notMine?.map((rejected) => rejected.candidate.id)).toEqual([a.id, b.id])
    const first = reconsiderCandidate(bothRejected)
    expect(first.candidate?.id).toBe(a.id)
    // Rejecting A again puts it behind B: the next look offers B, then A again.
    const second = reconsiderCandidate(rejectCandidate(first))
    expect(second.candidate?.id).toBe(b.id)
    const third = reconsiderCandidate(rejectCandidate(second))
    expect(third.candidate?.id).toBe(a.id)
    const next = deps()
    await submitCreate(request, acceptCandidate(third), next.value)
    expect(next.bodies.createStack![0]).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: a.id } })
  })

  test('"not mine" belongs to its attempt: giving up drops it, and a rejection for an earlier key does not hide a later attempt\'s hit', async () => {
    const { progress, key } = await heldK()
    const readback = deps({}, { repositories: [anotherAtA()] })
    const rejected = rejectCandidate((await confirmCreate(request, progress, { api: readback.api, catalog: readback.value.catalog })).progress)
    const givenUp = abandonUnsettled(rejected)
    expect([givenUp.attempts, givenUp.notMine, rejectedCandidate(givenUp)]).toEqual([undefined, undefined, undefined])
    // A later attempt (K2) whose create got no answer; a rejection kept for K must not mask what its readback finds.
    const lostK2 = await fail(submitCreate(request, givenUp, deps({ createSource: lost }).value))
    const k2 = lostK2.progress.attempts!.source!.key
    expect(k2).not.toBe(key)
    const stale = { ...lostK2.progress, unconfirmed: 'source' as const, notMine: rejected.notMine }
    const later = deps({}, { repositories: [anotherAtA()] })
    expect((await confirmCreate(request, stale, { api: later.api, catalog: later.value.catalog })).progress.candidate).toMatchObject({ step: 'source', id: 'source-0f1e2d3c4b5a' })
  })

  test('a found repository is never sent to DELETE on a rename or template change; a created one still is', async () => {
    const { progress } = await heldK()
    const readback = deps({}, { repositories: [anotherAtA()] })
    const chosen = acceptCandidate((await confirmCreate(request, progress, { api: readback.api, catalog: readback.value.catalog })).progress)
    const businessTemplate = templateOf({ ...wireTemplate, id: 'biz-master-postgres', category: 'business', githubTemplate: { repository: 'appthrust/template-biz-master', repositoryUrl: 'https://github.com/appthrust/template-biz-master', branch: 'main' } })
    const renamed = deps()
    await submitCreate({ ...request, urlName: 'mitsumori-2' }, chosen, renamed.value)
    const switched = deps()
    switched.value.catalog = { ...switched.value.catalog, template: businessTemplate }
    await submitCreate(request, chosen, switched.value)
    for (const run of [renamed, switched]) {
      expect(run.calls.some((call) => call.startsWith('deleteSource'))).toBe(false)
      expect(run.calls).toContain('createSource')
    }

    const made = await fail(submitCreate(request, {}, deps({ createStack: () => platformError(409, 'conflict', 'name taken') }).value))
    expect(made.progress.sourceRepositoryProvenance).toBe('created')
    const replaced = deps()
    await submitCreate({ ...request, urlName: 'mitsumori-2' }, made.progress, replaced.value)
    expect(replaced.calls).toContain('deleteSource:mitsumori-src')
  })

  test('a stack found by a readback is a candidate too; not theirs keeps the stack attempt held', async () => {
    const first = deps({ createStack: lost })
    const lostStack = await fail(submitCreate(request, {}, first.value))
    const refused = await fail(submitCreate(request, lostStack.progress, deps({ createStack: () => platformError(409, 'conflict', 'publish endpoint is already owned by another publish', { reason: 'publish_url_conflict' }) }).value))
    const readback = deps({}, { stacks: [wireStack('stack-other', 'mitsumori', 'mitsumori-src')] })
    const { progress: offered } = await confirmCreate(request, refused.progress, { api: readback.api, catalog: readback.value.catalog })
    expect(offered.candidate).toEqual({ step: 'stack', id: 'stack-other', appName: 'mitsumori' })
    const rejected = rejectCandidate(offered)
    expect(rejected).toMatchObject({ unsettled: 'stack', unsettledSearched: true, notMine: [{ key: refused.progress.attempts!.stack!.key, candidate: { step: 'stack', id: 'stack-other' } }] })
    const held = deps()
    await fail(submitCreate(request, rejected, held.value))
    expect(held.calls).toEqual([])
  })
})

describe('a resumed creation uses, and shows, the repository it already made (review finding 3)', () => {
  const movedDestination = resolvedDestinationOf({ revision: 'rd-builtin-2', registryNamespace: 'registry.appthrust.test/commerce' })

  test('source made at A, stack failed, default moved to B: the retry reuses A, and A is what is shown as already created', async () => {
    const first = deps({ validateStack: () => json({ valid: false, message: 'runtime not ready', source: ok, runtime: { valid: false, message: 'runtime not ready' } }) })
    const failure = await fail(submitCreate(request, {}, first.value))
    expect(failure.progress).toEqual({ draft, ...madeSource })
    // The confirm step shows the repository already made at A, whatever the destination resolves to now.
    expect(keptSource(failure.progress, templateOrigin)).toEqual({ state: 'created', id: 'mitsumori-src', binding: templateBinding, provenance: 'created' })

    const retry = deps()
    retry.value.destination = movedDestination
    await submitCreate(request, failure.progress, retry.value)
    expect(retry.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(retry.bodies.createStack![0]).toMatchObject({ source: { kind: 'application-source-repository', sourceRepositoryId: 'mitsumori-src' } })
  })

  test('another name or template is not this repository: it is not shown as kept', async () => {
    expect(keptSource({ draft, ...madeSource }, { ...templateOrigin, appName: 'other' })).toBeUndefined()
    expect(keptSource({ draft, ...madeSource }, { ...templateOrigin, templateId: 'other-template' })).toBeUndefined()
    // Progress saved before the binding was kept names only the repository id: the page reads it back.
    expect(keptSource({ draft, sourceRepositoryId: 'mitsumori-src', sourceRepositoryOrigin: templateOrigin }, templateOrigin)).toEqual({ state: 'created', id: 'mitsumori-src' })
  })
})
