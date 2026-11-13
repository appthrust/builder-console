import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { isResponseContractError, ResponseContractError, type ContractFailureReport } from './boundary'
import { ConsoleApiError, isConsoleError } from './console'
import { listCommentsContract, postCommentContract, removeCommentContract } from './contracts/console/comments'
import { getApplicationDraftContract } from './contracts/platform/build'
import { isTransientError } from './platform-error'
import { buildDraftOptions } from './queries/build'
import { retryQuery, retryReadQuery } from './queries/shared'
import { isSessionExpiredError, sessionExpiryStore } from './session-expiry'
import { createTestGateway } from './testing/gateway'
import { assertWireContractCases } from './testing/wire-contract-cases'

const SECRET = 'SENTINEL-c0ffee-secret-payload'
const at = '2026-11-13T00:00:00Z'
/** A draft as Platform marshals it before any execution: `creationExecutions` omitted (APT-748). */
const wireDraft = { id: 'draft-1', projectId: 'project-1', title: '見積', intent: '見積を作る', phase: 'planned', specMarkdown: '', architectureMarkdown: '', ownerUserId: 'owner-1', createdAt: at, updatedAt: at }
const execution = { id: 'exec-1', attempt: 1, status: 'running', startedAt: at, steps: [{ id: 'step-1', tool: 'appthrust.applicationStack.create', status: 'running' }] }

const draftJson = (body: unknown, status = 200) => () => Response.json(body, { status })

describe('Platform reference vertical: ApplicationDraft read', () => {
  test('wire variants of the draft contract', () => {
    assertWireContractCases(getApplicationDraftContract, [
      { name: 'APT-748: creationExecutions omitted reads as []', variant: 'absent', path: '/creationExecutions', wire: wireDraft, expect: { accept: true, check: (draft) => expect(draft.creationExecutions).toEqual([]) } },
      { name: 'creationExecutions null is a failure, not empty', variant: 'null', path: '/creationExecutions', wire: { ...wireDraft, creationExecutions: null }, expect: { accept: false, issues: [{ path: '/creationExecutions', code: 'invalid_type' }] } },
      { name: 'creationExecutions empty', variant: 'empty', path: '/creationExecutions', wire: { ...wireDraft, creationExecutions: [] }, expect: { accept: true, check: (draft) => expect(draft.creationExecutions).toEqual([]) } },
      { name: 'creationExecutions present', variant: 'present', path: '/creationExecutions', wire: { ...wireDraft, creationExecutions: [execution] }, expect: { accept: true, check: (draft) => expect(draft.creationExecutions[0]?.steps[0]?.status).toBe('running') } },
      { name: 'an execution without steps cannot be guessed', variant: 'absent', path: '/creationExecutions', wire: { ...wireDraft, creationExecutions: [{ ...execution, steps: undefined }] }, expect: { accept: false, issues: [{ path: '/creationExecutions/*/steps', code: 'missing' }] } },
      { name: 'other optional collections stay optional', variant: 'absent', path: '/conversationTurns', wire: wireDraft, expect: { accept: true, check: (draft) => expect(draft.conversationTurns).toBeUndefined() } },
      { name: 'unknown field is dropped', variant: 'unknown', path: '/', wire: { ...wireDraft, reviewers: [{ email: SECRET }] }, expect: { accept: true, check: (draft) => expect(draft).not.toHaveProperty('reviewers') } },
      { name: 'unknown phase is a failure while draft enums are closed', variant: 'unknown', path: '/phase', wire: { ...wireDraft, phase: SECRET }, expect: { accept: false, issues: [{ path: '/phase', code: 'invalid_value' }] } },
      { name: 'unknown execution status is a failure while draft enums are closed', variant: 'unknown', path: '/creationExecutions', wire: { ...wireDraft, creationExecutions: [{ ...execution, status: SECRET }] }, expect: { accept: false, issues: [{ path: '/creationExecutions/*/status', code: 'invalid_value' }] } },
      { name: 'required id absent', variant: 'absent', path: '/id', wire: { ...wireDraft, id: undefined }, expect: { accept: false, issues: [{ path: '/id', code: 'missing' }] } },
      { name: 'required title broken', variant: 'unknown', path: '/title', wire: { ...wireDraft, title: { text: SECRET } }, expect: { accept: false, issues: [{ path: '/title', code: 'invalid_type' }] } },
    ])
  })

  test('the gateway returns the domain draft through the real OpenAPILink', async () => {
    const gateway = createTestGateway({ platformFetch: async () => draftJson(wireDraft)() })
    const draft = await gateway.platform(getApplicationDraftContract, { projectId: 'project-1', id: 'draft-1' })
    expect(draft.creationExecutions).toEqual([])
    expect(draft.phase).toBe('planned')
  })

  test('success status, body format and parse failures are typed contract failures, reported once with safe metadata', async () => {
    const reports: ContractFailureReport[] = []
    const answers: Array<() => Response> = [
      draftJson({ ...wireDraft, phase: SECRET }),
      draftJson(wireDraft, 202),
      () => new Response(`{"id": "${SECRET}"`, { headers: { 'Content-Type': 'application/json' } }),
    ]
    const gateway = createTestGateway({ platformFetch: async () => answers.shift()!(), reportFailure: (report) => reports.push(report) })
    const read = () => gateway.platform(getApplicationDraftContract, { projectId: 'project-1', id: 'draft-1' }).catch((caught: unknown) => caught)
    const errors = [await read(), await read(), await read()]
    for (const error of errors) expect(error).toBeInstanceOf(ResponseContractError)
    expect(errors.map((error) => (error as ResponseContractError).issues)).toEqual([
      [{ path: '/phase', code: 'invalid_value' }],
      [{ path: '/', code: 'unexpected_status' }],
      [{ path: '/', code: 'invalid_json' }],
    ])
    expect(reports).toHaveLength(3)
    expect(reports[0]).toEqual({
      code: 'response_contract_invalid', source: 'platform', operationId: 'platformApiGetApplicationDraft', method: 'GET',
      routeTemplate: '/api/v1/projects/{projectId}/application-drafts/{id}', issues: [{ path: '/phase', code: 'invalid_value' }], outcome: 'read_failed',
    })
    expect(JSON.stringify(reports)).not.toContain(SECRET)
    expect(JSON.stringify(reports)).not.toContain('draft-1')
    for (const error of errors) expect(`${(error as Error).message}${(error as Error).stack}`).not.toContain(SECRET)
  })

  test('HTTP failures keep their existing classification; contract failures are neither transient, session nor console errors', async () => {
    const gateway = createTestGateway({ platformFetch: async () => new Response('upstream connect error', { status: 503, headers: { 'Content-Type': 'text/plain' } }) })
    const unavailable = await gateway.platform(getApplicationDraftContract, { projectId: 'p', id: 'd' }).catch((caught: unknown) => caught)
    expect(unavailable).toBeInstanceOf(ORPCError)
    expect(isTransientError(unavailable)).toBe(true)

    const contract = new ResponseContractError({ source: 'platform', operationId: 'x', method: 'GET', routeTemplate: '/x', issues: [{ path: '/', code: 'missing' }] })
    expect([isTransientError(contract), isSessionExpiredError(contract), isConsoleError(contract)]).toEqual([false, false, false])
    expect([retryQuery(0, contract), retryReadQuery(0, contract)]).toEqual([false, false])
  })

  test('an expired session stays a session failure, never a contract failure', async () => {
    try {
      const reports: unknown[] = []
      const gateway = createTestGateway({ platformFetch: async () => new Response(null, { status: 302, headers: { location: 'https://iam.example.test' } }), reportFailure: (report) => reports.push(report) })
      const error = await gateway.platform(getApplicationDraftContract, { projectId: 'p', id: 'd' }).catch((caught: unknown) => caught)
      expect(isSessionExpiredError(error)).toBe(true)
      expect(isResponseContractError(error)).toBe(false)
      expect(reports).toEqual([])
    } finally {
      sessionExpiryStore.setState(() => false)
    }
  })
})

describe('draft query: malformed 200 on the poll (X3)', () => {
  const originalFetch = globalThis.fetch
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://console.test' } } })
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })

  const running = { ...wireDraft, creationExecutions: [execution] }

  test('an initial malformed answer is the query error state, with no retries', async () => {
    const fetch = mock(async () => Response.json({ ...running, creationExecutions: [{ ...execution, steps: SECRET }] }))
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const cache = new QueryClient()
    const observer = new QueryObserver(cache, { ...buildDraftOptions('project-1', 'draft-1'), retryDelay: 0, refetchInterval: false })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await observer.refetch()
      const result = observer.getCurrentResult()
      expect(result.isLoadingError).toBe(true)
      expect(result.data).toBeUndefined()
      expect(result.error).toBeInstanceOf(ResponseContractError)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET)
    } finally {
      unsubscribe()
      cache.clear()
      warn.mockRestore()
    }
  })

  test('good → malformed tick → recovery keeps the cached draft identical, then updates it', async () => {
    const answers = [Response.json(running), Response.json({ ...running, title: { leaked: SECRET } }), Response.json({ ...running, title: '更新済み' })]
    const fetch = mock(async () => answers.shift()!)
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const cache = new QueryClient()
    const options = buildDraftOptions('project-1', 'draft-1')
    const observer = new QueryObserver(cache, { ...options, retryDelay: 0, refetchInterval: false })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await observer.refetch()
      const good = observer.getCurrentResult()
      expect(good.data?.title).toBe('見積')
      expect(good.data?.creationExecutions).toHaveLength(1)

      await observer.refetch()
      const stale = observer.getCurrentResult()
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(stale.isRefetchError).toBe(true)
      expect(stale.error).toBeInstanceOf(ResponseContractError)
      expect(stale.data).toBe(good.data)
      expect(stale.dataUpdatedAt).toBe(good.dataUpdatedAt)
      expect(Object.is(cache.getQueryData(options.queryKey), good.data)).toBe(true)
      // The poll keeps its normal cadence from the last good draft (still running): no stop, no burst.
      if (typeof options.refetchInterval !== 'function') throw new Error('Draft polling callback missing')
      expect(options.refetchInterval(cache.getQueryCache().find({ queryKey: options.queryKey })! as never)).toBe(3000)
      expect(JSON.stringify(stale.error)).not.toContain(SECRET)
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET)

      await observer.refetch()
      const recovered = observer.getCurrentResult()
      expect(recovered.isSuccess).toBe(true)
      expect(recovered.data?.title).toBe('更新済み')
      expect(recovered.dataUpdatedAt).toBeGreaterThanOrEqual(good.dataUpdatedAt)
    } finally {
      unsubscribe()
      cache.clear()
      warn.mockRestore()
    }
  })
})

describe('Console reference vertical: comments', () => {
  const author = { id: 'p-1', subject: 'sub-1', pending: false, email: 'yamada@example.test', displayName: '山田', avatarVersion: null }
  const comment = { id: 'c-1', appId: 'app-1', author, body: '使ってみました', createdAt: at }

  test('wire variants of the comment list, including the unknown-person variant', () => {
    assertWireContractCases(listCommentsContract, [
      { name: 'empty list', variant: 'empty', path: '/', wire: [], expect: { accept: true, value: [] } },
      { name: 'one comment', variant: 'present', path: '/', wire: [comment], expect: { accept: true, value: [comment] } },
      { name: 'list null', variant: 'null', path: '/', wire: null, expect: { accept: false, issues: [{ path: '/', code: 'invalid_type' }] } },
      {
        name: 'removed author is the explicit unknown variant, nothing invented',
        variant: 'unknown',
        path: '/*/author',
        wire: [{ ...comment, author: { id: 'p-gone', displayName: '', unknown: true } }],
        expect: { accept: true, value: [{ ...comment, author: { unknown: true, id: 'p-gone' } }] },
      },
      { name: 'unknown author without id', variant: 'absent', path: '/*/author/id', wire: [{ ...comment, author: { unknown: true } }], expect: { accept: false, issues: [{ path: '/*/author/id', code: 'missing' }] } },
      { name: 'known author without email is broken, not unknown', variant: 'absent', path: '/*/author/email', wire: [{ ...comment, author: { ...author, email: undefined } }], expect: { accept: false, issues: [{ path: '/*/author/email', code: 'missing' }] } },
      { name: 'author null', variant: 'null', path: '/*/author', wire: [{ ...comment, author: null }], expect: { accept: false } },
      { name: 'body null', variant: 'null', path: '/*/body', wire: [{ ...comment, body: null }], expect: { accept: false, issues: [{ path: '/*/body', code: 'invalid_type' }] } },
      { name: 'unknown fields are dropped', variant: 'unknown', path: '/*', wire: [{ ...comment, reactions: { [SECRET]: 1 }, author: { ...author, title: SECRET } }], expect: { accept: true, value: [comment] } },
      { name: 'a broken item fails the list instead of disappearing', variant: 'unknown', path: '/*/id', wire: [comment, { ...comment, id: 7 }], expect: { accept: false, issues: [{ path: '/*/id', code: 'invalid_type' }] } },
    ])
  })

  test('console transport: status, body format, 204 and error envelopes', async () => {
    const reports: ContractFailureReport[] = []
    const answers: Response[] = [
      Response.json(comment, { status: 200 }),
      new Response('<not json', { status: 201, headers: { 'Content-Type': 'application/json' } }),
      new Response(null, { status: 201 }),
      Response.json(comment, { status: 201 }),
      new Response(null, { status: 204 }),
      Response.json({}, { status: 200 }),
      Response.json({ error: 123, message: 'refused' }, { status: 403 }),
      new Response('gateway', { status: 404 }),
    ]
    const gateway = createTestGateway({ consoleFetch: async () => answers.shift()!, reportFailure: (report) => reports.push(report) })
    const post = () => gateway.console(postCommentContract, { appId: 'app-1', body: 'x' }).catch((caught: unknown) => caught)
    const remove = () => gateway.console(removeCommentContract, { appId: 'app-1', commentId: 'c-1' }).catch((caught: unknown) => caught)
    expect(await post()).toMatchObject({ issues: [{ path: '/', code: 'unexpected_status' }], outcome: 'write_unconfirmed' })
    expect(await post()).toMatchObject({ issues: [{ path: '/', code: 'invalid_json' }] })
    expect(await post()).toMatchObject({ issues: [{ path: '/', code: 'missing' }] })
    expect(await post()).toEqual(comment)
    expect(await remove()).toBeUndefined()
    expect(await remove()).toMatchObject({ issues: [{ path: '/', code: 'unexpected_status' }] })
    const forbidden = await remove()
    expect(forbidden).toBeInstanceOf(ConsoleApiError)
    expect(forbidden).toMatchObject({ status: 403, code: 'unknown', message: 'refused' })
    expect(await remove()).toMatchObject({ status: 404, code: 'not_found' })
    expect(reports.map((report) => report.operationId)).toEqual(['consolePostAppComment', 'consolePostAppComment', 'consolePostAppComment', 'consoleDeleteAppComment'])
  })
})
