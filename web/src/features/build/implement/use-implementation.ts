import type { ApplicationDraft, ApplicationDraftImplementationHandoff, ApplicationDraftImplementationRun, CreateApplicationDraftImplementationRunRequest } from '@appthrust/api-schema/platform-api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import * as api from '../../../api/build'
import { BUILD_POLL_MS, buildDraftOptions, buildKeys } from '../../../api/build-queries'
import { platformErrorEnvelope } from '../../../api/platform-error'
import { getWorkspace, restartWorkspace } from '../../../api/workspace'
import { classifyBuildFailure, type BuildFailure } from '../../../model/build'
import { isBuildPending } from '../../../model/build/progress'
import { implementationPreviewUrl, previewDatabaseStatus } from './runtime'
import { implemented, projectImplementation } from './state'
import { implementationCopy as copy } from './copy'
import { usePreviewReadiness } from './use-preview-readiness'

interface ImplementationInput {
  projectId: string
  draft: ApplicationDraft
  handoff?: ApplicationDraftImplementationHandoff
  enabled: boolean
}

/** 「データベースを作り直す」: restart the workspace with a fresh preview database. */
export interface PreviewDatabaseReset {
  /** A start/retry is still being submitted (its run is not in the draft yet) or a run is pending; the API answers 409 for a running one. */
  busy: boolean
  pending: boolean
  /** The last refusal as one plain sentence. */
  error?: string
  /** Resolves false when refused, busy or without a workspace. */
  reset(): Promise<boolean>
}

/** Mutations only submit intent. Draft polling owns progress, even when no build tab is open. */
export function useImplementation({ projectId, draft, handoff, enabled }: ImplementationInput) {
  const queryClient = useQueryClient()
  const lock = useRef(false)
  const [pending, setPending] = useState(false)
  const [requestFailure, setRequestFailure] = useState<{ draftId: string; failure: BuildFailure }>()
  const run = draft.implementationRuns?.at(-1)
  const projection = projectImplementation(draft, run, handoff)
  const workspaceId = run?.devWorkspaceId
  const workspaceKey = ['build', draft.id, projectId, 'workspace', workspaceId]
  const workspace = useQuery({
    queryKey: workspaceKey,
    queryFn: ({ signal }) => getWorkspace(projectId, workspaceId!, signal),
    enabled: Boolean(workspaceId),
    refetchInterval: (query) => isBuildPending(run) || query.state.data?.phase === 'Starting' || (query.state.data && previewDatabaseStatus(query.state.data, run?.tasks ?? []) === 'starting') ? BUILD_POLL_MS : false,
  })
  const previewUrl = workspace.data ? implementationPreviewUrl(workspace.data) : undefined
  const previewStatus = usePreviewReadiness(previewUrl)
  const state = {
    ...projection,
    previewUrl,
    previewStatus,
    ...(workspace.data ? { previewDatabaseStatus: previewDatabaseStatus(workspace.data, projection.tasks) } : {}),
    retryPending: pending || !enabled || !projection.tasks.length,
    ...(requestFailure?.draftId === draft.id ? { phase: 'failed' as const, failure: requestFailure.failure } : {}),
  }
  const databaseReset = useMutation({
    mutationFn: () => restartWorkspace(projectId, workspaceId!, { resetPreviewDatabase: true }),
    onSuccess: async (response) => {
      queryClient.setQueryData(workspaceKey, response.resource)
      await queryClient.invalidateQueries({ queryKey: workspaceKey })
    },
  })

  async function submit(payload?: CreateApplicationDraftImplementationRunRequest): Promise<boolean> {
    if (!enabled || lock.current || !state.tasks.length) return false
    lock.current = true
    setPending(true)
    setRequestFailure(undefined)
    const options = buildDraftOptions(projectId, draft.id)
    async function receive(next: ApplicationDraftImplementationRun) {
      // An older GET must not replace a just-accepted start/cancel response.
      await queryClient.cancelQueries({ queryKey: options.queryKey })
      queryClient.setQueryData<ApplicationDraft>(options.queryKey, (current) => {
        const previous = current ?? draft
        const runs = previous.implementationRuns ?? []
        return { ...previous, implementationRuns: [...runs.filter((item) => item.id !== next.id), next] }
      })
      void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(projectId) })
    }
    try {
      const current = queryClient.getQueryData<ApplicationDraft>(options.queryKey)?.implementationRuns?.at(-1) ?? run
      if (payload?.change && current && isBuildPending(current)) {
        const cancelled = await api.cancelImplementationRun(projectId, draft.id, current.id)
        await receive(cancelled.run)
      } else if (isBuildPending(current)) return false
      const created = await api.createImplementationRun(projectId, draft.id, payload)
      await receive(created.run)
      return true
    } catch (error) {
      const envelope = platformErrorEnvelope(error)
      const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : envelope?.status
      if (status === 409) {
        // Another tab won the start. Observe its run; do not create a second workspace.
        await queryClient.invalidateQueries({ queryKey: options.queryKey })
        return false
      }
      const failedRun = queryClient.getQueryData<ApplicationDraft>(options.queryKey)?.implementationRuns?.at(-1) ?? run
      setRequestFailure({ draftId: draft.id, failure: classifyBuildFailure(envelope?.message ?? (error instanceof Error ? error.message : String(error)), status, 'implement', { draftId: draft.id, at: new Date().toISOString(), ...(failedRun && failedRun.status !== 'succeeded' ? { executionId: failedRun.id } : {}) }, envelope?.code, undefined, undefined, envelope?.details) })
      return false
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  const databaseBusy = pending || isBuildPending(run)
  const previewDatabaseReset: PreviewDatabaseReset = {
    busy: databaseBusy,
    pending: databaseReset.isPending,
    error: databaseReset.error ? previewDatabaseResetError(databaseReset.error) : undefined,
    reset: () => workspaceId && !databaseBusy ? databaseReset.mutateAsync().then(() => true, () => false) : Promise.resolve(false),
  }

  return {
    state,
    pending,
    /** The start/retry request itself failed (no run was created); a stopped run reports through `state.failure`. */
    requestFailure: requestFailure?.draftId === draft.id ? requestFailure.failure : undefined,
    previewDatabaseReset,
    start: () => { if (projection.phase === 'idle' && !requestFailure) void submit() },
    /** Starts every handoff task the latest run has not made, whatever that run's outcome (improvement sessions). */
    startPending: () => { void submit() },
    retry: () => {
      // Explicitly selecting all-skipped work reopens it; normal retries keep completed/skipped work.
      const allSkipped = !implemented(state) && state.tasks.every((task) => task.status === 'skipped')
      void submit(allSkipped ? { taskIds: state.tasks.map((task) => task.id) } : undefined)
    },
    skipTask: (id: string) => { void submit({ skipTaskIds: [id] }) },
    requestChange: (message: string) => {
      const task = state.tasks.find((item) => item.id === state.currentTaskId) ?? state.tasks.find((item) => item.status === 'pending') ?? state.tasks.at(-1)
      return task && message.trim() ? submit({ change: { taskId: task.id, message: message.trim() } }) : Promise.resolve(false)
    },
  }
}

/** The refusal as one plain sentence: the API's `details.reason`, never its English message. */
export function previewDatabaseResetError(error: unknown): string {
  const envelope = platformErrorEnvelope(error)
  const reason = envelope?.details?.reason
  if (envelope?.status === 409 && reason === 'PreviewDatabaseBusy') return copy.databaseResetBusy
  if (envelope?.status === 412 && reason === 'PreviewDatabaseNotEnabled') return copy.databaseResetNotEnabled
  return copy.databaseResetFailed
}
