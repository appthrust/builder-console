// The create sequence over the real create calls, gateway and contracts; only
// the network is in memory. Every answer is a wire literal as Platform / the
// Console send it, so each step's success is read by its production reader.
import { describe, expect, test } from 'bun:test'
import { createCreateApi, type CreateApi } from '../../api/create'
import { decodeResponse } from '../../api/boundary'
import { getRepositoryDestinationContract } from '../../api/contracts/platform/catalog'
import { appOf, definitionOf, resolvedDestinationOf, sourceConnectionOf, templateOf } from '../../api/testing/catalog-domain'
import { createTestGateway } from '../../api/testing/gateway'
import { copy } from '../../copy'
import { MOCK_PROJECT_ID, platformRoutes } from '../../dev/mock-platform'
import { resolveCreateCatalog } from '../../model/create'
import { text } from './copy'
import {
  confirmCreate,
  CreateFailed,
  keptSource,
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
  createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z',
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
const madeSource = { sourceRepositoryId: 'mitsumori-src', sourceRepositoryOrigin: templateOrigin, sourceRepositoryBinding: templateBinding }

const json = (body: unknown, status = 200) => Response.json(body, { status })
const operation = (kind: string, id: string) => ({ id: `op-${id}`, type: `${kind}.create`, state: 'accepted', writeChannel: 'A', resource: { kind, id, projectId: 'pj' }, createdAt: '2026-10-06T00:00:00Z', links: { self: `/api/v1/operations/op-${id}` } })
/** A Platform mutation answer: the read model, the receipt and the written `resource`. */
const mutation = (kind: string, resource: { id: string }, status = 202) => json({ ...resource, operation: operation(kind, resource.id), resource }, status)
const platformError = (status: number, code: string, message: string, details?: Record<string, unknown>) => json({ error: { code, message, ...(details ? { details } : {}) } }, status)
const wireRepository = (body: { destination?: { repositoryName: string }; existing?: { repository: string }; sourceConnectionId?: string }, id: string) => ({
  id, projectId: 'pj', ...(body.sourceConnectionId ? { sourceConnectionId: body.sourceConnectionId } : {}),
  ...(body.destination ? { destination: { repositoryName: body.destination.repositoryName, visibility: 'private' } } : {}),
  ...(body.existing ? { existing: { repository: body.existing.repository } } : {}),
  image: { imagePath: `ghcr.io/acme/${body.destination?.repositoryName ?? body.existing?.repository.split('/')[1]?.toLowerCase() ?? 'x'}`, tagFilter: 'edge-', versioningScheme: 'Alphabetical' }, status: 'pending', conditions: [],
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
    expect(calls).toEqual(['createApp', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
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
    await submitCreate(request, { draft, sourceRepositoryId: 'old-src', sourceRepositoryOrigin: { appName: 'mitsumori', kind: 'template', templateId: 'biz-inventory-postgres' } }, value)
    expect(calls).toContain('deleteSource:old-src')
    expect(calls).toContain('createSource')
    expect(bodies.createSource?.[0]).toMatchObject({ template: { repository: 'appthrust/template-biz-master' } })
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
    expect(calls).toEqual(['createApp', 'validateSource', 'removeApp'])
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
    expect(retry.calls).toEqual(['updateApp', 'deleteSource:test-src', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:test2'])
    expect(retry.bodies.createSource?.[0]).toMatchObject({ destination: { repositoryName: 'test2' }, destinationRevision: 'rd-ghcr-1' })
    expect(retry.bodies.createSource?.[0]).not.toHaveProperty('image')
    expect(retry.bodies.createStack?.[0]?.source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: 'test2-src' })
  })

  test('a failed delete of the orphaned repository does not block the renamed attempt', async () => {
    const { value, calls } = deps({ deleteSource: () => platformError(409, 'conflict', 'referenced', { reason: 'referenced_by_stack' }) })
    const app = await submitCreate({ ...request, urlName: 'test2' }, { draft, sourceRepositoryId: 'test-src', sourceRepositoryOrigin: { appName: 'test', kind: 'template' } }, value)
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
    expect(retry.calls).toEqual(['deleteSource:mitsumori-src', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(retry.bodies.createSource?.[0]).toMatchObject({ destination: { repositoryName: 'mitsumori' } })
    expect(retry.bodies.createSource?.[0]?.existing).toBeUndefined()
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
    expect(retry.calls).toEqual(['validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
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

  test('source repository: the readback adopts the repository the create made, so the retry does not create it again', async () => {
    const first = deps({ createSource: malformed })
    const failure = await fail(submitCreate(request, {}, first.value))
    expectSafe(failure)
    expect(failure.progress).toMatchObject({ draft, unconfirmed: 'source', attempts: { source: { key: first.keys.createSource?.[0] } } })
    expect(failure.progress.sourceRepositoryId).toBeUndefined()
    expect(first.calls).toEqual(['createApp', 'validateSource', 'createSource'])

    const readback = deps({}, { repositories: [wireRepository({ destination: { repositoryName: 'other' } }, 'other-src'), wireRepository({ destination: { repositoryName: 'mitsumori' } }, 'mitsumori-src')] })
    const confirmed = await confirmCreate(request, failure.progress, readback.value)
    expect(readback.calls).toEqual(['app', 'sources'])
    expect(confirmed.progress).toEqual({ draft, ...madeSource })

    const retry = deps()
    await submitCreate(request, confirmed.progress, retry.value)
    expect(retry.calls).toEqual(['validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
  })

  test('作ったコードから: the adopted repository is found by the picked repository', async () => {
    const existing: CreateRequest = { ...request, path: { kind: 'existing', repository: { fullName: 'Acme/Picked-App', defaultBranch: 'main' } } }
    const failure = await fail(submitCreate(existing, {}, deps({ createSource: malformed }).value))
    const readback = deps({}, { repositories: [wireRepository({ existing: { repository: 'acme/picked-app' } }, 'picked-app-src')] })
    const confirmed = await confirmCreate(existing, failure.progress, readback.value)
    expect(confirmed.progress).toMatchObject({ sourceRepositoryId: 'picked-app-src', sourceRepositoryOrigin: { kind: 'existing', repository: 'Acme/Picked-App' } })
  })

  test('stack: the readback adopts only the stack made from this attempt\'s source; the retry only binds', async () => {
    const first = deps({ createStack: malformed })
    const failure = await fail(submitCreate(request, {}, first.value))
    expectSafe(failure)
    expect(failure.progress).toMatchObject({ draft, sourceRepositoryId: 'mitsumori-src', sourceRepositoryOrigin: templateOrigin, unconfirmed: 'platform', attempts: { stack: { key: first.keys.createStack?.[0] } } })

    const foreign = deps({}, { stacks: [wireStack('mitsumori-other', 'mitsumori', 'someone-else-src')] })
    expect((await confirmCreate(request, failure.progress, foreign.value)).progress.stackId).toBeUndefined()

    const readback = deps({}, { stacks: [wireStack('mitsumori', 'mitsumori', 'mitsumori-src')] })
    const confirmed = await confirmCreate(request, failure.progress, readback.value)
    expect(readback.calls).toEqual(['app', 'stacks'])
    expect(confirmed.progress).toEqual({ draft, ...madeSource, stackId: 'mitsumori', stackAppName: 'mitsumori' })

    const retry = deps()
    const app = await submitCreate(request, confirmed.progress, retry.value)
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
    const broken = deps({ stacks: () => json({ data: [{ id: SECRET }] }) })
    await expect(confirmCreate(request, failure.progress, broken.value)).rejects.toMatchObject({ code: 'response_contract_invalid', outcome: 'read_failed' })
    expect(failure.progress.unconfirmed).toBe('platform')
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

  test('another owner\'s repository of the same name is never adopted', async () => {
    const failure = await fail(submitCreate(request, {}, deps({ createSource: malformed }).value))
    const otherOwner = { ...wireRepository({ destination: { repositoryName: 'mitsumori' } }, 'other-src'), image: { imagePath: 'ghcr.io/someone-else/mitsumori' } }
    const otherConnection = wireRepository({ destination: { repositoryName: 'mitsumori' }, sourceConnectionId: 'github-other' }, 'other-connection-src')
    const readback = deps({}, { repositories: [otherOwner, otherConnection] })
    const confirmed = await confirmCreate(request, failure.progress, readback.value)
    expect(confirmed.progress.sourceRepositoryId).toBeUndefined()
    const mine = deps({}, { repositories: [wireRepository({ destination: { repositoryName: 'mitsumori' }, sourceConnectionId: 'github-source-207cb7ce' }, 'mitsumori-src')] })
    expect((await confirmCreate(request, failure.progress, mine.value)).progress.sourceRepositoryId).toBe('mitsumori-src')
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
    expect(calls).toEqual(['createApp', 'validateSource'])
    expect(failure.progress).toEqual({ draft })
  })

  test('the moved destination answered at the create itself ends the attempt without a resend', async () => {
    const { value, calls } = deps({ createSource: () => platformError(409, 'conflict', 'changed', { reason: 'DestinationChanged' }) })
    const failure = await fail(submitCreate(request, {}, value))
    expect(failure.destination).toBe('changed')
    expect(calls).toEqual(['createApp', 'validateSource', 'createSource'])
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
    expect(first.calls).toEqual(['createApp', 'validateSource', 'createSource'])
    const key = first.keys.createSource![0]!
    const sent = first.bodies.createSource![0]!
    expect(failure.progress.attempts?.source).toEqual({ key, origin: templateOrigin, request: sent as never, binding: templateBinding })
    return { progress: failure.progress, key, sent }
  }

  test('K was never accepted: the retry resends K\'s own request (no validation first), Platform refuses it, and only then is B shown and a new key used', async () => {
    const { progress, key, sent } = await lostCreate()
    // The wizard shows the earlier attempt's destination, not B, while K is unsettled.
    expect(keptSource(progress, templateOrigin)).toEqual({ state: 'pending', binding: templateBinding })

    // Retry while B is the default. Platform has no record of K, so it answers K's old request as new: DestinationChanged.
    const retry = deps({ validateSource: changed, createSource: changed })
    retry.value.destination = movedDestination
    const refused = await fail(submitCreate(request, progress, retry.value))
    expect(retry.calls).toEqual(['createSource'])
    expect(retry.keys.createSource).toEqual([key])
    expect(retry.bodies.createSource).toEqual([sent])
    expect(sent).toMatchObject({ destinationRevision: 'rd-ghcr-1' })
    // Platform's own refusal of K proves it was not applied: only now does the attempt end, and B is shown.
    expect(refused.destination).toBe('changed')
    expect(refused.progress.attempts).toBeUndefined()
    expect(keptSource(refused.progress, templateOrigin)).toBeUndefined()

    // The user confirms B: a new attempt, validated, with a new key and B's revision.
    const confirmed = deps()
    confirmed.value.destination = movedDestination
    await submitCreate(request, refused.progress, confirmed.value)
    expect(confirmed.calls).toEqual(['validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori'])
    expect(confirmed.keys.createSource).toHaveLength(1)
    expect(confirmed.keys.createSource![0]).not.toBe(key)
    expect(confirmed.bodies.createSource![0]).toMatchObject({ destinationRevision: 'rd-builtin-2' })
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

  test('a changed URL name does not drop K: K\'s own request is settled first, and only then does the renamed attempt start', async () => {
    const { progress, key } = await lostCreate()
    const renamed: CreateRequest = { ...request, urlName: 'mitsumori-2' }
    const retry = deps({ createSource: changed })
    retry.value.destination = movedDestination
    const refused = await fail(submitCreate(renamed, progress, retry.value))
    // Nothing for the new name yet: K's own request (A's revision, the old name) is resent first.
    expect(retry.calls).toEqual(['createSource'])
    expect(retry.keys.createSource).toEqual([key])
    expect(retry.bodies.createSource?.[0]).toMatchObject({ destination: { repositoryName: 'mitsumori' }, destinationRevision: 'rd-ghcr-1' })
    expect(refused.progress.attempts).toBeUndefined()

    const next = deps()
    next.value.destination = movedDestination
    await submitCreate(renamed, refused.progress, next.value)
    expect(next.calls).toEqual(['updateApp', 'validateSource', 'createSource', 'validateStack', 'createStack', 'bindApp:mitsumori:mitsumori-2'])
    expect(next.keys.createSource?.[0]).not.toBe(key)
    expect(next.bodies.createSource?.[0]).toMatchObject({ destination: { repositoryName: 'mitsumori-2' }, destinationRevision: 'rd-builtin-2' })
  })

  test('progress saved before requests were kept: the same origin is resent under K; an earlier accepted body answers idempotency_conflict, which is neither a taken name nor the end of K', async () => {
    const legacy: CreateProgress = { draft, attempts: { source: { key: 'legacy-key', origin: templateOrigin } } }
    const conflict = deps({ createSource: () => platformError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request') })
    const failure = await fail(submitCreate(request, legacy, conflict.value))
    expect(conflict.calls).toEqual(['createSource'])
    expect(conflict.keys.createSource).toEqual(['legacy-key'])
    expect([failure.keyConflict, failure.nameTaken]).toEqual([true, false])
    expect(failure.progress.attempts?.source?.key).toBe('legacy-key')

    // Another origin cannot be rebuilt: nothing is sent, and the user is told to go back to the earlier name.
    const other = deps()
    const refused = await fail(submitCreate({ ...request, urlName: 'other' }, legacy, other.value))
    expect(other.calls).toEqual([])
    expect(refused.message).toBe(text.pendingCreate('mitsumori'))
    expect(refused.progress.attempts?.source?.key).toBe('legacy-key')
  })

  test('the readback after an unreadable 2xx looks for the repository where the attempt sent it, not at the default now', async () => {
    const failure = await fail(submitCreate(request, {}, deps({ createSource: () => json({ resource: { id: 42 } }, 202) }).value))
    expect(failure.progress.unconfirmed).toBe('source')
    const atA = wireRepository({ destination: { repositoryName: 'mitsumori' }, sourceConnectionId: 'github-source-207cb7ce' }, 'mitsumori-src')
    const atB = { ...wireRepository({ destination: { repositoryName: 'mitsumori' } }, 'other-src'), image: { imagePath: 'registry.appthrust.test/commerce/mitsumori' } }
    const readback = deps({}, { repositories: [atB, atA] })
    // confirmCreate no longer reads the current destination at all: only the attempt's own binding decides.
    const confirmed = await confirmCreate(request, failure.progress, { api: readback.api, catalog: readback.value.catalog })
    expect(confirmed.progress).toMatchObject({ ...madeSource })
    expect(confirmed.progress.attempts).toBeUndefined()
    // Only the repository at B (where the attempt was not sent) is listed: nothing is adopted, K stays to be resent.
    const onlyB = deps({}, { repositories: [atB] })
    const none = await confirmCreate(request, failure.progress, { api: onlyB.api, catalog: onlyB.value.catalog })
    expect(none.progress.sourceRepositoryId).toBeUndefined()
    expect(none.progress.attempts?.source?.key).toBe(failure.progress.attempts!.source!.key)
  })
})

describe('a resumed creation uses, and shows, the repository it already made (review finding 3)', () => {
  const movedDestination = resolvedDestinationOf({ revision: 'rd-builtin-2', registryNamespace: 'registry.appthrust.test/commerce' })

  test('source made at A, stack failed, default moved to B: the retry reuses A, and A is what is shown as already created', async () => {
    const first = deps({ validateStack: () => json({ valid: false, message: 'runtime not ready', source: ok, runtime: { valid: false, message: 'runtime not ready' } }) })
    const failure = await fail(submitCreate(request, {}, first.value))
    expect(failure.progress).toEqual({ draft, ...madeSource })
    // The confirm step shows the repository already made at A, whatever the destination resolves to now.
    expect(keptSource(failure.progress, templateOrigin)).toEqual({ state: 'created', id: 'mitsumori-src', binding: templateBinding })

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
