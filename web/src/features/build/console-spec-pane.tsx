// The specification side of a console-v1 session (APT-753 S4-U2): the
// confirmed revision only (a proposal never shows here until it is accepted,
// and unresolved items never do). The publish name and audience are asked only
// after creation (console-publish-settings, design §12), never here.
import { buildCopy } from '../../model/build/copy'
import { parseSpec } from '../../model/build/spec'
import { SpecCard } from './artifact-pane'
import type { ConsoleBuildView } from './console-view'
import { text } from './copy'

export function ConsoleSpecPane({ view }: { view: ConsoleBuildView }) {
  const { specification } = view.session
  return <section aria-label={buildCopy.artifact.title} className="mx-auto w-full max-w-4xl min-w-0 space-y-4 p-4 sm:p-5">
    <div className="hidden items-baseline justify-between gap-3 md:flex">
      <h2 className="text-sm font-semibold text-stone-500">{buildCopy.artifact.title}</h2>
      <span className="text-xs tabular-nums text-stone-500" data-testid="spec-revision">{text.console.spec.revision(specification.revision)}</span>
    </div>
    <p className="text-xs tabular-nums text-stone-500 md:hidden">{text.console.spec.revision(specification.revision)}</p>
    {view.confirmation ? <p role="status" className="text-xs leading-relaxed text-stone-600">{text.console.spec.pending}</p> : null}
    <SpecCard spec={parseSpec(specification.markdown).spec} title={text.session.newApp} />
  </section>
}
