import type { SourceChangeProposal } from '@appthrust/api-schema/platform-api'
import { useQuery } from '@tanstack/react-query'
import { appsQuery } from '../../api/queries/console'
import { buildDraftOptions } from '../../api/queries/build'
import { runVersion } from '../../model/improve'
import { paths } from '../../routes/paths'
import { useShell } from '../../shell/use-shell'
import { HrefLink, LinkButton, LoadFailed, Loading, PageHeader, useDocumentTitle } from '../../ui'
import { text } from './copy'
import { ProposalActions, ProposalFeedback, ProposalPreview, ProposalStatus } from './proposal-ui'
import { proposalDiffOptions, proposalOptions, proposalsOptions, useProposalPeople } from '../../api/queries/proposal'

export function ProposalPage({ id }: { id: string }) {
  const { me } = useShell()
  const query = useQuery(proposalOptions(me.projectId, id))
  if (query.isPending) return <Loading />
  if (query.isError) return <LoadFailed error={query.error} onRetry={() => void query.refetch()} />
  return <ProposalDetail proposal={query.data} />
}

function ProposalDetail({ proposal }: { proposal: SourceChangeProposal }) {
  useDocumentTitle(proposal.title)
  const { me } = useShell()
  const people = useProposalPeople([proposal.proposer, ...proposal.reviewers])
  const name = (subject: string) => people.find((person) => person.subject === subject)?.displayName ?? text.unknownPerson
  const diff = useQuery(proposalDiffOptions(proposal))
  const apps = useQuery(appsQuery({ scope: 'all' }))
  // Drafts are private to their proposer. Reviewers use only the proposal projection.
  const draft = useQuery({ ...buildDraftOptions(me.projectId, proposal.originDraftId ?? ''), enabled: proposal.proposer === me.person.subject && !!proposal.originDraftId, refetchInterval: (query) => proposal.phase === 'Applied' && !runVersion(query.state.data?.implementationRuns?.at(-1)) ? 5000 : false })
  const app = apps.data?.find((entry) => entry.stackId === draft.data?.createdApplicationStackId)
  const version = runVersion(draft.data?.implementationRuns?.at(-1))
  const summary = proposal.change ?? diff.data?.summary
  return <div className="mx-auto w-full max-w-4xl space-y-6 pb-10" data-testid="proposal-detail" data-phase={proposal.phase}>
    <PageHeader title={proposal.title} lead={text.by(name(proposal.proposer))} actions={<ProposalStatus proposal={proposal} />} />
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-stone-500">{text.reviewers(proposal.reviewers.map(name).join(' / '))}</p>
      <ProposalPreview proposal={proposal} />
      {proposal.proposer === me.person.subject && proposal.originDraftId ? <LinkButton href={paths.improve(proposal.originDraftId)} size="sm">{text.continue}</LinkButton> : null}
      {app ? <LinkButton href={paths.app(app.group.path, app.slug)} size="sm">{text.back}</LinkButton> : null}
    </div>
    {proposal.phase === 'Applied' && version ? <p className="font-semibold text-accent-strong">{version}</p> : null}
    <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-800">{proposal.summary}</p>
    <section className="space-y-3"><h2 className="font-semibold">{text.tasks}</h2><ol className="list-inside list-decimal space-y-4 text-sm">
      {proposal.tasks.map((task, index) => <li key={index} className="leading-relaxed"><span className="font-medium">{task.title}</span><p className="mt-1 whitespace-pre-wrap text-stone-600">{task.description}</p><ul className="mt-1 list-inside list-disc text-stone-500">{task.acceptanceCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul></li>)}
    </ol></section>
    <section className="space-y-3 border-y border-line py-5">
      <h2 className="font-semibold">{text.changes}</h2>
      {summary ? <p className="flex gap-4 text-sm tabular-nums"><span>{text.files(summary.files)}</span><span className="text-emerald-700">+{summary.additions}</span><span className="text-red-700">−{summary.deletions}</span></p> : null}
      {diff.isPending ? <Loading /> : diff.isError ? <LoadFailed error={diff.error} onRetry={() => void diff.refetch()} /> : <details className="rounded-md border border-line bg-white"><summary className="cursor-pointer px-4 py-3 text-sm font-medium">{text.diff}</summary>
        {diff.data.truncated ? <p className="px-4 text-sm text-amber-800">{text.truncated}</p> : null}
        <pre className="max-h-[32rem] overflow-auto border-t border-line bg-stone-50 p-4 font-mono text-xs leading-relaxed" tabIndex={0}>{diff.data.unifiedDiff}</pre>
      </details>}
    </section>
    <ProposalFeedback proposal={proposal} />
    <ProposalActions proposal={proposal} />
  </div>
}

export function ProposalsPage({ applicationId }: { applicationId?: string }) {
  useDocumentTitle(text.title)
  const { me } = useShell()
  const query = useQuery(proposalsOptions(me.projectId, { applicationId, phase: 'Proposed' }))
  return <div className="mx-auto w-full max-w-4xl space-y-6">
    <PageHeader title={text.title} />
    {query.isPending ? <Loading /> : query.isError ? <LoadFailed error={query.error} onRetry={() => void query.refetch()} /> : query.data.data.length ? <ul className="divide-y divide-line rounded-lg border border-line bg-white">
      {query.data.data.map((proposal) => <li key={proposal.id} className="flex items-center justify-between gap-4 p-4"><HrefLink href={paths.proposal(proposal.id)} className="font-medium text-accent-strong hover:underline">{proposal.title}</HrefLink><ProposalStatus proposal={proposal} /></li>)}
    </ul> : <p className="text-sm text-stone-500">{text.empty}</p>}
  </div>
}
