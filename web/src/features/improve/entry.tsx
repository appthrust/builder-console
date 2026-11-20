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

/** The words of the entry: 「AIで直す」 by default; a proposer's entry passes its own (ux-design §8). */
export type ImproveWording = { action: string; title: string; description: (app: string) => string }

type ImproveTarget = { app: Pick<BusinessApp, 'displayName'>; stackId: string; projectId: string }

/**
 * Starting a session: the first message is also its first turn, so the AI answers as soon as the page opens.
 * After an unreadable answer the session may exist: `confirmLatest` reads the list back and opens the one that
 * was made; nothing is resent from here.
 */
function useImproveStart({ app, stackId, projectId }: ImproveTarget) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
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
    // the entry resumes it instead of starting another one. Nothing is resent.
    onError: (error) => { if (isResponseContractError(error)) void queryClient.invalidateQueries({ queryKey: buildKeys.drafts(projectId) }) },
  })
  const confirmLatest = async (onFound?: () => void) => {
    const latest = await queryClient.fetchQuery({ ...draftsOptions(projectId), staleTime: 0 }).catch(() => undefined)
    start.reset()
    const made = improvementFor(latest?.data, stackId)
    if (made) { onFound?.(); await navigate({ href: paths.improve(made.id) }) }
  }
  return { start, unconfirmed: isResponseContractError(start.error), confirmLatest }
}

/**
 * 「AIで直す」 on a bound app: resumes the newest open improvement session for the app's stack, or asks what to
 * change and starts one. `initialMessage` starts at once with that text (the build failure's one-click repair);
 * `draft` instead opens the question with that text filled in, to be edited before 「相談をはじめる」.
 */
export function ImproveButton({ app, stackId, projectId, initialMessage, draft, actionLabel, wording, tone = 'primary', refusal }: ImproveTarget & {
  initialMessage?: string; draft?: string; actionLabel?: string
  wording?: ImproveWording; tone?: 'primary' | 'secondary'
  /** A refusal this caller words itself (checked before the generic 412/409 wording); undefined falls through. */
  refusal?: (error: unknown) => string | undefined
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const drafts = useQuery(draftsOptions(projectId))
  const [open, setOpen] = useState(false)
  const oneClick = useImproveStart({ app, stackId, projectId })
  const onClick = async () => {
    if (initialMessage) { oneClick.start.mutate(initialMessage); return }
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
  return <>
    <Button tone={tone} icon={<Sparkles />} onClick={onClick} loading={initialMessage ? oneClick.start.isPending : drafts.isPending} disabled={oneClick.unconfirmed} data-testid={initialMessage ? 'repair-build-with-ai' : 'improve-with-ai'}>{actionLabel ?? wording?.action ?? text.entry.action}</Button>
    {initialMessage && oneClick.start.error ? oneClick.unconfirmed ? <UnconfirmedNotice onConfirm={() => void oneClick.confirmLatest()} /> : <ActionError error={oneClick.start.error} /> : null}
    <ImproveDialog app={app} stackId={stackId} projectId={projectId} open={open} onOpenChange={setOpen} draft={draft} wording={wording} refusal={refusal} />
  </>
}

/**
 * The question 「どこを直しますか？」 and its start. `draft` fills the answer in each time the dialog opens; the
 * person edits it before starting. Opened by a caller of its own (「これを AIで直す」 on a comment), the dialog
 * itself checks for an open session on the stack: that one is resumed instead, since a stack takes one at a time.
 */
export function ImproveDialog({ app, stackId, projectId, open, onOpenChange, draft, wording, refusal }: ImproveTarget & {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft?: string
  wording?: ImproveWording
  refusal?: (error: unknown) => string | undefined
}) {
  const navigate = useNavigate()
  const { start, unconfirmed, confirmLatest } = useImproveStart({ app, stackId, projectId })
  const [intent, setIntent] = useState(draft ?? '')
  // Each opening starts from the caller's draft; without one, what was typed stays across a cancel (as before).
  const [shownOpen, setShownOpen] = useState(open)
  if (shownOpen !== open) {
    setShownOpen(open)
    if (open && draft !== undefined) setIntent(draft)
  }
  const drafts = useQuery({ ...draftsOptions(projectId), enabled: open && draft !== undefined })
  const existing = draft !== undefined ? improvementFor(drafts.data?.data, stackId) : undefined
  const existingProposal = useQuery({ ...proposalOptions(projectId, existing?.proposalId), enabled: open && Boolean(existing?.proposalId) })
  const resumable = existing && !(existingProposal.data && proposalTerminal(existingProposal.data.phase)) ? existing : undefined
  const inputId = useId()
  const status = platformErrorEnvelope(start.error)?.status
  const trimmed = intent.trim()
  const ready = trimmed.length > 0 && trimmed.length <= MAX_LENGTH && !start.isPending && !resumable
  const refused = start.error ? refusal?.(start.error) : undefined
  const change = (next: boolean) => {
    if (start.isPending) return
    if (!next) start.reset()
    onOpenChange(next)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={wording?.title ?? text.entry.title}
      description={(wording?.description ?? text.entry.description)(app.displayName)}
      footer={<>
        <Button onClick={() => change(false)} disabled={start.isPending}>{copy.common.cancel}</Button>
        <Button tone="primary" type="submit" form={`${inputId}-form`} disabled={!ready || unconfirmed} loading={start.isPending}>{text.entry.submit}</Button>
      </>}
    >
      <form id={`${inputId}-form`} className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (ready && !unconfirmed) start.mutate(trimmed) }}>
        {resumable ? (
          <Notice tone="warning" actions={<Button size="sm" onClick={() => { onOpenChange(false); void navigate({ href: paths.improve(resumable.id) }) }}>{text.drafts.resume}</Button>}>
            {text.entry.openSession}
          </Notice>
        ) : null}
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
        {start.error ? refused ? <Notice tone="error">{refused}</Notice>
          : status === 412 ? <Notice tone="error">{platformErrorEnvelope(start.error)?.code === 'reviewers_unavailable' ? text.entry.noReviewers : text.entry.noSource}</Notice>
            : status === 409 ? <Notice tone="error">{text.entry.busy}</Notice>
              : unconfirmed ? <UnconfirmedNotice onConfirm={() => void confirmLatest(() => onOpenChange(false))} /> : <ActionError error={start.error} /> : null}
      </form>
    </Dialog>
  )
}
