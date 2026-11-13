// Step 2 誰に見せますか？: the four share scopes; a group share picks groups
// (the owner group by default). 社外にも is for console admins only.
import { useStore } from '@tanstack/react-form'
import { Building2, Globe, Lock, TriangleAlert, Users } from 'lucide-react'
import type { GroupNode } from '../../../model/contracts/console'
import type { ShareScope } from '../../../model/contracts/catalog'
import { copy } from '../../../copy'
import { shareScopeLabel } from '../../../model/access'
import { GroupChecklist, RadioCards } from '../../../ui'
import { text } from '../copy'
import { effectiveShareGroupIds, firstError, shareSchema, type CreateFormApi } from '../form'

export function ShareStep({
  form,
  groups,
  isConsoleAdmin,
  shareText,
}: {
  form: CreateFormApi
  /** Depth-first group tree. */
  groups: GroupNode[]
  isConsoleAdmin: boolean
  /** shareSentence() of the current choice. */
  shareText: string
}) {
  const groupId = useStore(form.store, (state) => state.values.groupId)
  const ownerGroupName = groups.find((group) => group.id === groupId)?.name
  return (
    <div className="space-y-5">
      <form.Field name="scope">
        {(scopeField) => (
          <RadioCards<ShareScope>
            name="share-scope"
            idPrefix="share"
            legend={copy.app.settings.share}
            columns={1}
            value={scopeField.state.value}
            onChange={(next) => scopeField.handleChange(next)}
            options={[
              {
                value: 'private',
                icon: <Lock className="size-4" />,
                title: shareScopeLabel('private'),
                description: copy.create.share.private.body,
              },
              {
                value: 'group',
                icon: <Users className="size-4" />,
                title: shareScopeLabel('group', ownerGroupName),
                description: copy.create.share.group.body,
                children: (
                  <form.Field name="shareGroupIds" validators={{ onChange: shareSchema.shape.shareGroupIds }}>
                    {(field) => (
                      <div className="max-w-md">
                        <GroupChecklist
                          groups={groups}
                          selected={effectiveShareGroupIds({ shareGroupIds: field.state.value, groupId })}
                          onChange={(ids) => field.handleChange(ids)}
                          legend={copy.create.share.groupPick}
                          error={firstError(field.state.meta.errors)}
                          idPrefix="share-groups"
                        />
                      </div>
                    )}
                  </form.Field>
                ),
              },
              {
                value: 'company',
                icon: <Building2 className="size-4" />,
                title: shareScopeLabel('company'),
                description: copy.create.share.company.body,
              },
              {
                value: 'public',
                icon: <Globe className="size-4" />,
                title: shareScopeLabel('public'),
                description: copy.create.share.public.body,
                disabled: !isConsoleAdmin,
                note: (
                  <span className="inline-flex items-start gap-1.5 text-xs text-amber-800">
                    <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                    {copy.create.share.publicWarning}
                  </span>
                ),
              },
            ]}
          />
        )}
      </form.Field>

      <div className="rounded-lg bg-stone-50 px-4 py-3" aria-live="polite" data-testid="share-preview">
        <p className="text-xs text-stone-500">{text.sharePreview}</p>
        <p className="mt-0.5 text-sm font-medium text-stone-900">{shareText}</p>
      </div>
      <p className="text-sm text-stone-500">※ {copy.create.share.later}</p>
    </div>
  )
}
