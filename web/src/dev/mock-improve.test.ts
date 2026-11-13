import { expect, test } from 'bun:test'
import { draftOf, readFirst } from '../api/testing/build-domain'
import { deriveImprove as deriveDomain } from '../model/improve'
import { platformRoutes } from './mock-platform'

/** The mock answers wire drafts; the page derives from what the draft reader makes of them. */
const deriveImprove = readFirst(draftOf, deriveDomain)
const project = '/api/v1/projects/commerce'
async function call(method: string, path: string, body?: unknown) {
  const url = new URL(path, 'http://mock.test')
  const response = await platformRoutes(new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), url)
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  return { status: response.status, body: await response.json() }
}

test('improvement drafts are born bound to an app with a source and refused otherwise', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const created = await call('POST', `${project}/application-drafts`, { kind: 'improvement', applicationStackId: 'mitsumori', intent: '一覧に絞り込みを足したい', title: '見積作成' })
  expect(created).toMatchObject({ status: 201, body: { resource: { kind: 'improvement', phase: 'created', title: '見積作成', createdApplicationId: 'mitsumori', createdApplicationStackId: 'mitsumori', specMarkdown: '一覧に絞り込みを足したい' } } })
  expect((await call('POST', `${project}/application-drafts`, { kind: 'improvement', applicationStackId: 'nippo', intent: '直したい' })).status).toBe(412)
  expect((await call('POST', `${project}/application-drafts`, { kind: 'improvement', intent: '直したい' })).status).toBe(400)
  expect((await call('POST', `${project}/application-drafts`, { applicationStackId: 'mitsumori', intent: '直したい' })).status).toBe(400)
  const path = `${project}/application-drafts/${created.body.resource.id}`
  for (const route of ['creation-plan-generations', 'creation-plan-validations', 'creation-cleanups']) expect((await call('POST', `${path}/${route}`)).status).toBe(412)
  expect((await call('POST', `${path}/creation-executions`, { clientRequestId: 'x' })).status).toBe(412)
})

test('question → proposal → run → review, in the application workspace', async () => {
  await call('POST', '/api/v1/__mock/reset')
  const draft = (await call('POST', `${project}/application-drafts`, { kind: 'improvement', applicationStackId: 'mitsumori', intent: '一覧に絞り込みを足したい' })).body.resource
  const path = `${project}/application-drafts/${draft.id}`
  const say = async (message: string) => {
    expect((await call('POST', `${path}/conversation-turns`, { message })).status).toBe(202)
    await call('POST', '/api/v1/__mock/advance')
    return (await call('GET', path)).body
  }
  const asked = await say('一覧に絞り込みを足したい')
  expect(asked.conversationTurns[0]).toMatchObject({ status: 'succeeded', devWorkspaceId: asked.implementationWorkspaceId, suggestedReplies: ['状態で絞り込みたい', '担当者で絞り込みたい', '日付の範囲で絞り込みたい'] })
  expect(asked.creationPlan).toBeUndefined()
  expect(deriveImprove(asked).stage).toBe('ask')

  const proposed = await say('状態で絞り込みたい')
  expect(proposed.creationPlan.implementationHandoff).toMatchObject({ workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'existing-source-repository' })
  expect(proposed.creationPlan.implementationHandoff.tasks).toHaveLength(3)
  expect(proposed.conversationTurns.at(-1).suggestedReplies[0]).toBe('この内容で直して')
  expect(proposed.specMarkdown).toBe(proposed.creationPlan.markdown)
  expect(deriveImprove(proposed)).toMatchObject({ phase: 'proposed', stage: 'fix' })

  const confirmed = await say('この内容で直して')
  expect(confirmed.creationPlan).toEqual(proposed.creationPlan)
  expect(confirmed.conversationTurns.at(-1).suggestedReplies).toEqual([])

  expect((await call('POST', `${path}/implementation-runs`)).status).toBe(202)
  let current = (await call('GET', path)).body
  for (let step = 0; step < 20 && current.implementationRuns.at(-1).status !== 'succeeded'; step++) {
    await call('POST', '/api/v1/__mock/advance')
    current = (await call('GET', path)).body
  }
  const run = current.implementationRuns.at(-1)
  expect(run).toMatchObject({ status: 'succeeded', devWorkspaceId: current.implementationWorkspaceId })
  expect(run.tasks.every((task: { status: string; versionLabel?: string }) => task.status === 'done' && !task.versionLabel)).toBe(true)
  expect(deriveImprove(current)).toMatchObject({ phase: 'done', stage: 'check' })
  expect(current.proposalId).toBeDefined()
  const proposalPath = `${project}/source-change-proposals/${current.proposalId}`
  expect((await call('GET', proposalPath)).body.phase).toBe('Proposed')
  expect((await call('POST', `${path}/implementation-runs`)).status).toBe(409)
  expect((await call('POST', `${proposalPath}/decisions`, { decision: 'RequestChanges', comment: '今月の分も表示してください' })).status).toBe(202)

  // The next request starts over with a question, then a new proposal with new tasks.
  const again = await say('CSV で書き出したい')
  expect(deriveImprove(again).stage).toBe('ask')
  const next = await say('今月の分だけ')
  expect(deriveImprove(next)).toMatchObject({ phase: 'proposed' })
})
