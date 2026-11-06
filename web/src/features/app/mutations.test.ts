import { describe, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { deleteAppResources, SourceStillReferencedError, type AppDeletion, type AppDeletionDeps } from './mutations'

const notFound = () => new ORPCError('NOT_FOUND', { status: 404 })
const referenced = (stackIds: string[]) =>
  new ORPCError('CONFLICT', { status: 409, data: { body: { error: { code: 'conflict', message: 'referenced', details: { reason: 'referenced_by_stack', stackIds } } } } })

function deps(source: Array<() => unknown> = [], stack: () => unknown = () => ({})) {
  const calls: string[] = []
  let clock = 0
  const value: AppDeletionDeps = {
    platform: {
      platformApiDeleteApplicationStack: (async (input: { params: { id: string } }) => {
        calls.push(`stack:${input.params.id}`)
        return stack()
      }) as never,
      platformApiDeleteApplicationSourceRepository: (async (input: { params: { id: string } }) => {
        calls.push(`source:${input.params.id}`)
        const next = source.length > 1 ? source.shift()! : source[0]
        return next ? next() : {}
      }) as never,
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
})
