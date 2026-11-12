import { describe, expect, mock, test } from 'bun:test'
import type { ApplicationStackDefinition, ApplicationTemplateSummary } from '@appthrust/api-schema/platform-api'
import { ORPCError } from '@orpc/client'
import { ConsoleApiError, type BusinessApp, type Resolved } from '../../api/console'
import { resolveCreateCatalog, type ResolvedDestination } from '../../model/create'
import { checkNameAvailability, suggestFreeUrlName, type AvailabilityDeps, type AvailabilityRequest } from './availability'

const template: ApplicationTemplateSummary = {
  id: 'nextjs-postgres',
  displayName: 'Next.js + PostgreSQL',
  generatedKind: 'ApplicationStack',
  sourceKinds: ['github-template'],
  defaultPort: 3000,
  components: [
    { id: 'web', displayName: 'Web', kind: 'web' },
    { id: 'postgres', displayName: 'PostgreSQL', kind: 'database' },
  ],
  availability: { available: true, sources: [{ kind: 'github-template', available: true }] },
}
const definition: ApplicationStackDefinition = {
  id: 'web-postgres',
  title: 'Web + PostgreSQL',
  category: 'application',
  components: [
    { id: 'web', definitionRef: { name: 'web-service' } },
    { id: 'database', definitionRef: { name: 'postgresql' } },
  ],
}
const destination: ResolvedDestination = {
  state: 'Resolved',
  source: 'Project',
  revision: 'rev-1',
  destination: { connectionId: 'gh', provider: 'github', displayName: 'gh', repositoryNamespace: 'acme', registryNamespace: 'ghcr.io/acme' },
}

const base: AvailabilityRequest = {
  projectId: 'pj',
  groupPath: 'sales/east',
  urlName: 'mitsumori',
  entry: 'template',
  catalog: resolveCreateCatalog([template], [definition], 'github-template'),
  destination,
}

/** A world where the console owns `consolePaths`, the platform `appNames` and GitHub `repositories`. */
function world({
  consolePaths = [] as string[],
  appNames = [] as Array<{ id: string; name: string }>,
  repositories = [] as string[],
  repositoryAnswer = 'conflict' as 'conflict' | 'invalid',
} = {}) {
  const resolve = mock(async (path: string): Promise<Resolved> => {
    if (!consolePaths.includes(path)) throw new ConsoleApiError(404, { error: 'not_found', message: 'not found' })
    return { kind: 'app', id: `app:${path}`, currentPath: path }
  })
  const validate = mock(async (body: { destination?: { repositoryName: string } }) => {
    const name = body.destination?.repositoryName ?? ''
    if (!repositories.includes(name)) return { valid: true }
    if (repositoryAnswer === 'invalid') return { valid: false, message: `repository acme/${name} already exists` }
    throw new ORPCError('CONFLICT', {
      status: 409,
      data: { body: { error: { code: 'conflict', message: `GitHub repository acme/${name} already exists. Choose a different repository name.` } }, status: 409 },
    })
  })
  const list = mock(async () => ({ data: appNames.map(({ id, name }) => ({ id, applicationName: name })), meta: {} }))
  const deps = {
    resolve,
    platform: { platformApiListApplicationStacks: list, platformApiValidateApplicationSourceRepository: validate },
  } as unknown as AvailabilityDeps
  return { deps, resolve, validate, list }
}

describe('checkNameAvailability', () => {
  test('a free name is not taken and asks each source once', async () => {
    const { deps, resolve, validate, list } = world()
    expect(await checkNameAvailability(base, deps)).toEqual({ taken: undefined })
    expect(resolve.mock.calls).toEqual([['/sales/east/mitsumori']])
    expect(list).toHaveBeenCalledTimes(1)
    expect(validate.mock.calls[0]![0]).toMatchObject({ projectId: 'pj', destination: { repositoryName: 'mitsumori' } })
  })

  test('console: the group path is taken; the suggestion is the first free number', async () => {
    const { deps } = world({ consolePaths: ['/sales/east/mitsumori', '/sales/east/mitsumori-2'] })
    expect(await checkNameAvailability(base, deps)).toEqual({ taken: 'console', suggestion: 'mitsumori-3' })
  })

  test('console: a redirect from an old path, the user’s own draft and other errors do not count', async () => {
    const own = { id: 'draft-1' } as BusinessApp
    const { deps } = world()
    const redirected = { ...deps, resolve: async () => ({ kind: 'app' as const, id: 'x', currentPath: '/sales/west/mitsumori' }) }
    expect((await checkNameAvailability(base, redirected)).taken).toBeUndefined()
    const mine = { ...deps, resolve: async (path: string) => ({ kind: 'app' as const, id: 'draft-1', currentPath: path }) }
    expect((await checkNameAvailability({ ...base, own: { draft: own } }, mine)).taken).toBeUndefined()
    const down = { ...deps, resolve: async () => Promise.reject(new ConsoleApiError(502, undefined)) }
    expect((await checkNameAvailability(base, down)).taken).toBeUndefined()
  })

  test('platform: a same-project application name is taken, except the user’s own stack', async () => {
    const { deps } = world({ appNames: [{ id: 'stack-1', name: 'mitsumori' }] })
    expect(await checkNameAvailability({ ...base, entry: 'image' }, deps)).toEqual({ taken: 'platform', suggestion: 'mitsumori-2' })
    expect((await checkNameAvailability({ ...base, entry: 'image', own: { stackId: 'stack-1' } }, deps)).taken).toBeUndefined()
  })


  test('repository: the platform’s 409 for an existing GitHub repository is taken (ひな形 only)', async () => {
    const { deps, validate } = world({ repositories: ['mitsumori'] })
    expect(await checkNameAvailability(base, deps)).toEqual({ taken: 'repository', suggestion: 'mitsumori-2' })
    validate.mockClear()
    expect((await checkNameAvailability({ ...base, entry: 'existing' }, deps)).taken).toBeUndefined()
    expect(validate).not.toHaveBeenCalled()
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

  test('repository: delivery and destination 409s are not answers about the name', async () => {
    const { deps } = world()
    for (const reason of ['delivery_pending', 'DestinationChanged', 'DestinationMismatch']) {
      const conflicting = {
        ...deps,
        platform: {
          ...deps.platform,
          platformApiValidateApplicationSourceRepository: async () => {
            throw new ORPCError('CONFLICT', { status: 409, data: { body: { error: { code: 'conflict', details: { reason } } }, status: 409 } })
          },
        },
      } as unknown as AvailabilityDeps
      expect((await checkNameAvailability(base, conflicting)).taken).toBeUndefined()
    }
  })

  test('repository: the check binds the seen destination revision and is skipped without a resolved destination', async () => {
    const { deps, validate } = world()
    await checkNameAvailability(base, deps)
    expect(validate.mock.calls[0]![0]).toMatchObject({ destinationRevision: 'rev-1' })
    expect(validate.mock.calls[0]![0]).not.toHaveProperty('sourceConnectionId')
    validate.mockClear()
    expect((await checkNameAvailability({ ...base, destination: undefined }, deps)).taken).toBeUndefined()
    expect(validate).not.toHaveBeenCalled()
  })

  test('an aborted check stops looking for a suggestion', async () => {
    const controller = new AbortController()
    controller.abort()
    const { deps } = world({ consolePaths: ['/sales/east/mitsumori'] })
    expect(await checkNameAvailability(base, { ...deps, signal: controller.signal })).toEqual({ taken: 'console', suggestion: undefined })
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
