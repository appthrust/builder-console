// Step 1's "URL になる名前" check: is the name free before the user leaves the
// step, instead of a conflict at submit. The name is used three times — the
// console path, the platform application name, and (for templates) the new
// source repository. A check that cannot answer does not block submission.
import { ORPCError } from '@orpc/client'
import type { PlatformApiClient } from '../../api/client'
import type { ConsoleApi } from '../../api/console-unverified'
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
  /** The first free numbered variant of a taken name (undefined when none was found). */
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
  resolve: ConsoleApi['resolve']
  platform: Pick<PlatformApiClient, 'platformApiListApplicationStacks' | 'platformApiValidateApplicationSourceRepository'>
  /** Stops looking for a suggestion once the check is stale. */
  signal?: AbortSignal
}

/** Numbered variants tried for a suggestion (`-2` … `-9`). */
const SUGGESTION_TRIES = 8

/** Platform application names of the project, without the user's own stack; empty when unknown. */
async function platformAppNames(request: AvailabilityRequest, deps: AvailabilityDeps): Promise<Set<string>> {
  try {
    const stacks = await deps.platform.platformApiListApplicationStacks({ projectId: request.projectId })
    return new Set(stacks.data.filter((stack) => stack.id !== request.own?.stackId).map((stack) => stack.applicationName))
  } catch {
    return new Set()
  }
}

/** 200 on exactly this path = taken (a redirect from an old path is not); 404 = free; anything else = unknown. */
async function consolePathTaken(name: string, request: AvailabilityRequest, deps: AvailabilityDeps): Promise<boolean> {
  const path = `${request.groupPath}/${name}`.replace(/^\/+/, '')
  try {
    const resolved = await deps.resolve(`/${path}`)
    if (resolved.kind === 'app' && resolved.id === request.own?.draft?.id) return false
    return resolved.currentPath.replace(/^\/+|\/+$/g, '') === path
  } catch {
    return false
  }
}

/**
 * ひな形 only: the GitHub repository the platform would create. The platform
 * answers an existing repository with a 409 conflict (`GitHub repository
 * owner/name already exists`); a `valid: false` saying so counts too.
 */
async function repositoryTaken(name: string, request: AvailabilityRequest, deps: AvailabilityDeps): Promise<boolean> {
  const { catalog, connections } = request
  const origin = request.own?.sourceRepositoryOrigin
  // Only a kept ひな形 repository made for this very name is the user's own; any other origin does not waive the check.
  const own = origin?.kind === 'template' && origin.appName === name
  if (request.entry !== 'template' || !catalog || !connections || own) return false
  try {
    const validation = await deps.platform.platformApiValidateApplicationSourceRepository({
      projectId: request.projectId,
      ...buildSourceRepositoryRequest(name, catalog, connections),
    })
    return !validation.valid && /already exists/i.test(validation.message ?? '')
  } catch (error) {
    if (!(error instanceof ORPCError) || error.status !== 409) return false
    const reason = platformErrorEnvelope(error)?.details?.reason
    return reason !== 'delivery_pending' && reason !== 'delivery_blocked'
  }
}

async function takenBy(
  name: string,
  request: AvailabilityRequest,
  deps: AvailabilityDeps,
  appNames: Set<string>
): Promise<NameTakenBy | undefined> {
  const [onConsole, repository] = await Promise.all([consolePathTaken(name, request, deps), repositoryTaken(name, request, deps)])
  if (onConsole) return 'console'
  if (appNames.has(name)) return 'platform'
  return repository ? 'repository' : undefined
}

async function freeVariant(request: AvailabilityRequest, deps: AvailabilityDeps, appNames: Set<string>): Promise<string | undefined> {
  for (let n = 2; n < 2 + SUGGESTION_TRIES; n++) {
    if (deps.signal?.aborted) return undefined
    const candidate = numberedUrlName(request.urlName, n)
    if (isValidAppName(candidate) && !(await takenBy(candidate, request, deps, appNames))) return candidate
  }
  return undefined
}

/** Who already uses `request.urlName`, and the first free numbered variant when someone does. */
export async function checkNameAvailability(request: AvailabilityRequest, deps: AvailabilityDeps): Promise<NameAvailability> {
  const appNames = await platformAppNames(request, deps)
  const taken = await takenBy(request.urlName, request, deps, appNames)
  if (!taken) return { taken: undefined }
  return { taken, suggestion: await freeVariant(request, deps, appNames) }
}

/** A free numbered variant of a name the server reported taken at submit. */
export async function suggestFreeUrlName(request: AvailabilityRequest, deps: AvailabilityDeps): Promise<string | undefined> {
  return freeVariant(request, deps, await platformAppNames(request, deps))
}
