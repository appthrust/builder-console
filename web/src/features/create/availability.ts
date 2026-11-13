// Step 1's "URL になる名前" check: is the name free before the user leaves the
// step, instead of a conflict at submit. The name is used three times — the
// console path, the platform application name, and (for templates) the new
// source repository. A check that cannot answer does not block submission
// (the create itself still meets the server's conflict), but it never reads
// as "free": an unanswered source makes the name unchecked, and a numbered
// variant is only suggested when every source answered that it is free.
import { ORPCError } from '@orpc/client'
import { isConsoleError } from '../../api/console'
import type { CreateApi } from '../../api/create'
import { platformErrorEnvelope } from '../../api/platform-error'
import {
  buildSourceRepositoryRequest,
  isValidAppName,
  numberedUrlName,
  type CreateCatalog,
  type CreateEntry,
  type SourceConnections,
} from '../../model/create'
import type { CreateProgress } from './submit'

export type NameTakenBy = 'console' | 'platform' | 'repository'

export interface NameAvailability {
  taken: NameTakenBy | undefined
  /** False when a source could not answer: the name is then neither known free nor known taken. */
  checked: boolean
  /** The first numbered variant every source answered free (undefined when none was found). */
  suggestion?: string
}

export interface AvailabilityRequest {
  projectId: string
  /** The owner group's path ("sales/east"). */
  groupPath: string
  urlName: string
  entry: Exclude<CreateEntry, 'ai'> | undefined
  /** ひな形 only: what the repository request is built from. */
  catalog?: CreateCatalog
  connections?: SourceConnections
  /** What an earlier attempt of this wizard made: the user's own, never "taken". */
  own?: Pick<CreateProgress, 'draft' | 'stackId' | 'sourceRepositoryOrigin'>
}

export interface AvailabilityDeps {
  api: Pick<CreateApi, 'resolve' | 'stacks' | 'validateSourceRepository'>
  /** Stops looking for a suggestion once the check is stale. */
  signal?: AbortSignal
}

/** One source's answer: taken, free, or `undefined` when it could not answer. */
type Answer = boolean | undefined

/** Numbered variants tried for a suggestion (`-2` … `-9`). */
const SUGGESTION_TRIES = 8

/** Platform application names of the project, without the user's own stack; undefined when they could not be read. */
async function platformAppNames(request: AvailabilityRequest, deps: AvailabilityDeps): Promise<Set<string> | undefined> {
  try {
    const stacks = await deps.api.stacks(request.projectId)
    return new Set(stacks.filter((stack) => stack.id !== request.own?.stackId).map((stack) => stack.applicationName))
  } catch {
    return undefined
  }
}

/** 200 on exactly this path = taken (a redirect from an old path is not); 404 = free; anything else = unknown. */
async function consolePathTaken(name: string, request: AvailabilityRequest, deps: AvailabilityDeps): Promise<Answer> {
  const path = `${request.groupPath}/${name}`.replace(/^\/+/, '')
  try {
    const resolved = await deps.api.resolve(`/${path}`)
    // A kind this console does not know still occupies its path.
    const { currentPath } = resolved.kind === 'supported' ? resolved.value : resolved.identity
    if (resolved.kind === 'supported' && resolved.value.kind === 'app' && resolved.value.id === request.own?.draft?.id) return false
    return currentPath.replace(/^\/+|\/+$/g, '') === path
  } catch (error) {
    return isConsoleError(error) && error.status === 404 ? false : undefined
  }
}

/**
 * ひな形 only: the GitHub repository the platform would create. The platform
 * answers an existing repository with a 409 conflict (`GitHub repository
 * owner/name already exists`); a `valid: false` saying so counts too.
 */
async function repositoryTaken(name: string, request: AvailabilityRequest, deps: AvailabilityDeps): Promise<Answer> {
  const { catalog, connections } = request
  const origin = request.own?.sourceRepositoryOrigin
  // Only a kept ひな形 repository made for this very name is the user's own; any other origin does not waive the check.
  const own = origin?.kind === 'template' && origin.appName === name
  if (request.entry !== 'template' || !catalog || !connections || own) return false
  try {
    const validation = await deps.api.validateSourceRepository(request.projectId, buildSourceRepositoryRequest(name, catalog, connections))
    return !validation.valid && /already exists/i.test(validation.message ?? '')
  } catch (error) {
    if (!(error instanceof ORPCError) || error.status !== 409) return undefined
    const reason = platformErrorEnvelope(error)?.details?.reason
    return reason === 'delivery_pending' || reason === 'delivery_blocked' ? undefined : true
  }
}

async function takenBy(
  name: string,
  request: AvailabilityRequest,
  deps: AvailabilityDeps,
  appNames: Set<string> | undefined
): Promise<{ taken: NameTakenBy | undefined; checked: boolean }> {
  const [onConsole, repository] = await Promise.all([consolePathTaken(name, request, deps), repositoryTaken(name, request, deps)])
  if (onConsole) return { taken: 'console', checked: true }
  if (appNames?.has(name)) return { taken: 'platform', checked: true }
  if (repository) return { taken: 'repository', checked: true }
  return { taken: undefined, checked: onConsole !== undefined && appNames !== undefined && repository !== undefined }
}

async function freeVariant(request: AvailabilityRequest, deps: AvailabilityDeps, appNames: Set<string> | undefined): Promise<string | undefined> {
  // Without the platform's names no variant can be shown to be free.
  if (!appNames) return undefined
  for (let n = 2; n < 2 + SUGGESTION_TRIES; n++) {
    if (deps.signal?.aborted) return undefined
    const candidate = numberedUrlName(request.urlName, n)
    if (!isValidAppName(candidate)) continue
    const answer = await takenBy(candidate, request, deps, appNames)
    if (!answer.taken && answer.checked) return candidate
  }
  return undefined
}

/** Who already uses `request.urlName`, and the first free numbered variant when someone does. */
export async function checkNameAvailability(request: AvailabilityRequest, deps: AvailabilityDeps): Promise<NameAvailability> {
  const appNames = await platformAppNames(request, deps)
  const answer = await takenBy(request.urlName, request, deps, appNames)
  if (!answer.taken) return answer
  return { ...answer, suggestion: await freeVariant(request, deps, appNames) }
}

/** A free numbered variant of a name the server reported taken at submit. */
export async function suggestFreeUrlName(request: AvailabilityRequest, deps: AvailabilityDeps): Promise<string | undefined> {
  return freeVariant(request, deps, await platformAppNames(request, deps))
}
