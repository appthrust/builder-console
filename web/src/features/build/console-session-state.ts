// This tab's UI state for console-v1 sessions (APT-753 S4-U1, design "集約と所有者"):
// only what is not yet the server's: the write being sent with its intent key
// and the session version it was decided on, the key of a session start, and the
// creation's execution request id and bound app on the Platform draft (a reload resumes them).
// Never the session, its turns or its specification, which only the server owns;
// nothing here decides which engine opens a draft.
import { z } from 'zod'
import type { BuildPublishInput, BuildResolutionInput, BuildTurnInput } from '../../model/contracts/console'
import type { CreationTab } from './use-draft-creation'

/**
 * A write this tab has decided on. `pending`: sent or about to be (a resend reuses the key and version, so the
 * server replays instead of applying twice). `unconfirmed`: answered 2xx unreadably; it may have happened, so it
 * is never resent; only a re-read clears it.
 */
export type ConsoleWriteIntent = { key: string; version: number; status: 'pending' | 'unconfirmed' } & (
  | { family: 'turn'; body: BuildTurnInput }
  | { family: 'resolution'; turnId: string; body: BuildResolutionInput }
  | { family: 'publish'; body: BuildPublishInput }
  | { family: 'advance' }
  | { family: 'archive' }
)
export type ConsoleWriteFamily = ConsoleWriteIntent['family']

const common = { key: z.string().min(1).max(128), version: z.number().int().positive(), status: z.enum(['pending', 'unconfirmed']) }
// The bodies were written by this tab from typed values; storage can still be edited or stale, so the shape is
// checked again. The annotations make the compiler hold these in step with the contract's input types.
const revision = z.number().int().nonnegative()
const turnBody: z.ZodType<BuildTurnInput> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conversation'), message: z.string().min(1), intent: z.enum(['auto', 'question', 'suggestions', 'change', 'undecided']), baseSpecRevision: revision }),
  z.strictObject({ kind: z.literal('request_plan'), specRevision: revision }),
])
const resolutionBody: z.ZodType<BuildResolutionInput> = z.strictObject({ decision: z.enum(['accept_spec', 'keep_spec']) })
const publishBody: z.ZodType<BuildPublishInput> = z.strictObject({ name: z.string().min(1), shareScope: z.enum(['private', 'group', 'company']) })
const intentSchema: z.ZodType<ConsoleWriteIntent> = z.discriminatedUnion('family', [
  z.object({ ...common, family: z.literal('turn'), body: turnBody }),
  z.object({ ...common, family: z.literal('resolution'), turnId: z.string().min(1), body: resolutionBody }),
  z.object({ ...common, family: z.literal('publish'), body: publishBody }),
  z.object({ ...common, family: z.literal('advance') }),
  z.object({ ...common, family: z.literal('archive') }),
])

const SESSION_PREFIX = 'builder-console:build-session:'

/** Storage can be unavailable (privacy settings): the in-memory intent still guards the write for this page. */
export function readConsoleIntent(sessionId: string, storage?: Pick<Storage, 'getItem'>): ConsoleWriteIntent | undefined {
  try {
    const raw = (storage ?? sessionStorage).getItem(SESSION_PREFIX + sessionId)
    const parsed = raw ? intentSchema.safeParse(JSON.parse(raw)) : undefined
    return parsed?.success ? parsed.data : undefined
  } catch { return undefined }
}

export function saveConsoleIntent(sessionId: string, intent: ConsoleWriteIntent | undefined, storage?: Pick<Storage, 'setItem' | 'removeItem'>): void {
  try {
    const target = storage ?? sessionStorage
    if (intent) target.setItem(SESSION_PREFIX + sessionId, JSON.stringify(intent))
    else target.removeItem(SESSION_PREFIX + sessionId)
  } catch { /* The in-memory intent remains authoritative for this page. */ }
}

/**
 * A NEW-APP start: the user's words, group and locale, the create key minted once for them, and the session id
 * once an answer named it. A reload or a lost answer resumes this session instead of creating a second one.
 */
export interface ConsoleStart {
  intent: string
  groupId: string
  locale: 'ja' | 'en'
  key: string
  sessionId?: string
}

const startSchema = z.object({
  intent: z.string().min(1), groupId: z.string().min(1), locale: z.enum(['ja', 'en']),
  key: z.string().min(1).max(128), sessionId: z.string().min(1).optional(),
})
const START_KEY = 'builder-console:build-start'

export function readConsoleStart(storage?: Pick<Storage, 'getItem'>): ConsoleStart | undefined {
  try {
    const raw = (storage ?? sessionStorage).getItem(START_KEY)
    const parsed = raw ? startSchema.safeParse(JSON.parse(raw)) : undefined
    return parsed?.success ? parsed.data : undefined
  } catch { return undefined }
}

export function saveConsoleStart(start: ConsoleStart | undefined, storage?: Pick<Storage, 'setItem' | 'removeItem'>): void {
  try {
    const target = storage ?? sessionStorage
    if (start) target.setItem(START_KEY, JSON.stringify(start))
    else target.removeItem(START_KEY)
  } catch { /* Without storage the start still runs; only a reload cannot resume it. */ }
}

/**
 * The creation on a console-v1 session's Platform draft (use-draft-creation): the execution request id and the
 * bound console app, kept so a reload resumes the same execution and binding instead of starting another.
 */
const creationSchema: z.ZodType<CreationTab> = z.object({
  groupId: z.string(), createdAppId: z.string().optional(), continuedAfterPublishAt: z.string().optional(),
  prepareRequested: z.boolean(), reusePlan: z.boolean(), executionRequestId: z.string().optional(), initialReleaseId: z.string().optional(),
})
const CREATION_PREFIX = 'builder-console:build-creation:'

export function readConsoleCreation(draftId: string, storage?: Pick<Storage, 'getItem'>): CreationTab | undefined {
  try {
    const raw = (storage ?? sessionStorage).getItem(CREATION_PREFIX + draftId)
    const parsed = raw ? creationSchema.safeParse(JSON.parse(raw)) : undefined
    return parsed?.success ? parsed.data : undefined
  } catch { return undefined }
}

export function saveConsoleCreation(draftId: string, tab: CreationTab, storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? sessionStorage).setItem(CREATION_PREFIX + draftId, JSON.stringify(tab)) } catch { /* The in-memory tab state still guards this page. */ }
}
