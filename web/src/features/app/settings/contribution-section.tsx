import { Switch } from 'radix-ui'
import { useId, useState } from 'react'
import { isUnknownPerson, type BusinessApp, type ContributionScope, type Person } from '../../../model/contracts/console'
import { ActionError, Notice, useUnsavedChangesGuard } from '../../../ui'
import { text } from '../copy'
import { useAppReadBack, useUpdateContribution } from '../mutations'
import { UnconfirmedNotice, useWriteConfirmation } from '../notices'
import { SaveRow, SettingsCard } from './parts'

/**
 * The scope the switch writes (ux-design §6.8): on = `group`. `company` is not offered yet, so an app already
 * open to the company keeps it while the switch stays on; turning it off is `off`.
 */
export function contributionScopeFor(accepting: boolean, saved: ContributionScope): ContributionScope {
  if (!accepting) return 'off'
  return saved === 'company' ? 'company' : 'group'
}

/** 提案の受け付け (WF-06): one switch, the rule it makes in two rows, and its own 保存. */
export function ContributionSection({ app, canEdit }: { app: BusinessApp; canEdit: boolean }) {
  const mutation = useUpdateContribution(app)
  const confirmation = useWriteConfirmation([mutation.error], mutation.reset, useAppReadBack(app.id))
  const scope = app.contribution.scope
  const saved = scope.kind === 'known' ? scope.value : undefined
  const [accepting, setAccepting] = useState(saved !== 'off')
  // The record changed under the form (saved here, or read back): the switch follows it.
  const [shownSaved, setShownSaved] = useState(saved)
  if (shownSaved !== saved) {
    setShownSaved(saved)
    setAccepting(saved !== 'off')
  }
  const next = saved ? contributionScopeFor(accepting, saved) : undefined
  const dirty = next !== undefined && next !== saved
  useUnsavedChangesGuard(canEdit && dirty && !mutation.isPending, text.settings.unsaved(text.settings.sections.contribution))
  const switchId = useId()
  const owners = app.owners.filter((owner): owner is Person => !isUnknownPerson(owner)).map((owner) => owner.displayName)
  const disabled = !canEdit || !saved || mutation.isPending || confirmation.unconfirmed

  return (
    <SettingsCard id="contribution" title={text.settings.contribution}>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (next && dirty && !disabled) mutation.mutate(next)
        }}
      >
        {!saved ? <Notice tone="warning">{text.unsupported.contribution}</Notice> : null}
        <div className="flex items-start gap-3">
          <Switch.Root
            id={switchId}
            checked={accepting}
            onCheckedChange={setAccepting}
            disabled={disabled}
            aria-describedby={`${switchId}-help`}
            className="relative mt-0.5 inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full bg-stone-300 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:bg-accent"
          >
            <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[1.125rem]" />
          </Switch.Root>
          <div className="min-w-0">
            <label htmlFor={switchId} className={accepting ? 'text-sm font-medium text-stone-900' : 'text-sm font-medium text-stone-600'}>
              {text.settings.contributionSwitch}
            </label>
            <p id={`${switchId}-help`} className="mt-1 text-sm text-stone-500">
              {accepting ? text.settings.contributionHelp : text.settings.contributionOff}
            </p>
          </div>
        </div>
        {accepting ? (
          <dl className="divide-y divide-stone-100 border-t border-stone-100 text-sm" data-testid="contribution-rule">
            <div className="grid gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
              <dt className="text-stone-500">{text.settings.contributionWho}</dt>
              <dd className="break-words text-stone-900">
                {next === 'company' ? text.settings.contributionWhoCompany : text.settings.contributionWhoGroup(app.group.name)}
              </dd>
            </div>
            <div className="grid gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
              <dt className="text-stone-500">{text.settings.contributionReviewer}</dt>
              <dd className="break-words text-stone-900">{text.settings.contributionReviewerValue(text.names.people(owners))}</dd>
            </div>
          </dl>
        ) : null}
        <div>
          <SaveRow pending={mutation.isPending} disabled={disabled || !dirty} saved={mutation.isSuccess && !dirty} />
          {confirmation.unconfirmed ? (
            <div className="mt-3">
              <UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} />
            </div>
          ) : mutation.isError ? (
            <div className="mt-3">
              <ActionError error={mutation.error} />
            </div>
          ) : null}
        </div>
      </form>
    </SettingsCard>
  )
}
