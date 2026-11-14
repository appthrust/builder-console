// The published name and audience of a created console-v1 session (APT-753,
// design §12): typed inputs saved with `setPublishPreferences`, asked where the
// legacy flow ran its hidden preparation turn (after creation, before 公開する),
// never prefilled from model text. The values come back from `session.publish`
// after a reload; 公開する waits until they are saved and applied (the server
// writes them to the Platform draft, which the publish step starts from).
import { Building2, Lock, Users } from 'lucide-react'
import { useState } from 'react'
import { useGroups } from '../../api/queries/console'
import { copy } from '../../copy'
import { failureKind, publishNameProblem } from '../../model/build/replies'
import type { BuildPublishInput } from '../../model/contracts/console'
import { Button, Field, RadioCards, TextInput } from '../../ui'
import type { ConsoleBuildView, ConsolePublish } from './console-view'
import { text } from './copy'
import type { ConsoleBuildActions } from './use-console-build-session'

type Scope = BuildPublishInput['shareScope']

/** Saved and written to the Platform draft: 公開する may proceed. */
export function publishReady(publish: ConsolePublish | undefined): boolean {
  return publish?.sync.state.kind === 'known' && publish.sync.state.value === 'applied'
}

export function ConsolePublishSettings({ view, actions, disabled }: { view: ConsoleBuildView; actions: ConsoleBuildActions; disabled: boolean }) {
  const groups = useGroups().data
  const groupName = groups.find((group) => group.id === view.session.groupId)?.name
  const saved = view.publish
  const [name, setName] = useState(saved?.desired.name ?? '')
  const [scope, setScope] = useState<Scope | undefined>(saved?.desired.shareScope)
  const problem = publishNameProblem(name)
  const error = problem === 'too_long' ? text.console.publish.nameTooLong : problem === 'multiline' ? text.console.publish.nameMultiline : undefined
  const sync = saved?.sync
  const syncing = sync?.state.kind === 'known' && (sync.state.value === 'pending' || sync.state.value === 'syncing')
  const locked = disabled || Boolean(view.write) || syncing
  const syncText = sync ? sync.state.kind === 'known' ? text.console.publish.sync[sync.state.value] : text.console.publish.sync.unknown : undefined
  // Saving the applied values again changes nothing; after a failed sync the same values can be sent again.
  const unchanged = publishReady(saved) && saved!.desired.name === name.trim() && saved!.desired.shareScope === scope
  return <section aria-labelledby="console-publish-title" data-testid="console-publish" className="rounded-lg border border-line bg-white px-4 py-3">
    <h3 id="console-publish-title" className="font-semibold text-stone-900">{text.console.publish.title}</h3>
    {!publishReady(saved) && !syncing ? <p className="mt-1 text-xs leading-relaxed text-stone-600" data-testid="console-publish-required">{text.console.publish.required}</p> : null}
    <form className="mt-3 space-y-4" onSubmit={(event) => {
      event.preventDefault()
      if (problem || !scope || locked || unchanged) return
      actions.setPublishPreferences({ name: name.trim(), shareScope: scope })
    }}>
      <Field id="console-publish-name" label={text.console.publish.name} hint={text.console.publish.nameHint} error={error}>
        {/* One line by construction: an <input> drops line breaks. The bound counts Unicode scalars, so no maxLength. */}
        <TextInput id="console-publish-name" value={name} invalid={Boolean(error)} disabled={locked} autoComplete="off" onChange={(event) => setName(event.target.value)} />
      </Field>
      <RadioCards<Scope>
        name="console-publish-scope"
        idPrefix="console-publish-scope"
        legend={text.console.publish.scope}
        value={scope}
        onChange={setScope}
        disabled={locked}
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
      <Button type="submit" disabled={Boolean(problem) || !scope || locked || unchanged} loading={(view.write?.family === 'publish' && view.write.status === 'sending') || syncing}>{text.console.publish.save}</Button>
    </form>
  </section>
}
