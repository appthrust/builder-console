// Step 0: describe the job, choose a business template, or publish existing work.
import type { CreationTools, TemplateSummary } from '../../../model/contracts/catalog'
import { isOneOf } from '../../../model/contracts/build'
import { useStore } from '@tanstack/react-form'
import { ArrowRight, Check, FileSpreadsheet, FolderGit2, Settings, Sparkles } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { copy } from '../../../copy'
import { aiPolicyExplanation } from '../../../copy/ai-policy'
import { DEFAULT_TEMPLATE_ID, templateUsableFor, type CreateEntry } from '../../../model/create'
import { Button, Disclosure, Field, HrefLink, LinkButton, LoadFailed, Notice, Select, Skeleton, TextArea, TextInput } from '../../../ui'
import { text } from '../copy'
import { paths } from '../../../routes/paths'
import { firstError, INTENT_MAX, startSchema, type CreateFormApi } from '../form'
import { joinBusinessTemplates, type BusinessTemplate } from '../templates'

export type EntryBlocks = Record<CreateEntry, string | undefined>

export function StartStep({ form, disabled, loading, catalogFailed, onRetryCatalog, stale, blocked, destinationNotice, setupLink, catalog, codexAvailable, codexUnavailableReason, codexPolicy, onBuild, onCustomize, startingBuild, onTemplate, onExisting, onUseImage }: {
  form: CreateFormApi
  disabled: boolean
  loading: boolean
  catalogFailed: boolean
  onRetryCatalog: () => void
  /** The "could not update" notice while a re-read of the shown catalog failed: every create entry waits for a fresh read. */
  stale: ReactNode
  blocked: EntryBlocks
  /**
   * Why no new repository can be made (no resolved repository destination). Only a Project
   * administrator can set it, so it never carries the platform-setup link.
   */
  destinationNotice?: string
  setupLink: boolean
  catalog: TemplateSummary[]
  codexAvailable: boolean
  codexUnavailableReason?: CreationTools['codexUnavailableReason']
  codexPolicy?: string
  onBuild: () => void
  onCustomize: (template: BusinessTemplate) => void
  startingBuild: boolean
  onTemplate: (id: string) => void
  onExisting: () => void
  onUseImage: () => void
}) {
  const values = useStore(form.store, (state) => state.values)
  const [framework, setFramework] = useState(DEFAULT_TEMPLATE_ID)
  const ready = (entry: CreateEntry) => !disabled && !loading && !catalogFailed && !stale && !blocked[entry]
  const templates = joinBusinessTemplates(catalog)
  // An omitted category is a framework template (canonical rule); an unknown one is neither.
  const frameworks = catalog.filter((item) => (item.category === undefined || isOneOf(item.category, 'framework')) && item.sourceKinds.some((kind) => isOneOf(kind, 'github-template')))
  const setupAction = setupLink ? <LinkButton to="/-/admin/platform" size="sm" icon={<Settings className="size-4" />}>{text.openPlatform}</LinkButton> : undefined
  const reasons = [...new Set([blocked.existing, blocked.template].filter((reason) => reason !== undefined && reason !== destinationNotice))]
  const policyExplanation = aiPolicyExplanation(codexUnavailableReason, codexPolicy)
  const showAi = codexAvailable || Boolean(policyExplanation)

  return (
    <div className="space-y-7">
      {/* Read first: it is why the AI and template entries below are unavailable (existing code still works). */}
      {!loading && !catalogFailed && destinationNotice ? <div data-testid="create-destination-blocked"><Notice tone="warning">{destinationNotice}</Notice></div> : null}
      <div className="space-y-3">
        <form.Field name="intent">
          {(field) => (
            <Field id="create-start-intent" label={copy.create.start.intent}>
              <TextArea id="create-start-intent" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} maxLength={INTENT_MAX} rows={3} placeholder={copy.create.intent.placeholder} />
            </Field>
          )}
        </form.Field>
        {showAi ? <Button onClick={onBuild} tone="primary" loading={startingBuild} disabled={!codexAvailable || Boolean(policyExplanation) || !ready('ai') || !values.intent.trim()} icon={<Sparkles className="size-4" />}>{copy.create.start.build}</Button> : null}
        {/* The destination notice stands once, above, not again under this button. */}
        {showAi && (policyExplanation || (blocked.ai && blocked.ai !== destinationNotice)) && !loading ? <p className="text-sm text-stone-500">{policyExplanation ?? blocked.ai}</p> : null}
      </div>

      <HrefLink href={paths.excel2app()} data-testid="create-excel2app" className="flex w-full items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 text-left hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-accent">
        <FileSpreadsheet aria-hidden className="size-5 shrink-0 text-emerald-700" />
        <span className="min-w-0"><span className="block text-sm font-semibold text-stone-900">{copy.create.start.excel.title}</span><span className="mt-1 block text-xs text-stone-600">{copy.create.start.excel.body}</span></span>
        <ArrowRight aria-hidden className="ml-auto size-4 shrink-0 text-stone-500" />
      </HrefLink>

      <section aria-labelledby="business-templates-title">
        <h3 id="business-templates-title" className="mb-3 text-sm font-semibold text-stone-900">{copy.create.start.popular}</h3>
        {stale ? <div className="mb-3">{stale}</div> : null}
        {loading ? <div className="grid gap-3 sm:grid-cols-2" aria-busy>{[0, 1, 2, 3].map((id) => <Skeleton key={id} className="h-48" />)}</div> : (
          <div className="grid gap-3 sm:grid-cols-2">
            {templates.map((template) => {
              const reason = !templateUsableFor(template, 'github-template')
                ? template.githubTemplate ? copy.create.start.templateNotAdmitted(template.githubTemplate.repository) : copy.create.start.templateUnavailable
                : blocked.template
              // A remembered choice of a template that cannot be used now is not shown as chosen.
              const selected = values.entry === 'template' && values.templateId === template.id && !reason
              const Icon = template.icon
              return (
                <div key={template.id} className="flex flex-col gap-2">
                <button type="button" aria-pressed={selected} disabled={disabled || catalogFailed || Boolean(stale) || Boolean(reason)} onClick={() => onTemplate(template.id)} className={`group relative flex flex-1 flex-col rounded-lg border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-stone-50 ${selected ? 'border-accent bg-accent-soft' : 'border-stone-200 hover:border-stone-400'}`} data-testid={`template-${template.id}`}>
                  {/* A card that cannot be chosen reads as unavailable; why stays at full contrast below. */}
                  <span className="flex flex-col group-disabled:opacity-60">
                    <span className="flex items-center gap-2 font-semibold text-stone-900"><Icon aria-hidden className="size-5 text-accent-strong" />{template.name}{selected ? <Check aria-hidden className="ml-auto size-4 text-accent-strong" /> : null}</span>
                    <span className="mt-2 text-sm leading-relaxed text-stone-600">{template.lead}</span>
                    <span className="mt-3 text-xs font-medium text-stone-500">{copy.create.start.includes}</span>
                    <span className="mt-1 space-y-1 text-xs text-stone-600">{template.includes.map((item) => <span className="block" key={item}>・{item}</span>)}</span>
                  </span>
                  {reason && reason !== destinationNotice ? <span className="mt-3 text-xs leading-relaxed text-amber-800">{reason}</span> : null}
                </button>
                {showAi ? <Button tone="ghost" disabled={!codexAvailable || Boolean(policyExplanation) || !ready('ai')} onClick={() => onCustomize(template)}>{text.customizeWithAi}</Button> : null}
                </div>
              )
            })}
          </div>
        )}
        {catalogFailed ? <LoadFailed onRetry={onRetryCatalog} /> : !loading && templates.length === 0 ? <p className="text-sm text-stone-500">{text.noBusinessTemplates}</p> : null}
      </section>

      {!loading && !catalogFailed ? reasons.map((reason) => <Notice key={reason} tone="warning" actions={setupAction}>{reason}</Notice>) : null}
      <button type="button" onClick={onExisting} disabled={!ready('existing')} className="flex w-full items-center gap-3 rounded-lg border border-stone-200 p-4 text-left hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60">
        <FolderGit2 aria-hidden className="size-5 shrink-0 text-stone-500" />
        <span className="min-w-0"><span className="block text-xs text-stone-500">{copy.create.start.upload.body}</span><span className="mt-1 block text-sm font-semibold text-accent-strong">{copy.create.start.upload.title}</span></span>
        <ArrowRight aria-hidden className="ml-auto size-4 shrink-0" />
      </button>

      <Disclosure title={copy.create.advanced.toggle}>
        <div className="space-y-6">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{copy.create.start.template.title}</h3>
            <Field id="create-framework" label={copy.create.advanced.framework} hint={copy.create.advanced.templateHint}>
              <Select id="create-framework" value={framework} onChange={setFramework} options={frameworks.map((item) => ({ value: item.id, label: item.displayName, disabled: !templateUsableFor(item, 'github-template') }))} disabled={!ready('template')} />
            </Field>
            <Button onClick={() => onTemplate(framework)} disabled={!ready('template') || !frameworks.some((item) => item.id === framework && templateUsableFor(item, 'github-template'))}>{copy.create.advanced.useTemplate}</Button>
          </div>
          <div className="space-y-4 border-t border-stone-100 pt-5">
            <h3 className="text-sm font-semibold">{text.fromImage}</h3>
            <p className="text-sm text-stone-500">{copy.create.advanced.lead}</p>
            <form.Field name="imageRef" validators={{ onChange: startSchema.shape.imageRef }}>
              {(field) => {
                const error = firstError(field.state.meta.errors)
                return <Field id="create-image" label={copy.create.advanced.image} hint={copy.create.advanced.imageHint} error={error}><TextInput id="create-image" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} onBlur={field.handleBlur} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); onUseImage() } }} invalid={Boolean(error)} autoComplete="off" spellCheck={false} className="font-mono" disabled={!ready('image')} /></Field>
              }}
            </form.Field>
            {!loading && !catalogFailed && blocked.image ? <Notice tone="warning" actions={setupAction}>{blocked.image}</Notice> : null}
            <Button onClick={onUseImage} disabled={!ready('image')}>{copy.create.advanced.use}</Button>
          </div>
        </div>
      </Disclosure>
    </div>
  )
}
