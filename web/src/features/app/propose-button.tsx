// 「直しを提案する」 (ux-design §6.6, WF-04): people who may propose but not
// maintain start the same improvement session as 「AIで直す」; what differs is
// the wording, that the owners review the result, and the one-line status of
// the caller's own proposal while it is moving.
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { draftsOptions } from '../../api/queries/build'
import { proposalOptions } from '../../api/queries/proposal'
import { platformErrorEnvelope } from '../../api/platform-error'
import type { OpenValue } from '../../api/boundary'
import { isOneOf } from '../../model/contracts/build'
import type { BusinessApp } from '../../model/contracts/console'
import { resolvedPeople } from '../../model/directory'
import type { ProposalPhase } from '../../model/contracts/proposal'
import { improvementFor } from '../../model/improve'
import { paths } from '../../routes/paths'
import { HrefLink, IconButton } from '../../ui'
import { ImproveButton } from '../improve/entry'
import { proposalTerminal } from '../proposals/model'
import { text } from './copy'

/** Shown only to people who may propose and do not maintain the app; maintainers keep 「AIで直す」. */
export function canPropose(app: Pick<BusinessApp, 'permissions' | 'stackId'>): boolean {
  return app.permissions.propose && !app.permissions.maintain && !!app.stackId
}

/** The owners as one name for 「△△ さん」; undefined when none can be named (the copy then says 「担当者」). */
export function ownerNames(app: Pick<BusinessApp, 'owners'>): string | undefined {
  const names = resolvedPeople(app.owners).map((owner) => owner.displayName)
  return names.length ? text.names.people(names) : undefined
}

/** The server refuses a proposal to an app whose contribution scope is `off` (console_authority). */
export function proposalRefusal(error: unknown): string | undefined {
  const envelope = platformErrorEnvelope(error)
  return envelope?.status === 403 && envelope.code === 'contribution_not_accepted' ? text.propose.refused : undefined
}

/**
 * The caller's own proposal, from their newest open improvement session and its proposal phase:
 * - `drafting`: talking or fixing, nothing sent yet → 続きから直す
 * - `reviewing`: sent, the owners decide or apply → 提案を見る
 * - `changes`: the owners asked for another round → 続きから直す
 * - `applied` / `rejected`: closed; shown until dismissed
 * Nothing while the proposal is unread, withdrawn, expired or in a phase this console does not know.
 */
export type ProposalStatus = 'drafting' | 'reviewing' | 'changes' | 'applied' | 'rejected'

export function proposalStatus(session: { proposalId?: string } | undefined, phase: OpenValue<ProposalPhase> | undefined): ProposalStatus | undefined {
  if (!session) return undefined
  if (!session.proposalId) return 'drafting'
  if (!phase) return undefined
  if (isOneOf(phase, 'Proposed', 'Accepted', 'Applying')) return 'reviewing'
  if (isOneOf(phase, 'ChangesRequested')) return 'changes'
  if (isOneOf(phase, 'Applied')) return 'applied'
  if (isOneOf(phase, 'Rejected')) return 'rejected'
  return undefined
}

/** A closed proposal's line stays dismissed in this browser: `<prefix>.<proposalId>` = '1'. */
const DISMISSED_KEY = 'builder-console.proposal-status-dismissed'

/** The newest open improvement session for this app and its proposal; both reads are shared with ImproveButton's cache. */
function useOwnProposal(projectId: string, stackId: string) {
  const drafts = useQuery(draftsOptions(projectId))
  const session = improvementFor(drafts.data?.data, stackId)
  const proposal = useQuery(proposalOptions(projectId, session?.proposalId))
  return { session, proposal: proposal.data, status: proposalStatus(session, proposal.data?.phase) }
}

/** The button: 「直しを提案する」, or 「続きから直す」 while the caller's proposal is still open. */
export function ProposeButton({ app, projectId }: { app: BusinessApp; projectId: string }) {
  const stackId = app.stackId
  if (!stackId || !canPropose(app)) return null
  return <ProposeAction app={app} projectId={projectId} stackId={stackId} />
}

function ProposeAction({ app, projectId, stackId }: { app: BusinessApp; projectId: string; stackId: string }) {
  const { session, proposal } = useOwnProposal(projectId, stackId)
  const owner = ownerNames(app)
  const open = session !== undefined && !(proposal && proposalTerminal(proposal.phase))
  return (
    <ImproveButton
      app={app}
      stackId={stackId}
      projectId={projectId}
      tone="secondary"
      actionLabel={open ? text.propose.resume : text.propose.action}
      wording={{ action: text.propose.action, title: text.propose.title, description: (name) => text.propose.description(name, owner) }}
      refusal={proposalRefusal}
    />
  )
}

/** One line under the header while the caller's own proposal is moving (§6.6 table). */
export function ProposalStatusLine({ app, projectId }: { app: BusinessApp; projectId: string }) {
  const stackId = app.stackId
  if (!stackId || !canPropose(app)) return null
  return <OwnProposalStatus app={app} projectId={projectId} stackId={stackId} />
}

function OwnProposalStatus({ app, projectId, stackId }: { app: BusinessApp; projectId: string; stackId: string }) {
  const { session, proposal, status } = useOwnProposal(projectId, stackId)
  const [dismissed, setDismissed] = useState<string>()
  if (!session || !status) return null
  const proposalId = session.proposalId
  if (proposalId && (dismissed === proposalId || localStorage.getItem(`${DISMISSED_KEY}.${proposalId}`) === '1')) return null
  const owner = ownerNames(app)
  const sentence = status === 'drafting' ? text.propose.drafting
    : status === 'reviewing' ? text.propose.reviewing(owner)
      : status === 'changes' ? text.propose.changesRequested(owner)
        : status === 'applied' ? text.propose.applied : text.propose.rejected
  // 続きから直す (drafting, changes) is the button itself, which says so while the proposal is open; the line adds only what it cannot.
  const action = (status === 'reviewing' || status === 'rejected') && proposal ? { href: paths.proposal(proposal.id), label: text.propose.view } : undefined
  const closable = (status === 'applied' || status === 'rejected') && proposalId
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-stone-200 bg-stone-50 py-1.5 pr-1.5 pl-4 text-sm text-stone-800" data-testid="proposal-status">
      <p className="min-w-0 flex-1 py-1 break-words">{sentence}</p>
      <div className="flex shrink-0 items-center gap-1">
        {action ? <HrefLink href={action.href} className="inline-flex min-h-9 items-center px-2 font-medium text-accent-strong underline-offset-2 hover:underline">{action.label}</HrefLink> : null}
        {closable ? <IconButton size="sm" label={text.propose.dismiss} icon={<X />} onClick={() => {
          localStorage.setItem(`${DISMISSED_KEY}.${proposalId}`, '1')
          setDismissed(proposalId)
        }} /> : null}
      </div>
    </div>
  )
}
