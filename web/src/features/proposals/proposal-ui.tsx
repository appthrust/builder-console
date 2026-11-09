import type { SourceChangeProposal } from '@appthrust/api-schema/platform-api'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, GitPullRequest } from 'lucide-react'
import { useId, useState } from 'react'
import { useDashboardSettingsUrl } from '../../api/queries'
import { copy } from '../../copy'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { ActionError, Button, Dialog, Field, HrefLink, LinkButton, Notice, StatusPill, TextArea } from '../../ui'
import { text } from './copy'
import { canReview, previewRevision, previewStatus, proposalChangePreview, requestedChanges } from './model'
import { proposalPreviewOptions, useProposalDecision, useProposalPeople } from './queries'

export function ProposalStatus({ proposal }: { proposal: SourceChangeProposal }) {
  const status = proposal.phase === 'Applied' ? 'live' : proposal.phase === 'ApplyFailed' ? 'failed' : proposal.phase === 'Applying' || proposal.phase === 'Accepted' ? 'deploying' : 'unfinished'
  return <StatusPill status={status} label={text.phase[proposal.phase]} />
}

/** The DevWorkspace dev-server preview while drafting; a preview Branch supersedes it. */
export function ProposalPreview({ proposal }: { proposal: SourceChangeProposal }) {
  const branchPreview = proposalChangePreview(proposal).preview
  const preview = useQuery(proposalPreviewOptions(proposal.projectId, branchPreview ? undefined : proposal.previewWorkspaceId))
  if (branchPreview) return null
  return preview.data ? <LinkButton external href={preview.data} size="sm" icon={<ExternalLink />}>{text.preview}</LinkButton> : preview.error ? <ActionError error={preview.error} /> : null
}

/** The Dashboard's Branch detail for a preview Branch, when the server names the Dashboard. */
function useBranchHref(proposal: SourceChangeProposal, branchId: string): string | undefined {
  const dashboardUrl = useDashboardSettingsUrl()
  if (!dashboardUrl) return undefined
  const path = `/dashboard/projects/${encodeURIComponent(proposal.projectId)}/applications/${encodeURIComponent(proposal.applicationId)}/branches/${encodeURIComponent(branchId)}`
  return new URL(path, new URL(dashboardUrl).origin).href
}

/**
 * The preview Branch built from the proposal's head, and the change request
 * that opened it. `compact` renders the same facts inline for proposal lists.
 */
export function ProposalBranchPreview({ proposal, compact = false }: { proposal: SourceChangeProposal; compact?: boolean }) {
  const { preview, externalChangeRequest } = proposalChangePreview(proposal)
  const branchHref = useBranchHref(proposal, preview?.branchId ?? '')
  if (!preview && !externalChangeRequest) return null
  const revision = preview ? previewRevision(proposal, preview) : {}
  // Every reason is shown: product copy when known, the controller code otherwise.
  const reason = preview?.reason ? (text.previewReason[preview.reason] ?? text.previewReasonOther(preview.reason)) : undefined
  return <section className={compact ? 'space-y-1.5' : 'space-y-3 rounded-lg border border-line bg-white p-4'} data-testid={compact ? 'proposal-branch-preview-summary' : 'proposal-branch-preview'} data-state={preview?.state}>
    {compact ? null : <h2 className="font-semibold">{text.branchPreview}</h2>}
    {preview ? <>
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill status={previewStatus(preview.state)} label={text.previewState[preview.state]} second={reason} />
        {preview.state === 'Ready' && preview.url ? <LinkButton external href={preview.url} size="sm" icon={<ExternalLink />}>{text.preview}</LinkButton> : null}
        {branchHref ? <a href={branchHref} target="_blank" rel="noreferrer" className="text-sm text-accent-strong underline">{text.openPreviewDetails}</a> : null}
      </div>
      {revision.pinned ? <p className="text-xs text-stone-500 tabular-nums" data-testid="proposal-preview-revision">
        <span className="font-mono">{text.pinned(revision.pinned)}</span>
        {revision.newerHead ? <span className="ml-2 text-busy-ink">· {text.newerHead(revision.newerHead)}</span> : null}
      </p> : null}
    </> : null}
    {externalChangeRequest ? <p className="flex flex-wrap items-center gap-2 text-sm">
      <GitPullRequest className="size-4 text-stone-500" aria-hidden />
      <a href={externalChangeRequest.url} target="_blank" rel="noreferrer" className="text-accent-strong underline" title={externalChangeRequest.repository}>{text.changeRequest(externalChangeRequest.externalId)}</a>
      {externalChangeRequest.state ? <span className="text-xs text-stone-500">{text.changeRequestState[externalChangeRequest.state]}</span> : null}
    </p> : null}
  </section>
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
