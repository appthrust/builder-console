// Create sequences (ux-design §8.1). Every entry: (1) console draft → (2)
// platform calls with the user's own token → (3) bind stackId → caller
// navigates. Each step's result is kept in `CreateProgress` so a retry resumes
// instead of duplicating.
// - ひな形 / 作ったコードから / イメージ: `submitCreate` (source repository →
//   stack, or the stack alone for an image).
import type {
  ApplicationStackValidation,
  CreateApplicationSourceRepositoryRequest,
} from '@appthrust/api-schema/platform-api'
import { ORPCError } from '@orpc/client'
import { isConsoleError, type BusinessApp, type ConsoleApi, type SharePolicy } from '../../api/console'
import type { PlatformApiClient } from '../../api/client'
import { platformErrorEnvelope } from '../../api/platform-error'
import { queueCreatedAppAccess } from './access'
import { text } from './copy'
import {
  buildCreateStackRequest,
  buildExistingSourceRepositoryRequest,
  buildSourceRepositoryRequest,
  type CreateCatalog,
  type PickedRepository,
  type SourceConnections,
  type StackSource,
} from '../../model/create'

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
  share: SharePolicy
}

export interface CreateRequest extends AppDetails {
  path: CreatePath
}


/** What already exists from an earlier attempt. */
export interface CreateProgress {
  draft?: BusinessApp
  sourceRepositoryId?: string
  /** The request origin `sourceRepositoryId` was made for; changed origins replace the orphan on retry. */
  sourceRepositoryOrigin?: { appName: string; kind: 'template' | 'existing'; repository?: string; templateId?: string }
  stackId?: string
  /** The URL name `stackId` was created with; bind follows at once, so a retry must keep it. */
  stackAppName?: string
}

export type SubmitPhase =
  | 'draft'
  | 'source'
  | 'checking'
  | 'platform'
  | 'bind'

type ConsoleCalls = Pick<ConsoleApi['apps'], 'create' | 'update' | 'bind' | 'remove'>

type PlatformCalls = Pick<
  PlatformApiClient,
  | 'platformApiValidateApplicationSourceRepository'
  | 'platformApiCreateApplicationSourceRepository'
  | 'platformApiDeleteApplicationSourceRepository'
  | 'platformApiValidateApplicationStack'
  | 'platformApiCreateApplicationStack'
>

export interface CreateDeps {
  console: ConsoleCalls
  platform: PlatformCalls
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
 * did not answer (`transient`). Otherwise `progress` is what to resume from.
 */
export class CreateFailed extends Error {
  readonly forbidden: boolean
  readonly nameTaken: boolean
  readonly retryable: boolean
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
  // The transient text is the failure's title already.
  if (isConsoleError(error) && error.transient) return undefined
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

function stackIssues(validation: ApplicationStackValidation): ValidationIssue[] {
  return SECTIONS.flatMap((section) => {
    const result = validation[section]
    return result && !result.valid ? [{ section, message: result.message }] : []
  })
}


/** Shared by the wizard and build sessions; keeps the console app across bind retries. */
export async function ensureDraft(request: AppDetails, progress: CreateProgress, consoleApi: ConsoleCalls): Promise<BusinessApp> {
  const input = {
    displayName: request.displayName,
    description: request.description,
    tags: request.tags,
    groupId: request.groupId,
    slug: request.urlName,
    share: request.share,
  }
  if (!progress.draft) return consoleApi.create(input)
  if (progress.draft.slug !== request.urlName || progress.draft.group.id !== request.groupId ||
      progress.draft.displayName !== input.displayName || progress.draft.description !== input.description ||
      JSON.stringify(progress.draft.tags) !== JSON.stringify(input.tags) || JSON.stringify(progress.draft.share) !== JSON.stringify(input.share)) {
    return consoleApi.update(progress.draft.id, input)
  }
  return progress.draft
}

/**
 * A platform 403 before anything exists on the platform deletes the draft (it
 * would only be an orphan); every other failure keeps what was made.
 */
async function failed(error: unknown, progress: CreateProgress, consoleApi: ConsoleCalls, platformTouched: boolean): Promise<never> {
  const forbidden = error instanceof ORPCError && error.status === 403
  if (forbidden && progress.draft && !platformTouched) {
    await consoleApi.remove(progress.draft.id).catch(() => undefined)
    throw new CreateFailed(error, {}, true)
  }
  throw new CreateFailed(error, progress, forbidden)
}

export async function submitCreate(
  request: CreateRequest,
  resume: CreateProgress,
  deps: CreateDeps
): Promise<BusinessApp> {
  const progress: CreateProgress = { ...resume }
  const appName = request.urlName
  try {
    // A kept stack is bound right after it is made, so only a failed bind
    // leaves one behind; binding it under another name would split the app.
    if (progress.stackId && progress.stackAppName !== appName) {
      throw new Error(text.alreadyCreated(progress.stackAppName ?? ''))
    }
    deps.onPhase('draft')
    progress.draft = await ensureDraft(request, progress, deps.console)
    deps.onProgress?.({ ...progress })

    if (!progress.stackId) {
      let source: StackSource
      if (request.path.kind === 'image') {
        source = { kind: 'sample-image', imageRef: request.path.imageRef }
      } else {
        if (!deps.connections) throw new Error(text.sourceUnavailable)
        const origin: NonNullable<CreateProgress['sourceRepositoryOrigin']> = {
          appName,
          kind: request.path.kind,
          ...(request.path.kind === 'existing' ? { repository: request.path.repository.fullName } : { templateId: deps.catalog.template.id }),
        }
        const keptOrigin = progress.sourceRepositoryOrigin
        if (progress.sourceRepositoryId && (
          keptOrigin?.appName !== origin.appName ||
          keptOrigin?.kind !== origin.kind ||
          keptOrigin?.repository !== origin.repository ||
          keptOrigin?.templateId !== origin.templateId
        )) {
          // The kept repository belongs to another name, entry, or picked
          // repository. Best effort: an orphan must not stop the new attempt.
          deps.onPhase('source')
          await deps.platform
            .platformApiDeleteApplicationSourceRepository({ params: { projectId: request.projectId, id: progress.sourceRepositoryId } })
            .catch(() => undefined)
          progress.sourceRepositoryId = undefined
          progress.sourceRepositoryOrigin = undefined
          deps.onProgress?.({ ...progress })
        }
        if (!progress.sourceRepositoryId) {
          deps.onPhase('source')
          const body: CreateApplicationSourceRepositoryRequest & { projectId: string } = {
            projectId: request.projectId,
            ...(request.path.kind === 'existing'
              ? buildExistingSourceRepositoryRequest(request.path.repository, deps.connections)
              : buildSourceRepositoryRequest(appName, deps.catalog, deps.connections)),
          }
          const validation = await deps.platform.platformApiValidateApplicationSourceRepository(body)
          if (!validation.valid) {
            const message = validation.message ?? ''
            throw new ValidationRejected(message, message ? [{ section: 'source', message }] : [])
          }
          const repository = await deps.platform.platformApiCreateApplicationSourceRepository(body)
          progress.sourceRepositoryId = repository.id
          progress.sourceRepositoryOrigin = origin
          deps.onProgress?.({ ...progress })
        }
        source = { kind: 'application-source-repository', sourceRepositoryId: progress.sourceRepositoryId }
      }
      const stackRequest = {
        projectId: request.projectId,
        ...buildCreateStackRequest(appName, source, deps.catalog, deps.domain),
      }
      deps.onPhase('checking')
      const validation = await deps.platform.platformApiValidateApplicationStack(stackRequest)
      if (!validation.valid) throw new ValidationRejected(validation.message, stackIssues(validation))
      deps.onPhase('platform')
      const stack = await deps.platform.platformApiCreateApplicationStack(stackRequest)
      progress.stackId = stack.id
      progress.stackAppName = appName
      deps.onProgress?.({ ...progress })
    }

    deps.onPhase('bind')
    return await bindCreatedApp(deps.console, progress.draft, progress.stackId, appName)
  } catch (error) {
    return failed(error, progress, deps.console, Boolean(progress.sourceRepositoryId || progress.stackId))
  }
}

/** Both creation paths bind the console app to the actual platform name and stack. */
export async function bindCreatedApp(consoleApi: ConsoleCalls, app: BusinessApp, stackId: string, appName: string): Promise<BusinessApp> {
  if (app.stackId === stackId && app.appName === appName) return app
  queueCreatedAppAccess(app.id)
  return consoleApi.bind(app.id, { stackId, appName })
}
