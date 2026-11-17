import { describe, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { QueryClient } from '@tanstack/react-query'
import { consoleKeys } from '../../api/queries/console'
import { keys } from '../../api/queries/shared'
import { deleteAppResources, DeletionWaitExpiredError, forgetDeletedApp, readsDeletedApp, SourceStillReferencedError, type AppDeletion, type AppDeletionDeps } from './mutations'

const notFound = () => new ORPCError('NOT_FOUND', { status: 404 })
const referenced = (stackIds: string[]) =>
  new ORPCError('CONFLICT', { status: 409, data: { body: { error: { code: 'conflict', message: 'referenced', details: { reason: 'referenced_by_stack', stackIds } } } } })

/** Fake Platform and clock: every send, wait and request timeout is recorded; `onWait` runs inside a wait. */
function deps(source: Array<() => unknown> = [], stack: () => unknown = () => ({}), onWait?: () => void) {
  const calls: string[] = []
  const keys: string[] = []
  const timeouts: number[] = []
  const waits: number[] = []
  let clock = 0
  let minted = 0
  const value: AppDeletionDeps = {
    deleteStack: async (_projectId, id, options) => {
      calls.push(`stack:${id}`)
      keys.push(options.idempotencyKey)
      return stack()
    },
    deleteSourceRepository: async (_projectId, id) => {
      calls.push(`source:${id}`)
      const next = source.length > 1 ? source.shift()! : source[0]
      return next ? next() : {}
    },
    removeApp: async (appId) => void calls.push(`console:${appId}`),
    wait: async (ms, signal) => {
      calls.push('wait')
      waits.push(ms)
      clock += ms
      onWait?.()
      signal.throwIfAborted()
    },
    now: () => clock,
    timeout: (ms) => {
      timeouts.push(ms)
      return new AbortController().signal
    },
    newKey: () => `key-${++minted}`,
  }
  return { value, calls, keys, timeouts, waits, advance: (ms: number) => { clock += ms } }
}

const deletion = (): AppDeletion => ({ appId: 'a-keihi', stackId: 'keihi', sourceRepositoryId: 'keihi-src' })
const run = (value: AppDeletionDeps, item = deletion(), signal = new AbortController().signal) => deleteAppResources('commerce', item, value, signal)

describe('deleteAppResources', () => {
  test('stack, then its source binding, then the console record', async () => {
    const { value, calls } = deps()
    await run(value)
    expect(calls).toEqual(['stack:keihi', 'source:keihi-src', 'console:a-keihi'])
  })

  test('already-deleted stack or binding (404) does not stop the delete', async () => {
    const { value, calls } = deps([() => { throw notFound() }], () => { throw notFound() })
    await run(value)
    expect(calls).toEqual(['stack:keihi', 'source:keihi-src', 'console:a-keihi'])
  })

  test('image apps and drafts have no binding to delete', async () => {
    const { value, calls } = deps()
    await run(value, { appId: 'a-nippo', stackId: 'nippo' })
    await run(value, { appId: 'a-draft' })
    expect(calls).toEqual(['stack:nippo', 'console:a-nippo', 'console:a-draft'])
  })

  test('waits while only the deleted stack still references the binding (GitOps prune)', async () => {
    const { value, calls } = deps([() => { throw referenced(['keihi']) }, () => { throw referenced(['keihi']) }, () => ({})])
    await run(value)
    expect(calls).toEqual(['stack:keihi', 'source:keihi-src', 'wait', 'source:keihi-src', 'wait', 'source:keihi-src', 'console:a-keihi'])
  })

  test('a binding another stack uses fails the delete and keeps the console record', async () => {
    const { value, calls } = deps([() => { throw referenced(['keihi', 'other']) }])
    await expect(run(value)).rejects.toBeInstanceOf(ORPCError)
    expect(calls).toEqual(['stack:keihi', 'source:keihi-src'])
  })

  test('a binding still referenced after the wait asks for a retry, which goes on from the binding', async () => {
    const stuck = deps([() => { throw referenced(['keihi']) }])
    const progress = deletion()
    await expect(run(stuck.value, progress)).rejects.toBeInstanceOf(SourceStillReferencedError)
    expect(stuck.calls).not.toContain('console:a-keihi')
    expect(progress.stackDeleted).toBe(true)
    // No send after the binding's time ran out: the last wait ended before it.
    expect(stuck.waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(120_000)

    const retry = deps()
    await run(retry.value, progress)
    expect(retry.calls).toEqual(['source:keihi-src', 'console:a-keihi'])
  })

  // APT-1234: Platform's typed answers to the stack delete (platform-api application.go / writer_application_stack_selection.go).
  const dependentsDeleting = (retryAfterSeconds?: number) => new ORPCError('CONFLICT', { status: 409, data: { body: { error: {
    code: 'conflict', message: 'application "keihi" is waiting for dependents to finish deleting: devws-1',
    details: { reason: 'dependents_deleting', dependents: [{ kind: 'DevWorkspace', id: 'devws-1', name: '経費精算' }], ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
  } } } })
  const activeDelivery = () => new ORPCError('PRECONDITION_FAILED', { status: 412, data: { body: { error: {
    code: 'failed_precondition', message: 'application branch still has active delivery consumers',
    details: { reason: 'branch_has_active_delivery', activeConsumers: [{ kind: 'DevWorkspace', count: 2 }] },
  } } } })

  test('a stack delete waiting for what Platform is already removing is sent again after its retry time with the same key, then goes on', async () => {
    let answers = [() => { throw dependentsDeleting(5) }, () => { throw dependentsDeleting() }, () => ({})]
    const { value, calls, keys, waits } = deps([], () => { const [next, ...rest] = answers; answers = rest; return next!() })
    await run(value)
    expect(calls).toEqual(['stack:keihi', 'wait', 'stack:keihi', 'wait', 'stack:keihi', 'source:keihi-src', 'console:a-keihi'])
    expect(waits).toEqual([5_000, 5_000])
    // One deletion, one Idempotency-Key for every send of its stack delete; the next deletion has its own.
    expect(keys).toEqual(['key-1', 'key-1', 'key-1'])
    answers = [() => ({})]
    await run(value, { appId: 'a-nippo', stackId: 'nippo' })
    expect(keys.at(-1)).toBe('key-2')
  })

  test('the stack delete ends at its deadline: each send is cut off there, no wait reaches past it, nothing is sent after it', async () => {
    const waiting = deps([], () => { throw dependentsDeleting(30) })
    const progress = deletion()
    const failure = await run(waiting.value, progress).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DeletionWaitExpiredError)
    // Sends at 0, 30, 60 and 90 s; a fifth would wait until 120 s, the deadline itself.
    expect(waiting.calls.filter((call) => call === 'stack:keihi')).toHaveLength(4)
    expect(waiting.timeouts).toEqual([120_000, 90_000, 60_000, 30_000])
    expect(waiting.waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(120_000)
    expect(waiting.calls).not.toContain('source:keihi-src')
    expect(progress.stackDeleted).toBeUndefined()

    // A send whose answer outlasts the deadline is cut off and ends the deletion.
    const slow = deps()
    const cutoff = new AbortController()
    slow.value.timeout = (ms) => { slow.timeouts.push(ms); return cutoff.signal }
    slow.value.deleteStack = async () => { slow.advance(120_000); cutoff.abort(); throw new DOMException('timed out', 'TimeoutError') }
    await expect(run(slow.value)).rejects.toBeInstanceOf(DeletionWaitExpiredError)
    expect(slow.calls).toEqual([])

    const blocked = deps([], () => { throw activeDelivery() })
    await expect(run(blocked.value)).rejects.toBeInstanceOf(ORPCError)
    expect(blocked.calls).toEqual(['stack:keihi'])
  })

  test('aborting the deletion during a wait sends nothing more', async () => {
    const controller = new AbortController()
    const { value, calls } = deps([], () => { throw dependentsDeleting(5) }, () => controller.abort())
    await expect(run(value, deletion(), controller.signal)).rejects.toBeDefined()
    expect(calls).toEqual(['stack:keihi', 'wait'])

    // Aborted while the stack delete was answering: no binding, no console record.
    const later = new AbortController()
    const answered = deps()
    answered.value.deleteStack = async () => { answered.calls.push('stack:keihi'); later.abort() }
    await expect(run(answered.value, deletion(), later.signal)).rejects.toBeDefined()
    expect(answered.calls).toEqual(['stack:keihi'])
  })
})

describe('forgetDeletedApp', () => {
  const deleted = { appId: 'a-keihi', applicationId: 'keihi', stackId: 'keihi', webComponentId: 'keihi-web' }

  test('takes the app out of every cached list and leaves the others', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(keys.applications('commerce'), [{ id: 'keihi' }, { id: 'nippo' }])
    queryClient.setQueryData(keys.stacks('commerce'), { data: [{ id: 'keihi' }, { id: 'nippo' }], unreadable: [{ id: 'bad' }] })
    queryClient.setQueryData(consoleKeys.apps({ scope: 'mine' }), [{ id: 'a-keihi' }, { id: 'a-nippo' }])
    await forgetDeletedApp(queryClient, 'commerce', deleted)
    expect(queryClient.getQueryData<unknown>(keys.applications('commerce'))).toEqual([{ id: 'nippo' }])
    expect(queryClient.getQueryData<unknown>(keys.stacks('commerce'))).toEqual({ data: [{ id: 'nippo' }], unreadable: [{ id: 'bad' }] })
    expect(queryClient.getQueryData<unknown>(consoleKeys.apps({ scope: 'mine' }))).toEqual([{ id: 'a-nippo' }])
  })

  test('cancels the deleted app\'s in-flight reads only', async () => {
    const queryClient = new QueryClient()
    const signals: Record<string, AbortSignal> = {}
    const hang = (name: string) => ({ signal }: { signal: AbortSignal }) => {
      signals[name] = signal
      return new Promise(() => {})
    }
    void queryClient.fetchQuery({ queryKey: keys.releases('commerce', 'keihi', 'production'), queryFn: hang('keihi') }).catch(() => {})
    void queryClient.fetchQuery({ queryKey: keys.releases('commerce', 'nippo', 'production'), queryFn: hang('nippo') }).catch(() => {})
    await forgetDeletedApp(queryClient, 'commerce', deleted)
    expect(signals.keihi?.aborted).toBe(true)
    expect(signals.nippo?.aborted).toBe(false)
  })

  test('matches reads of the deleted app, never project lists or other apps', () => {
    const reads = (queryKey: readonly unknown[]) => readsDeletedApp({ queryKey }, 'commerce', deleted)
    expect(reads(consoleKeys.app('a-keihi'))).toBe(true)
    expect(reads(consoleKeys.appTools('a-keihi'))).toBe(true)
    expect(reads(keys.releases('commerce', 'keihi', 'production'))).toBe(true)
    expect(reads(keys.releaseState('commerce', 'keihi', 'production', 'keihi-web'))).toBe(true)
    expect(reads(keys.logs('commerce', 'keihi-web', 'production'))).toBe(true)
    expect(reads(consoleKeys.app('a-nippo'))).toBe(false)
    expect(reads(keys.releases('commerce', 'nippo', 'production'))).toBe(false)
    expect(reads(keys.applications('commerce'))).toBe(false)
    expect(reads(consoleKeys.apps({ scope: 'mine' }))).toBe(false)
  })
})

describe('cache writes after a delete', () => {
  test('a list read that started before the delete cannot put the deleted app back', async () => {
    const deleted = { appId: 'a-keihi', applicationId: 'keihi', stackId: 'keihi' }
    const queryClient = new QueryClient()
    queryClient.setQueryData(keys.stacks('commerce'), { data: [{ id: 'keihi' }, { id: 'nippo' }], unreadable: [] })
    const { promise, resolve: resolveRead } = Promise.withResolvers<{ data: { id: string }[]; unreadable: [] }>()
    const read = queryClient.fetchQuery({ queryKey: keys.stacks('commerce'), queryFn: () => promise, staleTime: 0 }).catch(() => {})
    await forgetDeletedApp(queryClient, 'commerce', deleted)
    resolveRead({ data: [{ id: 'keihi' }, { id: 'nippo' }], unreadable: [] })
    await read
    expect(queryClient.getQueryData<unknown>(keys.stacks('commerce'))).toEqual({ data: [{ id: 'nippo' }], unreadable: [] })
  })
})
