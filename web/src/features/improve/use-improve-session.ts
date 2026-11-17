import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { isResponseContractError } from '../../api/boundary'
import * as api from '../../api/build'
import { buildDraftOptions, buildKeys } from '../../api/queries/build'
import { platformErrorEnvelope } from '../../api/platform-error'
import { classifyBuildFailure, unconfirmedFailure, type BuildFailure } from '../../model/build'
import { isOneOf, knownValue, type BuildDraft } from '../../model/contracts/build'
import { deriveImprove } from '../../model/improve'
import { useImplementation } from '../build/implement'
import { proposalKeys, proposalOptions } from '../../api/queries/proposal'
import { improvementAdmitted, proposalTerminal, proposalWaiting } from '../proposals/model'

/**
 * Turns and runs are server-owned: sending a message only POSTs the turn and
 * puts it into the draft cache; the draft query's polling (three seconds while
 * a turn or run is pending/running) carries the answer and the run's progress.
 */
export function useImproveSession(projectId: string, draft: BuildDraft) {
  const queryClient = useQueryClient()
  const lock = useRef(false)
  const [sending, setSending] = useState(false)
  const [sendFailure, setSendFailure] = useState<{ text: string; failure: BuildFailure }>()
  const state = deriveImprove(draft)
  const implementation = useImplementation({ projectId, draft, handoff: draft.creationPlan?.implementationHandoff, enabled: !draft.creationPlanUnreadable })
  const proposal = useQuery(proposalOptions(projectId, draft.proposalId))
  const phase = proposal.data?.phase
  const reviewLocked = !!draft.proposalId && !improvementAdmitted(phase)
  /**
   * Why the session takes no new change: its proposal awaits review or apply, is closed, or could not be applied
   * (ApplyFailed is not closed: the proposal keeps being read).
   */
  const review = !draft.proposalId || !phase ? undefined
    : proposalWaiting(phase) ? 'waiting' as const
      : proposalTerminal(phase) ? 'closed' as const
        : isOneOf(phase, 'ApplyFailed') ? 'applyFailed' as const : undefined
  // A start Platform refused: read the proposal again, so the page says which holds. The refusal is taken back only
  // when a read made after it shows the proposal changed and admitting a run again; a read of the same proposal
  // (still drafting with its submission pending, say) keeps it.
  const requestFailure = implementation.requestFailure
  const refusal = requestFailure?.reasonCode === 'ProposalRunBlocked' || requestFailure?.reasonCode === 'StartRefused' ? requestFailure : undefined
  const proposalMark = proposal.data ? [knownValue(proposal.data.phase) ?? 'unknown', proposal.data.updatedAt, proposal.data.decisions.length].join('|') : undefined
  const refusedWith = useRef<{ failure: BuildFailure; mark?: string; at: number }>(undefined)
  const { dismissRefusal } = implementation
  useEffect(() => {
    if (!refusal || !draft.proposalId) {
      refusedWith.current = undefined
      return
    }
    if (refusedWith.current?.failure !== refusal) {
      refusedWith.current = { failure: refusal, mark: proposalMark, at: Date.now() }
      void queryClient.invalidateQueries({ queryKey: proposalKeys.detail(projectId, draft.proposalId) })
      return
    }
    if (proposal.dataUpdatedAt > refusedWith.current.at && proposalMark !== refusedWith.current.mark && improvementAdmitted(phase)) dismissRefusal()
  })
  const applied = isOneOf(phase, 'Applied')
  // The controller applies first; release correlation updates the private draft later.
  useQuery({
    ...buildDraftOptions(projectId, draft.id),
    enabled: applied && !state.version,
    refetchInterval: applied && !state.version ? 3000 : false,
  })
  useEffect(() => {
    if (applied) void queryClient.invalidateQueries({ queryKey: buildKeys.draft(projectId, draft.id) })
  }, [applied, projectId, draft.id, queryClient])

  async function send(text: string) {
    const message = text.trim()
    if (!message || lock.current || state.busy || reviewLocked) return
    lock.current = true
    setSending(true)
    setSendFailure(undefined)
    const options = buildDraftOptions(projectId, draft.id)
    try {
      const accepted = await api.createTurn(projectId, draft.id, { message })
      // An older GET must not replace the just-accepted turn.
      await queryClient.cancelQueries({ queryKey: options.queryKey })
      queryClient.setQueryData<BuildDraft>(options.queryKey, (current) => {
        const previous = current ?? draft
        return { ...previous, conversationTurns: [...previous.conversationTurns.filter((item) => item.id !== accepted.id), accepted] }
      })
      void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(projectId) })
    } catch (error) {
      // Answered 2xx but unreadably: the turn was most likely accepted. Read the draft back; the
      // failure offers no resend (an unconfirmed send is never repeated from here).
      if (isResponseContractError(error)) {
        void queryClient.invalidateQueries({ queryKey: options.queryKey })
        setSendFailure({ text: message, failure: unconfirmedFailure({ draftId: draft.id, at: new Date().toISOString() }) })
        return
      }
      const envelope = platformErrorEnvelope(error)
      const status = envelope?.status ?? (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined)
      // Another tab's turn is running: observe it instead of reporting a failure.
      if (status === 409) await queryClient.invalidateQueries({ queryKey: options.queryKey })
      else setSendFailure({ text: message, failure: classifyBuildFailure(envelope?.message ?? (error instanceof Error ? error.message : String(error)), status, 'turn', { draftId: draft.id, at: new Date().toISOString() }, envelope?.code, undefined, undefined, envelope?.details) })
    } finally {
      lock.current = false
      setSending(false)
    }
  }

  return {
    state,
    proposal,
    reviewLocked,
    review,
    implementation,
    sending,
    sendFailure: sendFailure?.failure,
    /** Nothing can be sent while a turn or a run is in flight (or in an unknown state), or while a send or start request is out. */
    locked: state.busy || reviewLocked || sending || implementation.pending,
    send: (text: string) => void send(text),
    retrySend: () => { if (sendFailure && sendFailure.failure.kind !== 'unconfirmed') void send(sendFailure.text) },
    /** After a send whose answer could not be read: reads the draft back (it shows whether the turn arrived); nothing is resent. */
    confirmSend: () => {
      setSendFailure(undefined)
      void queryClient.invalidateQueries({ queryKey: buildDraftOptions(projectId, draft.id).queryKey })
    },
  }
}
