import type { ApplicationDraft, ApplicationDraftConversationTurn } from '@appthrust/api-schema/platform-api'
import { summarizeCreationPlan } from '../create'
import { buildCopy } from './copy'
import { classifyBuildFailure } from './failure'
import { parseSpec } from './spec'
import { conversationTurns, prepareAnswers } from './questions'
import { needsPlanRefresh } from './stage'
import type { BuildMessage, BuildProposal } from './types'
import { isProductLanguage } from './wording'

/** Handoff tasks the proposal lists before 「ほか n 件」. */
export const PROPOSAL_TASKS = 6

type AssistantBuildMessage = Extract<BuildMessage, { role: 'assistant' }>

/** The three parts of an AI reply (conversation-turn.tmpl: 要約 / 変えたところ / 次の質問). */
export interface AssistantParts {
  summary: string
  changed: string[]
  question?: string
}

const SECTIONS: [keyof AssistantParts, RegExp][] = [
  ['summary', /^(要約|まとめ)$/],
  ['changed', /^(変えたところ|変更したところ|変更点|変更)$/],
  ['question', /^(次の質問|質問|次に決めること)$/],
]
const HEADING = /^\s{0,3}(?:#{1,6}\s*(.+?)\s*#*|\*\*(.+?)\*\*|(.+?)\s*[:：])\s*$/
const BULLET = /^\s*(?:[-*+]\s+|[・•]\s*|\d+[.)．]\s+)/
const NOTHING = /^[（(]?(なし|特になし|ありません|変更なし)[）)]?[。.]?$/

function sectionOf(line: string): keyof AssistantParts | undefined | null {
  const match = HEADING.exec(line)
  if (!match) return null
  const title = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\*\*/g, '').replace(/[:：]\s*$/, '').trim()
  const found = SECTIONS.find(([, pattern]) => pattern.test(title))
  // A `##` heading of an unknown section still ends the previous section; a bare "x:" line is prose.
  return found ? found[0] : match[1] !== undefined ? undefined : null
}

/** Inline markdown the transcript never shows: emphasis, code ticks, links, leading markers. */
export function stripMarkdown(text: string): string {
  return text.split('\n').map((line) => line
    .replace(/^\s{0,3}#{1,6}\s*/, '')
    .replace(/^\s*>\s?/, '')
    .replace(BULLET, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim()).filter(Boolean).join('\n')
}

/**
 * Splits an AI reply into its summary, change list and next question. Tolerates
 * `#`–`######` headings, `**見出し**`, trailing colons, `-`/`・`/numbered bullets,
 * and missing or empty sections. Text without any known section is returned as
 * the summary with markdown markers stripped.
 */
export function parseAssistantMessage(text: string): AssistantParts {
  const buckets: Record<keyof AssistantParts, string[]> = { summary: [], changed: [], question: [] }
  let current: keyof AssistantParts = 'summary'
  let sectioned = false
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const section = sectionOf(line)
    if (section !== null) {
      sectioned ||= section !== undefined
      current = section ?? 'summary'
      continue
    }
    if (line.trim()) buckets[current].push(line)
  }
  if (!sectioned) return { summary: stripMarkdown(text), changed: [] }
  const changed = buckets.changed.map((line) => stripMarkdown(line)).filter((line) => line && !NOTHING.test(line))
  const question = stripMarkdown(buckets.question.join('\n'))
  return { summary: stripMarkdown(buckets.summary.join('\n')), changed, ...(question ? { question } : {}) }
}

/** Parts to render; the API's `changed[]` wins over the parsed bullets. */
export function assistantParts(message: AssistantBuildMessage): AssistantParts {
  const parsed = message.summary !== undefined || message.question !== undefined
    ? { summary: message.summary ?? '', changed: [], ...(message.question ? { question: message.question } : {}) }
    : parseAssistantMessage(message.text)
  return { ...parsed, changed: message.changed?.length ? message.changed : parsed.changed }
}

export function assistantMessage(turn: ApplicationDraftConversationTurn, draftId: string): BuildMessage {
  if (turn.status === 'failed') {
    const at = turn.finishedAt ?? turn.startedAt
    const failure = classifyBuildFailure(turn.error ?? '', undefined, 'turn', { draftId, at })
    return { role: 'notice', tone: 'error', title: failure.title, detail: failure.reason, at, ...(failure.kind !== 'policy' ? { retry: 'turn' as const } : {}), ...(failure.reference ? { reference: failure.reference } : {}) }
  }
  if (turn.status !== 'succeeded') return { role: 'notice', tone: 'info', title: buildCopy.progress.turn.title, at: turn.startedAt }
  const text = turn.assistantMessage ?? ''
  const parts = parseAssistantMessage(text)
  const changed = turn.changed?.length ? turn.changed : parts.changed
  return {
    role: 'assistant', text, summary: parts.summary, at: turn.finishedAt ?? turn.startedAt, turnId: turn.id,
    ...(parts.question ? { question: parts.question } : {}),
    ...(changed.length ? { changed } : {}),
    ...(turn.suggestedReplies?.length ? { options: turn.suggestedReplies } : {}),
  }
}

/**
 * The plan as a proposal the user can read before 「この内容で作る」: the current spec
 * plus the planned address (plain text, not a live URL) and what the AI will build.
 * Infrastructure wording stays in 「詳しい人向け」.
 */
export function planProposal(draft: ApplicationDraft, lastPlannedIntent?: string): BuildProposal | undefined {
  const plan = draft.creationPlan
  if (!plan) return undefined
  const { spec } = parseSpec(draft.specMarkdown)
  const handoff = plan.implementationHandoff?.tasks ?? []
  const readable = handoff.filter((task) => isProductLanguage(task.title))
  // A task's description reads as one line: its first sentence, if it is business language.
  const detail = (text: string) => { const sentence = text.split(/(?<=[。！？])|(?<=[.!?])(?=\s|$)|\n/)[0]?.trim() ?? ''; return sentence && isProductLanguage(sentence) ? sentence : undefined }
  const { url } = summarizeCreationPlan(plan)
  return {
    ...(isProductLanguage(plan.summary) ? { lead: plan.summary.trim() } : {}),
    name: spec.name ?? draft.title,
    ...(spec.oneLine ? { oneLine: spec.oneLine } : {}),
    users: spec.users,
    screens: spec.screens.map((name) => {
      const task = readable.find((item) => item.title.includes(name))
      const purpose = task ? detail(task.description) : undefined
      return purpose ? { name, purpose } : { name }
    }),
    records: spec.records,
    rules: spec.rules,
    ...(url ? { url } : {}),
    tasks: readable.slice(0, PROPOSAL_TASKS).map((task) => { const text = detail(task.description); return text ? { title: task.title, detail: text } : { title: task.title } }),
    moreTasks: Math.max(0, readable.length - PROPOSAL_TASKS) + (handoff.length - readable.length),
    stale: needsPlanRefresh(draft, lastPlannedIntent),
  }
}

/** The proposal sits in the conversation where the plan finished, as the AI's own message. */
function proposalMessage(draft: ApplicationDraft, lastPlannedIntent?: string): BuildMessage | undefined {
  const proposal = planProposal(draft, lastPlannedIntent)
  if (!proposal) return undefined
  const generation = [...(draft.creationPlanGenerations ?? [])].reverse().find((item) => item.status === 'succeeded')
  const at = generation?.finishedAt ?? generation?.startedAt ?? draft.updatedAt
  return { role: 'assistant', text: proposal.lead ?? proposal.name, proposal, at, turnId: `proposal:${generation?.id ?? draft.id}` }
}

export function messagesFromDraft(draft: ApplicationDraft, extra: BuildMessage[], options: { lastPlannedIntent?: string; preparationDone?: boolean } = {}): BuildMessage[] {
  const messages: BuildMessage[] = []
  const all = [...(draft.conversationTurns ?? [])].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  // Excel → app's analysis and screen-design turns read as one line before the conversation,
  // linked back to Excel → app; 「この内容で提案して」 is offered right away, since the
  // specification is already written.
  const excel = all.filter((turn) => turn.kind === 'excel-analysis' || turn.kind === 'ui-design')
  if (excel.some((turn) => turn.status === 'succeeded')) {
    const text = buildCopy.questions.excelReady
    messages.push({ role: 'assistant', text, summary: text, at: excel[0]!.startedAt, turnId: `excel:${draft.id}`, options: [buildCopy.questions.kickoffReply], link: { kind: 'excel2app', draftId: draft.id } })
  }
  const turns = conversationTurns(all)
  for (const turn of turns) {
    messages.push({ role: 'user', text: turn.userMessage, at: turn.startedAt })
    if (turn.status === 'succeeded' || turn.status === 'failed') messages.push(assistantMessage(turn, draft.id))
  }
  const proposal = proposalMessage(draft, options.lastPlannedIntent)
  if (proposal) messages.push(proposal)
  // Only observed template startup earns the completion line; execution success
  // alone merely proves that the application's resources were created.
  const execution = draft.creationExecutions?.at(-1)
  const exchange = prepareAnswers(turns)
  if (execution?.status === 'succeeded' && options.preparationDone && !exchange.open) {
    const text = buildCopy.prepareConversation.ready
    const asked = turns.filter((turn) => exchange.turnIds.includes(turn.id)).map((turn) => turn.finishedAt ?? turn.startedAt)
    const at = [execution.finishedAt ?? draft.updatedAt, ...asked].reduce((latest, item) => Date.parse(item) > Date.parse(latest) ? item : latest)
    messages.push({ role: 'assistant', text, summary: text, at, turnId: `prepared:${execution.id}` })
  }
  for (const message of extra) {
    const duplicate = messages.some((item) => {
      if (item.role !== message.role) return false
      if (item.role === 'assistant' && message.role === 'assistant' && message.turnId) return item.turnId === message.turnId
      if (item.at !== message.at) return false
      if (item.role === 'notice' && message.role === 'notice') return item.title === message.title
      return 'text' in item && 'text' in message && item.text === message.text
    })
    if (!duplicate) messages.push(message)
  }
  return messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}
