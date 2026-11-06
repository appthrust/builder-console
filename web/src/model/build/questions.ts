import type { ApplicationDraftConversationTurn, ApplicationDraftConversationTurnKind, ApplicationDraftPublishPreferences, ExcelAnalysis } from '@appthrust/api-schema/platform-api'
import { shareScopeLabel, type DraftShareScope } from '../access'
import { apps } from '../../copy/apps'
import { appsEn } from '../../copy/apps.en'
import { buildCopy, textJa } from './copy'
import { textEn } from './copy.en'
import type { BuildMessage } from './types'

/**
 * The turns of the build conversation. Excel → app's excel-analysis and ui-design turns
 * run on the same draft but are not replies: they never enter the intent or the chat.
 * A turn without `kind` predates the field and is a conversation turn.
 */
export function conversationTurns<T extends { kind?: ApplicationDraftConversationTurnKind }>(turns: readonly T[] = []): T[] {
  return turns.filter((turn) => turn.kind === undefined || turn.kind === 'conversation')
}

/** Recognize saved prompts in either language, even after the console switches language. */
export function isFirstTurn(text: string): boolean {
  return text === textJa.questions.firstTurn || text === textEn.questions.firstTurn
}

export function isKickoffReply(text: string): boolean {
  return text === textJa.questions.kickoffReply || text === textEn.questions.kickoffReply
}

export function isPrepareTurn(text: string): boolean {
  return text === textJa.questions.prepareTurn || text === textEn.questions.prepareTurn
}

/** Only successful AI turns count; notices and the derived proposal are not replies. */
export function replyOptions(messages: BuildMessage[]): string[] {
  const conversation = messages.filter((message) => message.role !== 'notice' && !(message.role === 'assistant' && message.proposal))
  const latest = conversation.at(-1)
  if (latest?.role !== 'assistant') return []
  const previous = conversation.at(-2)
  const options = latest.options ?? []
  if (previous?.role === 'user' && isKickoffReply(previous.text)) return options
  // 用意する asks two fixed things; 「この内容で提案して」 would restart planning.
  if (conversation.some((message) => message.role === 'user' && isPrepareTurn(message.text))) return options
  const successful = conversation.filter((message) => message.role === 'assistant' && message.turnId).length
  return successful >= 3 && !options.some(isKickoffReply) ? [...options, buildCopy.questions.kickoffReply] : options
}

/** Conversation replies enter the plan in order; publication keeps its explicit marker. */
export function composeBuildIntent(base: string, replies: string[], publish?: boolean): string {
  const parts = [base.trim()]
  for (const reply of replies) if (reply.trim()) parts.push(`${buildCopy.intent.reply}\n\n${reply.trim()}`)
  const marker = publish === true ? `\n\n${buildCopy.intent.publish}` : ''
  let content = parts.filter(Boolean).join('\n\n').slice(0, 8000 - marker.length)
  // Do not leave half a UTF-16 surrogate at the storage boundary.
  if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1)
  return content.trimEnd() + marker
}

/** Recover the user-authored opening from the console's persisted intent envelope. */
export function decomposeBuildIntent(intent: string): string {
  let base = intent.trim()
  for (const catalog of [textJa, textEn]) {
    const reply = base.indexOf(`\n\n${catalog.intent.reply}\n\n`)
    if (reply >= 0) base = base.slice(0, reply)
    const marker = `\n\n${catalog.intent.publish}`
    if (base.endsWith(marker)) base = base.slice(0, -marker.length)
  }
  return base
}

/** Integrated entities already exclude headers, reports and merged duplicates. */
export function importedRowCount(analysis: Pick<ExcelAnalysis, 'entities'> | undefined): number | undefined {
  return analysis?.entities.reduce((sum, entity) => sum + entity.importRows, 0)
}

/** Accept historical Q&A labels when reading already-persisted turns. */
const SHARE_CHOICES: DraftShareScope[] = ['private', 'group', 'company']
const SHARE_WORDS: [DraftShareScope, RegExp][] = [['private', /自分だけ|自分のみ|私だけ/], ['company', /全社|会社全体|社員全員/], ['group', /課|部署|チーム|グループ/]]

export function prepareShareScope(reply: string, ownerGroupName?: string): DraftShareScope | undefined {
  return SHARE_CHOICES.find((scope) => reply === apps.create.share[scope].title || reply === appsEn.create.share[scope].title
    || (scope === 'group' && (reply === '自分の課' || reply === 'My group' || (ownerGroupName && reply === ownerGroupName)))
    || (scope === 'company' && reply === 'Everyone at work'))
}

/** Normalize AI-suggested audience chips without changing unrelated suggestions. */
export function prepareShareLabel(reply: string, ownerGroupName?: string): string {
  const scope = prepareShareScope(reply, ownerGroupName)
  return scope ? shareScopeLabel(scope, ownerGroupName) : reply
}

export interface PrepareAnswers {
  /** The name to publish under: the reply to the AI's first 用意する question. */
  name?: string
  shareChoice?: DraftShareScope
  /** The preparation prompt and its replies; their spec changes never invalidate the plan. */
  turnIds: string[]
  /** The AI is still asking (its latest turn belongs to the exchange): replies go to it, even once the app is made. */
  open: boolean
}
type PrepareTurn = Pick<ApplicationDraftConversationTurn, 'id' | 'status' | 'startedAt' | 'userMessage' | 'suggestedReplies'> & { kind?: ApplicationDraftConversationTurnKind }

/**
 * The answers to the latest preparation prompt: the name first, then who sees the app. A name is an
 * offered option or one short line; a reply that is neither ends the exchange (it is a spec request).
 * Explicit Excel hand-off answers supersede the exchange without inventing conversation turns.
 */
export function prepareAnswers(turns: readonly PrepareTurn[] = [], preferences?: ApplicationDraftPublishPreferences, ownerGroupName?: string): PrepareAnswers {
  const answered = { ...(preferences?.name ? { name: preferences.name } : {}), ...(preferences?.shareScope ? { shareChoice: preferences.shareScope } : {}) }
  const ordered = conversationTurns(turns).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  let start = ordered.length - 1
  while (start >= 0 && !isPrepareTurn(ordered[start]!.userMessage)) start--
  const opening = ordered[start]
  if (!opening) return { ...answered, turnIds: [], open: false }
  const result: PrepareAnswers = { turnIds: [opening.id], open: false }
  const replies = ordered.slice(start + 1).filter((turn) => turn.status !== 'failed').slice(0, 2)
  for (const [index, turn] of replies.entries()) {
    const reply = turn.userMessage.trim()
    const share = prepareShareScope(reply, ownerGroupName)
      ?? (index > 0 ? SHARE_WORDS.find(([, pattern]) => pattern.test(reply))?.[0] : undefined)
    if (share) {
      result.shareChoice = share
      result.turnIds.push(turn.id)
      break
    }
    const offered = opening.suggestedReplies?.includes(reply)
    const name = offered ? reply : reply.replace(/^[「『"“]+|[」』"”]+$/g, '').trim()
    if (index > 0 || !(offered || /^[^\n。！？!?]{1,40}$/.test(name))) break
    result.name = name
    result.turnIds.push(turn.id)
  }
  const last = ordered.filter((turn) => turn.status !== 'failed').at(-1)
  result.open = opening.status !== 'failed' && !result.shareChoice && last !== undefined && result.turnIds.includes(last.id)
  return { ...result, ...answered, open: preferences?.name && preferences.shareScope ? false : result.open }
}
