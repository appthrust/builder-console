import { jobState, type BuildDraft } from '../../model/contracts/build'
import { z } from 'zod'
import { isBuildPending } from '../../model/build/progress'
import { buildCopy } from '../../model/build/copy'
import { decomposeBuildIntent, isKickoffReply, isPrepareTurn } from '../../model/build/questions'
import type { BuildMessage, BuildStage } from '../../model/build/types'
import { localized } from '../../shell/language'
import { text, textJa } from './copy'
import { textEn } from './copy.en'

const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: z.string(), at: z.string() }),
  z.object({ role: z.literal('assistant'), text: z.string(), at: z.string(), summary: z.string().optional(), changed: z.array(z.string()).optional(), question: z.string().optional(), options: z.array(z.string()).optional(), turnId: z.string().optional() }),
  z.object({ role: z.literal('notice'), tone: z.enum(['info', 'warning', 'error']), title: z.string(), detail: z.string().optional(), at: z.string(), retry: z.enum(['turn', 'plan', 'prepare', 'implement', 'publish', 'confirm']).optional(), reference: z.object({ draftId: z.string(), executionId: z.string().optional(), at: z.iso.datetime() }).optional() }),
])
const sessionSchema = z.object({
  baseIntent: z.string(),
  projectId: z.string(),
  ownerSubject: z.string(),
  groupId: z.string(),
  kickoffSent: z.boolean().default(false),
  messages: z.array(messageSchema),
  pending: z.array(z.object({ text: z.string(), at: z.string() })),
  lastPlannedIntent: z.string().optional(),
  createdAppId: z.string().optional(),
  continuedAfterPublishAt: z.string().optional(),
  prepareRequested: z.boolean().default(false),
  planRequested: z.boolean().default(false),
  planRetries: z.number().default(0),
  reusePlan: z.boolean().default(false),
  executionRequestId: z.string().optional(),
  /** The template release observed before any implementation task is pushed. */
  initialReleaseId: z.string().optional(),
})
export type BuildSession = z.infer<typeof sessionSchema>
export const stageLabels: Record<BuildStage, string> = localized({ ja: textJa.session.stageLabels, en: textEn.session.stageLabels })
export const buildStages: BuildStage[] = ['ask', 'decide', 'build', 'publish']
const PREFIX = 'builder-console:build:'

export function initialSession(input: Pick<BuildSession, 'baseIntent' | 'projectId' | 'ownerSubject' | 'groupId'>): BuildSession {
  return { ...input, baseIntent: decomposeBuildIntent(input.baseIntent), messages: [], pending: [], kickoffSent: false, prepareRequested: false, planRequested: false, planRetries: 0, reusePlan: false }
}

export function readBuildSession(draftId: string, storage?: Pick<Storage, 'getItem'>): BuildSession | undefined {
  try {
    const raw = (storage ?? sessionStorage).getItem(PREFIX + draftId)
    const result = raw ? sessionSchema.safeParse(JSON.parse(raw)) : undefined
    return result?.success ? result.data : undefined
  } catch { return undefined }
}

export function saveBuildSession(draftId: string, session: BuildSession, storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? sessionStorage).setItem(PREFIX + draftId, JSON.stringify(session)) } catch { /* The in-memory session remains usable when storage is unavailable. */ }
}

export function forgetBuildSession(draftId: string, storage?: Pick<Storage, 'removeItem'>): void {
  try { (storage ?? sessionStorage).removeItem(PREFIX + draftId) } catch { /* Nothing to forget when storage is unavailable. */ }
}

/** Persist the reservation with the queued first turn before starting its request. */
export function startConversation(session: BuildSession, draft: Pick<BuildDraft, 'conversationTurns' | 'creationPlan' | 'creationExecutions' | 'phase'>, at: string): BuildSession {
  // Only a draft known to be before creation opens the conversation; an unknown phase starts nothing.
  if (session.kickoffSent || session.pending.length || draft.conversationTurns.length || draft.creationPlan || draft.creationExecutions.length || draft.phase.kind !== 'known' || draft.phase.value === 'created') return session
  return queueReply({ ...session, kickoffSent: true }, buildCopy.questions.firstTurn, at)
}

/** While 用意する runs and the AI is idle, queue the hidden preparation turn once. */
export function startPrepareConversation(session: BuildSession, draft: Pick<BuildDraft, 'conversationTurns' | 'creationPlanGenerations' | 'creationExecutions' | 'publishPreferences'>, at: string): BuildSession {
  const turns = draft.conversationTurns
  if ((draft.publishPreferences?.name && draft.publishPreferences.shareScope) || session.pending.length || session.messages.some((message) => message.role === 'user' && isPrepareTurn(message.text)) || !isBuildPending(draft.creationExecutions.at(-1))) return session
  // The AI must be known to be idle: a turn or generation in a state this console does not know may still run.
  if (turns.some((turn) => isPrepareTurn(turn.userMessage) || jobState(turn) !== 'settled') || jobState(draft.creationPlanGenerations.at(-1)) !== 'settled') return session
  return queueReply(session, buildCopy.questions.prepareTurn, at)
}

export function queueReply(session: BuildSession, text: string, at: string): BuildSession {
  const reply = { text: text.trim(), at }
  if (!reply.text) return session
  const message: BuildMessage = { role: 'user', ...reply }
  return { ...session, planRequested: session.planRequested || isKickoffReply(reply.text), pending: [...session.pending, reply], messages: [...session.messages, message] }
}

export function acknowledgeReply(session: BuildSession, at: string): BuildSession {
  return { ...session, pending: session.pending.filter((message) => message.at !== at), messages: session.messages.filter((message) => !(message.role === 'user' && message.at === at)) }
}

/** First clause of the intent; a Markdown heading (the Excel specification starts with one) loses its `#`. */
export function titleFromIntent(intent: string): string {
  return intent.trim().split(/[\n。！？]/, 1)[0]?.replace(/^#+\s*/, '').slice(0, 60) || text.session.newApp
}
