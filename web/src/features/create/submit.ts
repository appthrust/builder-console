// Create sequences (ux-design §8.1). Every entry: (1) console draft → (2)
// platform calls with the user's own token → (3) bind stackId → caller
// navigates. Each step's result is kept in `CreateProgress` so a retry resumes
// instead of duplicating.
// - ひな形 / 作ったコードから / イメージ: `submitCreate` (source repository →
//   stack, or the stack alone for an image).
// - A step whose 2xx answer cannot be read (a ResponseContractError) may have
//   happened: the attempt stops with `progress.unconfirmed` set, nothing is
//   resent, and only `confirmCreate` (a readback) clears it. The readback
//   adopts what the unconfirmed step made, so the next attempt does not make
//   it twice.
import { ORPCError } from '@orpc/client'
import { isResponseContractError } from '../../api/boundary'
import { isConsoleError } from '../../api/console'
import type { CreateApi } from '../../api/create'
import { platformErrorEnvelope } from '../../api/platform-error'
import { knownValue } from '../../model/contracts/build'
import type { ShareChoice, SourceRepository, SourceRepositoryRequest, StackValidation } from '../../model/contracts/catalog'
import type { BusinessApp } from '../../model/contracts/console'
import {
  buildCreateStackRequest,
  buildExistingSourceRepositoryRequest,
  buildSourceRepositoryRequest,
  type CreateCatalog,
  type PickedRepository,
  type SourceConnections,
  type StackSource,
} from '../../model/create'
import { queueCreatedAppAccess } from './access'
import { text } from './copy'

export type CreatePath =
  | { kind: 'template' }
  | { kind: 'existing'; repository: PickedRepository }
  | { kind: 'image'; imageRef: string }

/** What every entry asks in Steps 1–2. */
export interface AppDetails {
  projectId: string
  displayName: string
  description: string
  tags: string[]
  groupId: string
  /** "URL になる名前": console slug and platform application name. */
  urlName: string
  share: ShareChoice
}

export interface CreateRequest extends AppDetails {
  path: CreatePath
}

export type SubmitPhase =
  | 'draft'
  | 'source'
  | 'checking'
  | 'platform'
  | 'bind'

/** What already exists from an earlier attempt. */
export interface CreateProgress {
  draft?: BusinessApp
  sourceRepositoryId?: string
  /** The request origin `sourceRepositoryId` was made for; changed origins replace the orphan on retry. */
  sourceRepositoryOrigin?: { appName: string; kind: 'template' | 'existing'; repository?: string; templateId?: string }
  stackId?: string
  /** The URL name `stackId` was created with; bind follows at once, so a retry must keep it. */
  stackAppName?: string
  /** The phase whose write answered with an unreadable 2xx: it may have happened. Only `confirmCreate` clears it. */
  unconfirmed?: SubmitPhase
  /**
   * The Idempotency-Key of a platform create that was sent but whose resource is not recorded yet, with what it was
   * sent for. A resend of the same request reuses it, so Platform replays the first write instead of making a second
   * resource, even when a readback could not see the first one yet (Platform lists may lag an accepted write).
   */
  attempts?: { source?: SourceAttempt; stack?: StackAttempt }
}

export type SourceAttempt = { key: string; origin: { appName: string; kind: 'template' | 'existing'; repository?: string; templateId?: string } }
export type StackAttempt = { key: string; appName: string; sourceRepositoryId?: string }

type CreateCalls = Pick<CreateApi,
  | 'createApp' | 'updateApp' | 'bindApp' | 'removeApp'
  | 'validateSourceRepository' | 'createSourceRepository' | 'deleteSourceRepository'
  | 'validateStack' | 'createStack'
>

export interface CreateDeps {
  api: CreateCalls
  catalog: CreateCatalog
  /** Publish-ready domain base for the app URL. */
  domain: string
  /** Required for the ひな形 and 作ったコードから paths. */
  connections?: SourceConnections
  onPhase: (phase: SubmitPhase) => void
  onProgress?: (progress: CreateProgress) => void
}

export type ValidationSectionName = 'source' | 'runtime' | 'publish'

/** One failing section of a platform validation answer; `message` is the server's (not localized). */
export interface ValidationIssue {
  section: ValidationSectionName
  message: string
}

/**
 * A failed attempt. `forbidden` = the Platform API refused the caller (not a
 * Team Editor); the draft has been deleted. `nameTaken` = the URL name is
 * already used (console slug, platform application name or repository name);
 * the wizard sends the user back to the name. `retryable` = the same request
 * succeeds shortly: the platform's delivery was converging, or the console
 * did not answer (`transient`). `unconfirmed` = a step's answer could not be
 * read: only a readback (`confirmCreate`) may follow, never a resend.
 * Otherwise `progress` is what to resume from.
 */
export class CreateFailed extends Error {
  readonly forbidden: boolean
  readonly nameTaken: boolean
  readonly retryable: boolean
  readonly unconfirmed: boolean
  /** Quoted Platform API input field and the wizard step that owns it. */
  readonly field?: { path: string; step: 0 | 1 }
  /** No answer from the console (gateway 5xx, network); its message is `copy.errors.transient`. */
  readonly transient: boolean
  readonly progress: CreateProgress
  /** Server-provided detail (not localized); ActionError reads `data.message`. */
  readonly data: { message: string } | undefined
  /** Failing validation sections, in source → runtime → publish order; empty when not a validation answer. */
  readonly issues: readonly ValidationIssue[]

  constructor(cause: unknown, progress: CreateProgress, forbidden: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'CreateFailed'
    this.forbidden = forbidden
    this.unconfirmed = isResponseContractError(cause)
    // Every Platform API 409 carries code `conflict`; the delivery-root
    // rejections (apierror.DeliveryBlocked) say `details.reason`
    // `delivery_pending` (converging, retry the same request) or
    // `delivery_blocked` (an operator must restore delivery). Neither is about
    // the caller's name.
    const conflict = cause instanceof ORPCError && cause.status === 409
    const reason = conflict ? platformErrorEnvelope(cause)?.details?.reason : undefined
    this.transient = isConsoleError(cause) && cause.transient
    this.retryable = reason === 'delivery_pending' || this.transient
    this.nameTaken =
      isConsoleError(cause, 'slug_taken') || (conflict && reason !== 'delivery_pending' && reason !== 'delivery_blocked')
    this.progress = progress
    const detail = detailOf(cause)
    this.data = detail ? { message: detail } : undefined
    this.issues = cause instanceof ValidationRejected ? cause.issues : []
    const envelope = cause instanceof ORPCError && cause.status === 400 ? platformErrorEnvelope(cause) : undefined
    const field = envelope?.code === 'invalid_argument'
      ? /^'((template|existing|destination)\.[^']+)'(?:\s|$)/.exec(envelope.message ?? '')
      : undefined
    if (field) this.field = { path: field[1]!, step: field[2] === 'template' ? 0 : 1 }
  }
}

function detailOf(error: unknown): string | undefined {
  if (error instanceof ValidationRejected) return error.message
  if (error instanceof ORPCError) return platformErrorEnvelope(error)?.message
  // The transient text is the failure's title already; an unreadable answer has no detail to show.
  if ((isConsoleError(error) && error.transient) || isResponseContractError(error)) return undefined
  return error instanceof Error ? error.message : undefined
}

/** A 2xx validation answer with `valid: false`, with the sections that failed. */
class ValidationRejected extends Error {
  readonly issues: readonly ValidationIssue[]

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message)
    this.issues = issues
  }
}

const SECTIONS: readonly ValidationSectionName[] = ['source', 'runtime', 'publish']

function stackIssues(validation: StackValidation): ValidationIssue[] {
  return SECTIONS.flatMap((section) => {
    const result = validation[section]
    return result && !result.valid ? [{ section, message: result.message }] : []
  })
}

/** Whether the kept console app already says what `share` says (an unknown scope never does). */
function sameShare(kept: BusinessApp['share'], share: ShareChoice): boolean {
  return knownValue(kept.scope) === share.scope && JSON.stringify(kept.groupIds) === JSON.stringify(share.groupIds) &&
    JSON.stringify(kept.extraPersonIds) === JSON.stringify(share.extraPersonIds)
}

/** Shared by the wizard and build sessions; keeps the console app across bind retries. */
export async function ensureDraft(request: AppDetails, progress: CreateProgress, api: Pick<CreateApi, 'createApp' | 'updateApp'>): Promise<BusinessApp> {
  const input = {
    displayName: request.displayName,
    description: request.description,
    tags: request.tags,
    groupId: request.groupId,
    slug: request.urlName,
    share: request.share,
  }
  if (!progress.draft) return api.createApp(input)
  if (progress.draft.slug !== request.urlName || progress.draft.group.id !== request.groupId ||
      progress.draft.displayName !== input.displayName || progress.draft.description !== input.description ||
      JSON.stringify(progress.draft.tags) !== JSON.stringify(input.tags) || !sameShare(progress.draft.share, input.share)) {
    return api.updateApp(progress.draft.id, input)
  }
  return progress.draft
}

/**
 * A platform 403 before anything exists on the platform deletes the draft (it
 * would only be an orphan); every other failure keeps what was made. An
 * unreadable answer marks its phase unconfirmed.
 */
async function failed(error: unknown, progress: CreateProgress, phase: SubmitPhase, api: CreateCalls, platformTouched: boolean): Promise<never> {
  const forbidden = error instanceof ORPCError && error.status === 403
  if (forbidden && progress.draft && !platformTouched) {
    await api.removeApp(progress.draft.id).catch(() => undefined)
    throw new CreateFailed(error, {}, true)
  }
  throw new CreateFailed(error, isResponseContractError(error) ? { ...progress, unconfirmed: phase } : progress, forbidden)
}

type SourcePath = Exclude<CreatePath, { kind: 'image' }>
type SourceOrigin = NonNullable<CreateProgress['sourceRepositoryOrigin']>

function sourceOrigin(appName: string, path: SourcePath, catalog: CreateCatalog): SourceOrigin {
  return {
    appName,
    kind: path.kind,
    ...(path.kind === 'existing' ? { repository: path.repository.fullName } : { templateId: catalog.template.id }),
  }
}

function sourceRequest(appName: string, path: SourcePath, catalog: CreateCatalog, connections: SourceConnections): SourceRepositoryRequest {
  return path.kind === 'existing'
    ? buildExistingSourceRepositoryRequest(path.repository, connections)
    : buildSourceRepositoryRequest(appName, catalog, connections)
}

const sameName = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The source repository `request` made. The adopted repository is named with
 * its owner (`owner/name`). A new repository's name is unique per owner only,
 * so it must also carry this request's owner: the same image path
 * (`<registry>/<owner>/<name>`) and, when the record still names it, the same
 * source connection. Anything less is not adopted (the resend replays instead).
 */
function madeBy(repository: SourceRepository, request: SourceRepositoryRequest): boolean {
  if (repository.sourceConnectionId !== undefined && repository.sourceConnectionId !== request.sourceConnectionId) return false
  return request.existing
    ? sameName(repository.existing?.repository, request.existing.repository)
    : sameName(repository.destination?.repositoryName, request.destination?.repositoryName) && sameName(repository.image.imagePath, request.image?.imagePath)
}

const sameOrigin = (a: SourceAttempt['origin'], b: SourceAttempt['origin']) =>
  a.appName === b.appName && a.kind === b.kind && a.repository === b.repository && a.templateId === b.templateId

export async function submitCreate(
  request: CreateRequest,
  resume: CreateProgress,
  deps: CreateDeps
): Promise<BusinessApp> {
  const progress: CreateProgress = { ...resume }
  const appName = request.urlName
  let phase: SubmitPhase = 'draft'
  const enter = (next: SubmitPhase) => {
    phase = next
    deps.onPhase(next)
  }
  try {
    // An unread answer may have made something: only the readback may follow.
    if (progress.unconfirmed) throw new Error(text.unconfirmed.title)
    // A kept stack is bound right after it is made, so only a failed bind
    // leaves one behind; binding it under another name would split the app.
    if (progress.stackId && progress.stackAppName !== appName) {
      throw new Error(text.alreadyCreated(progress.stackAppName ?? ''))
    }
    enter('draft')
    progress.draft = await ensureDraft(request, progress, deps.api)
    deps.onProgress?.({ ...progress })

    if (!progress.stackId) {
      let source: StackSource
      if (request.path.kind === 'image') {
        source = { kind: 'sample-image', imageRef: request.path.imageRef }
      } else {
        if (!deps.connections) throw new Error(text.sourceUnavailable)
        const origin = sourceOrigin(appName, request.path, deps.catalog)
        const keptOrigin = progress.sourceRepositoryOrigin
        if (progress.sourceRepositoryId && (
          keptOrigin?.appName !== origin.appName ||
          keptOrigin?.kind !== origin.kind ||
          keptOrigin?.repository !== origin.repository ||
          keptOrigin?.templateId !== origin.templateId
        )) {
          // The kept repository belongs to another name, entry, or picked
          // repository. Best effort: an orphan must not stop the new attempt.
          enter('source')
          await deps.api.deleteSourceRepository(request.projectId, progress.sourceRepositoryId).catch(() => undefined)
          progress.sourceRepositoryId = undefined
          progress.sourceRepositoryOrigin = undefined
          deps.onProgress?.({ ...progress })
        }
        if (!progress.sourceRepositoryId) {
          enter('source')
          const body = sourceRequest(appName, request.path, deps.catalog, deps.connections)
          const validation = await deps.api.validateSourceRepository(request.projectId, body)
          if (!validation.valid) {
            const message = validation.message ?? ''
            throw new ValidationRejected(message, message ? [{ section: 'source', message }] : [])
          }
          // The same origin reuses the key of an attempt that may already have been applied.
          const kept = progress.attempts?.source
          const attempt: SourceAttempt = kept && sameOrigin(kept.origin, origin) ? kept : { key: crypto.randomUUID(), origin }
          progress.attempts = { ...progress.attempts, source: attempt }
          deps.onProgress?.({ ...progress })
          const repository = await deps.api.createSourceRepository(request.projectId, body, attempt.key)
          progress.sourceRepositoryId = repository.id
          progress.sourceRepositoryOrigin = origin
          progress.attempts = { ...progress.attempts, source: undefined }
          deps.onProgress?.({ ...progress })
        }
        source = { kind: 'application-source-repository', sourceRepositoryId: progress.sourceRepositoryId }
      }
      const stackRequest = buildCreateStackRequest(appName, source, deps.catalog, deps.domain)
      enter('checking')
      const validation = await deps.api.validateStack(request.projectId, stackRequest)
      if (!validation.valid) throw new ValidationRejected(validation.message, stackIssues(validation))
      enter('platform')
      const kept = progress.attempts?.stack
      const attempt: StackAttempt = kept && kept.appName === appName && kept.sourceRepositoryId === progress.sourceRepositoryId
        ? kept
        : { key: crypto.randomUUID(), appName, sourceRepositoryId: progress.sourceRepositoryId }
      progress.attempts = { ...progress.attempts, stack: attempt }
      deps.onProgress?.({ ...progress })
      const stack = await deps.api.createStack(request.projectId, stackRequest, attempt.key)
      progress.stackId = stack.id
      progress.stackAppName = appName
      progress.attempts = { ...progress.attempts, stack: undefined }
      deps.onProgress?.({ ...progress })
    }

    enter('bind')
    return await bindCreatedApp(deps.api, progress.draft, progress.stackId, appName)
  } catch (error) {
    return failed(error, progress, phase, deps.api, Boolean(progress.sourceRepositoryId || progress.stackId))
  }
}

/** What the readback found: the progress to resume from, and the finished app when the bind had happened. */
export interface ConfirmedCreate {
  progress: CreateProgress
  app?: BusinessApp
}

/**
 * The only action after an unconfirmed step: read back what that step may
 * have made and adopt it, so the next attempt resumes instead of making it
 * twice. Reads only; never resends. Only the unconfirmed phase's resource is
 * looked up (a same-named resource found for another phase is not this
 * attempt's). A failed read rejects and leaves the step unconfirmed.
 *
 * A Platform list that does not show the resource is not proof it was not
 * made (an accepted write may not be listed yet). The next attempt therefore
 * keeps the step's recorded attempt key: Platform replays the first write for
 * it instead of making a second resource. The Console reads its own store, so
 * an app it does not list was not made.
 */
export async function confirmCreate(
  request: CreateRequest,
  resume: CreateProgress,
  deps: { api: Pick<CreateApi, 'app' | 'myApps' | 'sourceRepositories' | 'stacks'>; catalog: CreateCatalog; connections?: SourceConnections }
): Promise<ConfirmedCreate> {
  const progress: CreateProgress = { ...resume, unconfirmed: undefined }
  const phase = resume.unconfirmed
  const appName = request.urlName
  if (progress.draft) {
    progress.draft = await deps.api.app(progress.draft.id)
  } else if (phase === 'draft') {
    progress.draft = (await deps.api.myApps()).find((app) => app.slug === appName && app.group.id === request.groupId && !app.stackId)
  }
  const draft = progress.draft
  if (draft?.stackId && draft.appName === appName && (!progress.stackId || progress.stackId === draft.stackId)) {
    return { progress: { ...progress, stackId: draft.stackId, stackAppName: appName }, app: draft }
  }
  if (phase === 'source' && request.path.kind !== 'image' && !progress.sourceRepositoryId && deps.connections) {
    const body = sourceRequest(appName, request.path, deps.catalog, deps.connections)
    const made = (await deps.api.sourceRepositories(request.projectId)).data.find((repository) => madeBy(repository, body))
    if (made) {
      progress.sourceRepositoryId = made.id
      progress.sourceRepositoryOrigin = sourceOrigin(appName, request.path, deps.catalog)
    }
  }
  if (phase === 'platform' && !progress.stackId) {
    const made = (await deps.api.stacks(request.projectId)).find((stack) =>
      stack.applicationName === appName && stack.templateId === deps.catalog.template.id && stack.sourceRepositoryRefName === progress.sourceRepositoryId)
    if (made) {
      progress.stackId = made.id
      progress.stackAppName = appName
    }
  }
  return { progress }
}

/** Both creation paths bind the console app to the actual platform name and stack. */
export async function bindCreatedApp(api: Pick<CreateApi, 'bindApp'>, app: BusinessApp, stackId: string, appName: string): Promise<BusinessApp> {
  if (app.stackId === stackId && app.appName === appName) return app
  queueCreatedAppAccess(app.id)
  return api.bindApp(app.id, { stackId, appName })
}
