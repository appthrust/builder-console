// Create sequences (ux-design §8.1). Every entry: (1) console draft → (2)
// platform calls with the user's own token → (3) bind stackId → caller
// navigates. Each step's result is kept in `CreateProgress` so a retry resumes
// instead of duplicating.
// - ひな形 / 作ったコードから / イメージ: `submitCreate` (source repository →
//   stack, or the stack alone for an image).
// - A step whose 2xx answer cannot be read (a ResponseContractError) may have
//   happened: the attempt stops with `progress.unconfirmed` set, nothing is
//   resent, and only `confirmCreate` (a readback) clears it.
// - A platform create whose outcome is unknown (no answer, a 5xx, an unread
//   2xx the readback could not find) is settled before anything else: the
//   next attempt first resends its exact request under its key (`attempts`).
// - A readback finds resources by name and place, which Platform's list does not
//   tie to the attempt's key: a hit is only a `candidate` until the user says it
//   is theirs. Every retained id records how it was learned (`created` / `found`),
//   and the wizard's own cleanup (origin replacement, start-over) deletes only what
//   its own keyed create answered. Deleting the finished app later is not covered:
//   app/mutations.ts `deleteAppResources` deletes the stack's source repository
//   record however the wizard learned it (follow-up APT-1080: durable provenance on
//   the Console app record, or ownership enforced by Platform).
import { ORPCError } from '@orpc/client'
import { isResponseContractError } from '../../api/boundary'
import { isConsoleError } from '../../api/console'
import type { CreateApi } from '../../api/create'
import { destinationRejection, platformErrorEnvelope, type DestinationRejection } from '../../api/platform-error'
import { knownValue } from '../../model/contracts/build'
import type { ResolvedRepositoryDestination, ShareChoice, SourceConnection, SourceRepository, SourceRepositoryRequest, StackRequest, StackValidation } from '../../model/contracts/catalog'
import type { BusinessApp } from '../../model/contracts/console'
import {
  buildCreateStackRequest,
  buildExistingSourceRepositoryRequest,
  buildSourceRepositoryRequest,
  destinationImage,
  destinationRepository,
  type CreateCatalog,
  type PickedRepository,
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

/**
 * How the console learned a retained resource id. `created`: a readable success answer to this attempt's own keyed
 * create (Platform answers it for that key only). `found`: a readback listed it and the user chose it (`acceptCandidate`).
 * Only a `created` resource is deleted by the wizard's own cleanup. Provenance ends with the wizard: deleting the app
 * later (`deleteAppResources`) removes the stack's source repository record either way (APT-1080).
 */
export type Provenance = 'created' | 'found'

/**
 * A readback's hit for the unconfirmed or unsettled step: a resource with the attempt's name where the attempt sent it.
 * Platform's list carries no trace of the request or key that made it (the idempotency annotations stay on the
 * resource; platform-api internal/handler/application_source_repository.go:1702-1749), so it may be another attempt's.
 * A repository carries its creation time (`createdAt`, the cluster's clock) and the attempt's first send (`sentAt`,
 * this browser's clock) for the user to see; the two clocks have no known relation, so neither decides anything
 * (`createdBeforeSent` is a display hint only). A stack record has no creation time.
 */
export type CreateCandidate =
  | { step: 'source'; id: string; binding: SourceBinding; createdAt?: string; sentAt?: string }
  | { step: 'stack'; id: string; appName: string }

/** A readback hit the user said is not theirs, for the attempt whose Idempotency-Key is `key` (absent: no attempt kept). */
export interface RejectedCandidate { key?: string; candidate: CreateCandidate }

/** What already exists from an earlier attempt. */
export interface CreateProgress {
  draft?: BusinessApp
  sourceRepositoryId?: string
  /** The request origin `sourceRepositoryId` was made for; changed origins replace the orphan on retry. */
  sourceRepositoryOrigin?: SourceOrigin
  /**
   * Where `sourceRepositoryId` is (the repository Platform made or adopted): a resumed attempt shows this, never the
   * destination Platform resolves now, because its retry reuses this repository. Absent in progress saved before it was kept.
   */
  sourceRepositoryBinding?: SourceBinding
  /** How `sourceRepositoryId` was learned. Absent in progress saved before it was kept: not provably this attempt's, never deleted by the wizard. */
  sourceRepositoryProvenance?: Provenance
  stackId?: string
  /** The URL name `stackId` was created with; bind follows at once, so a retry must keep it. */
  stackAppName?: string
  /** How `stackId` was learned. */
  stackProvenance?: Provenance
  /** The phase whose write answered with an unreadable 2xx: it may have happened. Only `confirmCreate` clears it. */
  unconfirmed?: SubmitPhase
  /**
   * Platform creates that were sent (or about to be) and whose resource is not recorded: they may have been applied.
   * Each keeps its Idempotency-Key and the exact request it carried. The next attempt sends nothing else before it has
   * resent that request under that key (Platform replays an accepted write, also after the destination moved). Only
   * the resource it answers ends such an attempt, or, for a request sent in the same attempt that made it, Platform's
   * refusal of that very write (a 4xx). A validation answer, another destination or another name never does.
   */
  attempts?: { source?: SourceAttempt; stack?: StackAttempt }
  /**
   * The attempt whose resend Platform refused (or that cannot be resent exactly). The refusal does not prove the first
   * send was not applied (Platform does not serialize a resend with a first send still in flight, and records the key
   * only after the write), so nothing is sent for it any more. The user accepting a readback's hit clears it; otherwise
   * only the user's explicit `abandonUnsettled`, offered once a readback has looked and not found it (or the user said
   * what it found is not theirs), does.
   */
  unsettled?: 'source' | 'stack'
  /** A readback has read Platform's list and not found the unsettled attempt's resource where it was sent. */
  unsettledSearched?: boolean
  /** A readback hit the user has not judged yet: nothing is sent while it is set (`acceptCandidate` / `rejectCandidate`). */
  candidate?: CreateCandidate
  /**
   * Readback hits the user said are not theirs. Each counts only for its resource kind and the attempt it was rejected
   * for (`key`): a readback for that attempt skips it, and the held notice can offer it again (`reconsiderCandidate`).
   * Dropped when that attempt ends (answered, refused, accepted or given up), never carried into a later one.
   */
  notMine?: RejectedCandidate[]
}

/** What a source repository is made for: the URL name and the entry (with its template or picked repository). */
export interface SourceOrigin { appName: string; kind: 'template' | 'existing'; repository?: string; templateId?: string }

/** Where a source repository is: what the confirm step shows for it and what a readback of it must match. */
export interface SourceBinding {
  /** `owner/name`: ひな形 = the destination's repository namespace and the URL name; 作ったコードから = the picked repository. */
  repository: string
  /** Where its images go: Platform's image path once it answered (ひな形: also the one shown before). */
  image?: string
  /** ひな形: the destination revision the request bound. */
  revision?: string
  /** The connection that makes (ひな形) or adopts (作ったコードから) it. */
  connectionId?: string
}

/**
 * A source create whose outcome is unknown. `request`/`binding` are absent only in progress saved before they were kept;
 * `sentAt` (this browser's clock, ISO) is when its first send started, absent in progress saved before it was kept.
 */
export interface SourceAttempt { key: string; origin: SourceOrigin; request?: SourceRepositoryRequest; binding?: SourceBinding; sentAt?: string }
/** A stack create whose outcome is unknown. `request` is absent only in progress saved before it was kept. */
export interface StackAttempt { key: string; appName: string; sourceRepositoryId?: string; request?: StackRequest }

type CreateCalls = Pick<CreateApi,
  | 'createApp' | 'updateApp' | 'bindApp' | 'removeApp'
  | 'sourceRepositories' | 'validateSourceRepository' | 'createSourceRepository' | 'deleteSourceRepository'
  | 'validateStack' | 'createStack'
>

/** What a source repository is made at: ひな形 = the resolved destination the user saw, 作ったコードから = the adopting connection. */
export interface SourceTargets {
  destination?: ResolvedRepositoryDestination
  adoption?: SourceConnection
}

export interface CreateDeps extends SourceTargets {
  api: CreateCalls
  catalog: CreateCatalog
  /** Publish-ready domain base for the app URL. */
  domain: string
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
 * `destination` = Platform refused the new repository at its destination: it
 * moved since it was shown (`changed`), it is no longer resolvable
 * (`blocked`), or the request asserted another one (`mismatch`). Each is a
 * typed failure, never resent: the wizard re-reads the destination and shows
 * it, and only the user's next confirmation sends again. A refused resend of an
 * earlier attempt is none of these: it sets `progress.unsettled`.
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
  readonly destination?: DestinationRejection
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
    this.destination = destinationRejection(cause)
    // Every Platform API 409 carries code `conflict`; the delivery-root
    // rejections (apierror.DeliveryBlocked) say `details.reason`
    // `delivery_pending` (converging, retry the same request) or
    // `delivery_blocked` (an operator must restore delivery); the repository
    // destination says DestinationChanged / DestinationMismatch. None of them
    // is about the caller's name.
    const conflict = cause instanceof ORPCError && cause.status === 409
    const reason = conflict ? platformErrorEnvelope(cause)?.details?.reason : undefined
    this.transient = isConsoleError(cause) && cause.transient
    this.retryable = reason === 'delivery_pending' || this.transient
    this.nameTaken = cause instanceof RepositoryNameTaken ||
      isConsoleError(cause, 'slug_taken') || (conflict && reason !== 'delivery_pending' && reason !== 'delivery_blocked' && this.destination === undefined)
    this.progress = progress
    const detail = this.destination ? undefined : detailOf(cause)
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

/**
 * Before the first send of a new ひな形 attempt, Platform already lists a source repository with this name where this one
 * would go. It cannot be this attempt's (nothing was sent yet), so the name is taken there.
 */
class RepositoryNameTaken extends Error {}

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
 * A platform 403 before anything exists (or may exist) on the platform deletes the draft (it would only be an
 * orphan); every other failure keeps what was made and every create whose outcome is unknown. An unreadable answer
 * marks its phase unconfirmed.
 */
async function failed(error: unknown, progress: CreateProgress, phase: SubmitPhase, api: CreateCalls): Promise<never> {
  // A destination the Project cannot use (NotVisible answers 403) is not the caller's permission.
  const forbidden = error instanceof ORPCError && error.status === 403 && destinationRejection(error) === undefined
  const platformTouched = Boolean(progress.sourceRepositoryId || progress.stackId || progress.attempts)
  if (forbidden && progress.draft && !platformTouched) {
    await api.removeApp(progress.draft.id).catch(() => undefined)
    throw new CreateFailed(error, {}, true)
  }
  if (isResponseContractError(error)) throw new CreateFailed(error, { ...progress, unconfirmed: phase }, forbidden)
  throw new CreateFailed(error, progress, forbidden)
}

/**
 * Platform refused this very create, so it was not applied. The source create answers every 4xx before it writes:
 * the key's replay first, then createRepositoryWithID's checks (the destination and its revision included) before
 * Writer.Apply (platform-api internal/handler/application_source_repository.go:362-386, 433-476). The exception is
 * `idempotency_conflict`: the key was already accepted with another request. No answer, a 5xx (one can follow the
 * write, :1206-1215) and an unreadable 2xx may have been applied. This holds for the first send of a key only: a
 * resend's refusal says nothing about the first send (`CreateProgress.unsettled`).
 */
function refused(error: unknown): boolean {
  return error instanceof ORPCError && error.status >= 400 && error.status < 500 && platformErrorEnvelope(error)?.code !== 'idempotency_conflict'
}

/**
 * Platform answered a resend of an earlier, uncertain create with a refusal (any 4xx but a missing sign-in, which never
 * reached it). Not proof the first send failed: Platform neither serializes a resend with a first send still being
 * processed nor records the key before the write (handler/application_source_repository.go:375-380, 1101-1141,
 * 1206-1215), so a resend can be judged as new while the first one is (or was) applied.
 */
function refusedResend(error: unknown): boolean {
  return error instanceof ORPCError && error.status >= 400 && error.status < 500 && error.status !== 401
}

type SourcePath = Exclude<CreatePath, { kind: 'image' }>

export function sourceOrigin(appName: string, path: SourcePath, catalog: CreateCatalog): SourceOrigin {
  return {
    appName,
    kind: path.kind,
    ...(path.kind === 'existing' ? { repository: path.repository.fullName } : { templateId: catalog.template.id }),
  }
}

/** The create request of a new source attempt and where it makes (ひな形) or adopts (作ったコードから) the repository. */
function newSource(appName: string, path: SourcePath, catalog: CreateCatalog, targets: SourceTargets): { request: SourceRepositoryRequest; binding: SourceBinding } {
  if (path.kind === 'existing') {
    if (!targets.adoption) throw new Error(text.sourceUnavailable)
    return { request: buildExistingSourceRepositoryRequest(path.repository, targets.adoption), binding: { repository: path.repository.fullName, connectionId: targets.adoption.id } }
  }
  const destination = targets.destination
  if (!destination) throw new Error(text.destinationUnavailable)
  return {
    request: buildSourceRepositoryRequest(appName, catalog, destination),
    binding: { repository: destinationRepository(destination, appName), image: destinationImage(destination, appName), revision: destination.revision, connectionId: destination.connectionId },
  }
}

/** Where a recorded repository is: where its attempt sent it, with the image path Platform answered. */
function madeAt(repository: SourceRepository, sent: SourceBinding | undefined): SourceBinding | undefined {
  const name = sent?.repository ?? repository.existing?.repository ?? repository.repositoryUrl
  return name ? { ...sent, repository: name, image: repository.image.imagePath } : undefined
}

const sameName = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * A source repository with the attempt's name where the attempt sent it (its binding), never at the destination resolved
 * now. The adopted repository is named with its owner (`owner/name`) and its connection. A new repository's name is
 * unique per owner only, so it must also be where the attempt sent it: the image path shown for it and, when the record
 * still names it, its connection. An attempt saved without its binding matches nothing (its resend settles it).
 * Similarity, not identity: any request with that name and place makes such a repository, so a match is only a
 * candidate (`CreateCandidate`), or, before anything was sent, a taken name.
 */
function atAttemptPlace(repository: SourceRepository, attempt: Pick<SourceAttempt, 'origin' | 'binding'>): boolean {
  const { origin, binding } = attempt
  if (!binding || (repository.sourceConnectionId !== undefined && repository.sourceConnectionId !== binding.connectionId)) return false
  return origin.kind === 'existing'
    ? sameName(repository.existing?.repository, origin.repository)
    : sameName(repository.destination?.repositoryName, origin.appName) && sameName(repository.image.imagePath, binding.image)
}

/**
 * Display threshold for one hint, never a rule: by this browser's clock the repository was created more than 1 minute
 * before the attempt's first send (`createdAt` is the cluster's creationTimestamp, whole seconds rounded down; `sentAt`
 * is this browser's clock, with no known relation to it). The hint says it may be an existing repository with the same
 * name; both choices stay offered either way.
 */
export const CREATED_BEFORE_HINT_MS = 60_000

/** Whether the candidate notice adds the hint above. Unknown either time: no hint. */
export function createdBeforeSent(candidate: CreateCandidate): boolean {
  if (candidate.step !== 'source') return false
  const created = candidate.createdAt ? Date.parse(candidate.createdAt) : Number.NaN
  const sent = candidate.sentAt ? Date.parse(candidate.sentAt) : Number.NaN
  return Number.isFinite(created) && Number.isFinite(sent) && created < sent - CREATED_BEFORE_HINT_MS
}

/** What is left once `step`'s attempt has ended: the other attempt, and only the rejections made for that one. */
function settled(progress: CreateProgress, step: 'source' | 'stack'): Pick<CreateProgress, 'attempts' | 'notMine'> {
  const rest: NonNullable<CreateProgress['attempts']> = { ...progress.attempts }
  delete rest[step]
  const notMine = progress.notMine?.filter((rejected) => rejected.candidate.step !== step)
  return { attempts: rest.source || rest.stack ? rest : undefined, notMine: notMine?.length ? notMine : undefined }
}

/** Whether the user said `id` is not theirs for `step`'s current attempt. */
function rejectedNow(progress: CreateProgress, step: 'source' | 'stack', id: string): boolean {
  const key = progress.attempts?.[step]?.key
  return progress.notMine?.some((rejected) => rejected.candidate.step === step && rejected.candidate.id === id && rejected.key === key) ?? false
}

export const sameOrigin = (a: SourceOrigin | undefined, b: SourceOrigin | undefined) =>
  a !== undefined && b !== undefined && a.appName === b.appName && a.kind === b.kind && a.repository === b.repository && a.templateId === b.templateId

/**
 * What the confirm step shows as the source of `origin` (the entry, name and template or repository on screen) instead
 * of a new repository at the destination resolved now. `pending`: a create of it whose outcome is unknown; the next
 * attempt resends it exactly, to `binding`. `created`: the repository already made, adopted or chosen for it (how it
 * was learned: `provenance`), which the next attempt reuses; without `binding` (progress saved before it was kept) it
 * is read back by `id`.
 */
export type KeptSource = { state: 'pending'; binding: SourceBinding } | { state: 'created'; id: string; binding?: SourceBinding; provenance?: Provenance }

export function keptSource(progress: CreateProgress, origin: SourceOrigin | undefined): KeptSource | undefined {
  const attempt = progress.attempts?.source
  if (attempt?.request && attempt.binding && !progress.sourceRepositoryId && sameOrigin(attempt.origin, origin)) return { state: 'pending', binding: attempt.binding }
  if (progress.sourceRepositoryId && sameOrigin(progress.sourceRepositoryOrigin, origin)) {
    return {
      state: 'created', id: progress.sourceRepositoryId,
      ...(progress.sourceRepositoryBinding ? { binding: progress.sourceRepositoryBinding } : {}),
      ...(progress.sourceRepositoryProvenance ? { provenance: progress.sourceRepositoryProvenance } : {}),
    }
  }
  return undefined
}

/**
 * A kept repository the next attempt would not use (another name, entry, template or picked repository) and that the
 * wizard never deletes, because no keyed create of its own answered it: it stays where it is, and the confirm step
 * says so. A `created` one is removed instead (best effort) when the next attempt replaces it.
 */
export function keptElsewhere(progress: CreateProgress, origin: SourceOrigin | undefined): { binding?: SourceBinding } | undefined {
  if (!progress.sourceRepositoryId || progress.stackId || sameOrigin(progress.sourceRepositoryOrigin, origin) || progress.sourceRepositoryProvenance === 'created') return undefined
  return progress.sourceRepositoryBinding ? { binding: progress.sourceRepositoryBinding } : {}
}

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
  const report = () => deps.onProgress?.({ ...progress })
  /**
   * An attempt's create. A first send ends the attempt with the resource answered or with Platform's refusal of it. A
   * resend of an earlier, uncertain one ends it only with the resource: a refusal holds it unsettled, and nothing is
   * sent any more. Anything else (no answer, a 5xx) keeps the attempt for the next resend.
   */
  const write = async <T,>(step: 'source' | 'stack', resend: boolean, send: () => Promise<T>): Promise<T> => {
    try {
      return await send()
    } catch (error) {
      if (resend && refusedResend(error)) {
        progress.unsettled = step
        throw new Error(text.unsettled.title, { cause: error })
      }
      if (!resend && refused(error)) Object.assign(progress, settled(progress, step))
      throw error
    }
  }
  // A readable answer to this attempt's own keyed create names what that key made (`created`).
  const createSource = async (attempt: SourceAttempt, body: SourceRepositoryRequest, resend: boolean): Promise<string> => {
    const repository = await write('source', resend, () => deps.api.createSourceRepository(request.projectId, body, attempt.key))
    progress.sourceRepositoryId = repository.id
    progress.sourceRepositoryOrigin = attempt.origin
    progress.sourceRepositoryBinding = madeAt(repository, attempt.binding)
    progress.sourceRepositoryProvenance = 'created'
    Object.assign(progress, settled(progress, 'source'))
    report()
    return repository.id
  }
  const createStack = async (attempt: StackAttempt, body: StackRequest, resend: boolean): Promise<string> => {
    const stack = await write('stack', resend, () => deps.api.createStack(request.projectId, body, attempt.key))
    progress.stackId = stack.id
    progress.stackAppName = attempt.appName
    progress.stackProvenance = 'created'
    Object.assign(progress, settled(progress, 'stack'))
    report()
    return stack.id
  }
  try {
    // An unread answer may have made something: only the readback may follow. So may a refused resend, and a readback
    // hit the user has not judged.
    if (progress.unconfirmed) throw new Error(text.unconfirmed.title)
    if (progress.candidate) throw new Error(text.candidate.title)
    if (progress.unsettled) throw new Error(text.unsettled.title)
    // A create that may have been applied is settled before anything else is validated or sent: its own request again
    // under its own key. Platform replays an accepted one (made where it was sent, whatever the destination is now); no
    // other destination, name or key is tried meanwhile. Progress saved before requests were kept cannot be resent
    // exactly, and a request rebuilt against today's destination is not that create: it is held unsettled unsent.
    const pendingSource = progress.attempts?.source
    if (pendingSource && !progress.sourceRepositoryId) {
      enter('source')
      if (!pendingSource.request) {
        progress.unsettled = 'source'
        throw new Error(text.unsettled.title)
      }
      await createSource(pendingSource, pendingSource.request, true)
    }
    const pendingStack = progress.attempts?.stack
    if (pendingStack && !progress.stackId) {
      enter('platform')
      if (!pendingStack.request) {
        progress.unsettled = 'stack'
        throw new Error(text.unsettled.title)
      }
      await createStack(pendingStack, pendingStack.request, true)
    }
    // A kept stack is bound right after it is made, so only a failed bind
    // leaves one behind; binding it under another name would split the app.
    if (progress.stackId && progress.stackAppName !== appName) {
      throw new Error(text.alreadyCreated(progress.stackAppName ?? ''))
    }
    enter('draft')
    progress.draft = await ensureDraft(request, progress, deps.api)
    report()

    if (!progress.stackId) {
      let source: StackSource
      if (request.path.kind === 'image') {
        source = { kind: 'sample-image', imageRef: request.path.imageRef }
      } else {
        const origin = sourceOrigin(appName, request.path, deps.catalog)
        // The kept repository belongs to another name, entry, or picked repository: the next attempt makes its own.
        const replaced = progress.sourceRepositoryId && !sameOrigin(progress.sourceRepositoryOrigin, origin) ? progress.sourceRepositoryId : undefined
        // Only one this console's own keyed create answered is removed (best effort: an orphan must not stop the new
        // attempt). One a readback found, or kept without how it was learned, may be someone else's: it is left where it
        // is (the confirm step said so, `keptElsewhere`).
        const removed = replaced && progress.sourceRepositoryProvenance === 'created' ? replaced : undefined
        if (replaced) {
          if (removed) {
            enter('source')
            await deps.api.deleteSourceRepository(request.projectId, removed).catch(() => undefined)
          }
          progress.sourceRepositoryId = undefined
          progress.sourceRepositoryOrigin = undefined
          progress.sourceRepositoryBinding = undefined
          progress.sourceRepositoryProvenance = undefined
          report()
        }
        // A kept repository is used where it is, whatever the destination resolves to now.
        let sourceRepositoryId = progress.sourceRepositoryId
        if (!sourceRepositoryId) {
          const created = newSource(appName, request.path, deps.catalog, deps)
          enter('source')
          if (origin.kind === 'template') {
            // Before the first send: a repository Platform already lists with this name where this one would go is not
            // this attempt's, so the name is taken there. Validation sees only GitHub (an existing repository or
            // package), not a record whose repository is not made yet, such as an earlier attempt's whose progress this
            // browser lost. The one just removed may still be listed while Platform deletes it; one left in place is not.
            const listed = await deps.api.sourceRepositories(request.projectId)
            if (listed.data.some((repository) => repository.id !== removed && atAttemptPlace(repository, { origin, binding: created.binding }))) {
              throw new RepositoryNameTaken(text.repositoryNameTaken)
            }
          }
          // The request carries the destination revision the user confirmed; a moved destination answers 409, never a create elsewhere.
          const validation = await deps.api.validateSourceRepository(request.projectId, created.request)
          if (!validation.valid) {
            const message = validation.message ?? ''
            throw new ValidationRejected(message, message ? [{ section: 'source', message }] : [])
          }
          const attempt: SourceAttempt = { key: crypto.randomUUID(), origin, request: created.request, binding: created.binding, sentAt: new Date().toISOString() }
          progress.attempts = { ...progress.attempts, source: attempt }
          report()
          sourceRepositoryId = await createSource(attempt, created.request, false)
        }
        source = { kind: 'application-source-repository', sourceRepositoryId }
      }
      const body = buildCreateStackRequest(appName, source, deps.catalog, deps.domain)
      enter('checking')
      const validation = await deps.api.validateStack(request.projectId, body)
      if (!validation.valid) throw new ValidationRejected(validation.message, stackIssues(validation))
      enter('platform')
      const attempt: StackAttempt = { key: crypto.randomUUID(), appName, sourceRepositoryId: progress.sourceRepositoryId, request: body }
      progress.attempts = { ...progress.attempts, stack: attempt }
      report()
      progress.stackId = await createStack(attempt, body, false)
    }

    enter('bind')
    return await bindCreatedApp(deps.api, progress.draft, progress.stackId, appName)
  } catch (error) {
    return failed(error, progress, phase, deps.api)
  }
}

/** What the readback found: the progress to resume from, and the finished app when the bind had happened. */
export interface ConfirmedCreate {
  progress: CreateProgress
  app?: BusinessApp
}

/**
 * The only action after an unconfirmed step, or after a refused resend
 * (`unsettled`): read back what that step may have made. Reads only; never
 * resends. Only that phase's resource is looked up (a same-named resource found
 * for another phase is not this attempt's), and only where that attempt sent it
 * (its binding), never at the destination resolved now. A failed read rejects
 * and leaves the step as it was.
 *
 * A source repository or stack found that way is matched by name and place, not
 * by the attempt's key (Platform's list does not expose it), so it is not
 * adopted: it becomes the `candidate`, nothing is sent while it is shown, and
 * only the user's `acceptCandidate` / `rejectCandidate` ends it. One the user
 * already said is not theirs for this attempt (`notMine`) is not offered by a
 * readback again; only the user's `reconsiderCandidate` brings it back.
 *
 * A Platform list that does not show the resource is not proof it was not
 * made (an accepted write may not be listed yet). After an unconfirmed step the
 * next attempt therefore resends the step's recorded request under its key
 * first: Platform replays the first write for it instead of making a second
 * resource. An unsettled step stays unsettled. The Console reads its own store
 * (the caller's apps), so an app it does not list was not made.
 */
export async function confirmCreate(
  request: CreateRequest,
  resume: CreateProgress,
  deps: { api: Pick<CreateApi, 'app' | 'myApps' | 'sourceRepositories' | 'stacks'>; catalog: CreateCatalog }
): Promise<ConfirmedCreate> {
  // A hit waiting for the user's choice is not looked for again.
  if (resume.candidate) return { progress: resume }
  const progress: CreateProgress = { ...resume, unconfirmed: undefined, unsettled: undefined, unsettledSearched: undefined }
  const phase = resume.unconfirmed ?? (resume.unsettled === 'source' ? 'source' : resume.unsettled === 'stack' ? 'platform' : undefined)
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
  const sourceAttempt = progress.attempts?.source
  if (phase === 'source' && sourceAttempt && !progress.sourceRepositoryId) {
    const hit = (await deps.api.sourceRepositories(request.projectId)).data.find((repository) => !rejectedNow(resume, 'source', repository.id) && atAttemptPlace(repository, sourceAttempt))
    const binding = hit && madeAt(hit, sourceAttempt.binding)
    if (hit && binding) {
      const candidate: CreateCandidate = {
        step: 'source', id: hit.id, binding,
        ...(hit.createdAt ? { createdAt: hit.createdAt } : {}),
        ...(sourceAttempt.sentAt ? { sentAt: sourceAttempt.sentAt } : {}),
      }
      return { progress: { ...progress, candidate } }
    }
  }
  const stackAttempt = progress.attempts?.stack
  if (phase === 'platform' && !progress.stackId) {
    const name = stackAttempt?.appName ?? appName
    const sourceRepositoryId = stackAttempt ? stackAttempt.sourceRepositoryId : progress.sourceRepositoryId
    const hit = (await deps.api.stacks(request.projectId)).find((stack) =>
      !rejectedNow(resume, 'stack', stack.id) && stack.applicationName === name && stack.templateId === deps.catalog.template.id && stack.sourceRepositoryRefName === sourceRepositoryId)
    if (hit) return { progress: { ...progress, candidate: { step: 'stack', id: hit.id, appName: name } } }
  }
  // A refused resend's attempt stays held (nothing is sent for it again), now known not to be listed where it was
  // sent: that is what lets the user explicitly give it up (`abandonUnsettled`).
  const held = resume.unsettled && progress.attempts?.[resume.unsettled] ? resume.unsettled : undefined
  return { progress: held ? { ...progress, unsettled: held, unsettledSearched: true } : progress }
}

/**
 * The user's explicit choice to give up an unsettled create after a readback looked for it where it was sent and did
 * not find it (or found only what the user said is not theirs): its key and request are dropped, and the next 作る starts
 * a new attempt at the destination shown then.
 * Not proof the earlier create failed: it may still be applied later (a resend refused while the first send was in
 * flight, or a first send applied without its key recorded), which then leaves two. Refused (unchanged) before such a readback.
 */
export function abandonUnsettled(progress: CreateProgress): CreateProgress {
  if (!progress.unsettled || !progress.unsettledSearched) return progress
  return { ...progress, ...settled(progress, progress.unsettled), unsettled: undefined, unsettledSearched: undefined }
}

/**
 * 「この置き場で続ける」 / 「このアプリで続ける」: the user says the readback's hit is what the earlier request made. It is kept as
 * `found` (never deleted by the wizard's own cleanup) and the app goes on with it. Its times never stop this: they are
 * shown, not judged (`createdBeforeSent`).
 */
export function acceptCandidate(progress: CreateProgress): CreateProgress {
  const candidate = progress.candidate
  if (!candidate) return progress
  if (candidate.step === 'stack') {
    return { ...progress, ...settled(progress, 'stack'), candidate: undefined, stackId: candidate.id, stackAppName: candidate.appName, stackProvenance: 'found' }
  }
  const attempt = progress.attempts?.source
  if (!attempt) return progress
  return {
    ...progress, ...settled(progress, 'source'), candidate: undefined,
    sourceRepositoryId: candidate.id, sourceRepositoryOrigin: attempt.origin, sourceRepositoryBinding: candidate.binding, sourceRepositoryProvenance: 'found',
  }
}

/**
 * 「自分の置き場ではない」 / 「自分のアプリではない」: a readback for this attempt does not offer the hit again and the earlier
 * attempt stays held, as after a readback that found nothing. Nothing new is created from here: the user may look at the
 * hit again (`reconsiderCandidate`), check the latest state, or explicitly give the attempt up (`abandonUnsettled`, which
 * states the residual risk).
 */
export function rejectCandidate(progress: CreateProgress): CreateProgress {
  const candidate = progress.candidate
  if (!candidate) return progress
  const key = progress.attempts?.[candidate.step]?.key
  const rejected: RejectedCandidate = { candidate, ...(key ? { key } : {}) }
  return { ...progress, candidate: undefined, notMine: [...(progress.notMine ?? []), rejected], unsettled: candidate.step, unsettledSearched: true }
}

/**
 * The hit the held notice offers again: the one rejected longest ago for the held attempt. A hit rejected again goes to
 * the back, so looking again repeatedly walks through every rejected hit; none becomes unreachable.
 */
export function rejectedCandidate(progress: CreateProgress): CreateCandidate | undefined {
  const step = progress.unsettled
  if (!step || progress.candidate) return undefined
  const key = progress.attempts?.[step]?.key
  return progress.notMine?.find((rejected) => rejected.candidate.step === step && rejected.key === key)?.candidate
}

/**
 * 「見つかったものをもう一度見る」: the user takes back "not mine" and the hit is offered again as it was found, with both
 * choices. Sends nothing; its rejection is dropped (choosing "not mine" again records it again).
 */
export function reconsiderCandidate(progress: CreateProgress): CreateProgress {
  const candidate = rejectedCandidate(progress)
  if (!candidate) return progress
  const notMine = progress.notMine?.filter((rejected) => rejected.candidate !== candidate)
  return { ...progress, candidate, notMine: notMine?.length ? notMine : undefined, unsettled: undefined, unsettledSearched: undefined }
}

/** Both creation paths bind the console app to the actual platform name and stack. */
export async function bindCreatedApp(api: Pick<CreateApi, 'bindApp'>, app: BusinessApp, stackId: string, appName: string): Promise<BusinessApp> {
  if (app.stackId === stackId && app.appName === appName) return app
  queueCreatedAppAccess(app.id)
  return api.bindApp(app.id, { stackId, appName })
}
