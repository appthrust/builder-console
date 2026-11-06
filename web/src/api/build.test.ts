import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { QueryClient, QueryObserver, skipToken } from '@tanstack/react-query'
import * as api from './build'
import { BUILD_POLL_MS, buildDraftOptions, buildExecutionOptions, buildGenerationOptions, buildKeys, buildToolsOptions, buildTurnOptions, draftsOptions } from './build-queries'
import { readRetryDelay, retryReadQuery } from './queries'
import { isPublishPreparationPending } from './publish-retry'

const originalFetch = globalThis.fetch
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const requests: Request[] = []
const startedAt = '2026-10-08T00:00:00Z'
const execution = { id: 'exec-1', status: 'running' as const, attempt: 1, startedAt, steps: [] }
const draft = { id: 'draft-1', projectId: 'project-1', title: '見積', intent: '見積を作る', phase: 'creating' as const, specMarkdown: '', architectureMarkdown: '', ownerUserId: 'owner-1', createdAt: startedAt, updatedAt: startedAt, creationExecutions: [execution] }

beforeEach(() => {
  requests.length = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://console.test' } } })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input)
    requests.push(request)
    return Response.json(draft)
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
  else Reflect.deleteProperty(globalThis, 'window')
  if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
})

test('all build API adapters use contract routes, payloads and idempotency keys per mutation attempt', async () => {
  await api.createDraft('project-1', { intent: '見積を作る', title: '見積' })
  await api.updateDraft('project-1', 'draft-1', { specMarkdown: '---\nspec: {}\n---\n', intent: '新しい内容', title: '新しい名前' })
  await api.createTurn('project-1', 'draft-1', { message: 'PDF を出す' })
  await api.createGeneration('project-1', 'draft-1', { devWorkspaceId: 'workspace-1' })
  await api.validatePlan('project-1', 'draft-1')
  await api.createExecution('project-1', 'draft-1', { clientRequestId: 'attempt-1', creationPlanFingerprint: 'fingerprint-1' })
  await api.runExecution('project-1', 'draft-1', 'exec-1')
  await api.cleanupCreation('project-1', 'draft-1')
  const root = '/api/v1/projects/project-1/application-drafts'
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ['POST', root], ['PATCH', `${root}/draft-1`], ['POST', `${root}/draft-1/conversation-turns`],
    ['POST', `${root}/draft-1/creation-plan-generations`], ['POST', `${root}/draft-1/creation-plan-validations`],
    ['POST', `${root}/draft-1/creation-executions`], ['POST', `${root}/draft-1/creation-executions/exec-1/run`], ['POST', `${root}/draft-1/creation-cleanups`],
  ])
  expect(await requests[0]!.json()).toEqual({ intent: '見積を作る', title: '見積' })
  expect(await requests[1]!.json()).toEqual({ specMarkdown: '---\nspec: {}\n---\n', intent: '新しい内容', title: '新しい名前' })
  expect(await requests[2]!.json()).toEqual({ message: 'PDF を出す' })
  expect(await requests[3]!.json()).toEqual({ devWorkspaceId: 'workspace-1' })
  expect(await requests[5]!.json()).toEqual({ clientRequestId: 'attempt-1', creationPlanFingerprint: 'fingerprint-1' })
  const keys = requests.map((request) => request.headers.get('Idempotency-Key'))
  expect(keys.every(Boolean)).toBe(true)
  expect(new Set(keys).size).toBe(requests.length)
})

test('workbook set and structured turns use the draft contract routes, payloads and the caller key', async () => {
  const workbook = { fileName: '台帳.xlsx', sheets: [{ name: '台帳', rows: [['名前'], ['案件']] }] }
  await api.addWorkbook('project-1', 'draft-1', workbook, 'file-key-1')
  await api.addWorkbook('project-1', 'draft-1', workbook, 'file-key-1')
  await api.listWorkbooks('project-1', 'draft-1')
  await api.getWorkbook('project-1', 'draft-1', 'wb-0123456789ab')
  await api.removeWorkbook('project-1', 'draft-1', 'wb-0123456789ab')
  await api.createTurn('project-1', 'draft-1', { message: '', kind: 'excel-analysis' })
  await api.createTurn('project-1', 'draft-1', { message: '__init__', kind: 'ui-design' })
  const root = '/api/v1/projects/project-1/application-drafts/draft-1'
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ['POST', `${root}/workbooks`], ['POST', `${root}/workbooks`], ['GET', `${root}/workbooks`],
    ['GET', `${root}/workbooks/wb-0123456789ab`], ['DELETE', `${root}/workbooks/wb-0123456789ab`],
    ['POST', `${root}/conversation-turns`], ['POST', `${root}/conversation-turns`],
  ])
  expect(await requests[0]!.json()).toEqual(workbook)
  // A retried upload of the same file reuses its key, so the server replays instead of adding twice.
  expect(requests.slice(0, 2).map((request) => request.headers.get('Idempotency-Key'))).toEqual(['file-key-1', 'file-key-1'])
  expect(await requests[5]!.json()).toEqual({ message: '', kind: 'excel-analysis' })
  expect(await requests[6]!.json()).toEqual({ message: '__init__', kind: 'ui-design' })
})

test('publish repair sends the branch-aware gateway body unchanged', async () => {
  const body = { applicationId: 'app-1', branchId: 'production', componentId: 'app-1-web', destination: { type: 'gateway' }, customDomain: 'project.test', hostnamePattern: 'wildcard' as const, subdomain: 'app-1', idempotencyKey: 'build-publish-draft-1-app-1' }
  await api.createPublish('project-1', body)
  expect(requests[0]!.method).toBe('POST')
  expect(new URL(requests[0]!.url).pathname).toBe('/api/v1/projects/project-1/publishes')
  expect(await requests[0]!.json()).toEqual(body)
  expect(requests[0]!.headers.get('Idempotency-Key')).toBe(body.idempotencyKey)
})

test('publish repair retries a real readiness response with the same HTTP idempotency key', async () => {
  const body = { applicationId: 'app-1', branchId: 'production', componentId: 'app-1-web', destination: { type: 'gateway' }, customDomain: 'project.test', hostnamePattern: 'wildcard' as const, subdomain: 'app-1', idempotencyKey: 'build-publish-draft-1-app-1' }
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    requests.push(input instanceof Request ? input : new Request(input))
    return requests.length === 1
      ? Response.json({ error: { code: 'app_installation_not_ready', message: 'external authorization app installation and its publish must be Ready' } }, { status: 409 })
      : Response.json({ id: 'publish-1' })
  }) as unknown as typeof fetch
  const error = await api.createPublish('project-1', body).catch((caught: unknown) => caught)
  expect(isPublishPreparationPending(error)).toBe(true)
  await api.createPublish('project-1', body)
  expect(requests.map((request) => request.headers.get('Idempotency-Key'))).toEqual([body.idempotencyKey, body.idempotencyKey])
})

test('reads do not mutate; executions are resolved from the authoritative draft', async () => {
  await api.listDrafts('project-1')
  await api.getDraft('project-1', 'draft-1')
  await api.getTurn('project-1', 'draft-1', 'turn-1')
  await api.getGeneration('project-1', 'draft-1', 'gen-1')
  expect(await api.getExecution('project-1', 'draft-1', 'exec-1')).toEqual(execution)
  await api.creationTools('project-1')
  await expect(api.getExecution('project-1', 'draft-1', 'missing')).rejects.toThrow('Creation execution not found: missing')
  expect(requests.every((request) => request.method === 'GET' && !request.headers.has('Idempotency-Key'))).toBe(true)
  expect(requests.map((request) => new URL(request.url).pathname.split('/application-drafts')[1])).toEqual([
    '', '/draft-1', '/draft-1/conversation-turns/turn-1', '/draft-1/creation-plan-generations/gen-1', '/draft-1', '/creation-tools', '/draft-1',
  ])
})

test('session query keys isolate projects, drafts and operation attempts; missing IDs disable fetching', () => {
  expect(buildKeys.turn('p1', 'd1', 't1').slice(0, 2)).toEqual(['build', 'd1'])
  expect(buildKeys.draft('p1', 'd1')).not.toEqual(buildKeys.draft('p2', 'd1'))
  expect(buildKeys.turn('p1', 'd1', 't1')).not.toEqual(buildKeys.turn('p1', 'd1', 't2'))
  expect(buildTurnOptions('p1', 'd1').queryFn).toBe(skipToken)
  expect(buildGenerationOptions('p1', 'd1').queryFn).toBe(skipToken)
  expect(buildExecutionOptions('p1', 'd1').queryFn).toBe(skipToken)
  expect(buildDraftOptions('', 'd1').queryFn).toBe(skipToken)
  expect(buildToolsOptions('p1').refetchInterval).toBe(false)
})

test('operation polling is 3 seconds only while pending/running, including lapsed leases', () => {
  const options = [buildTurnOptions('p1', 'd1', 't1'), buildGenerationOptions('p1', 'd1', 'g1'), buildExecutionOptions('p1', 'd1', 'e1')]
  for (const option of options) {
    if (typeof option.refetchInterval !== 'function') throw new Error('Polling callback missing')
    for (const status of ['pending', 'running', 'succeeded', 'failed']) {
      expect(option.refetchInterval({ state: { data: { status, runLeaseExpiresAt: startedAt } } } as never)).toBe(status === 'pending' || status === 'running' ? BUILD_POLL_MS : false)
    }
    expect(option.refetchInterval({ state: { data: undefined } } as never)).toBe(false)
  }
  const optionsForDraft = buildDraftOptions('p1', 'd1')
  if (typeof optionsForDraft.refetchInterval !== 'function') throw new Error('Draft polling callback missing')
  expect(optionsForDraft.refetchInterval({ state: { data: draft } } as never)).toBe(3000)
  expect(optionsForDraft.refetchInterval({ state: { data: { ...draft, creationExecutions: [] } } } as never)).toBe(false)
  expect(optionsForDraft.refetchInterval({ state: { data: { ...draft, creationExecutions: [], conversationTurns: [{ status: 'pending' }] } } } as never)).toBe(3000)
  const listOptions = draftsOptions('p1')
  if (typeof listOptions.refetchInterval !== 'function') throw new Error('Draft list polling callback missing')
  expect(listOptions.refetchInterval({ state: { data: { data: [draft] } } } as never)).toBe(3000)
})

test('implementation mutations use the run envelope and leave task execution to the server', async () => {
  const run = { id: 'impl-1', status: 'pending' as const, tasks: [], taskIds: [], devWorkspaceId: '', startedAt }
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    requests.push(input instanceof Request ? input : new Request(input))
    return Response.json({ run, resource: run, operation: { id: 'operation-1' } }, { status: 202 })
  }) as unknown as typeof fetch
  expect((await api.createImplementationRun('project-1', 'draft-1')).run).toEqual(run)
  await api.createImplementationRun('project-1', 'draft-1', { skipTaskIds: ['two'] })
  await api.cancelImplementationRun('project-1', 'draft-1', 'impl-1')
  await api.createImplementationRun('project-1', 'draft-1', { change: { taskId: 'one', message: '色を変えて' } })
  const root = '/api/v1/projects/project-1/application-drafts/draft-1/implementation-runs'
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ['POST', root], ['POST', root], ['POST', `${root}/impl-1/cancel`], ['POST', root],
  ])
  expect(await requests[0]!.text()).toBe('')
  expect(await requests[1]!.json()).toEqual({ skipTaskIds: ['two'] })
  expect(await requests[3]!.json()).toEqual({ change: { taskId: 'one', message: '色を変えて' } })
  expect(new Set(requests.map((request) => request.headers.get('Idempotency-Key'))).size).toBe(4)
})

test('draft and list poll implementation runs every three seconds until terminal', () => {
  for (const status of ['pending', 'running', 'succeeded', 'failed', 'cancelled']) {
    const value = { ...draft, creationExecutions: [], implementationRuns: [{ status, runLeaseExpiresAt: startedAt }] }
    for (const options of [buildDraftOptions('p1', 'd1'), draftsOptions('p1')]) {
      if (typeof options.refetchInterval !== 'function') throw new Error('Polling callback missing')
      const data = options.queryKey.includes('drafts') ? { data: [value] } : value
      expect(options.refetchInterval({ state: { data } } as never)).toBe(status === 'pending' || status === 'running' ? BUILD_POLL_MS : false)
    }
  }
})

test('draft and draft-list reads share the rollout retry policy', () => {
  for (const options of [buildDraftOptions('project-1', 'draft-1'), draftsOptions('project-1')]) {
    expect(options.retry).toBe(retryReadQuery)
    expect(options.retryDelay).toBe(readRetryDelay)
    // Same-key polling keeps cached data natively; never display a different draft/project.
    expect(options.placeholderData).toBeUndefined()
  }
})

test('draft GET stays loading through five coded 500s, then succeeds without a load error', async () => {
  let attempts = 0
  globalThis.fetch = mock(async () => {
    attempts++
    return attempts <= 5
      ? Response.json({ error: { code: 'internal_error', message: 'request canceled' } }, { status: 500 })
      : Response.json(draft)
  }) as unknown as typeof fetch
  const cache = new QueryClient()
  const observer = new QueryObserver(cache, { ...buildDraftOptions('project-1', 'draft-1'), retryDelay: 0, refetchInterval: false })
  const states: Array<{ pending: boolean; failed: boolean; failureCount: number }> = []
  const unsubscribe = observer.subscribe((result) => {
    states.push({ pending: result.isPending, failed: result.isLoadingError, failureCount: result.failureCount })
  })
  try {
    await observer.refetch()
    expect(attempts).toBe(6)
    expect(observer.getCurrentResult().data).toEqual(draft)
    expect(states.filter((state) => state.pending).map((state) => state.failureCount)).toEqual([0, 1, 2, 3, 4, 5])
    expect(states.some((state) => state.failed)).toBe(false)
  } finally {
    unsubscribe()
    cache.clear()
  }
})

test('draft GET only exposes a load error after the initial request and all five retries fail', async () => {
  const fetch = mock(async () => Response.json({ error: { code: 'internal_error', message: 'request canceled' } }, { status: 500 }))
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  const cache = new QueryClient()
  const observer = new QueryObserver(cache, { ...buildDraftOptions('project-1', 'draft-1'), retryDelay: 0, refetchInterval: false })
  const failures: number[] = []
  const unsubscribe = observer.subscribe((result) => {
    if (result.isLoadingError) failures.push(result.failureCount)
  })
  try {
    await observer.refetch()
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(failures).toEqual([6])
    expect(observer.getCurrentResult().data).toBeUndefined()
  } finally {
    unsubscribe()
    cache.clear()
  }
})

test('a failed draft poll retains the previous data without a load error, then receives recovery', async () => {
  const fetch = mock(async () => new Response('unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } }))
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  const cache = new QueryClient()
  const options = buildDraftOptions('project-1', 'draft-1')
  cache.setQueryData(options.queryKey, draft)
  const observer = new QueryObserver(cache, { ...options, retryDelay: 0, refetchInterval: false, refetchOnMount: false })
  const data: unknown[] = []
  const failures: boolean[] = []
  const unsubscribe = observer.subscribe((result) => {
    data.push(result.data)
    failures.push(result.isLoadingError)
  })
  try {
    await observer.refetch()
    expect(observer.getCurrentResult().error).toMatchObject({ status: 503 })
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(observer.getCurrentResult().isRefetchError).toBe(true)
    expect(data.every((value) => value === draft)).toBe(true)
    expect(failures.some(Boolean)).toBe(false)
    const recovered = { ...draft, title: '更新済み' }
    globalThis.fetch = mock(async () => Response.json(recovered)) as unknown as typeof globalThis.fetch
    await observer.refetch()
    expect(observer.getCurrentResult().data).toEqual(recovered)
    expect(observer.getCurrentResult().isSuccess).toBe(true)
  } finally {
    unsubscribe()
    cache.clear()
  }
})
