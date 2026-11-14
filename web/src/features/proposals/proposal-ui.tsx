import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { copy } from '../../copy'
import { knownValue } from '../../model/contracts/build'
import type { Person } from '../../model/contracts/console'
import type { Proposal, ProposalDecisionCommand } from '../../model/contracts/proposal'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { ActionError, Button, Dialog, Field, HrefLink, LinkButton, Notice, StatusPill, TextArea } from '../../ui'
import { isUnconfirmedWrite, UnconfirmedNotice, useWriteConfirmation } from '../app/notices'
import { text } from './copy'
import { requestedChanges, reviewGate } from './model'
import { proposalOptions, proposalPreviewOptions, useProposalDecision, useProposalPeople } from '../../api/queries/proposal'

/** The Directory name of a principal subject; a subject without a known person is 「不明な利用者」, never someone else. */
export function personName(people: readonly Person[], subject: string): string {
  return people.find((person) => person.subject === subject)?.displayName || copy.common.unknownPerson
}

export function ProposalStatus({ proposal }: { proposal: Proposal }) {
  const phase = knownValue(proposal.phase)
  if (!phase) return <StatusPill status="unknown" label={text.phaseUnknown} />
  const status = phase === 'Applied' ? 'live' : phase === 'ApplyFailed' ? 'failed' : phase === 'Applying' || phase === 'Accepted' ? 'deploying' : 'unfinished'
  return <StatusPill status={status} label={text.phase[phase]} />
}

/**
 * 「変更後の画面を見る」 opens the Console's preview viewer in a new tab, never the preview origin itself. A workspace
 * never moved to its own origin opens its legacy same-origin URL, as before (remove at migration stage 5).
 */
export function ProposalPreview({ proposal }: { proposal: Proposal }) {
  const preview = useQuery(proposalPreviewOptions(proposal.projectId, proposal.previewWorkspaceId))
  const href = preview.data?.kind === 'viewer' ? paths.workspacePreview(preview.data.workspaceId) : preview.data?.url
  return href ? <LinkButton external href={href} size="sm" icon={<ExternalLink />}>{text.preview}</LinkButton> : preview.error ? <ActionError error={preview.error} /> : null
}

/**
 * The reviewer's decisions. Offered only while the proposal awaits the caller's
 * review and every part a decision rests on is known and current: an unknown
 * phase, decision or revision shows the actions disabled with the fixed
 * explanation, and a failed refresh of the proposal disables them too. A
 * decision answered 2xx unreadably is never resent: the only action is
 * 「最新の状態を確認する」, and the decisions stay disabled until it has read the
 * proposal back.
 */
export function ProposalActions({ proposal, inline = false }: { proposal: Proposal; inline?: boolean }) {
  const { me } = useShell()
  const decision = useProposalDecision(proposal)
  // Observes the proposal's own read (never fetches): a decision must rest on a current answer.
  const snapshot = useQuery({ ...proposalOptions(proposal.projectId, proposal.id), enabled: false })
  const confirmation = useWriteConfirmation([decision.error], decision.reset, decision.readBack)
  const sending = useRef(false)
  const [open, setOpen] = useState(false)
  const [comment, setComment] = useState('')
  const id = useId()
  const gate = reviewGate(proposal, me.person.subject)
  if (gate === 'none') return null
  const blocked = gate !== 'review' || snapshot.isRefetchError || decision.isPending || confirmation.unconfirmed || confirmation.confirming
  const send = (body: ProposalDecisionCommand) => {
    // One decision at a time: a second click before the first settles is not a second send.
    if (blocked || sending.current) return
    sending.current = true
    decision.mutate(body, {
      onSuccess: () => setOpen(false),
      onError: (error) => { if (isUnconfirmedWrite(error)) setOpen(false) },
      onSettled: () => { sending.current = false },
    })
  }
  // A failed read-back confirms nothing: the gate stays closed, the page's stale notice shows the failed read,
  // and the same confirmation can be tried again.
  const confirm = () => void confirmation.confirm().catch(() => {})
  const failure = confirmation.unconfirmed
    ? <UnconfirmedNotice confirming={confirmation.confirming} onConfirm={confirm} />
    : decision.error ? <ActionError error={decision.error} /> : null
  return <div className="space-y-3" data-testid="proposal-actions">
    {gate === 'unsupported' ? <Notice tone="warning">{text.unsupported}</Notice> : null}
    {failure}
    <div className="flex flex-wrap gap-2">
      <Button tone="primary" loading={decision.isPending} disabled={blocked} onClick={() => send({ decision: 'Accept' })}>{text.accept}</Button>
      {!inline ? <>
        <Button disabled={blocked} onClick={() => setOpen(true)}>{text.requestChanges}</Button>
        <Button disabled={blocked} onClick={() => send({ decision: 'Reject' })}>{text.reject}</Button>
      </> : null}
    </div>
    <Dialog open={open} onOpenChange={(value) => { if (!decision.isPending) setOpen(value) }} title={text.requestChanges} description={text.commentHelp} footer={<>
      <Button disabled={decision.isPending} onClick={() => setOpen(false)}>{copy.common.cancel}</Button>
      <Button tone="primary" type="submit" form={`${id}-form`} loading={decision.isPending} disabled={!comment.trim() || blocked}>{text.requestChanges}</Button>
    </>}>
      <form id={`${id}-form`} onSubmit={(event) => { event.preventDefault(); if (comment.trim()) send({ decision: 'RequestChanges', comment: comment.trim() }) }}>
        <Field id={id} label={text.comment}><TextArea id={id} rows={5} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
        {decision.error && !confirmation.unconfirmed ? <ActionError error={decision.error} /> : null}
      </form>
    </Dialog>
  </div>
}

export function ProposalFeedback({ proposal }: { proposal: Proposal }) {
  const comment = requestedChanges(proposal)
  return comment ? <Notice title={text.feedback}><p className="whitespace-pre-wrap">{comment}</p></Notice> : null
}

/** A successful run is a proposal, not a live update. */
export function ProposalOutcome({ proposal, version }: { proposal: Proposal; version?: string }) {
  const { me } = useShell()
  const people = useProposalPeople(proposal.reviewers)
  const names = proposal.reviewers.map((subject) => personName(people, subject))
  return <section className="space-y-3" data-testid="proposal-outcome" aria-live="polite">
    <p className="font-semibold text-stone-900">{text.sent}</p>
    <div className="flex flex-wrap items-center gap-2"><ProposalStatus proposal={proposal} />{knownValue(proposal.phase) === 'Applied' && version ? <span className="font-medium">{version}</span> : null}</div>
    <p className="text-xs text-stone-500">{text.reviewers(names.join(' / '))}</p>
    <div className="flex flex-wrap items-center gap-3"><HrefLink href={paths.proposal(proposal.id)} className="text-accent-strong underline">{text.open}</HrefLink><ProposalPreview proposal={proposal} /></div>
    <ProposalFeedback proposal={proposal} />
    {proposal.proposer === me.person.subject ? <ProposalActions proposal={proposal} inline /> : null}
  </section>
}
