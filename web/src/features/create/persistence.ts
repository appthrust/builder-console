import { z } from 'zod'
import type { BusinessApp } from '../../api/console'
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
    draft: z.custom<BusinessApp>((value) => typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string').optional(),
    sourceRepositoryId: z.string().optional(),
    sourceRepositoryOrigin: z.object({ appName: z.string(), kind: z.enum(['template', 'existing']), repository: z.string().optional(), templateId: z.string().optional() }).optional(),
    stackId: z.string().optional(), stackAppName: z.string().optional(),
  }),
  phase: z.enum(['draft', 'source', 'checking', 'platform', 'bind']).optional(),
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

/** Server metadata is authoritative; locally-kept resource ids prevent duplicate work. */
export function restoreCreateDraft(draft: BusinessApp, saved?: CreateSession): CreateSession {
  const values = saved?.values ?? initialValues(draft.group.id)
  const progress = { ...saved?.progress, draft }
  const entry = values.entry
  return {
    version: 1,
    values: { ...values, entry, displayName: draft.displayName, description: draft.description, tags: draft.tags, groupId: draft.group.id, urlName: draft.slug, scope: draft.share.scope, shareGroupIds: draft.share.groupIds },
    progress,
    // A draft with a known origin resumes at confirmation. Never guess how an unknown draft was made.
    step: entry ? 'confirm' : 'start',
  }
}
