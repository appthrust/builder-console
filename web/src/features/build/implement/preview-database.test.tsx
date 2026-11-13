import { afterEach, beforeEach, expect, spyOn, test, type Mock } from 'bun:test'
import type { ApplicationDraft, DevWorkspaceRead } from '@appthrust/api-schema/platform-api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { preserveLanguage } from '../../../../test/language'
import * as buildApi from '../../../api/build'
import * as workspaceApi from '../../../api/workspace'
import { draftOf, workspaceOf } from '../../../api/testing/build-domain'
import { ResponseContractError } from '../../../api/boundary'
import { buildCopy } from '../../../model/build/copy'
import { setLanguage } from '../../../shell/language'
import { ArtifactPane } from '../artifact-pane'
import { implementationCopy as copy } from './copy'
import { useImplementation, type PreviewDatabaseReset } from './use-implementation'

const at = '2026-10-31T00:00:00Z'
const workspace: DevWorkspaceRead = {
  id: 'ws-1', projectId: 'p1', scope: 'applicationDraft', draftId: 'draft-1', displayName: '点検',
  ownerUserId: 'owner', phase: 'Ready', branchName: 'main', baseRef: 'main', conditions: [],
  previewDatabase: { engine: 'PostgreSQL', ready: true, reason: 'PreviewDatabaseReady', resetGeneration: 0 },
}
// A stopped run: the phase is `failed`, so only `pending` tells that a retry is being submitted.
const draft: ApplicationDraft = {
  id: 'draft-1', projectId: 'p1', title: '点検', intent: '点検を管理する', phase: 'created',
  specMarkdown: '', architectureMarkdown: '', creationExecutions: [], ownerUserId: 'owner', createdAt: at, updatedAt: at,
  implementationRuns: [{ id: 'run-1', status: 'failed', startedAt: at, devWorkspaceId: 'ws-1', taskIds: ['list'], tasks: [{ id: 'list', title: '点検一覧', status: 'done' }] }],
}

let root: Root
let container: HTMLDivElement
let client: QueryClient
let restoreLanguage: () => void
let reset: PreviewDatabaseReset
let workspaceRead: Mock<typeof workspaceApi.getWorkspace>
let restarts: Mock<typeof workspaceApi.restartWorkspace>
let created: Mock<typeof buildApi.createImplementationRun>

function Harness() {
  const implementation = useImplementation({ projectId: 'p1', draft: draftOf(draft), enabled: true })
  reset = implementation.previewDatabaseReset
  return <ArtifactPane draft={draftOf(draft)} spec={{ users: [], screens: [], records: [], rules: [] }} stage="build"
    implementation={implementation.state} shareText="" previewDatabaseReset={implementation.previewDatabaseReset}
    onOpenPreview={() => {}} onRetry={implementation.retry} onSkipTask={() => {}} onCollapse={() => {}} />
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}

async function settle() {
  for (let index = 0; index < 5; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

beforeEach(async () => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
  workspaceRead = spyOn(workspaceApi, 'getWorkspace').mockResolvedValue(workspaceOf(workspace))
  restarts = spyOn(workspaceApi, 'restartWorkspace').mockResolvedValue(workspaceOf(workspace))
  // The retry request never answers: the hook stays in its submitting state.
  created = spyOn(buildApi, 'createImplementationRun').mockImplementation(() => Promise.withResolvers<Awaited<ReturnType<typeof buildApi.createImplementationRun>>>().promise)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>) })
  await settle()
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  client.clear()
  for (const spy of [workspaceRead, restarts, created]) spy.mockRestore()
  restoreLanguage()
})

test('cancel sends nothing; confirming restarts the workspace with resetPreviewDatabase', async () => {
  expect(container.textContent).toContain(copy.database.readyUnverified(false))
  expect(button(copy.databaseReset).disabled).toBe(false)
  await act(async () => { button(copy.databaseReset).click() })
  expect(document.body.textContent).toContain(copy.databaseResetBody)
  await act(async () => { button('キャンセル').click() })
  await settle()
  expect(document.body.textContent).not.toContain(copy.databaseResetBody)
  expect(restarts).not.toHaveBeenCalled()

  await act(async () => { button(copy.databaseReset).click() })
  await act(async () => { button(copy.databaseResetConfirm).click() })
  await settle()
  expect(restarts).toHaveBeenCalledTimes(1)
  expect(restarts.mock.calls[0]).toEqual(['p1', 'ws-1', { resetPreviewDatabase: true }])
  expect(document.body.textContent).not.toContain(copy.databaseResetBody)
})

test('a retry still being submitted disables the reset and refuses it without a request', async () => {
  await act(async () => { button(copy.retry).click() })
  await settle()
  expect(created).toHaveBeenCalledTimes(1)
  expect(button(copy.databaseReset).disabled).toBe(true)
  expect(button(copy.databaseReset).title).toBe(copy.databaseResetRunning)
  expect(reset.busy).toBe(true)
  let accepted: boolean | undefined
  await act(async () => { accepted = await reset.reset() })
  expect(accepted).toBe(false)
  expect(restarts).not.toHaveBeenCalled()
})

test('an engine this console does not know pauses only the database line: fixed copy, no reset, the rest of the workspace is read', async () => {
  workspaceRead.mockResolvedValue(workspaceOf({ ...workspace, previewDatabase: { engine: 'NewEngineDB', ready: true, reason: 'PreviewDatabaseReady', resetGeneration: 0 } }))
  await act(async () => { await client.invalidateQueries() })
  await settle()
  expect(container.textContent).toContain(buildCopy.unsupported.title)
  expect(container.textContent).toContain(buildCopy.unsupported.detail)
  expect(container.textContent).not.toContain('NewEngineDB')
  expect(button(copy.databaseReset).disabled).toBe(true)
  // The workspace itself is still read (no load failure) and the run keeps its own controls.
  expect(client.getQueryCache().getAll().find((query) => query.queryKey.includes('workspace'))?.state.status).toBe('success')
  expect(button(copy.retry).disabled).toBe(false)
  let accepted: boolean | undefined
  await act(async () => { accepted = await reset.reset() })
  expect(accepted).toBe(false)
  expect(restarts).not.toHaveBeenCalled()
})

test('a restart whose answer cannot be read offers only 「最新の状態を確認する」, which re-reads the workspace and never restarts again', async () => {
  restarts.mockRejectedValue(new ResponseContractError({ source: 'platform', operationId: 'platformApiRestartDevWorkspace', method: 'POST', routeTemplate: '/x', issues: [{ path: '/resource', code: 'missing' }] }))
  await act(async () => { button(copy.databaseReset).click() })
  await act(async () => { button(copy.databaseResetConfirm).click() })
  await settle()
  expect(restarts).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain(buildCopy.failure.unconfirmed.title)
  expect(button(copy.databaseReset).disabled).toBe(true)
  const reads = workspaceRead.mock.calls.length
  await act(async () => { button(buildCopy.failure.confirm).click() })
  await settle()
  expect(workspaceRead.mock.calls.length).toBeGreaterThan(reads)
  expect(restarts).toHaveBeenCalledTimes(1)
  expect(container.textContent).not.toContain(buildCopy.failure.unconfirmed.title)
  expect(button(copy.databaseReset).disabled).toBe(false)
})
