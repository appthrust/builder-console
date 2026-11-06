// Step 3 確認して作る: one sentence of what will be made, the answers, and the
// 詳しい人向け pieces (ひな形 choice, the image reference).
import { useStore } from '@tanstack/react-form'
import { useEffect, type ReactNode } from 'react'
import { copy } from '../../../copy'
import { Button, Disclosure, focusHeading, Notice } from '../../../ui'
import { text } from '../copy'
import type { CreateFormApi } from '../form'
import { SummaryList } from './summary-list'

export function ConfirmStep({
  form,
  url,
  groupName,
  shareText,
  templateName,
  sourceProblem,
  onChooseTemplate,
}: {
  form: CreateFormApi
  /** `https://<urlName>.<domain>`. */
  url: string | undefined
  groupName: string
  shareText: string
  templateName: string | undefined
  sourceProblem: string | undefined
  onChooseTemplate: () => void
}) {
  const values = useStore(form.store, (state) => state.values)
  useEffect(() => {
    if (!sourceProblem) return
    focusHeading('create-template-problem')
    document.getElementById('create-template-problem')?.scrollIntoView({ block: 'nearest' })
  }, [sourceProblem])
  const rows: Array<[string, ReactNode]> = [
    ...(values.entry === 'template' && templateName ? [[copy.create.confirm.labels.template, templateName] as [string, ReactNode]] : []),
    ...(values.entry === 'existing' && values.repository
      ? [[copy.create.confirm.labels.repository, <span className="font-mono">{values.repository.fullName}</span>] as [string, ReactNode]]
      : []),
    [copy.create.details.name, values.displayName],
    [copy.create.confirm.labels.description, values.description || '—'],
    [copy.create.confirm.labels.tags, values.tags.length > 0 ? values.tags.join(text.tagSeparator) : '—'],
    [copy.create.details.group, groupName],
    [copy.app.settings.share, shareText],
    [copy.create.confirm.url, <span className="font-mono">{url ?? '—'}</span>],
  ]
  return (
    <div className="space-y-5">
      {sourceProblem ? (
        <div id="create-template-problem" tabIndex={-1} className="focus:outline-none">
          <Notice tone="error" actions={<Button size="sm" onClick={onChooseTemplate}>{text.chooseTemplate}</Button>}>
            {sourceProblem}
          </Notice>
        </div>
      ) : null}
      <p className="text-base leading-relaxed text-stone-900" data-testid="confirm-summary">
        {copy.create.confirm.summary(values.displayName, groupName, shareText)}
      </p>
      <SummaryList rows={rows} />
      {values.entry === 'image' ? (
        <Disclosure title={copy.create.advanced.toggle}>
          <p className="font-mono text-sm break-all text-stone-800">{values.imageRef.trim()}</p>
        </Disclosure>
      ) : null}
    </div>
  )
}
