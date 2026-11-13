import type { SourceChangeProposal } from '@appthrust/api-schema/platform-api'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useId, useState } from 'react'
import { copy } from '../../copy'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { ActionError, Button, Dialog, Field, HrefLink, LinkButton, Notice, StatusPill, TextArea } from '../../ui'
import { text } from './copy'
import { canReview, requestedChanges } from './model'
import { proposalPreviewOptions, useProposalDecision, useProposalPeople } from '../../api/queries/proposal'

export function ProposalStatus({ proposal }: { proposal: SourceChangeProposal }) {
  const status = proposal.phase === 'Applied' ? 'live' : proposal.phase === 'ApplyFailed' ? 'failed' : proposal.phase === 'Applying' || proposal.phase === 'Accepted' ? 'deploying' : 'unfinished'
  return <StatusPill status={status} label={text.phase[proposal.phase]} />
}

export function ProposalPreview({ proposal }: { proposal: SourceChangeProposal }) {
  const preview = useQuery(proposalPreviewOptions(proposal.projectId, proposal.previewWorkspaceId))
  return preview.data ? <LinkButton external href={preview.data} size="sm" icon={<ExternalLink />}>{text.preview}</LinkButton> : preview.error ? <ActionError error={preview.error} /> : null
}

export function ProposalActions({ proposal, inline = false }: { proposal: SourceChangeProposal; inline?: boolean }) {
  const { me } = useShell()
  const decision = useProposalDecision(proposal)
  const [open, setOpen] = useState(false)
  const [comment, setComment] = useState('')
  const id = useId()
  if (!canReview(proposal, me.person.subject)) return null
  const submit = () => decision.mutate({ decision: 'RequestChanges', comment: comment.trim() }, { onSuccess: () => setOpen(false) })
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button tone="primary" loading={decision.isPending} disabled={decision.isPending} onClick={() => decision.mutate({ decision: 'Accept' })}>{text.accept}</Button>
      {!inline ? <>
        <Button disabled={decision.isPending} onClick={() => setOpen(true)}>{text.requestChanges}</Button>
        <Button disabled={decision.isPending} onClick={() => decision.mutate({ decision: 'Reject' })}>{text.reject}</Button>
      </> : null}
    </div>
    {decision.error ? <ActionError error={decision.error} /> : null}
    <Dialog open={open} onOpenChange={(value) => { if (!decision.isPending) setOpen(value) }} title={text.requestChanges} description={text.commentHelp} footer={<>
      <Button disabled={decision.isPending} onClick={() => setOpen(false)}>{copy.common.cancel}</Button>
      <Button tone="primary" type="submit" form={`${id}-form`} loading={decision.isPending} disabled={!comment.trim() || decision.isPending}>{text.requestChanges}</Button>
    </>}>
      <form id={`${id}-form`} onSubmit={(event) => { event.preventDefault(); if (comment.trim() && !decision.isPending) submit() }}>
        <Field id={id} label={text.comment}><TextArea id={id} rows={5} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
        {decision.error ? <ActionError error={decision.error} /> : null}
      </form>
    </Dialog>
  </div>
}

export function ProposalFeedback({ proposal }: { proposal: SourceChangeProposal }) {
  const comment = requestedChanges(proposal)
  return comment ? <Notice title={text.feedback}><p className="whitespace-pre-wrap">{comment}</p></Notice> : null
}

/** A successful run is a proposal, not a live update. */
export function ProposalOutcome({ proposal, version }: { proposal: SourceChangeProposal; version?: string }) {
  const { me } = useShell()
  const people = useProposalPeople(proposal.reviewers)
  const names = proposal.reviewers.map((subject) => people.find((person) => person.subject === subject)?.displayName ?? text.unknownPerson)
  return <section className="space-y-3" data-testid="proposal-outcome" aria-live="polite">
    <p className="font-semibold text-stone-900">{text.sent}</p>
    <div className="flex flex-wrap items-center gap-2"><ProposalStatus proposal={proposal} />{proposal.phase === 'Applied' && version ? <span className="font-medium">{version}</span> : null}</div>
    <p className="text-xs text-stone-500">{text.reviewers(names.join(' / '))}</p>
    <div className="flex flex-wrap items-center gap-3"><HrefLink href={paths.proposal(proposal.id)} className="text-accent-strong underline">{text.open}</HrefLink><ProposalPreview proposal={proposal} /></div>
    <ProposalFeedback proposal={proposal} />
    {proposal.proposer === me.person.subject ? <ProposalActions proposal={proposal} inline /> : null}
  </section>
}
