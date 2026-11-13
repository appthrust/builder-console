import { describe, expect, mock, test, type Mock } from 'bun:test'
import type {
  ApplicationStackDefinition,
  ApplicationTemplateSummary,
  CreateApplicationSourceRepositoryRequest,
  CreateApplicationStackRequest,
} from '@appthrust/api-schema/platform-api'
import { platformApiRouter } from '@appthrust/api-schema/platform-api-router'
import { createORPCClient, ORPCError } from '@orpc/client'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import type { PlatformApiClient } from '../../api/client'
import { ConsoleApiError } from '../../api/console'
import { type BusinessApp } from '../../api/console-unverified'
import { copy } from '../../copy'
import { MOCK_PROJECT_ID, platformRoutes } from '../../dev/mock-platform'
import { resolveCreateCatalog, type SourceConnections } from '../../model/create'
import {
  CreateFailed,
  submitCreate,
  type CreateDeps,
  type CreateRequest,
} from './submit'

const template: ApplicationTemplateSummary = {
  id: 'nextjs-postgres',
  displayName: 'Next.js + PostgreSQL',
  generatedKind: 'ApplicationStack',
  sourceKinds: ['sample-image', 'github-template'],
  defaultPort: 3000,
  components: [
    { id: 'web', displayName: 'Web', kind: 'web' },
    { id: 'postgres', displayName: 'PostgreSQL', kind: 'database' },
  ],
  availability: { available: true, sources: [{ kind: 'sample-image', available: true }, { kind: 'github-template', available: true }] },
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
const connections: SourceConnections = {
  source: {
    id: 'gh',
    displayName: 'gh',
    account: { login: 'acme', type: 'Organization' },
    capabilities: ['createRepositories'],
    status: 'ready',
    source: 'github-source-connection-cr',
  },
  registry: { id: 'ghcr', displayName: 'ghcr', registryHost: 'ghcr.io', registryType: 'ghcr', status: 'ready', source: 'registry-connection-cr' },
}

const person = { id: 'p1', subject: 's', pending: false, email: 'a@example.test', displayName: '山田', avatarVersion: null }
const draft: BusinessApp = {
  id: 'app-1',
  slug: 'mitsumori',
  displayName: '見積作成',
  description: '',
  icon: '',
  tags: [],
  guide: '',
  capabilities: [],
  screenshots: [],
  group: { id: 'g1', path: 'sales/east', name: '営業1課' },
  owners: [person],
  stackId: null,
  appName: 'mitsumori',
  share: { scope: 'group', groupIds: ['g1'], extraPersonIds: [] },
  createdBy: person,
  createdAt: '2026-10-06T00:00:00Z',
  updatedAt: '2026-10-06T00:00:00Z',
}

const request: CreateRequest = {
  projectId: 'pj',
  path: { kind: 'template' },
  displayName: '見積作成',
  description: '',
  tags: [],
  groupId: 'g1',
  urlName: 'mitsumori',
  share: draft.share,
}

/** A Platform API 409 as `OpenAPILink` delivers it: the HTTP body under `data.body`. */
function platformConflict(message: string, details?: Record<string, unknown>) {
  return new ORPCError('CONFLICT', {
    status: 409,
    data: { body: { error: { code: 'conflict', message, ...(details ? { details } : {}) } }, status: 409, headers: {} },
  })
}

function deps(overrides: Partial<CreateDeps['platform']> = {}) {
  const calls: string[] = []
  const record = <T>(name: string, value: T) =>
    mock(async (..._args: unknown[]) => {
      calls.push(name)
      return value
    })
  const value: CreateDeps = {
    console: {
      create: record('console.create', draft),
      update: record('console.update', draft),
      bind: mock(async (_id: string, input: { stackId: string; appName: string }) => {
        calls.push(`console.bind:${input.stackId}:${input.appName}`)
        return { ...draft, stackId: input.stackId }
      }),
      remove: record('console.remove', undefined),
    },
    platform: {
      platformApiValidateApplicationSourceRepository: record('platform.validateSource', { valid: true }),
      platformApiCreateApplicationSourceRepository: mock(async (body: CreateApplicationSourceRepositoryRequest) => {
        calls.push('platform.createSource')
        return { id: `${body.destination?.repositoryName ?? 'mitsumori'}-src` }
      }) as never,
      platformApiDeleteApplicationSourceRepository: mock(async (input: { params: { id: string } }) => {
        calls.push(`platform.deleteSource:${input.params.id}`)
        return {}
      }) as never,
      platformApiValidateApplicationStack: record('platform.validateStack', { valid: true, message: 'ok' }) as never,
      platformApiCreateApplicationStack: record('platform.createStack', { id: 'mitsumori' }) as never,
      ...overrides,
    },
    catalog: resolveCreateCatalog([template], [definition], 'github-template')!,
    domain: 'pj.appthrust.test',
    connections,
    onPhase: () => {},
  }
  return { value, calls }
}

describe('submitCreate', () => {
  test('ひな形: draft → source repository → stack → bind, in that order', async () => {
    const { value, calls } = deps()
    const app = await submitCreate(request, {}, value)
    expect(app.stackId).toBe('mitsumori')
    expect(calls).toEqual([
      'console.create',
      'platform.validateSource',
      'platform.createSource',
      'platform.validateStack',
      'platform.createStack',
      'console.bind:mitsumori:mitsumori',
    ])
  })

  test('the template path reports its loading phase synchronously before waiting for the draft', async () => {
    const { value } = deps()
    const pending = Promise.withResolvers<BusinessApp>()
    value.console.create = mock(() => pending.promise)
    const phases: string[] = []
    value.onPhase = (phase) => { phases.push(phase) }
    const result = submitCreate(request, {}, value)
    expect(phases).toEqual(['draft'])
    pending.resolve(draft)
    await result
  })

  test.each([
    ['template.repository', 0],
    ['existing.repository', 1],
    ['destination.repositoryName', 1],
  ] as const)('invalid_argument for %s belongs to step %s through a real OpenAPILink', async (path, step) => {
    const message = `'${path}' is not allowed by the selected source connection`
    const link = new OpenAPILink(platformApiRouter, {
      url: 'http://platform.test',
      fetch: async () => Response.json({ error: { code: 'invalid_argument', message } }, { status: 400 }),
    })
    const client: PlatformApiClient = createORPCClient(link)
    const { value } = deps({ platformApiCreateApplicationSourceRepository: client.platformApiCreateApplicationSourceRepository })
    const failure = await submitCreate(request, {}, value).catch((error: unknown) => error) as CreateFailed
    expect(failure.field).toEqual({ path, step })
    expect(failure.data?.message).toBe(message)
    expect(failure.nameTaken).toBe(false)
    expect(failure.progress.draft).toEqual(draft)
  })

  test('a stale catalog reaches the mock allowlist rejection and returns to the template step', async () => {
    const link = new OpenAPILink(platformApiRouter, {
      url: 'http://platform.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const response = await platformRoutes(request, new URL(request.url))
        if (!response) throw new Error(`unhandled ${request.url}`)
        return response
      },
    })
    const client: PlatformApiClient = createORPCClient(link)
    const { value } = deps({
      platformApiValidateApplicationSourceRepository: client.platformApiValidateApplicationSourceRepository,
      platformApiCreateApplicationSourceRepository: client.platformApiCreateApplicationSourceRepository,
    })
    value.connections = { ...connections, source: { ...connections.source, id: 'github-source-207cb7ce' } }
    value.catalog = {
      ...value.catalog,
      template: {
        ...template,
        id: 'biz-approval-postgres',
        githubTemplate: { repository: 'appthrust/template-biz-approval', repositoryUrl: 'https://github.com/appthrust/template-biz-approval' },
      },
    }
    const failure = await submitCreate({ ...request, projectId: MOCK_PROJECT_ID, urlName: 'blocked-template-test' }, {}, value).catch((error: unknown) => error) as CreateFailed
    expect(failure.field).toEqual({ path: 'template.repository', step: 0 })
    expect(failure.data?.message).toBe("'template.repository' is not allowed by the selected source connection")
    expect(failure.progress).toEqual({ draft })
  })

  test.each([
    ['invalid_argument', 'the source connection is unavailable', 400],
    ['invalid_argument', "problem with 'template.repository'", 400],
    ['invalid_argument', "'image.imagePath' is invalid", 400],
    ['conflict', "'template.repository' is invalid", 400],
    ['invalid_argument', "'template.repository' is invalid", 500],
  ])('non-field or non-validation errors remain generic: %s / %s / %s', (code, message, status) => {
    const failure = new CreateFailed(new ORPCError('BAD_REQUEST', {
      status,
      data: { body: { error: { code, message } } },
    }), {}, false)
    expect(failure.field).toBeUndefined()
  })

  test('publishes completed resource ids before the next phase, so reload can resume', async () => {
    const { value } = deps()
    const saved: Array<{ draft?: BusinessApp; sourceRepositoryId?: string; stackId?: string }> = []
    value.onProgress = (progress) => { saved.push(progress) }
    await submitCreate(request, {}, value)
    expect(saved.map((item) => [item.draft?.id, item.sourceRepositoryId, item.stackId])).toEqual([
      ['app-1', undefined, undefined], ['app-1', 'mitsumori-src', undefined], ['app-1', 'mitsumori-src', 'mitsumori'],
    ])
  })

  test('changing a business template after a failed attempt uses the newly chosen source', async () => {
    const { value, calls } = deps()
    value.catalog = { ...value.catalog, template: { ...template, id: 'biz-master-postgres', githubTemplate: { repository: 'appthrust/template-biz-master', repositoryUrl: 'https://github.com/appthrust/template-biz-master', branch: 'main' } } }
    await submitCreate(request, { draft, sourceRepositoryId: 'old-src', sourceRepositoryOrigin: { appName: 'mitsumori', kind: 'template', templateId: 'biz-inventory-postgres' } }, value)
    expect(calls).toContain('platform.deleteSource:old-src')
    expect(calls).toContain('platform.createSource')
    const source = value.platform.platformApiCreateApplicationSourceRepository as Mock<typeof value.platform.platformApiCreateApplicationSourceRepository>
    expect(source.mock.calls[0]?.[0]).toMatchObject({ template: { repository: 'appthrust/template-biz-master' } })
  })

  test('イメージ: no source repository calls', async () => {
    const { value, calls } = deps()
    await submitCreate({ ...request, path: { kind: 'image', imageRef: 'ghcr.io/a/b:1' } }, {}, value)
    expect(calls).toEqual(['console.create', 'platform.validateStack', 'platform.createStack', 'console.bind:mitsumori:mitsumori'])
  })

  test('platform 403 deletes the draft and reports forbidden', async () => {
    const forbidden = mock(async () => {
      throw new ORPCError('FORBIDDEN', { status: 403 })
    })
    const { value, calls } = deps({ platformApiValidateApplicationSourceRepository: forbidden as never })
    const failure = await submitCreate(request, {}, value).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CreateFailed)
    expect((failure as CreateFailed).forbidden).toBe(true)
    expect((failure as CreateFailed).progress).toEqual({})
    expect(calls).toEqual(['console.create', 'console.remove'])
  })

  test('other failures keep the draft and what was created; the retry resumes', async () => {
    const conflict = mock(async () => {
      throw platformConflict('name taken')
    })
    const first = deps({ platformApiCreateApplicationStack: conflict as never })
    const failure = (await submitCreate(request, {}, first.value).catch((error: unknown) => error)) as CreateFailed
    expect(failure.forbidden).toBe(false)
    expect(failure.data).toEqual({ message: 'name taken' })
    expect(failure.progress).toEqual({ draft, sourceRepositoryId: 'mitsumori-src', sourceRepositoryOrigin: { appName: 'mitsumori', kind: 'template', templateId: 'nextjs-postgres' } })
    expect(first.calls).not.toContain('console.remove')

    const retry = deps()
    await submitCreate(request, failure.progress, retry.value)
    expect(retry.calls).toEqual(['platform.validateStack', 'platform.createStack', 'console.bind:mitsumori:mitsumori'])
  })

  test('a 409 delivery_pending is retryable, not a taken name; the retry resumes from the kept draft', async () => {
    const message = 'Platform delivery is converging; retry the same request in a few seconds.'
    const converging = mock(async () => {
      throw platformConflict(message, { reason: 'delivery_pending', retryAfterSeconds: 5 })
    })
    const first = deps({ platformApiCreateApplicationStack: converging as never })
    const failure = (await submitCreate(request, {}, first.value).catch((error: unknown) => error)) as CreateFailed
    expect(failure.retryable).toBe(true)
    expect(failure.nameTaken).toBe(false)
    expect(failure.data).toEqual({ message })
    expect(failure.progress).toEqual({ draft, sourceRepositoryId: 'mitsumori-src', sourceRepositoryOrigin: { appName: 'mitsumori', kind: 'template', templateId: 'nextjs-postgres' } })

    const retry = deps()
    await submitCreate(request, failure.progress, retry.value)
    expect(retry.calls).toEqual(['platform.validateStack', 'platform.createStack', 'console.bind:mitsumori:mitsumori'])

    const blocked = deps({
      platformApiCreateApplicationStack: mock(async () => {
        throw platformConflict('blocked', { reason: 'delivery_blocked' })
      }) as never,
    })
    const stopped = (await submitCreate(request, {}, blocked.value).catch((error: unknown) => error)) as CreateFailed
    expect([stopped.retryable, stopped.nameTaken]).toEqual([false, false])

    const taken = deps({
      platformApiCreateApplicationStack: mock(async () => {
        throw platformConflict('publish endpoint is already owned by another publish', { reason: 'publish_url_conflict' })
      }) as never,
    })
    const nameFailure = (await submitCreate(request, {}, taken.value).catch((error: unknown) => error)) as CreateFailed
    expect([nameFailure.retryable, nameFailure.nameTaken]).toEqual([false, true])
  })

  test('the same 409 through a real OpenAPILink is classified by its details.reason', async () => {
    const answer = (details: Record<string, unknown>) => {
      const link = new OpenAPILink(platformApiRouter, {
        url: 'http://platform.test',
        fetch: async () => Response.json({ error: { code: 'conflict', message: 'converging', details } }, { status: 409 }),
      })
      const client: PlatformApiClient = createORPCClient(link)
      return deps({ platformApiCreateApplicationStack: client.platformApiCreateApplicationStack })
    }
    const pending = (await submitCreate(request, {}, answer({ reason: 'delivery_pending' }).value).catch((error: unknown) => error)) as CreateFailed
    expect([pending.retryable, pending.nameTaken, pending.data?.message]).toEqual([true, false, 'converging'])
    const other = (await submitCreate(request, {}, answer({ reason: 'publish_url_conflict' }).value).catch((error: unknown) => error)) as CreateFailed
    expect([other.retryable, other.nameTaken]).toEqual([false, true])
  })

  test('a console answer without a contract envelope (gateway 500) is transient and retryable', async () => {
    const { value } = deps()
    value.console.create = mock(async () => {
      throw new ConsoleApiError(500, undefined)
    })
    const failure = (await submitCreate(request, {}, value).catch((error: unknown) => error)) as CreateFailed
    expect([failure.transient, failure.retryable, failure.nameTaken]).toEqual([true, true, false])
    expect(failure.message).toBe(copy.errors.transient)
    expect(failure.data).toBeUndefined()
  })

  test('a validation answer of valid=false stops before creating anything on the platform', async () => {
    const { value, calls } = deps({
      platformApiValidateApplicationStack: mock(async () => ({ valid: false, message: 'quota exceeded' })) as never,
    })
    const failure = (await submitCreate({ ...request, path: { kind: 'image', imageRef: 'x' } }, {}, value).catch(
      (error: unknown) => error
    )) as CreateFailed
    expect(failure.data).toEqual({ message: 'quota exceeded' })
    expect(calls).toEqual(['console.create'])
  })

  test('the stack request publishes https://<urlName>.<domain>', async () => {
    const validate = mock(async (_input: CreateApplicationStackRequest) => ({ valid: true, message: 'ok' }))
    const { value } = deps({ platformApiValidateApplicationStack: validate as never })
    await submitCreate(request, {}, value)
    expect(validate.mock.calls[0]![0].publish).toEqual({
      enabled: true,
      customDomain: 'pj.appthrust.test',
      hostnamePattern: 'wildcard',
      subdomain: 'mitsumori',
    })
  })

  test('a rejected stack validation carries each failing section message, in source → runtime → publish order', async () => {
    const ok = { valid: true, message: 'ok' }
    const { value, calls } = deps({
      platformApiValidateApplicationStack: mock(async () => ({
        valid: false,
        message: 'Launch needs changes before resources can be created.',
        publish: { valid: false, message: "'customDomain' is required for gateway publish" },
        runtime: ok,
        source: { valid: false, message: 'sample-image ApplicationStack source requires a ready credentialed ContainerRepository' },
      })) as never,
    })
    const failure = (await submitCreate({ ...request, path: { kind: 'image', imageRef: 'x' } }, {}, value).catch(
      (error: unknown) => error
    )) as CreateFailed
    expect(failure.issues).toEqual([
      { section: 'source', message: 'sample-image ApplicationStack source requires a ready credentialed ContainerRepository' },
      { section: 'publish', message: "'customDomain' is required for gateway publish" },
    ])
    expect(failure.data).toEqual({ message: 'Launch needs changes before resources can be created.' })
    expect(calls).toEqual(['console.create'])
  })

  test('a rejected source repository validation is reported as the source section; other failures have no sections', async () => {
    const { value } = deps({
      platformApiValidateApplicationSourceRepository: mock(async () => ({ valid: false, message: 'repository already exists' })) as never,
    })
    const failure = (await submitCreate(request, {}, value).catch((error: unknown) => error)) as CreateFailed
    expect(failure.issues).toEqual([{ section: 'source', message: 'repository already exists' }])

    const conflict = deps({
      platformApiCreateApplicationStack: mock(async () => {
        throw new ORPCError('CONFLICT', { status: 409 })
      }) as never,
    })
    const other = (await submitCreate(request, {}, conflict.value).catch((error: unknown) => error)) as CreateFailed
    expect(other.issues).toEqual([])
  })

  test('a retry after changing the URL name updates the kept draft first', async () => {
    const { value, calls } = deps()
    await submitCreate({ ...request, urlName: 'mitsumori2' }, { draft }, value)
    expect(calls[0]).toBe('console.update')
    expect(calls.at(-1)).toBe('console.bind:mitsumori:mitsumori2')
  })

  test('a rename after the stack failed replaces the kept repository with one named after the new URL name', async () => {
    const first = deps({
      platformApiCreateApplicationStack: mock(async () => {
        throw platformConflict('publish endpoint is already owned by another publish', { reason: 'publish_url_conflict' })
      }) as never,
    })
    const failure = (await submitCreate({ ...request, urlName: 'test' }, {}, first.value).catch((error: unknown) => error)) as CreateFailed
    expect(failure.nameTaken).toBe(true)
    expect(failure.progress).toMatchObject({ sourceRepositoryId: 'test-src', sourceRepositoryOrigin: { appName: 'test', kind: 'template' } })

    const retry = deps()
    await submitCreate({ ...request, urlName: 'test2' }, failure.progress, retry.value)
    expect(retry.calls).toEqual([
      'console.update',
      'platform.deleteSource:test-src',
      'platform.validateSource',
      'platform.createSource',
      'platform.validateStack',
      'platform.createStack',
      'console.bind:mitsumori:test2',
    ])
    const create = retry.value.platform.platformApiCreateApplicationSourceRepository as unknown as Mock<(body: CreateApplicationSourceRepositoryRequest) => unknown>
    expect(create.mock.calls[0]![0]).toMatchObject({
      destination: { repositoryName: 'test2' },
      image: { imagePath: 'ghcr.io/acme/test2' },
    })
    const stack = retry.value.platform.platformApiCreateApplicationStack as unknown as Mock<(body: CreateApplicationStackRequest) => unknown>
    expect(stack.mock.calls[0]![0].source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: 'test2-src' })
  })

  test('a failed delete of the orphaned repository does not block the renamed attempt', async () => {
    const { value, calls } = deps({
      platformApiDeleteApplicationSourceRepository: mock(async () => {
        throw platformConflict('referenced', { reason: 'referenced_by_stack' })
      }) as never,
    })
    const app = await submitCreate({ ...request, urlName: 'test2' }, { draft, sourceRepositoryId: 'test-src', sourceRepositoryOrigin: { appName: 'test', kind: 'template' } }, value)
    expect(app.stackId).toBe('mitsumori')
    expect(calls).toContain('platform.createSource')
    expect(calls.at(-1)).toBe('console.bind:mitsumori:test2')
  })

  test('a kept stack is only bound under the name it was created with', async () => {
    const kept = { draft, sourceRepositoryId: 'test-src', sourceRepositoryOrigin: { appName: 'test', kind: 'template' as const }, stackId: 'test', stackAppName: 'test' }
    const same = deps()
    await submitCreate({ ...request, urlName: 'test' }, kept, same.value)
    expect(same.calls).toEqual(['console.update', 'console.bind:test:test'])

    const renamed = deps()
    const failure = (await submitCreate({ ...request, urlName: 'test2' }, kept, renamed.value).catch((error: unknown) => error)) as CreateFailed
    expect(failure).toBeInstanceOf(CreateFailed)
    expect(failure.message).toContain('already created as "test"')
    expect(failure.progress).toEqual(kept)
    expect(renamed.calls).toEqual([])
  })

  test('作ったコードから: draft → adopt the picked repository → stack → bind', async () => {
    const { value, calls } = deps()
    const repository = { fullName: 'acme/claude-mitsumori', defaultBranch: 'main' }
    await submitCreate({ ...request, urlName: 'claude-mitsumori', path: { kind: 'existing', repository } }, {}, value)
    expect(calls).toEqual([
      'console.create',
      'platform.validateSource',
      'platform.createSource',
      'platform.validateStack',
      'platform.createStack',
      'console.bind:mitsumori:claude-mitsumori',
    ])
    const validate = value.platform.platformApiValidateApplicationSourceRepository as unknown as Mock<(body: CreateApplicationSourceRepositoryRequest) => unknown>
    const body = validate.mock.calls[0]![0]
    expect(body).toMatchObject({
      projectId: 'pj',
      existing: { repository: 'acme/claude-mitsumori', ref: 'main' },
      image: { imagePath: 'ghcr.io/acme/claude-mitsumori' },
    })
    expect(body.template).toBeUndefined()
    expect(body.destination).toBeUndefined()
  })

  test('same URL name with a different existing repository deletes the orphan and adopts the new repository', async () => {
    const firstRequest: CreateRequest = {
      ...request,
      path: { kind: 'existing', repository: { fullName: 'acme/old-app', defaultBranch: 'main' } },
    }
    const first = deps({
      platformApiCreateApplicationStack: mock(async () => {
        throw platformConflict('name taken')
      }) as never,
    })
    const failure = (await submitCreate(firstRequest, {}, first.value).catch((error: unknown) => error)) as CreateFailed
    expect(failure.progress.sourceRepositoryOrigin).toEqual({ appName: 'mitsumori', kind: 'existing', repository: 'acme/old-app' })

    const create = mock(async (_body: CreateApplicationSourceRepositoryRequest) => ({ id: 'new-app-src' }))
    const retry = deps({ platformApiCreateApplicationSourceRepository: create as never })
    await submitCreate({
      ...request,
      path: { kind: 'existing', repository: { fullName: 'acme/new-app', defaultBranch: 'develop' } },
    }, failure.progress, retry.value)
    expect(retry.calls).toEqual([
      'platform.deleteSource:mitsumori-src',
      'platform.validateSource',
      'platform.validateStack',
      'platform.createStack',
      'console.bind:mitsumori:mitsumori',
    ])
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({ existing: { repository: 'acme/new-app', ref: 'develop' } })
    const stack = retry.value.platform.platformApiCreateApplicationStack as unknown as Mock<(body: CreateApplicationStackRequest) => unknown>
    expect(stack.mock.calls[0]![0].source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: 'new-app-src' })
  })

  test('same URL name switching template to existing deletes the orphan and adopts the picked repository', async () => {
    const first = deps({
      platformApiCreateApplicationStack: mock(async () => {
        throw platformConflict('name taken')
      }) as never,
    })
    const failure = (await submitCreate(request, {}, first.value).catch((error: unknown) => error)) as CreateFailed
    const create = mock(async (_body: CreateApplicationSourceRepositoryRequest) => ({ id: 'picked-src' }))
    const retry = deps({ platformApiCreateApplicationSourceRepository: create as never })
    await submitCreate({
      ...request,
      path: { kind: 'existing', repository: { fullName: 'acme/picked-app', defaultBranch: 'main' } },
    }, failure.progress, retry.value)
    expect(retry.calls).toEqual([
      'platform.deleteSource:mitsumori-src',
      'platform.validateSource',
      'platform.validateStack',
      'platform.createStack',
      'console.bind:mitsumori:mitsumori',
    ])
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({ existing: { repository: 'acme/picked-app', ref: 'main' } })
    expect(create.mock.calls[0]![0].template).toBeUndefined()
    const stack = retry.value.platform.platformApiCreateApplicationStack as unknown as Mock<(body: CreateApplicationStackRequest) => unknown>
    expect(stack.mock.calls[0]![0].source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: 'picked-src' })
  })

  test('an identical existing repository origin reuses the source without deleting or creating', async () => {
    const existingRequest: CreateRequest = {
      ...request,
      path: { kind: 'existing', repository: { fullName: 'acme/picked-app', defaultBranch: 'main' } },
    }
    const first = deps({
      platformApiCreateApplicationStack: mock(async () => {
        throw platformConflict('name taken')
      }) as never,
    })
    const failure = (await submitCreate(existingRequest, {}, first.value).catch((error: unknown) => error)) as CreateFailed
    const retry = deps()
    await submitCreate(existingRequest, failure.progress, retry.value)
    expect(retry.calls).toEqual(['platform.validateStack', 'platform.createStack', 'console.bind:mitsumori:mitsumori'])
    expect(retry.value.platform.platformApiDeleteApplicationSourceRepository).not.toHaveBeenCalled()
    expect(retry.value.platform.platformApiCreateApplicationSourceRepository).not.toHaveBeenCalled()
    const stack = retry.value.platform.platformApiCreateApplicationStack as unknown as Mock<(body: CreateApplicationStackRequest) => unknown>
    expect(stack.mock.calls[0]![0].source).toEqual({ kind: 'application-source-repository', sourceRepositoryId: 'mitsumori-src' })
  })

  test('same URL name switching existing to template deletes the orphan and creates the template repository', async () => {
    const first = deps({
      platformApiCreateApplicationStack: mock(async () => {
        throw platformConflict('name taken')
      }) as never,
    })
    const failure = (await submitCreate({
      ...request,
      path: { kind: 'existing', repository: { fullName: 'acme/picked-app', defaultBranch: 'main' } },
    }, {}, first.value).catch((error: unknown) => error)) as CreateFailed
    const retry = deps()
    await submitCreate(request, failure.progress, retry.value)
    expect(retry.calls).toEqual([
      'platform.deleteSource:mitsumori-src',
      'platform.validateSource',
      'platform.createSource',
      'platform.validateStack',
      'platform.createStack',
      'console.bind:mitsumori:mitsumori',
    ])
    const create = retry.value.platform.platformApiCreateApplicationSourceRepository as unknown as Mock<(body: CreateApplicationSourceRepositoryRequest) => unknown>
    expect(create.mock.calls[0]![0]).toMatchObject({ destination: { repositoryName: 'mitsumori' } })
    expect(create.mock.calls[0]![0].existing).toBeUndefined()
  })
})
