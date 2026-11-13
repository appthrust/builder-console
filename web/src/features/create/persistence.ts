import { z } from 'zod'
import { knownValue } from '../../model/contracts/build'
import type { BusinessApp } from '../../model/contracts/console'
import { initialValues, type CreateValues } from './form'
import type { CreateProgress, SubmitPhase } from './submit'

export const createSteps = ['start', 'details', 'share', 'confirm'] as const
export type CreateStep = (typeof createSteps)[number]
export type Step = 0 | 1 | 2 | 3
export interface CreateSession {
  version: 1
  seed?: { template?: string; intent?: string }
  values: CreateValues
  step: CreateStep
  progress: CreateProgress
  phase?: SubmitPhase
  failure?: { message: string }
}

const phases = z.enum(['draft', 'source', 'checking', 'platform', 'bind'])

const sessionSchema = z.object({
  version: z.literal(1),
  seed: z.object({ template: z.string().optional(), intent: z.string().optional() }).optional(),
  values: z.object({
    entry: z.enum(['existing', 'template', 'image']).optional(), imageRef: z.string(),
    repository: z.object({ fullName: z.string(), defaultBranch: z.string() }).optional(),
    intent: z.string(), templateId: z.string().optional(), displayName: z.string(), description: z.string(),
    tags: z.array(z.string()), groupId: z.string(), urlName: z.string(), urlNameEdited: z.boolean(),
    scope: z.enum(['private', 'group', 'company', 'public']), shareGroupIds: z.array(z.string()).nullable(),
  }),
  step: z.enum(createSteps),
  progress: z.object({
    // This tab's own record of the console app the attempt made (read through the boundary when it was made).
    draft: z.custom<BusinessApp>((value) => typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string').optional(),
    sourceRepositoryId: z.string().optional(),
    sourceRepositoryOrigin: z.object({ appName: z.string(), kind: z.enum(['template', 'existing']), repository: z.string().optional(), templateId: z.string().optional() }).optional(),
    stackId: z.string().optional(), stackAppName: z.string().optional(),
    // A reload keeps an unconfirmed step unconfirmed: only the readback may follow.
    unconfirmed: phases.optional(),
    // Keys of creates that may have been applied: a resend reuses them so Platform replays instead of creating twice.
    attempts: z.object({
      source: z.object({ key: z.string(), origin: z.object({ appName: z.string(), kind: z.enum(['template', 'existing']), repository: z.string().optional(), templateId: z.string().optional() }) }).optional(),
      stack: z.object({ key: z.string(), appName: z.string(), sourceRepositoryId: z.string().optional() }).optional(),
    }).optional(),
  }),
  phase: phases.optional(),
  failure: z.object({ message: z.string() }).optional(),
})

/** Session storage can be unavailable (privacy settings); creation itself must still work. */
export function readCreateSession(draftId?: string, storage?: Pick<Storage, 'getItem'>): CreateSession | undefined {
  try {
    const raw = (storage ?? sessionStorage).getItem(`builder-console:create:${draftId ?? 'new'}`)
    const parsed = raw ? sessionSchema.safeParse(JSON.parse(raw)) : undefined
    return parsed?.success ? parsed.data as CreateSession : undefined
  } catch { return undefined }
}

export function saveCreateSession(session: CreateSession, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const target = storage ?? sessionStorage
    const raw = JSON.stringify(session)
    target.setItem(`builder-console:create:${session.progress.draft?.id ?? 'new'}`, raw)
    // Reloading /new without ?resume must recover the current attempt too.
    target.setItem('builder-console:create:new', raw)
  } catch { /* Storage is optional; the in-memory attempt still owns its progress. */ }
}

export function clearCreateSession(draftId?: string, storage?: Pick<Storage, 'removeItem'>): void {
  try {
    const target = storage ?? sessionStorage
    target.removeItem(`builder-console:create:${draftId ?? 'new'}`)
    target.removeItem('builder-console:create:new')
  } catch { /* Nothing to clear when browser storage is disabled. */ }
}

/**
 * Server metadata is authoritative; locally-kept resource ids prevent duplicate
 * work. A share scope this console does not know is not carried into the form:
 * the most restrictive scope is shown and the resume opens on the share step,
 * so the user chooses the audience before anything is written.
 */
export function restoreCreateDraft(draft: BusinessApp, saved?: CreateSession): CreateSession {
  const values = saved?.values ?? initialValues(draft.group.id)
  const progress = { ...saved?.progress, draft }
  const entry = values.entry
  const scope = knownValue(draft.share.scope)
  return {
    version: 1,
    values: { ...values, entry, displayName: draft.displayName, description: draft.description, tags: draft.tags, groupId: draft.group.id, urlName: draft.slug, scope: scope ?? 'private', shareGroupIds: draft.share.groupIds },
    progress,
    // A draft with a known origin resumes at confirmation. Never guess how an unknown draft was made.
    step: !entry ? 'start' : scope ? 'confirm' : 'share',
  }
}
