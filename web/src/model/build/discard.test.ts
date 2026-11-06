import { describe, expect, test } from 'bun:test'
import type { ApplicationDraft, ApplicationDraftCreationExecution } from '@appthrust/api-schema/platform-api'
import { hasCreationResources, isDraftBusy } from './discard'

const at = '2026-10-08T00:00:00Z'
const draft: ApplicationDraft = {
  id: 'draft-1', projectId: 'pj', title: '見積', intent: '見積を作る', phase: 'planned', specMarkdown: '', architectureMarkdown: '',
  creationExecutions: [], ownerUserId: 'u1', createdAt: at, updatedAt: at,
}
const execution = (status: ApplicationDraftCreationExecution['status'], steps: ApplicationDraftCreationExecution['steps']): ApplicationDraftCreationExecution =>
  ({ id: 'exec-1', status, attempt: 1, startedAt: at, steps })

describe('やめる preconditions mirror the Platform API delete handler', () => {
  test('a running turn, generation, execution or the creating phase blocks deletion', () => {
    expect(isDraftBusy(draft)).toBe(false)
    expect(isDraftBusy({ ...draft, phase: 'creating' })).toBe(true)
    expect(isDraftBusy({ ...draft, conversationTurns: [{ id: 't', kind: 'conversation', status: 'running', startedAt: at, devWorkspaceId: 'ws', userMessage: 'x' }] })).toBe(true)
    expect(isDraftBusy({ ...draft, creationPlanGenerations: [{ id: 'g', status: 'pending', startedAt: at, devWorkspaceId: 'ws' }] })).toBe(true)
    expect(isDraftBusy({ ...draft, creationExecutions: [execution('running', [])] })).toBe(true)
    expect(isDraftBusy({ ...draft, creationExecutions: [execution('failed', [])], conversationTurns: [{ id: 't', kind: 'conversation', status: 'succeeded', startedAt: at, devWorkspaceId: 'ws', userMessage: 'x' }] })).toBe(false)
  })
  test('cleanup precedes deletion only when 用意する created something', () => {
    expect(hasCreationResources(draft)).toBe(false)
    expect(hasCreationResources({ ...draft, createdApplicationStackId: 'stack-1' })).toBe(true)
    expect(hasCreationResources({ ...draft, creationExecutions: [execution('failed', [{ id: 's1', tool: 'appthrust.applicationSourceRepository.create', status: 'done' }, { id: 's2', tool: 'appthrust.applicationStack.create', status: 'failed' }])] })).toBe(true)
    // Validation and observation leave nothing behind; a failed create step neither.
    expect(hasCreationResources({ ...draft, creationExecutions: [execution('failed', [{ id: 's1', tool: 'appthrust.applicationStack.validate', status: 'done' }, { id: 's2', tool: 'appthrust.applicationStack.create', status: 'failed' }])] })).toBe(false)
  })
})
