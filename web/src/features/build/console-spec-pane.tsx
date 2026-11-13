// The specification side of a console-v1 session (APT-753 S4-U2): the
// confirmed revision only (a proposal never shows here until it is accepted,
// and unresolved items never do), and the publish name and audience as typed
// inputs saved with `setPublishPreferences` (design §12). Nothing here is
// prefilled from model text.
import { Building2, Lock, Users } from 'lucide-react'
import { useState } from 'react'
import { useGroups } from '../../api/queries/console'
import { copy } from '../../copy'
import { buildCopy } from '../../model/build/copy'
import { failureKind, publishNameProblem } from '../../model/build/replies'
import { parseSpec } from '../../model/build/spec'
import type { BuildPublishInput } from '../../model/contracts/console'
import { Button, Field, RadioCards, TextInput } from '../../ui'
import { SpecCard } from './artifact-pane'
import type { ConsoleBuildView } from './console-view'
import { text } from './copy'
import type { ConsoleBuildActions } from './use-console-build-session'

type Scope = BuildPublishInput['shareScope']

export function ConsoleSpecPane({ view, actions, writable }: { view: ConsoleBuildView; actions: ConsoleBuildActions; writable: boolean }) {
  const { specification } = view.session
  return <section aria-label={buildCopy.artifact.title} className="mx-auto w-full max-w-4xl min-w-0 space-y-4 p-4 sm:p-5">
    <div className="hidden items-baseline justify-between gap-3 md:flex">
      <h2 className="text-sm font-semibold text-stone-500">{buildCopy.artifact.title}</h2>
      <span className="text-xs tabular-nums text-stone-500" data-testid="spec-revision">{text.console.spec.revision(specification.revision)}</span>
    </div>
    <p className="text-xs tabular-nums text-stone-500 md:hidden">{text.console.spec.revision(specification.revision)}</p>
    {view.confirmation ? <p role="status" className="text-xs leading-relaxed text-stone-600">{text.console.spec.pending}</p> : null}
    <SpecCard spec={parseSpec(specification.markdown).spec} title={text.session.newApp} />
    <PublishSettings view={view} actions={actions} writable={writable} />
  </section>
}

function PublishSettings({ view, actions, writable }: { view: ConsoleBuildView; actions: ConsoleBuildActions; writable: boolean }) {
  const groups = useGroups().data
  const groupName = groups.find((group) => group.id === view.session.groupId)?.name
  const saved = view.publish
  const [name, setName] = useState(saved?.desired.name ?? '')
  const [scope, setScope] = useState<Scope | undefined>(saved?.desired.shareScope)
  const problem = publishNameProblem(name)
  const disabled = !writable || Boolean(view.write)
  const error = problem === 'too_long' ? text.console.publish.nameTooLong : problem === 'multiline' ? text.console.publish.nameMultiline : undefined
  const sync = saved?.sync
  const syncText = sync ? sync.state.kind === 'known' ? text.console.publish.sync[sync.state.value] : text.console.publish.sync.unknown : undefined
  return <section aria-labelledby="console-publish-title" className="border-t border-stone-200 pt-4">
    <h3 id="console-publish-title" className="text-sm font-semibold text-stone-900">{text.console.publish.title}</h3>
    <form className="mt-3 space-y-4" onSubmit={(event) => {
      event.preventDefault()
      if (problem || !scope || disabled) return
      actions.setPublishPreferences({ name: name.trim(), shareScope: scope })
    }}>
      <Field id="console-publish-name" label={text.console.publish.name} hint={text.console.publish.nameHint} error={error}>
        {/* One line by construction: an <input> drops line breaks. The bound counts Unicode scalars, so no maxLength. */}
        <TextInput id="console-publish-name" value={name} invalid={Boolean(error)} disabled={disabled} autoComplete="off" onChange={(event) => setName(event.target.value)} />
      </Field>
      <RadioCards<Scope>
        name="console-publish-scope"
        idPrefix="console-publish-scope"
        legend={text.console.publish.scope}
        value={scope}
        onChange={setScope}
        disabled={disabled}
        options={[
          { value: 'private', icon: <Lock className="size-4" />, title: copy.create.share.private.title, description: copy.create.share.private.body },
          { value: 'group', icon: <Users className="size-4" />, title: groupName ? text.console.publish.group(groupName) : text.console.publish.groupFallback, description: text.console.publish.groupBody },
          { value: 'company', icon: <Building2 className="size-4" />, title: copy.create.share.company.title, description: copy.create.share.company.body },
        ]}
      />
      {saved ? <div role="status" className="text-xs leading-relaxed text-stone-600" data-testid="console-publish-saved">
        <p>{text.console.publish.saved(saved.desired.name)} {syncText}</p>
        {sync?.failure ? <p className="mt-0.5 text-bad-ink">{text.console.failure[failureKind(sync.failure.error, sync.failure.details)].title}</p> : null}
      </div> : null}
      <Button type="submit" tone="primary" disabled={Boolean(problem) || !scope || disabled} loading={view.write?.family === 'publish' && view.write.status === 'sending'}>{text.console.publish.save}</Button>
    </form>
  </section>
}
