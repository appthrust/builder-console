import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { isResponseContractError } from '../../../api/boundary'
import * as api from '../../../api/build'
import { BUILD_POLL_MS, buildDraftOptions, buildKeys } from '../../../api/queries/build'
import { POLL_INTERVAL_MS } from '../../../api/queries/shared'
import { platformErrorEnvelope } from '../../../api/platform-error'
import { getWorkspace, restartWorkspace } from '../../../api/workspace'
import { classifyBuildFailure, unconfirmedFailure, type BuildFailure } from '../../../model/build'
import { buildCopy } from '../../../model/build/copy'
import { isBuildPending } from '../../../model/build/progress'
import { isOneOf, jobState, knownValue, type BuildDraft, type ImplementationHandoff, type ImplementationRun } from '../../../model/contracts/build'
import { useLegacyPreview } from './legacy-preview'
import { previewAvailability } from './preview'
import { previewDatabaseStatus } from './runtime'
import { implemented, projectImplementation } from './state'
import { implementationCopy as copy } from './copy'

interface ImplementationInput {
  projectId: string
  draft: BuildDraft
  handoff?: ImplementationHandoff
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
  /** Present only after a restart whose answer could not be read: reads the workspace back, never restarts again. */
  confirm?(): void
}

/** The latest run as far as an unconfirmed write is concerned: which run, and its state. */
const runMark = (run: ImplementationRun | undefined) => run ? `${run.id}/${knownValue(run.status) ?? 'unknown'}` : ''

/** Mutations only submit intent. Draft polling owns progress, even when no build tab is open. */
export function useImplementation({ projectId, draft, handoff, enabled }: ImplementationInput) {
  const queryClient = useQueryClient()
  const lock = useRef(false)
  const [pending, setPending] = useState(false)
  const [requestFailure, setRequestFailure] = useState<{ draftId: string; failure: BuildFailure; runBefore?: string }>()
  const run = draft.implementationRuns.at(-1)
  const projection = projectImplementation(draft, run, handoff)
  const workspaceId = run?.devWorkspaceId
  const workspaceKey = buildKeys.workspace(projectId, draft.id, workspaceId)
  const workspace = useQuery({
    queryKey: workspaceKey,
    queryFn: ({ signal }) => getWorkspace(projectId, workspaceId!, signal),
    enabled: Boolean(workspaceId),
    refetchInterval: (query) => {
      const current = query.state.data
      if (isBuildPending(run) || isOneOf(current?.phase, 'Starting') || (current && previewDatabaseStatus(current, run?.tasks ?? []) === 'starting')) return BUILD_POLL_MS
      // A preview origin still being published moves on by itself: keep reading until it is Ready (or stops).
      if (current && previewAvailability(current).kind === 'preparing') return BUILD_POLL_MS
      // A run, workspace or preview state this console does not know: keep reading at the normal pace until it is known.
      return jobState(run) === 'unknown' || current?.phase.kind === 'unknown' || (current && previewAvailability(current).kind === 'unknown') ? POLL_INTERVAL_MS : false
    },
  })
  const preview = workspace.data && workspaceId ? {
    projectId, workspaceId, availability: previewAvailability(workspace.data),
    readBack: () => { void queryClient.invalidateQueries({ queryKey: workspaceKey }) },
  } : undefined
  // Legacy same-origin preview (remove at migration stage 5): probes only a never-moved workspace's URL.
  const legacyPreview = useLegacyPreview(preview?.availability)
  // An unconfirmed write is settled by the draft read back: once it shows another run, or the run in another state, that is what happened.
  const failure = requestFailure?.draftId === draft.id && !(requestFailure.failure.kind === 'unconfirmed' && runMark(run) !== requestFailure.runBefore) ? requestFailure.failure : undefined
  const state = {
    ...projection,
    preview,
    ...(legacyPreview ? { legacyPreview } : {}),
    ...(workspace.data ? { previewDatabaseStatus: previewDatabaseStatus(workspace.data, projection.tasks) } : {}),
    retryPending: pending || !enabled || !projection.tasks.length,
    // An unconfirmed start is not a stopped run: the draft read back shows what actually happened.
    ...(failure ? { ...(failure.kind === 'unconfirmed' ? {} : { phase: 'failed' as const }), failure } : {}),
  }
  const databaseReset = useMutation({
    mutationFn: () => restartWorkspace(projectId, workspaceId!, { resetPreviewDatabase: true }),
    onSuccess: async (restarted) => {
      queryClient.setQueryData(workspaceKey, restarted)
      await queryClient.invalidateQueries({ queryKey: workspaceKey })
    },
    // The restart may have happened even when its answer could not be read: read the workspace back.
    onError: (error) => { if (isResponseContractError(error)) void queryClient.invalidateQueries({ queryKey: workspaceKey }) },
  })

  async function submit(payload?: api.ImplementationRunRequest): Promise<boolean> {
    if (!enabled || lock.current || !state.tasks.length) return false
    lock.current = true
    setPending(true)
    setRequestFailure(undefined)
    const options = buildDraftOptions(projectId, draft.id)
    async function receive(next: ImplementationRun) {
      // An older GET must not replace a just-accepted start/cancel response.
      await queryClient.cancelQueries({ queryKey: options.queryKey })
      queryClient.setQueryData<BuildDraft>(options.queryKey, (current) => {
        const previous = current ?? draft
        return { ...previous, implementationRuns: [...previous.implementationRuns.filter((item) => item.id !== next.id), next] }
      })
      void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(projectId) })
    }
    const current = queryClient.getQueryData<BuildDraft>(options.queryKey)?.implementationRuns.at(-1) ?? run
    try {
      if (payload?.change && current && isBuildPending(current)) {
        await receive(await api.cancelImplementationRun(projectId, draft.id, current.id))
      } else if (jobState(current) !== 'settled') return false
      await receive(await api.createImplementationRun(projectId, draft.id, payload))
      return true
    } catch (error) {
      const reference = { draftId: draft.id, at: new Date().toISOString() }
      if (isResponseContractError(error)) {
        // The run may have started: read the draft back, never start it again on our own.
        void queryClient.invalidateQueries({ queryKey: options.queryKey })
        setRequestFailure({ draftId: draft.id, failure: unconfirmedFailure(reference), runBefore: runMark(current) })
        return false
      }
      const envelope = platformErrorEnvelope(error)
      const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : envelope?.status
      if (status === 409) {
        // Another tab won the start. Observe its run; do not create a second workspace.
        await queryClient.invalidateQueries({ queryKey: options.queryKey })
        return false
      }
      const failedRun = queryClient.getQueryData<BuildDraft>(options.queryKey)?.implementationRuns.at(-1) ?? run
      setRequestFailure({ draftId: draft.id, failure: classifyBuildFailure(envelope?.message ?? (error instanceof Error ? error.message : String(error)), status, 'implement', { ...reference, ...(failedRun && !isOneOf(failedRun.status, 'succeeded') ? { executionId: failedRun.id } : {}) }, envelope?.code, undefined, undefined, envelope?.details) })
      return false
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  const databaseBusy = pending || jobState(run) !== 'settled'
  const previewDatabaseReset: PreviewDatabaseReset = {
    busy: databaseBusy,
    pending: databaseReset.isPending,
    error: databaseReset.error ? previewDatabaseResetError(databaseReset.error) : undefined,
    // A preview database engine this console does not know is never recreated from here (the rest of the workspace still is read).
    reset: () => workspaceId && !databaseBusy && state.previewDatabaseStatus !== 'unsupported' ? databaseReset.mutateAsync().then(() => true, () => false) : Promise.resolve(false),
    ...(isResponseContractError(databaseReset.error) ? { confirm: () => { databaseReset.reset(); void queryClient.invalidateQueries({ queryKey: workspaceKey }) } } : {}),
  }

  return {
    state,
    pending,
    /** The start/retry request itself failed (no run was created, or its answer could not be read); a stopped run reports through `state.failure`. */
    requestFailure: failure,
    previewDatabaseReset,
    start: () => { if (projection.phase === 'idle' && !requestFailure) void submit() },
    /** After a write whose answer could not be read: reads the draft back; the notice leaves once it shows what happened. Never resends. */
    confirm: () => { void queryClient.invalidateQueries({ queryKey: buildDraftOptions(projectId, draft.id).queryKey }) },
    /** Starts every handoff task the latest run has not made, whatever that run's outcome (improvement sessions). */
    startPending: () => { void submit() },
    retry: () => {
      // Explicitly selecting all-skipped work reopens it; normal retries keep completed/skipped work.
      const allSkipped = !implemented(state) && state.tasks.every((task) => isOneOf(task.status, 'skipped'))
      void submit(allSkipped ? { taskIds: state.tasks.map((task) => task.id) } : undefined)
    },
    skipTask: (id: string) => { void submit({ skipTaskIds: [id] }) },
    requestChange: (message: string) => {
      const task = state.tasks.find((item) => item.id === state.currentTaskId) ?? state.tasks.find((item) => isOneOf(item.status, 'pending')) ?? state.tasks.at(-1)
      return task && message.trim() ? submit({ change: { taskId: task.id, message: message.trim() } }) : Promise.resolve(false)
    },
  }
}

/** The refusal as one plain sentence: the API's `details.reason`, never its English message. */
export function previewDatabaseResetError(error: unknown): string {
  if (isResponseContractError(error)) return buildCopy.failure.unconfirmed.title
  const envelope = platformErrorEnvelope(error)
  const reason = envelope?.details?.reason
  if (envelope?.status === 409 && reason === 'PreviewDatabaseBusy') return copy.databaseResetBusy
  if (envelope?.status === 412 && reason === 'PreviewDatabaseNotEnabled') return copy.databaseResetNotEnabled
  return copy.databaseResetFailed
}
