// Step 3 確認して作る: one sentence of what will be made, the answers, where
// the repository and its image go, and the 詳しい人向け pieces (ひな形
// choice, the image reference).
import { useStore } from '@tanstack/react-form'
import { useEffect, type ReactNode } from 'react'
import { copy } from '../../../copy'
import { Button, Disclosure, focusHeading, Notice } from '../../../ui'
import { text } from '../copy'
import type { CreateFormApi } from '../form'
import { SummaryList } from './summary-list'

/** 作ったコードから: the image path from Platform's validation of the adoption, while it is read. */
export type AdoptionImage = { kind: 'checking' } | { kind: 'known'; path: string } | { kind: 'unknown' }

/**
 * The repository an earlier attempt made for this source (`created`, reused where it is) or sent a create for whose
 * outcome is unknown (`pending`, resent exactly there; `held` once that resend was refused, nothing is sent and the
 * wizard's notice says why); `checking` / `unknown` = progress saved without where it is, being read back / not showable.
 */
export type KeptSourceState = 'created' | 'pending' | 'held' | 'checking' | 'unknown'

export function ConfirmStep({
  form,
  url,
  groupName,
  shareText,
  templateName,
  sourceProblem,
  onChooseTemplate,
  newRepository,
  kept,
  onStartOver,
  startingOver,
  destinationBlocked,
  adoptionImage,
}: {
  form: CreateFormApi
  /** `https://<urlName>.<domain>`. */
  url: string | undefined
  groupName: string
  shareText: string
  templateName: string | undefined
  sourceProblem: string | undefined
  onChooseTemplate: () => void
  /** ひな形: where the repository is made and its image pushed: the resolved destination shown before 作る, or the earlier attempt's (`kept`). */
  newRepository?: { repository: string; image?: string }
  kept?: KeptSourceState
  /** `kept: 'unknown'`: leave the earlier repository unused and create a new one at the current destination. */
  onStartOver?: () => void
  startingOver?: boolean
  /** ひな形: no destination is resolved, so nothing is created. */
  destinationBlocked?: boolean
  adoptionImage?: AdoptionImage
}) {
  const values = useStore(form.store, (state) => state.values)
  useEffect(() => {
    if (!sourceProblem) return
    focusHeading('create-template-problem')
    document.getElementById('create-template-problem')?.scrollIntoView({ block: 'nearest' })
  }, [sourceProblem])
  const mono = (value: string) => <span className="font-mono break-all">{value}</span>
  const adoptionImageValue = adoptionImage?.kind === 'known' ? mono(adoptionImage.path)
    : adoptionImage?.kind === 'checking' ? <span className="text-stone-500">{text.destination.imageChecking}</span>
      : <span className="text-stone-500">{text.destination.imageUnknown}</span>
  const rows: Array<[string, ReactNode]> = [
    ...(values.entry === 'template' && templateName ? [[copy.create.confirm.labels.template, templateName] as [string, ReactNode]] : []),
    ...(values.entry === 'template' && newRepository
      ? [
          [kept === 'created' ? text.destination.created : kept === 'pending' || kept === 'held' ? text.destination.pending : text.destination.repository, mono(newRepository.repository)],
          [text.destination.image, newRepository.image ? mono(newRepository.image) : <span className="text-stone-500">{text.destination.imageUnknown}</span>],
        ] as Array<[string, ReactNode]>
      : []),
    ...(values.entry === 'existing' && values.repository
      ? [[copy.create.confirm.labels.repository, mono(values.repository.fullName)], [text.destination.image, adoptionImageValue]] as Array<[string, ReactNode]>
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
      {values.entry === 'template' && destinationBlocked ? (
        <div data-testid="create-destination-blocked"><Notice tone="warning">{text.destination.blocked}</Notice></div>
      ) : null}
      <p className="text-base leading-relaxed text-stone-900" data-testid="confirm-summary">
        {copy.create.confirm.summary(values.displayName, groupName, shareText)}
      </p>
      <SummaryList rows={rows} />
      {kept && kept !== 'held' && values.entry !== 'image' ? (
        <div data-testid="create-kept-source">
          {kept === 'created' ? <Notice>{text.destination.createdNote}</Notice>
            : kept === 'pending' ? <Notice tone="warning">{text.destination.pendingNote}</Notice>
              : kept === 'checking' ? <p role="status" className="text-sm text-stone-500">{text.destination.retainedChecking}</p>
                : (
                  <Notice tone="warning" actions={onStartOver ? <Button size="sm" loading={startingOver} onClick={onStartOver}>{text.destination.startOver}</Button> : undefined}>
                    {text.destination.retainedUnknown}
                  </Notice>
                )}
        </div>
      ) : null}
      {values.entry === 'image' ? (
        <Disclosure title={copy.create.advanced.toggle}>
          <p className="font-mono text-sm break-all text-stone-800">{values.imageRef.trim()}</p>
        </Disclosure>
      ) : null}
    </div>
  )
}
