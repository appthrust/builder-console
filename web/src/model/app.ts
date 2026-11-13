// Pure derivation from Platform API read models to the console view model.
// This is the only module that interprets status vocabulary
// (component statusKey/reasonKey, publish phase, release phase).
import type { OpenValue } from '../api/boundary'
import type { AppPublish, AppRelease, AppStack, ComponentSummary, PlatformApplication, PublishPhase, ReleaseOverview, ReleasePhase, ReleaseState } from './contracts/app'
import type { BusinessApp } from './contracts/console'
import { copy, relativeTime, reasonHelp, reasonText, type ConsoleStatus } from '../copy'
import { text as appText } from '../features/app/copy'
import { buildCopy } from './build/copy'
import { isProductLanguage } from './build/wording'
import { isOneOf, knownValue, type ImplementationRun, type ImplementationTask } from './contracts/build'

export type { ConsoleStatus }

export interface ConsoleRelease {
  id: string
  version: string
  /** A phase this console does not know is never read as succeeded, failed or in flight. */
  phase: OpenValue<ReleasePhase>
  phaseText: string
  /** finishedAt → startedAt → createdAt; the most meaningful moment for a user. */
  at?: string
  createdAt?: string
  failureReason?: string
}

export interface ConsoleApp {
  id: string
  name: string
  status: ConsoleStatus
  statusText: string
  /** What the user can do about a failure, when its reason has a specific next action. */
  help?: string
  url?: string
  /** Same selected publish that supplies the displayed app URL. */
  publish?: AppPublish
  lastRelease?: ConsoleRelease
  webComponentId?: string
  /** Port the platform resolved for the web component (explicit or from the image); 「詳しい人向け」 only. */
  webPort?: number
  stackId?: string
  branchId: string
  /** Raw progress facts for the creating view (src/model/progress.ts). */
  facts: ConsoleAppFacts
}

export interface ConsoleAppFacts {
  /** The web component reports Ready. */
  webReady: boolean
  /** Known phases only: an unknown phase is absent, never read as succeeded or failed. */
  webReleasePhase?: ReleasePhase
  /** Any component has a Succeeded release: the app has been up at least once. */
  everReleased: boolean
  hasPublish: boolean
  /** Known phases only, like `webReleasePhase`. */
  publishPhase?: PublishPhase
}

export interface ConsoleAppSources {
  application: PlatformApplication
  /** The stack bound to the Console app, not an arbitrary stack of its Application. */
  stack?: AppStack
  publishes: readonly AppPublish[]
  componentSummaries: readonly ComponentSummary[]
  /** Release overview for this application; undefined while unknown. */
  releases?: ReleaseOverview
}

/** What the app status needs of a source repository: whether its last image build failed (known evidence only). */
export interface SourceRepositoryFacts {
  id: string
  buildFailed: boolean
}

export interface ConsoleAppsInput {
  applications: readonly PlatformApplication[]
  stacks: readonly AppStack[]
  publishes: readonly AppPublish[]
  componentSummaries: readonly ComponentSummary[]
  releasesByApplication: Readonly<Record<string, ReleaseOverview | undefined>>
  sourceRepositories?: readonly SourceRepositoryFacts[]
}

export interface VersionLabel {
  n: number
  label: `v${number}`
  at: string
}

/** Stable per-app release numbering, independent of response order and completion time. */
export function versionLabel(
  releases: readonly Pick<AppRelease, 'id' | 'createdAt' | 'startedAt'>[],
  releaseId: string | undefined
): VersionLabel | undefined {
  const ordered = [...releases].sort((a, b) =>
    (a.createdAt ?? a.startedAt ?? '').localeCompare(b.createdAt ?? b.startedAt ?? '') || a.id.localeCompare(b.id)
  )
  const index = ordered.findIndex((release) => release.id === releaseId)
  const release = ordered[index]
  return release ? { n: index + 1, label: `v${index + 1}`, at: release.createdAt ?? release.startedAt ?? '' } : undefined
}

/** AI-build evidence only; absent for applications made without a build session. */
export interface AppBuildProgress {
  draftId: string
  initialReleaseId?: string
  taskCount: number
  tasks?: readonly Pick<ImplementationTask, 'status'>[]
  run?: ImplementationRun
}

export function implementedReleaseReady(platform: ConsoleApp | undefined, releases: readonly Pick<AppRelease, 'id' | 'componentId' | 'branchId'>[], build: AppBuildProgress): boolean {
  if (!platform?.lastRelease || !isOneOf(platform.lastRelease.phase, 'Succeeded')) return false
  const history = releases.filter((release) => release.componentId === platform.webComponentId && release.branchId === platform.branchId)
  const laterRelease = build.initialReleaseId
    ? platform.lastRelease.id !== build.initialReleaseId
    : history.length >= 2 && history.some((release) => release.id === platform.lastRelease?.id)
  const pushed = build.tasks?.some((task) => isOneOf(task.status, 'done')) === true
  return pushed && laterRelease
}

/** A run or task status this console does not know is never read as stopped, saved or finished: it stays "building". */
function buildStatusText(build: AppBuildProgress): string {
  if (build.run) {
    const run = build.run
    if (isOneOf(run.status, 'failed', 'cancelled')) return appText.build.stopped
    if (isOneOf(run.step, 'pushing') && isOneOf(run.status, 'running')) return appText.build.saving
    const task = run.tasks.find((item) => item.id === run.currentTaskId)
    if (task && isOneOf(run.status, 'pending', 'running')) {
      return appText.build.screen(isProductLanguage(task.title) ? task.title : appText.build.screenFallback)
    }
    if (isOneOf(run.status, 'succeeded') && !run.tasks.some((item) => item.status.kind === 'unknown')) {
      if (run.tasks.some((item) => !isOneOf(item.status, 'done', 'skipped'))) return appText.build.stopped
      return run.tasks.some((item) => isOneOf(item.status, 'done')) ? appText.build.preparing : appText.build.noScreens
    }
  }
  const current = build.tasks?.findIndex((task) => !isOneOf(task.status, 'done', 'skipped')) ?? -1
  const screen = build.tasks ? current < 0 ? build.tasks.filter((task) => isOneOf(task.status, 'done')).length : current + 1 : 0
  return copy.statusText.building(screen, build.taskCount)
}

export function appSecondLine(platform: ConsoleApp, releases: readonly AppRelease[], now = Date.now(), build?: AppBuildProgress): string {
  if (build && (!build.tasks?.length || build.tasks.some((task) => !isOneOf(task.status, 'done', 'skipped')) || !implementedReleaseReady(platform, releases, build))) return buildStatusText(build)
  if (platform.status !== 'live' || !platform.url) return platform.statusText
  const version = versionLabel(releases, platform.lastRelease?.id)
  if (!version) return copy.statusText.live
  const when = relativeTime(version.at, now)
  return copy.statusText.liveVersion(`${version.label}${when ? `・${when}` : ''}`)
}

const IN_FLIGHT_RELEASE_TEXT: Partial<Record<ReleasePhase, string>> = {
  get Pending() { return copy.statusText.releasePending },
  get InProgress() { return copy.statusText.releaseInProgress },
  get WaitingPromotion() { return copy.statusText.releaseWaiting },
}

/** The release phase in words; a phase this console does not know says so instead of guessing. */
export function releasePhaseText(phase: OpenValue<ReleasePhase>): string {
  return phase.kind === 'known' ? copy.releasePhase[phase.value] : appText.unsupported.releasePhase
}

function toConsoleRelease(release: AppRelease): ConsoleRelease {
  return {
    id: release.id,
    version: release.version,
    phase: release.phase,
    phaseText: releasePhaseText(release.phase),
    at: release.finishedAt ?? release.startedAt ?? release.createdAt,
    createdAt: release.createdAt,
    ...(release.failureReason ? { failureReason: release.failureReason } : {}),
  }
}

function releaseTime(release: AppRelease): string {
  return release.createdAt ?? release.startedAt ?? ''
}

/** Application-level release queries use its creation source, never list order. */
export function stackForApplication(
  application: PlatformApplication,
  stacks: readonly AppStack[]
): AppStack | undefined {
  if (isOneOf(application.sourceKind, 'applicationStack') && application.sourceId) {
    return stacks.find((stack) => stack.id === application.sourceId)
  }
  const candidates = stacks.filter((stack) => stack.applicationId === application.id)
  return candidates.length === 1 ? candidates[0] : undefined
}

/** Resolve the Application through the exact persisted Console stack binding. */
export function applicationForStack(stackId: string | null, input: Pick<ConsoleAppsInput, 'applications' | 'stacks'>): PlatformApplication | undefined {
  if (!stackId) return undefined
  const stack = input.stacks.find((item) => item.id === stackId)
  return input.applications.find((item) =>
    item.id === stack?.applicationId ||
    (isOneOf(item.sourceKind, 'applicationStack') && item.sourceId === stackId)
  )
}

/**
 * Publish for the web component: the live publishes list wins over the stack's
 * embedded `publish` snapshot, which is only a creation-time copy.
 */
function publishFor(
  application: PlatformApplication,
  stack: AppStack,
  branchId: string,
  publishes: readonly AppPublish[]
): AppPublish | undefined {
  const scoped = publishes.filter(
    (publish) => publish.applicationId === application.id && publish.branchId === branchId
  )
  return (
    scoped.find((publish) => publish.componentId === stack.webComponentId) ??
    scoped[0] ??
    stack.publish
  )
}

/**
 * Status rules (first match wins):
 * 1. unknown  — deletion observed (Application.deleting or any component
 *               reasonKey=DeletionInProgress), no stack, or no component facts.
 * 2. failed   — a Blocked/Degraded component, a Failed latest release on any
 *               component, or a failed publish.
 * 3. unknown  — a component whose status cannot be observed (statusKey=Unknown).
 * 4. deploying — a Provisioning component, an in-flight latest release, or a
 *               publish that has not succeeded or has no URL yet.
 * 5. live.
 * Status considers every component; the displayed "latest release" is the web
 * component's only.
 */
export function deriveConsoleApp(sources: ConsoleAppSources): ConsoleApp {
  const { application, stack } = sources
  // A per-item projection failure: a reason this console does not know is not a working application either.
  if (application.status.reason) {
    const known = isOneOf(application.status.reason, 'default_branch_unresolved')
    return {
      id: application.id,
      name: application.name,
      branchId: '',
      stackId: stack?.id,
      status: known ? 'failed' : 'unknown',
      statusText: known ? copy.statusText.unresolved : appText.unsupported.status,
      facts: { webReady: false, everReleased: false, hasPublish: false },
    }
  }
  const branchId = stack?.branchId ?? application.defaultBranchId
  const releaseComponents = sources.releases?.branchId === branchId ? sources.releases.components : []
  const publish = stack ? publishFor(application, stack, branchId, sources.publishes) : undefined
  const url = publish?.publicUrl ?? publish?.tailnetUrl
  const components = sources.componentSummaries.filter(
    (component) => component.applicationId === application.id
  )
  const web = components.find((component) => component.id === stack?.webComponentId)
  const latestReleases = releaseComponents.flatMap((component) => {
    const latest = component.latestRelease
    if (!latest) return []
    const ready = components.some((fact) => fact.id === component.id && isOneOf(fact.status, 'Ready'))
    const succeeded = [...component.releases].sort((a, b) => releaseTime(b).localeCompare(releaseTime(a)))
      .find((release) => isOneOf(release.phase, 'Succeeded'))
    // Pending re-application of the already-running version does not stop the app.
    return [ready && isOneOf(latest.phase, 'Pending') && succeeded?.version === latest.version ? succeeded : latest]
  })
  const webRelease = latestReleases.find((release) => release.componentId === stack?.webComponentId)

  const base = {
    id: application.id,
    name: application.name,
    branchId,
    ...(url ? { url } : {}),
    ...(publish ? { publish } : {}),
    ...(webRelease ? { lastRelease: toConsoleRelease(webRelease) } : {}),
    ...(stack?.webComponentId ? { webComponentId: stack.webComponentId } : {}),
    ...(web?.port ? { webPort: web.port } : {}),
    ...(stack ? { stackId: stack.id } : {}),
    facts: {
      webReady: isOneOf(web?.status, 'Ready'),
      ...(webRelease && knownValue(webRelease.phase) ? { webReleasePhase: knownValue(webRelease.phase) } : {}),
      everReleased: releaseComponents.some((component) =>
        component.releases.some((release) => isOneOf(release.phase, 'Succeeded'))
      ),
      hasPublish: publish !== undefined,
      ...(knownValue(publish?.phase) ? { publishPhase: knownValue(publish?.phase) } : {}),
    },
  }
  const result = (status: ConsoleStatus, statusText: string, help?: string): ConsoleApp => ({
    ...base,
    status,
    statusText,
    ...(help ? { help } : {}),
  })

  // 1. unknown: deletion observed, no stack, or nothing observed yet.
  if (application.deleting || components.some((component) => isOneOf(component.reason, 'DeletionInProgress'))) {
    return result('unknown', copy.statusText.deleting)
  }
  if (!stack) return result('unknown', copy.statusText.noStack)
  // No component facts at all cannot prove any state.
  if (components.length === 0) return result('unknown', copy.statusText.noComponents)

  // 2. failed: a blocked/degraded component, a failed latest release, or a failed publish.
  const broken = components.find((component) => isOneOf(component.status, 'Blocked', 'Degraded'))
  if (broken) return result('failed', componentReasonText(broken), helpFor(broken))
  // failureReason is free text without a key vocabulary; it is shown in the
  // release history, not in the one-line status sentence.
  if (latestReleases.some((release) => isOneOf(release.phase, 'Failed'))) {
    return result('failed', copy.statusText.releaseFailed)
  }
  // Publish `message` is operator prose (not localized), so only the phase is used.
  if (isOneOf(publish?.phase, 'failed')) return result('failed', copy.publishPhase.failed)

  // 3. unknown: a component whose canonical status or dependency is unobservable,
  // or a component status / latest release phase this console does not know.
  const unobservable = components.find((component) => isOneOf(component.status, 'Unknown') || component.status.kind === 'unknown')
  if (unobservable) return result('unknown', unobservable.status.kind === 'unknown' ? appText.unsupported.status : componentReasonText(unobservable))
  if (latestReleases.some((release) => release.phase.kind === 'unknown')) return result('unknown', appText.unsupported.status)

  // 4. deploying: anything still settling.
  const settling = components.find((component) => isOneOf(component.status, 'Provisioning'))
  if (settling) return result('deploying', componentReasonText(settling))
  const inFlightText = latestReleases.map((release) => {
    const phase = knownValue(release.phase)
    return phase && IN_FLIGHT_RELEASE_TEXT[phase]
  }).find(Boolean)
  if (inFlightText) return result('deploying', inFlightText)
  if (publish && !isOneOf(publish.phase, 'succeeded')) {
    const phase = publish.phase
    return result('deploying', !phase ? copy.publishPhase.service_creating : phase.kind === 'known' ? copy.publishPhase[phase.value] : appText.unsupported.status)
  }
  if (publish && !url) return result('deploying', copy.statusText.publishUrlMissing)

  // 5. live.
  if (!publish) return result('live', copy.statusText.liveNoUrl)
  const version = versionLabel(releaseComponents.flatMap((component) => component.releases), webRelease?.id)
  return result('live', version ? copy.statusText.liveVersion(version.label) : copy.statusText.live)
}

/** A known reason's sentence; a reason this console does not know says so (its known status still decides). */
function componentReasonText(component: ComponentSummary): string {
  const reason = knownValue(component.reason)
  return reason ? reasonText(reason) : appText.unsupported.status
}

function helpFor(component: ComponentSummary): string | undefined {
  const reason = knownValue(component.reason)
  return reason ? reasonHelp[reason] : undefined
}

export function deriveConsoleApps(input: ConsoleAppsInput): ConsoleApp[] {
  return input.applications.map((application) =>
    deriveConsoleApp({
      application,
      stack: stackForApplication(application, input.stacks),
      publishes: input.publishes,
      componentSummaries: input.componentSummaries,
      releases: input.releasesByApplication[application.id],
    })
  )
}

/** What every screen shows for a BusinessApp: one of the four status words plus a second line. */
export interface AppView {
  status: ConsoleStatus
  /** The status word (公開中 / 準備中 / 問題あり / 作りかけ / 停止中). */
  label: string
  /** Second line, a plain-language sentence. */
  text: string
  second: string
  draftReason?: string
  draftPlatform?: DraftPlatformState
  next?: readonly ('resume' | 'ask' | 'delete')[]
  build?: { draftId: string; phase: 'implementing' | 'done' }
  /** Next action for a failure with a specific reason (shown under the status sentence). */
  help?: string
  url?: string
  /** No platform binding yet (`stackId` null). */
  draft: boolean
  stack?: AppStack
  platform?: ConsoleApp
}

export interface DraftPlatformState {
  /** A failed/unread platform read must never declare a draft abandoned. */
  observed: boolean
  /** Any active platform draft operation prevents proving abandonment. */
  inProgress?: boolean
  progress?: { sourceRepositoryId?: string; stackId?: string }
  reason?: string
}

/**
 * Only observed inactivity can make an old draft 作りかけ. An abandoned draft is
 * the user's choice, not a platform problem, so it never becomes `failed`.
 */
export function draftState(
  app: Pick<BusinessApp, 'stackId' | 'createdAt'>,
  platform: DraftPlatformState | undefined,
  now = Date.now()
): { status: 'deploying' | 'unfinished'; reason: string; next: readonly ('resume' | 'ask' | 'delete')[] } {
  const stopped = !app.stackId && platform?.observed && !platform.inProgress &&
    now - Date.parse(app.createdAt) > 20 * 60_000
  return stopped
    ? { status: 'unfinished', reason: platform.reason ?? copy.statusText.draftStale, next: ['resume', 'ask', 'delete'] }
    : { status: 'deploying', reason: copy.statusText.draft, next: [] }
}

/**
 * BusinessApp ↔ platform join by `stackId` (never by name):
 * - draft (no stackId): only observed inactivity without plan progress can become 作りかけ;
 * - bound stack missing from the stack list: 停止中 (deleted or not visible);
 * - stack without an observed Application yet: 準備中;
 * - otherwise the PoC rules of `deriveConsoleApp` on the stack's Application.
 */
export function deriveAppView(
  app: Pick<BusinessApp, 'stackId' | 'createdAt'>,
  input: ConsoleAppsInput,
  now: number = Date.now(),
  draftPlatform?: DraftPlatformState,
  build?: AppBuildProgress
): AppView {
  const stack = input.stacks.find((item) => item.id === app.stackId)
  const sourceId = app.stackId
    ? isOneOf(stack?.sourceKind, 'application-source-repository') ? stack?.sourceRepositoryRefName : undefined
    : draftPlatform?.progress?.sourceRepositoryId
  const buildFailed = sourceId !== undefined && input.sourceRepositories?.some((source) => source.id === sourceId && source.buildFailed)
  const view = (status: ConsoleStatus, text: string, extra: Partial<AppView> = {}): AppView => ({
    status,
    label: copy.status[status],
    text,
    second: text,
    draft: false,
    ...extra,
    ...(buildFailed ? {
      status: 'failed', label: buildCopy.sourceBuild.status, text: buildCopy.sourceBuild.status, second: buildCopy.sourceBuild.status,
      ...(extra.platform ? { platform: { ...extra.platform, status: 'failed', statusText: buildCopy.sourceBuild.status } } : {}),
    } : {}),
  })
  if (!app.stackId) {
    const state = draftState(app, draftPlatform, now)
    return view(state.status, state.status === 'unfinished' ? copy.statusText.draftStale : state.reason, {
      draft: true, draftReason: state.reason, draftPlatform, next: state.next,
    })
  }
  const application = applicationForStack(app.stackId, input)
  if (application?.status.reason) {
    const platform = deriveConsoleApp({ application, stack, publishes: [], componentSummaries: [] })
    return view(platform.status, platform.statusText, { stack, platform })
  }
  if (!stack) return view('unknown', copy.statusText.noStack)
  if (!application) return view('deploying', copy.statusText.preparing, { stack })
  const platform = deriveConsoleApp({
    application,
    stack,
    publishes: input.publishes,
    componentSummaries: input.componentSummaries,
    releases: input.releasesByApplication[application.id],
  })
  const releases = input.releasesByApplication[application.id]?.components.flatMap((component) => component.releases) ?? []
  if (build) {
    const released = implementedReleaseReady(platform, releases, build)
    const complete = isOneOf(build.run?.status, 'succeeded') && build.run!.tasks.every((task) => isOneOf(task.status, 'done', 'skipped'))
    if (!complete || !released) {
      const text = buildStatusText(build)
      return view('deploying', text, {
        label: isOneOf(build.run?.status, 'failed', 'cancelled') ? appText.build.stopped : appText.build.building,
        build: { draftId: build.draftId, phase: 'implementing' }, stack,
        platform: released ? platform : { ...platform, status: 'deploying', statusText: text, url: undefined },
        ...(released && platform.url ? { url: platform.url } : {}),
      })
    }
  }
  return view(platform.status, appSecondLine(platform, releases, now), {
    stack,
    platform,
    ...(build ? { build: { draftId: build.draftId, phase: 'done' as const } } : {}),
    ...(platform.url ? { url: platform.url } : {}),
    ...(platform.help ? { help: platform.help } : {}),
  })
}

/** Release history of one component, newest first. */
export function deriveReleaseHistory(
  overview: ReleaseOverview | undefined,
  componentId: string | undefined
): ConsoleRelease[] {
  const component = overview?.components.find((item) => item.id === componentId)
  if (!component) return []
  return [...component.releases].sort((a, b) => releaseTime(b).localeCompare(releaseTime(a))).map(toConsoleRelease)
}

export interface RollbackOption {
  transitionId: string
  version: string
  at?: string
}

export interface RollbackView {
  currentVersion?: string
  inFlight: boolean
  options: RollbackOption[]
}

/**
 * Rollback choices from release-state; the version label prefers the human tag
 * over the digest. A candidate equal to the current target digest is not a
 * "previous" version (release-state keeps it listed after a rollback lands).
 */
export function deriveRollbackView(state: ReleaseState | undefined): RollbackView {
  return {
    ...(state?.targetImageTag ? { currentVersion: state.targetImageTag } : {}),
    inFlight: Boolean(state?.activeTransitionId),
    options: (state?.rollbackCandidates ?? [])
      .filter((candidate) => candidate.imageDigest !== state?.targetImageDigest)
      .map((candidate) => ({
        transitionId: candidate.transitionId,
        version: candidate.imageTag ?? candidate.imageDigest.slice(0, 19),
        ...(candidate.createdAt ? { at: candidate.createdAt } : {}),
      })),
  }
}
