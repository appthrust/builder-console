import { describe, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { QueryClient } from '@tanstack/react-query'
import { consoleKeys } from '../../api/queries/console'
import { keys } from '../../api/queries/shared'
import { deleteAppResources, forgetDeletedApp, readsDeletedApp, SourceStillReferencedError, type AppDeletion, type AppDeletionDeps } from './mutations'

const notFound = () => new ORPCError('NOT_FOUND', { status: 404 })
const referenced = (stackIds: string[]) =>
  new ORPCError('CONFLICT', { status: 409, data: { body: { error: { code: 'conflict', message: 'referenced', details: { reason: 'referenced_by_stack', stackIds } } } } })

function deps(source: Array<() => unknown> = [], stack: () => unknown = () => ({})) {
  const calls: string[] = []
  let clock = 0
  const value: AppDeletionDeps = {
    deleteStack: async (_projectId, id) => {
      calls.push(`stack:${id}`)
      return stack()
    },
    deleteSourceRepository: async (_projectId, id) => {
      calls.push(`source:${id}`)
      const next = source.length > 1 ? source.shift()! : source[0]
      return next ? next() : {}
    },
    removeApp: async (appId) => void calls.push(`console:${appId}`),
    wait: async (ms) => {
      calls.push('wait')
      clock += ms
    },
    now: () => clock,
  }
  return { value, calls }
}

const deletion = (): AppDeletion => ({ appId: 'a-keihi', stackId: 'keihi', sourceRepositoryId: 'keihi-src' })

describe('deleteAppResources', () => {
  test('stack, then its source binding, then the console record', async () => {
    const { value, calls } = deps()
    await deleteAppResources('commerce', deletion(), value)
    expect(calls).toEqual(['stack:keihi', 'source:keihi-src', 'console:a-keihi'])
  })

  test('already-deleted stack or binding (404) does not stop the delete', async () => {
    const { value, calls } = deps([() => { throw notFound() }], () => { throw notFound() })
    await deleteAppResources('commerce', deletion(), value)
    expect(calls).toEqual(['stack:keihi', 'source:keihi-src', 'console:a-keihi'])
  })

  test('image apps and drafts have no binding to delete', async () => {
    const { value, calls } = deps()
    await deleteAppResources('commerce', { appId: 'a-nippo', stackId: 'nippo' }, value)
    await deleteAppResources('commerce', { appId: 'a-draft' }, value)
    expect(calls).toEqual(['stack:nippo', 'console:a-nippo', 'console:a-draft'])
  })

  test('waits while only the deleted stack still references the binding (GitOps prune)', async () => {
    const { value, calls } = deps([() => { throw referenced(['keihi']) }, () => { throw referenced(['keihi']) }, () => ({})])
    await deleteAppResources('commerce', deletion(), value)
    expect(calls).toEqual(['stack:keihi', 'source:keihi-src', 'wait', 'source:keihi-src', 'wait', 'source:keihi-src', 'console:a-keihi'])
  })

  test('a binding another stack uses fails the delete and keeps the console record', async () => {
    const { value, calls } = deps([() => { throw referenced(['keihi', 'other']) }])
    await expect(deleteAppResources('commerce', deletion(), value)).rejects.toBeInstanceOf(ORPCError)
    expect(calls).toEqual(['stack:keihi', 'source:keihi-src'])
  })

  test('a binding still referenced after the wait asks for a retry, which goes on from the binding', async () => {
    const stuck = deps([() => { throw referenced(['keihi']) }])
    const progress = deletion()
    await expect(deleteAppResources('commerce', progress, stuck.value)).rejects.toBeInstanceOf(SourceStillReferencedError)
    expect(stuck.calls).not.toContain('console:a-keihi')
    expect(progress.stackDeleted).toBe(true)

    const retry = deps()
    await deleteAppResources('commerce', progress, retry.value)
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

  test('a stack delete waiting for what Platform is already removing is sent again after its retry time, then goes on', async () => {
    let answers = [() => { throw dependentsDeleting(5) }, () => { throw dependentsDeleting() }, () => ({})]
    const { value, calls } = deps([], () => { const [next, ...rest] = answers; answers = rest; return next!() })
    const waits: number[] = []
    const wait = value.wait!
    value.wait = async (ms) => { waits.push(ms); await wait(ms) }
    await deleteAppResources('commerce', deletion(), value)
    expect(calls).toEqual(['stack:keihi', 'wait', 'stack:keihi', 'wait', 'stack:keihi', 'source:keihi-src', 'console:a-keihi'])
    expect(waits).toEqual([5_000, 5_000])
  })

  test('a stack delete still waiting after the bound fails with Platform\'s answer; a running blocker is never waited for', async () => {
    const waiting = deps([], () => { throw dependentsDeleting(5) })
    const progress = deletion()
    await expect(deleteAppResources('commerce', progress, waiting.value)).rejects.toBeInstanceOf(ORPCError)
    expect(waiting.calls.filter((call) => call === 'wait').length).toBeGreaterThan(0)
    expect(waiting.calls).not.toContain('source:keihi-src')
    expect(progress.stackDeleted).toBeUndefined()

    const blocked = deps([], () => { throw activeDelivery() })
    await expect(deleteAppResources('commerce', deletion(), blocked.value)).rejects.toBeInstanceOf(ORPCError)
    expect(blocked.calls).toEqual(['stack:keihi'])
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
