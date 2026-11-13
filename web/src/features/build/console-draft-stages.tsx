// A console-v1 session from its plan onward (APT-753, design "計画生成以降は
// Platform に残す"): the conversation stays the Console session's; the plan,
// the creation execution, the implementation and publishing are the Platform
// draft the session points to (`session.draftId`), driven by the same shared
// creation as the legacy engine (use-draft-creation), including its
// name-collision recovery (NameChoice). Nothing here sends a Platform
// conversation turn, asks for a plan by text, or infers the published name.
//
// 「この内容で作る」 is offered only for a current plan (`session.plan`, not stale);
// a stale plan asks for re-planning with the typed plan action; without a plan
// there is nothing to create from. Once the session is created, the typed
// publish name and audience are asked where the legacy flow ran its hidden
// preparation turn (design §12); 公開する waits until they are saved and applied.
// A published app is changed further with 「AIで直す」 (a created session takes
// no more spec turns), as is an app created from an earlier specification.
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
import { ConsolePublishSettings, publishReady } from './console-publish-settings'
import { readConsoleCreation, saveConsoleCreation } from './console-session-state'
import type { ConsoleBuildView } from './console-view'
import { AiTurn } from './conversation-pane'
import { text } from './copy'
import { implemented } from './implement'
import { NameChoice } from './name-choice'
import { ProposalBody } from './proposal'
import { PublishStep } from './publish-step'
import { StageAction } from './session-header'
import { useCreatedAppView } from './use-created-app-view'
import type { ConsoleBuildActions } from './use-console-build-session'
import { draftFailure, useDraftCreation, useDraftCreationEffects, writeDraft, type CreationContext, type CreationTab } from './use-draft-creation'
import { useNameSuggestion } from './use-name-suggestion'
import { ImproveButton } from '../improve/entry'

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
  const created = session.lifecycle.kind === 'known' && session.lifecycle.value === 'created'
  const proposal = planProposal(creation.proposalDraft)
  const preparing = tab.prepareRequested && !execution
  const canCreate = readiness.kind === 'current' && !started && !creation.defaultPending && !busy && !view.write && !session.activeTurnId && !view.unsupported
  const proposalAction = started ? undefined
    : readiness.kind === 'current' ? <Button tone="primary" loading={preparing} disabled={!canCreate || preparing} onClick={effects.prepare}>{buildCopy.primary.prepare}</Button>
      : readiness.kind === 'stale' ? <div className="space-y-2" data-testid="console-plan-stale">
        <p className="text-xs leading-relaxed text-busy-ink">{text.console.plan.stale}</p>
        <Button tone="primary" disabled={!view.canRequestPlan} onClick={() => actions.requestPlan()}>{text.console.plan.replan}</Button>
      </div> : undefined

  // The typed publish preferences are the server's once saved; the publish step starts from the draft they were written to.
  // Asked once the creation has finished (the legacy flow wrote them then too): the Platform draft takes them only then.
  // While the publish step is open it carries the same name and audience (started from these), so they are not shown twice.
  const askPublish = created && Boolean(draft.createdApplicationStackId) && !running && !published && !sharing
  const publishSaved = publishReady(view.publish)
  useEffect(() => {
    if (publishSaved) void queryClient.invalidateQueries({ queryKey: buildDraftOptions(projectId, draft.id).queryKey, exact: true })
  }, [publishSaved, view.publish?.desired.name, view.publish?.desired.shareScope])
  const primary = result.primary.action === 'publish' ? { ...result.primary, enabled: result.primary.enabled && publishSaved && !busy && !sharing } : { action: 'none' as const, label: '', enabled: false }

  // 「AIで直す」 needs the created stack and a finished first build (公開する is offered); a published app gets it in the header.
  const improveName = app?.displayName ?? draft.publishPreferences?.name ?? spec.name ?? draft.title
  const continuing = result.primary.action === 'continue'
  const improvable = Boolean(draft.createdApplicationStackId) && ((result.primary.action === 'publish' && result.primary.enabled) || continuing || published)
  const improve = improvable ? <ImproveButton app={{ displayName: improveName }} stackId={draft.createdApplicationStackId!} projectId={projectId} /> : undefined
  const earlierSpec = created && session.plan?.stale === true

  // A URL or repository name another app holds: the shared recovery renames and prepares again (legacy NameChoice).
  const suggestion = useNameSuggestion(draft, failure?.failure, groups.find((group) => group.id === session.groupId)?.path)
  const shown = failure?.failure.reasonCode === 'PublishURLConflict' ? { ...failure.failure, suggestedName: suggestion } : failure?.failure
  const retry = failure && shown?.kind === 'name-taken'
    // The checked suggestion arrives after the failure: start over with it offered instead of an open field.
    ? <NameChoice key={shown.suggestedName ?? ''} suggestion={shown.suggestedName} onUse={(name) => effects.rename(name, failure.failure, () => setFailure(undefined))} />
    : failure && failure.failure.kind !== 'policy'
      ? <Button size="sm" onClick={() => {
        const { context, failure: reported } = failure
        setFailure(undefined)
        effects.resetBinding()
        if (reported.kind === 'unconfirmed') void queryClient.invalidateQueries({ queryKey: buildDraftOptions(projectId, draft.id).queryKey })
        else if (context !== 'plan') effects.retry(context)
      }}>{failure.failure.kind === 'unconfirmed' ? buildCopy.failure.confirm : text.conversation.retry}</Button> : undefined

  return {
    stage: started ? result.stage : 'decide',
    released,
    ...(started ? { headerAction: continuing && improve ? improve : <StageAction stage={result.stage} primary={primary} progress={result.progress} onPrimary={() => { setSharing(true); onOpenArtifact() }} /> } : {}),
    ...((readiness.kind !== 'none' && proposal) || askPublish ? {
      conversationEnd: <>
        {readiness.kind !== 'none' && proposal ? <AiTurn><ProposalBody proposal={{ ...proposal, stale: false }} action={proposalAction} /></AiTurn> : null}
        {askPublish ? <AiTurn><ConsolePublishSettings view={view} actions={actions} disabled={view.unsupported} /></AiTurn> : null}
      </>,
    } : {}),
    ...(started ? {
      // The failure is one page notice with its retry; the pane does not repeat it (a failed preparation's card says the same).
      artifact: <ArtifactPane draft={draft} spec={spec} proposal={proposal} stage={result.stage} progress={failure?.context === 'prepare' ? undefined : result.progress} implementation={implementation.state}
        url={url} shareText={shareText} previewDatabaseReset={implementation.previewDatabaseReset} onOpenPreview={onOpenArtifact} onRetry={implementation.retry} onSkipTask={implementation.skipTask} onConfirm={implementation.confirm}
        onCollapse={() => setArtifactCollapsed(true)}
        databaseChanges={<DatabaseChanges projectId={projectId} databaseId={app && canEditApp(app, me) ? appView?.stack?.databaseComponentId : undefined} />}
        shareStep={sharing && app ? <PublishStep app={app} publishId={appView?.platform?.publish?.id} publishPreferences={draft.publishPreferences} onPublished={() => { void effects.markPublished(); setSharing(false) }} onCancel={() => setSharing(false)} /> : undefined} />,
    } : {}),
    notices: [
      earlierSpec ? <Notice key="earlier-spec" tone="warning" title={text.console.createdFromEarlier.title} actions={continuing ? undefined : improve}>
        {improvable ? text.console.createdFromEarlier.reason : text.console.createdFromEarlier.waiting}
      </Notice> : null,
      failure && shown ? <Notice key="creation-failure" tone={shown.kind === 'unconfirmed' ? 'warning' : 'error'} title={shown.title} actions={retry}>{shown.reason}</Notice> : null,
      creationAccess.error ? <ActionError key="creation-access" error={creationAccess.error} /> : null,
      effects.waitingForPublish || creationAccess.waitingForPublish ? <p key="waiting-publish" role="status" className="text-xs text-stone-500">{text.page.waitingForPublish}</p> : null,
    ].filter(Boolean),
    closed: started,
  }
}
