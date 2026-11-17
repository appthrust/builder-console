// APT-1234: a deletion Platform refused is said in the user's words, never with Platform's message.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { preserveLanguage } from '../../../test/language'
import { ResponseContractError } from '../../api/boundary'
import { copy } from '../../copy'
import { setLanguage } from '../../shell/language'
import { deletionRefusal } from './delete-dialog'
import { DeletionWaitExpiredError } from './mutations'

let restoreLanguage: () => void
beforeEach(() => { restoreLanguage = preserveLanguage() })
afterEach(() => restoreLanguage())

const MESSAGE = 'application branch still has active delivery consumers'
const platform = (status: number, code: string, details?: Record<string, unknown>) =>
  new ORPCError('UNKNOWN', { status, data: { body: { error: { code, message: MESSAGE, ...(details ? { details } : {}) } } } })
const activeDelivery = (activeConsumers: unknown) => platform(412, 'failed_precondition', { reason: 'branch_has_active_delivery', activeConsumers, nextActions: ['Stop or delete the listed delivery consumers, then retry the Application Branch deletion.'] })
const said = (error: unknown) => {
  const refusal = deletionRefusal(error)
  return refusal ? [refusal.title, ...refusal.lines].join(' ') : ''
}

test.each(['ja', 'en'] as const)('remaining work areas are named and counted, with who can clear them, in %s', (language) => {
  setLanguage(language)
  const words = copy.app.settings.deleteRefused
  expect(deletionRefusal(activeDelivery([{ kind: 'DevWorkspace', count: 2 }]))).toEqual({ title: words.inUse, lines: [words.workAreas(2), words.workAreasNext] })
  expect(deletionRefusal(activeDelivery([{ kind: 'DevWorkspace', count: 1 }, { kind: 'Release', count: 1 }]))).toEqual({ title: words.inUse, lines: [words.workAreas(1), words.others, words.workAreasNext] })
  // Something else, or nothing listed: no count, and to try again shortly.
  for (const consumers of [[{ kind: 'Release', count: 1 }], undefined, 'unreadable']) {
    expect(deletionRefusal(activeDelivery(consumers))).toEqual({ title: words.inUse, lines: [words.others, words.othersNext] })
  }
  for (const consumers of [[{ kind: 'DevWorkspace', count: 2 }], [{ kind: 'HTTPPublish', count: 1 }]]) {
    for (const hidden of [MESSAGE, 'DevWorkspace', 'HTTPPublish', 'delivery', 'workspace', 'branch_has_active_delivery', copy.common.actionFailed]) expect(said(activeDelivery(consumers))).not.toContain(hidden)
  }
})

test.each(['ja', 'en'] as const)('a wait that outlasted the deletion says what is being cleared and to try again, in %s', (language) => {
  setLanguage(language)
  const words = copy.app.settings.deleteRefused
  const deleting = (dependents: unknown) => platform(409, 'conflict', { reason: 'dependents_deleting', retryAfterSeconds: 5, dependents })
  expect(deletionRefusal(deleting([{ kind: 'DevWorkspace', id: 'devws-1', name: '経費精算' }, { kind: 'DevWorkspace', id: 'devws-2', name: '経費精算' }]))).toEqual({ title: words.waiting, lines: [words.waitingWorkAreas(2), words.waitingNext] })
  expect(deletionRefusal(deleting([{ kind: 'Component', id: 'db', name: 'db' }]))).toEqual({ title: words.waiting, lines: [words.waitingOthers, words.waitingNext] })
  expect(deletionRefusal(platform(409, 'idempotency_in_progress', { reason: 'idempotency_in_progress', retryable: true }))).toEqual({ title: words.waiting, lines: [words.waitingOthers, words.waitingNext] })
  expect(said(deleting([{ kind: 'DevWorkspace', id: 'devws-1', name: '経費精算' }]))).not.toContain('devws-1')
  // The deletion's own time ran out: Platform's last answer names what is being cleared; without one, the general words.
  expect(deletionRefusal(new DeletionWaitExpiredError(deleting([{ kind: 'DevWorkspace', id: 'devws-1', name: '経費精算' }])))).toEqual({ title: words.waiting, lines: [words.waitingWorkAreas(1), words.waitingNext] })
  expect(deletionRefusal(new DeletionWaitExpiredError())).toEqual({ title: words.waiting, lines: [words.waitingOthers, words.waitingNext] })
})

test('any other Platform refusal says it was not deleted without Platform\'s message; what ActionError owns is left to it', () => {
  setLanguage('ja')
  const words = copy.app.settings.deleteRefused
  expect(deletionRefusal(platform(409, 'conflict'))).toEqual({ title: words.failed, lines: [words.failedNext] })
  expect(deletionRefusal(platform(403, 'forbidden'))).toEqual({ title: words.failed, lines: [copy.errors.forbidden] })
  expect(said(platform(500, 'internal'))).not.toContain(MESSAGE)
  expect(deletionRefusal(new ORPCError('UNAUTHORIZED', { status: 401 }))).toBeUndefined()
  expect(deletionRefusal(new ResponseContractError({ source: 'platform', operationId: 'platformApiDeleteApplicationStack', method: 'DELETE', routeTemplate: '/application-stacks/{id}', issues: [{ path: '/', code: 'missing' }] }))).toBeUndefined()
  expect(deletionRefusal(new Error(MESSAGE))).toBeUndefined()
  expect(deletionRefusal(null)).toBeUndefined()
})
