import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { useId, useState } from 'react'
import { isResponseContractError } from '../../api/boundary'
import { createDraft, createTurn } from '../../api/build'
import { buildKeys, draftsOptions } from '../../api/queries/build'
import type { BusinessApp } from '../../model/contracts/console'
import { platformErrorEnvelope } from '../../api/platform-error'
import { copy } from '../../copy'
import { improvementFor } from '../../model/improve'
import { paths } from '../../routes/paths'
import { ActionError, Button, Dialog, Field, Notice, TextArea } from '../../ui'
import { MAX_LENGTH } from '../build/composer'
import { text } from './copy'
import { UnconfirmedNotice } from '../build/unconfirmed-notice'
import { proposalOptions } from '../../api/queries/proposal'
import { proposalTerminal } from '../proposals/model'

/**
 * 「AIで直す」 on a bound app: resumes the newest open improvement session for
 * the app's stack, or asks what to change and starts one. The first message is
 * also the session's first turn, so the AI answers as soon as the page opens.
 */
export function ImproveButton({ app, stackId, projectId, initialMessage, actionLabel }: {
  app: Pick<BusinessApp, 'displayName'>; stackId: string; projectId: string
  initialMessage?: string; actionLabel?: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const drafts = useQuery({ ...draftsOptions(projectId), enabled: !initialMessage })
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState('')
  const inputId = useId()
  const start = useMutation({
    mutationFn: async (message: string) => {
      const draft = await createDraft(projectId, { kind: 'improvement', applicationStackId: stackId, intent: message, title: app.displayName })
      // The session exists from here on: a refused first turn is sent again from the session's composer.
      await createTurn(projectId, draft.id, { message }).catch(() => undefined)
      return draft
    },
    onSuccess: async (draft) => {
      void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(projectId) })
      await navigate({ href: paths.improve(draft.id) })
    },
    // The session may have been created even though its answer could not be read: read the list back so
    // the button resumes it instead of starting another one. Nothing is resent.
    onError: (error) => { if (isResponseContractError(error)) void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(projectId) }) },
  })
  const status = platformErrorEnvelope(start.error)?.status
  const unconfirmed = isResponseContractError(start.error)
  /** After an unreadable start: read the sessions back and open the one that was made; never start another from here. */
  const confirmLatest = async () => {
    const latest = await queryClient.fetchQuery({ ...draftsOptions(projectId), staleTime: 0 }).catch(() => undefined)
    start.reset()
    const made = improvementFor(latest?.data, stackId)
    if (made) { setOpen(false); await navigate({ href: paths.improve(made.id) }) }
  }
  const trimmed = intent.trim()
  const ready = trimmed.length > 0 && trimmed.length <= MAX_LENGTH && !start.isPending
  const onClick = async () => {
    if (initialMessage) { start.mutate(initialMessage); return }
    const existing = improvementFor(drafts.data?.data, stackId)
    if (existing?.proposalId) {
      try {
        const proposal = await queryClient.fetchQuery(proposalOptions(projectId, existing.proposalId))
        if (proposalTerminal(proposal.phase)) { setOpen(true); return }
      } catch {
        // The session owns the read error and its retry, never create a duplicate.
      }
    }
    if (existing) void navigate({ href: paths.improve(existing.id) })
    else setOpen(true)
  }
  const change = (next: boolean) => {
    if (start.isPending) return
    if (!next) start.reset()
    setOpen(next)
  }
  return <>
    <Button tone="primary" icon={<Sparkles />} onClick={onClick} loading={initialMessage ? start.isPending : drafts.isPending} disabled={unconfirmed} data-testid={initialMessage ? 'repair-build-with-ai' : 'improve-with-ai'}>{actionLabel ?? text.entry.action}</Button>
    {initialMessage && start.error ? unconfirmed ? <UnconfirmedNotice onConfirm={() => void confirmLatest()} /> : <ActionError error={start.error} /> : null}
    <Dialog
      open={open}
      onOpenChange={change}
      title={text.entry.title}
      description={text.entry.description(app.displayName)}
      footer={<>
        <Button onClick={() => change(false)} disabled={start.isPending}>{copy.common.cancel}</Button>
        <Button tone="primary" type="submit" form={`${inputId}-form`} disabled={!ready || unconfirmed} loading={start.isPending}>{text.entry.submit}</Button>
      </>}
    >
      <form id={`${inputId}-form`} className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (ready && !unconfirmed) start.mutate(trimmed) }}>
        <Field id={inputId} label={text.entry.label}>
          <TextArea
            id={inputId}
            value={intent}
            rows={4}
            maxLength={MAX_LENGTH}
            placeholder={text.entry.placeholder}
            onChange={(event) => setIntent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ready && !unconfirmed) { event.preventDefault(); start.mutate(trimmed) }
            }}
          />
        </Field>
        {start.error ? status === 412 ? <Notice tone="error">{platformErrorEnvelope(start.error)?.code === 'reviewers_unavailable' ? text.entry.noReviewers : text.entry.noSource}</Notice>
          : status === 409 ? <Notice tone="error">{text.entry.busy}</Notice>
            : unconfirmed ? <UnconfirmedNotice onConfirm={() => void confirmLatest()} /> : <ActionError error={start.error} /> : null}
      </form>
    </Dialog>
  </>
}
