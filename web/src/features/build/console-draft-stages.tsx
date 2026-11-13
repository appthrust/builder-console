// A console-v1 session from its plan onward (APT-753, design "計画生成以降は
// Platform に残す"): the conversation stays the Console session's; the plan,
// the creation execution, the implementation and publishing are the Platform
// draft the session points to (`session.draftId`), driven by the same shared
// creation as the legacy engine (use-draft-creation). Nothing here sends a
// Platform conversation turn, asks for a plan by text, or infers the published
// name: it is the typed publish preference (the server writes it to the draft).
//
// 「この内容で作る」 is offered only for a current plan (`session.plan`, not stale);
// a stale plan asks for re-planning with the typed plan action; without a plan
// there is nothing to create from.
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { buildDraftOptions } from '../../api/queries/build'
import { buildSessionKeys } from '../../api/queries/build-sessions'
import { isSessionExpiredError, sessionExpiryStore } from '../../api/session-expiry'
import { buildCopy } from '../../model/build/copy'
import { planProposal } from '../../model/build/messages'
import { isBuildPending } from '../../model/build/progress'
import { planReadiness } from '../../model/build/replies'
import { parseSpec } from '../../model/build/spec'
import { deriveStage } from '../../model/build/stage'
import type { BuildFailure, BuildStage } from '../../model/build/types'
import type { BuildDraft, BuildExecutionStep } from '../../model/contracts/build'
import type { Group, Me } from '../../model/contracts/console'
import { setArtifactCollapsed } from '../../shell/store'
import { ActionError, Button, Notice } from '../../ui'
import { DatabaseChanges } from '../app/database-changes'
import { canEditApp } from '../app/permissions'
import { ArtifactPane } from './artifact-pane'
import { readConsoleCreation, saveConsoleCreation } from './console-session-state'
import type { ConsoleBuildView } from './console-view'
import { AiTurn } from './conversation-pane'
import { text } from './copy'
import { implemented } from './implement'
import { ProposalBody } from './proposal'
import { PublishStep } from './publish-step'
import { StageAction } from './session-header'
import { useCreatedAppView } from './use-created-app-view'
import type { ConsoleBuildActions } from './use-console-build-session'
import { draftFailure, useDraftCreation, useDraftCreationEffects, writeDraft, type CreationContext, type CreationTab } from './use-draft-creation'

/** What the plan and creation add to the console-v1 layout. */
export interface ConsoleStages {
  /** The rail's step: 決める while planning/planned, then the draft's own build/publish stage. */
  stage: BuildStage
  released: boolean
  /** The header's stage action once building started (公開する, progress); undefined keeps the plan action. */
  headerAction?: ReactNode
  /** The plan's proposal under the conversation, with 「この内容で作る」 or the re-plan action. */
  conversationEnd?: ReactNode
  /** What is being built, once the creation started; undefined keeps the specification pane. */
  artifact?: ReactNode
  notices: ReactNode[]
  /** The composer is closed because building started. */
  closed: boolean
}

export function useConsoleDraftStages({ view, actions, draft: observed, me, groups, onOpenArtifact }: {
  view: ConsoleBuildView
  actions: ConsoleBuildActions
  draft: BuildDraft
  me: Me
  groups: Group[]
  onOpenArtifact(): void
}): ConsoleStages {
  const { projectId } = me
  const { session } = view
  const queryClient = useQueryClient()
  // A write's answer reaches the draft cache before React Query notifies the page (see useBuildSession).
  const draft = queryClient.getQueryData<BuildDraft>(buildDraftOptions(projectId, observed.id).queryKey) ?? observed
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [tab, setTab] = useState<CreationTab>(() => readConsoleCreation(draft.id) ?? { groupId: session.groupId, prepareRequested: false, reusePlan: false })
  const tabRef = useRef(tab)
  const [failure, setFailure] = useState<{ failure: BuildFailure; context: CreationContext }>()
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [sharing, setSharing] = useState(false)
  const lock = useRef(false)
  const observedFailures = useRef(new Set<string>())
  const readiness = planReadiness(session)
  const spec = useMemo(() => parseSpec(session.specification.markdown).spec, [session.specification.markdown])

  const creation = useDraftCreation({ projectId, draft, tab, hasPending: false, now })
  const { app, appProgress, generation, execution, implementation, published } = creation
  const running = [generation, execution].some(isBuildPending)
  const result = deriveStage({ draft, generation, execution, appProgress, implementation: { phase: implementation.state.phase, done: implementation.state.phase === 'done', implemented: implemented(implementation.state), activityTail: implementation.state.activityTail }, published, now })

  function patch(next: Partial<CreationTab>) {
    tabRef.current = { ...tabRef.current, ...next }
    setTab(tabRef.current)
    saveConsoleCreation(draft.id, tabRef.current)
  }
  function fail(error: unknown, context: CreationContext, at = new Date().toISOString(), failedStep?: BuildExecutionStep) {
    const preparationExecution = context === 'prepare' ? draftRef.current.creationExecutions.at(-1) : undefined
    const next = draftFailure(error, context, { draftId: draft.id, at, ...(preparationExecution ? { executionId: preparationExecution.id } : {}) }, failedStep)
    // An answer this console cannot read may have happened: read the draft back; only that re-read is offered.
    if (next.kind === 'unconfirmed') void queryClient.invalidateQueries({ queryKey: buildDraftOptions(projectId, draft.id).queryKey })
    setFailure({ failure: next, context })
  }
  async function perform(context: CreationContext, action: () => Promise<void>) {
    if (lock.current || sessionExpiryStore.state) return
    lock.current = true
    setBusy(true)
    try { await action() } catch (error) { if (!isSessionExpiredError(error)) fail(error, context) } finally { lock.current = false; setBusy(false) }
  }

  const effects = useDraftCreationEffects(creation, {
    projectId, groupId: session.groupId, draft, draftRef, tab, currentTab: () => tabRef.current, patch,
    receive: (next) => writeDraft(queryClient, projectId, draftRef, next), perform, fail, clearFailure: () => setFailure(undefined),
    busy, lock, failure: failure?.failure, running, unsupported: Boolean(result.unsupported) || view.unsupported,
    // Never from a plan that is missing or stale, and never while the conversation has a turn open.
    holdPreparation: readiness.kind !== 'current' || Boolean(session.activeTurnId), observedFailures,
    displayName: draft.publishPreferences?.name ?? spec.name ?? draft.title, description: spec.oneLine ?? '',
  })

  useEffect(() => {
    if (!running && !tab.prepareRequested && !appProgress) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, tab.prepareRequested, Boolean(appProgress)])

  // The server moves the session to `created` once the draft has an execution: read the session again.
  useEffect(() => {
    if (execution) void queryClient.invalidateQueries({ queryKey: buildSessionKeys.session(session.id), exact: true })
  }, [execution?.id])

  const { appView, creationAccess, released, url, shareText } = useCreatedAppView({ projectId, draft, app, groups, initialReleaseId: tab.initialReleaseId, tasks: implementation.state.tasks })
  const started = Boolean(execution || draft.createdApplicationStackId)
  const proposal = planProposal(creation.proposalDraft)
  const preparing = tab.prepareRequested && !execution
  const canCreate = readiness.kind === 'current' && !started && !creation.defaultPending && !busy && !view.write && !session.activeTurnId && !view.unsupported
  const proposalAction = started ? undefined
    : readiness.kind === 'current' ? <Button tone="primary" loading={preparing} disabled={!canCreate || preparing} onClick={effects.prepare}>{buildCopy.primary.prepare}</Button>
      : readiness.kind === 'stale' ? <div className="space-y-2" data-testid="console-plan-stale">
        <p className="text-xs leading-relaxed text-busy-ink">{text.console.plan.stale}</p>
        <Button disabled={!view.canRequestPlan} onClick={() => actions.requestPlan()}>{text.console.plan.replan}</Button>
      </div> : undefined
  const primary = result.primary.action === 'publish' ? { ...result.primary, enabled: result.primary.enabled && !busy && !sharing } : { action: 'none' as const, label: '', enabled: false }
  const retry = failure && failure.failure.kind !== 'policy'
    ? <Button size="sm" onClick={() => {
      const { context, failure: shown } = failure
      setFailure(undefined)
      effects.resetBinding()
      if (shown.kind === 'unconfirmed') void queryClient.invalidateQueries({ queryKey: buildDraftOptions(projectId, draft.id).queryKey })
      else if (context !== 'plan') effects.retry(context)
    }}>{failure.failure.kind === 'unconfirmed' ? buildCopy.failure.confirm : text.conversation.retry}</Button> : undefined

  return {
    stage: started ? result.stage : 'decide',
    released,
    ...(started ? { headerAction: <StageAction stage={result.stage} primary={primary} progress={result.progress} onPrimary={() => { setSharing(true); onOpenArtifact() }} /> } : {}),
    ...(readiness.kind !== 'none' && proposal ? { conversationEnd: <AiTurn><ProposalBody proposal={{ ...proposal, stale: false }} action={proposalAction} /></AiTurn> } : {}),
    ...(started ? {
      // The failure is one page notice with its retry; the pane does not repeat it.
      artifact: <ArtifactPane draft={draft} spec={spec} proposal={proposal} stage={result.stage} progress={result.progress} implementation={implementation.state}
        url={url} shareText={shareText} previewDatabaseReset={implementation.previewDatabaseReset} onOpenPreview={onOpenArtifact} onRetry={implementation.retry} onSkipTask={implementation.skipTask} onConfirm={implementation.confirm}
        onCollapse={() => setArtifactCollapsed(true)}
        databaseChanges={<DatabaseChanges projectId={projectId} databaseId={app && canEditApp(app, me) ? appView?.stack?.databaseComponentId : undefined} />}
        shareStep={sharing && app ? <PublishStep app={app} publishId={appView?.platform?.publish?.id} publishPreferences={draft.publishPreferences} onPublished={() => { void effects.markPublished(); setSharing(false) }} onCancel={() => setSharing(false)} /> : undefined} />,
    } : {}),
    notices: [
      failure ? <Notice key="creation-failure" tone={failure.failure.kind === 'unconfirmed' ? 'warning' : 'error'} title={failure.failure.title} actions={retry}>{failure.failure.reason}</Notice> : null,
      creationAccess.error ? <ActionError key="creation-access" error={creationAccess.error} /> : null,
      effects.waitingForPublish || creationAccess.waitingForPublish ? <p key="waiting-publish" role="status" className="text-xs text-stone-500">{text.page.waitingForPublish}</p> : null,
    ].filter(Boolean),
    closed: started,
  }
}
