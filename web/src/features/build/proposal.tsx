import { Circle, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { buildCopy } from '../../model/build/copy'
import type { BuildProposal } from '../../model/build/types'
import { text } from './copy'

/**
 * The AI's proposal in the conversation: everything 「用意する」 will make, readable
 * before the user commits, with the prepare action attached to it (ai-build-session-ux §5.2).
 */
export function ProposalBody({ proposal, action }: { proposal: BuildProposal; action?: ReactNode }) {
  const copy = buildCopy.proposal
  const rows: [string, ReactNode][] = []
  if (proposal.users.length) rows.push([text.artifact.users, proposal.users.join(text.artifact.listSeparator)])
  if (proposal.screens.length) rows.push([text.artifact.screens, <ul className="space-y-0.5">{proposal.screens.map((screen) => <li key={screen.name}>{screen.name}{screen.purpose ? <span className="text-stone-500">{text.proposal.purposeSeparator}{screen.purpose}</span> : null}</li>)}</ul>])
  if (proposal.records.length) rows.push([text.artifact.records, proposal.records.map((record) => text.proposal.record(record.name, record.fields)).join(text.proposal.recordSeparator)])
  if (proposal.rules.length) rows.push([text.artifact.rules, <ul className="space-y-0.5">{proposal.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>])
  rows.push([copy.url, proposal.url ? <span className="break-all">{proposal.url}</span> : <span className="text-stone-500">{copy.urlLater}</span>])
  // Where the new repository and its image go: Platform's destination, the one 「この内容で作る」 binds.
  if (proposal.newRepository === 'blocked') rows.push([copy.repository, <span className="text-amber-800">{copy.destinationBlocked}</span>])
  else if (proposal.newRepository) {
    rows.push([copy.repository, <span className="break-all font-mono text-xs">{proposal.newRepository.repository}</span>])
    rows.push([copy.image, <span className="break-all font-mono text-xs">{proposal.newRepository.image}</span>])
  }
  return <div data-testid="build-proposal">
    <p className="break-words">{proposal.lead ?? copy.intro}</p>
    <section aria-label={text.proposal.title(proposal.name)} className="mt-3 rounded-lg border border-line bg-white px-4 py-3">
      <h3 className="font-semibold text-stone-900">{proposal.name}</h3>
      {proposal.oneLine ? <p className="mt-0.5 text-stone-600">{proposal.oneLine}</p> : null}
      <dl className="mt-3 space-y-2">{rows.map(([label, value]) => <div key={label} className="grid grid-cols-[6rem_1fr] gap-3 sm:grid-cols-[7.5rem_1fr]"><dt className="text-stone-500">{label}</dt><dd className="min-w-0 break-words text-stone-900">{value}</dd></div>)}</dl>
      {proposal.tasks.length ? <div className="mt-3 border-t border-stone-100 pt-3">
        <p className="text-xs font-medium text-stone-500">{copy.tasks}</p>
        <ul className="mt-1.5 space-y-1">{proposal.tasks.map((task, index) => <li key={`${index}-${task.title}`} className="flex gap-2"><Circle aria-hidden className="mt-1.5 size-2.5 shrink-0 text-stone-400" /><span className="min-w-0 break-words">{task.title}{task.detail ? <span className="block text-xs text-stone-500">{task.detail}</span> : null}</span></li>)}</ul>
        {proposal.moreTasks ? <p className="mt-1 text-xs text-stone-500">{copy.moreTasks(proposal.moreTasks)}</p> : null}
      </div> : null}
    </section>
    {proposal.stale ? <p className="mt-2 flex items-start gap-1.5 text-xs text-busy-ink"><Info aria-hidden className="mt-px size-3.5 shrink-0" />{copy.stale}</p> : null}
    {action ? <div className="mt-3 flex flex-wrap items-center gap-2">{action}</div> : null}
  </div>
}
