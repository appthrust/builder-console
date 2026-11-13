// The Step 1 name check over the real create calls, gateway and contracts; only
// the network is in memory (wire answers as Platform and the Console send them).
import { describe, expect, test } from 'bun:test'
import { createCreateApi } from '../../api/create'
import { appOf, definitionOf, registryOf, sourceConnectionOf, templateOf } from '../../api/testing/catalog-domain'
import { createTestGateway } from '../../api/testing/gateway'
import { resolveCreateCatalog } from '../../model/create'
import { checkNameAvailability, suggestFreeUrlName, type AvailabilityDeps, type AvailabilityRequest } from './availability'

const template = templateOf({
  id: 'nextjs-postgres',
  displayName: 'Next.js + PostgreSQL',
  category: 'framework',
  generatedKind: 'ApplicationStack',
  sourceKinds: ['github-template'],
  defaultPort: 3000,
  components: [
    { id: 'web', displayName: 'Web', kind: 'web' },
    { id: 'postgres', displayName: 'PostgreSQL', kind: 'database' },
  ],
  availability: { available: true, sources: [{ kind: 'github-template', available: true }] },
})
const definition = definitionOf({
  id: 'web-postgres',
  title: 'Web + PostgreSQL',
  category: 'application',
  components: [
    { id: 'web', definitionRef: { name: 'web-service' } },
    { id: 'database', definitionRef: { name: 'postgresql' } },
  ],
})
const connections = {
  source: sourceConnectionOf({ id: 'gh', displayName: 'gh', account: { login: 'acme', type: 'Organization' }, capabilities: ['createRepositories'], status: 'ready', source: 'github-source-connection-cr' }),
  registry: registryOf({ id: 'ghcr', displayName: 'ghcr', registryHost: 'ghcr.io', registryType: 'ghcr', status: 'ready', source: 'registry-connection-cr' }),
}

const base: AvailabilityRequest = {
  projectId: 'pj',
  groupPath: 'sales/east',
  urlName: 'mitsumori',
  entry: 'template',
  catalog: resolveCreateCatalog([template], [definition], 'github-template'),
  connections,
}

const person = { id: 'p1', subject: 's', pending: false, email: 'a@example.test', displayName: '山田', avatarVersion: null }
const ownDraft = appOf({
  id: 'draft-1', slug: 'mitsumori', displayName: '見積', description: '', icon: '', tags: [], guide: '', capabilities: [], screenshots: [],
  group: { id: 'g1', path: 'sales/east', name: '営業1課' }, owners: [person], createdBy: person, stackId: null, appName: null,
  share: { scope: 'private', groupIds: [], extraPersonIds: [] }, createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z',
})

const json = (body: unknown, status = 200) => Response.json(body, { status })
const conflict = (details?: Record<string, unknown>) => json({ error: { code: 'conflict', message: 'GitHub repository acme/x already exists. Choose a different repository name.', ...(details ? { details } : {}) } }, 409)

interface World {
  consolePaths?: string[]
  appNames?: Array<{ id: string; name: string }>
  repositories?: string[]
  repositoryAnswer?: 'conflict' | 'invalid'
  /** Rewrites one source's answer (status and body as the server sent them). */
  resolveAnswer?: (path: string) => Response | undefined
  stacksAnswer?: () => Response
  validateAnswer?: (name: string) => Response | undefined
}

/** A world where the console owns `consolePaths`, the platform `appNames` and GitHub `repositories`. */
function world({ consolePaths = [], appNames = [], repositories = [], repositoryAnswer = 'conflict', resolveAnswer, stacksAnswer, validateAnswer }: World = {}) {
  const calls = { resolve: [] as string[], stacks: 0, validate: [] as Array<Record<string, unknown>> }
  const gateway = createTestGateway({
    consoleFetch: async (path) => {
      const url = new URL(path, 'http://console.test')
      const target = url.searchParams.get('path') ?? ''
      calls.resolve.push(target)
      const rewritten = resolveAnswer?.(target)
      if (rewritten) return rewritten
      return consolePaths.includes(target) ? json({ kind: 'app', id: `app:${target}`, currentPath: target }) : json({ error: 'not_found', message: 'not found' }, 404)
    },
    platformFetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && path === '/api/v1/projects/pj/application-stacks') {
        calls.stacks++
        return stacksAnswer?.() ?? json({ data: appNames.map(({ id, name }) => ({ id, projectId: 'pj', templateId: 'nextjs-postgres', applicationName: name, sourceKind: 'sample-image', pendingSync: false })), meta: { total: appNames.length } })
      }
      if (request.method === 'POST' && path === '/api/v1/projects/pj/application-source-repositories/validate') {
        const body = (await request.json()) as { destination?: { repositoryName: string } }
        calls.validate.push(body)
        const name = body.destination?.repositoryName ?? ''
        const rewritten = validateAnswer?.(name)
        if (rewritten) return rewritten
        if (!repositories.includes(name)) return json({ valid: true })
        return repositoryAnswer === 'invalid' ? json({ valid: false, message: `repository acme/${name} already exists` }) : conflict()
      }
      return json({ error: { code: 'not_found', message: 'unhandled' } }, 404)
    },
  })
  const deps: AvailabilityDeps = { api: createCreateApi(gateway) }
  return { deps, calls }
}

describe('checkNameAvailability', () => {
  test('a free name is not taken, is checked, and asks each source once', async () => {
    const { deps, calls } = world()
    expect(await checkNameAvailability(base, deps)).toEqual({ taken: undefined, checked: true })
    expect(calls.resolve).toEqual(['/sales/east/mitsumori'])
    expect(calls.stacks).toBe(1)
    expect(calls.validate[0]).toMatchObject({ destination: { repositoryName: 'mitsumori' } })
  })

  test('console: the group path is taken; the suggestion is the first free number', async () => {
    const { deps } = world({ consolePaths: ['/sales/east/mitsumori', '/sales/east/mitsumori-2'] })
    expect(await checkNameAvailability(base, deps)).toEqual({ taken: 'console', checked: true, suggestion: 'mitsumori-3' })
  })

  test('console: a redirect from an old path and the user’s own draft do not count; a console that cannot answer leaves the name unchecked', async () => {
    const redirected = world({ resolveAnswer: () => json({ kind: 'app', id: 'x', currentPath: '/sales/west/mitsumori' }) })
    expect(await checkNameAvailability(base, redirected.deps)).toEqual({ taken: undefined, checked: true })
    const mine = world({ resolveAnswer: (path) => json({ kind: 'app', id: 'draft-1', currentPath: path }) })
    expect(await checkNameAvailability({ ...base, own: { draft: ownDraft } }, mine.deps)).toEqual({ taken: undefined, checked: true })
    const down = world({ resolveAnswer: () => json({ error: 'upstream_unavailable', message: 'down' }, 502) })
    expect(await checkNameAvailability(base, down.deps)).toEqual({ taken: undefined, checked: false })
  })

  test('console: a path held by a kind this console does not know is taken', async () => {
    const { deps } = world({ resolveAnswer: (path) => json({ kind: 'collection', id: 'c-1', currentPath: path }) })
    expect((await checkNameAvailability(base, deps)).taken).toBe('console')
  })

  test('platform: a same-project application name is taken, except the user’s own stack', async () => {
    const { deps } = world({ appNames: [{ id: 'stack-1', name: 'mitsumori' }] })
    expect(await checkNameAvailability({ ...base, entry: 'image' }, deps)).toEqual({ taken: 'platform', checked: true, suggestion: 'mitsumori-2' })
    expect((await checkNameAvailability({ ...base, entry: 'image', own: { stackId: 'stack-1' } }, deps)).taken).toBeUndefined()
  })

  test('repository: the platform’s 409 for an existing GitHub repository is taken (ひな形 only)', async () => {
    const { deps, calls } = world({ repositories: ['mitsumori'] })
    expect(await checkNameAvailability(base, deps)).toEqual({ taken: 'repository', checked: true, suggestion: 'mitsumori-2' })
    calls.validate.length = 0
    expect((await checkNameAvailability({ ...base, entry: 'existing' }, deps)).taken).toBeUndefined()
    expect(calls.validate).toEqual([])
  })

  test('repository: a valid=false answer about an existing repository is taken; the user’s own repository is not', async () => {
    const { deps } = world({ repositories: ['mitsumori'], repositoryAnswer: 'invalid' })
    expect((await checkNameAvailability(base, deps)).taken).toBe('repository')
    expect((await checkNameAvailability({ ...base, own: { sourceRepositoryOrigin: { kind: 'template', appName: 'mitsumori' } } }, deps)).taken).toBeUndefined()
    // A kept repository of another origin (作ったコードから) does not make the ひな形 name the user's own.
    expect(
      (await checkNameAvailability({ ...base, own: { sourceRepositoryOrigin: { appName: 'mitsumori', kind: 'existing', repository: 'acme/mitsumori' } } }, deps)).taken
    ).toBe('repository')
  })

  test('repository: a delivery_pending 409 is not an answer about the name', async () => {
    const { deps } = world({ validateAnswer: () => conflict({ reason: 'delivery_pending' }) })
    expect(await checkNameAvailability(base, deps)).toEqual({ taken: undefined, checked: false })
  })

  test('an aborted check stops looking for a suggestion', async () => {
    const controller = new AbortController()
    controller.abort()
    const { deps } = world({ consolePaths: ['/sales/east/mitsumori'] })
    expect(await checkNameAvailability(base, { ...deps, signal: controller.signal })).toEqual({ taken: 'console', checked: true, suggestion: undefined })
  })
})

describe('an unreadable answer is never "free" (X2/X4)', () => {
  const SECRET = 'SENTINEL-availability-3c9e'

  test('platform names that cannot be read are not an empty name set: the name is unchecked and no variant is suggested', async () => {
    const malformed = world({ consolePaths: ['/sales/east/mitsumori'], stacksAnswer: () => json({ data: [{ id: 'stack-1', applicationName: SECRET }] }) })
    expect(await checkNameAvailability(base, malformed.deps)).toEqual({ taken: 'console', checked: true, suggestion: undefined })
    expect(await checkNameAvailability({ ...base, urlName: 'other' }, malformed.deps)).toEqual({ taken: undefined, checked: false })
    expect(await suggestFreeUrlName(base, malformed.deps)).toBeUndefined()
    const absent = world({ stacksAnswer: () => json({ meta: { total: 0 } }) })
    expect(await checkNameAvailability(base, absent.deps)).toEqual({ taken: undefined, checked: false })
  })

  test('a malformed console resolve or repository validation leaves the name unchecked, never free', async () => {
    const resolve = world({ resolveAnswer: () => json({ kind: 'app', id: 7, currentPath: SECRET }) })
    expect(await checkNameAvailability(base, resolve.deps)).toEqual({ taken: undefined, checked: false })
    const validate = world({ validateAnswer: () => json({ valid: SECRET }) })
    expect(await checkNameAvailability(base, validate.deps)).toEqual({ taken: undefined, checked: false })
  })

  test('a variant is only suggested when every source answered for it', async () => {
    const { deps } = world({ consolePaths: ['/sales/east/mitsumori'], resolveAnswer: (path) => (path.endsWith('-2') ? json({ junk: SECRET }) : undefined) })
    expect((await checkNameAvailability(base, deps)).suggestion).toBe('mitsumori-3')
  })
})

describe('suggestFreeUrlName', () => {
  test('skips numbered names taken anywhere', async () => {
    const { deps } = world({
      consolePaths: ['/sales/east/test-2'],
      appNames: [{ id: 's', name: 'test-3' }],
      repositories: ['test-4'],
    })
    expect(await suggestFreeUrlName({ ...base, urlName: 'test' }, deps)).toBe('test-5')
  })
})
