import { isOneOf, type BuildDraft, type BuildTurn } from '../contracts/build'
import type { RepositoryDestination } from '../contracts/catalog'
import { destinationImage, destinationRepository, summarizeCreationPlan } from '../create'
import { newRepositoryRequest } from './plan'
import { buildCopy } from './copy'
import { classifyBuildFailure } from './failure'
import { parseSpec } from './spec'
import { conversationTurns, prepareAnswers } from './questions'
import { needsPlanRefresh } from './stage'
import type { BuildMessage, BuildProposal } from './types'
import { isProductLanguage } from './wording'

/** Handoff tasks the proposal lists before 「ほか n 件」. */
export const PROPOSAL_TASKS = 6

/** The repository destination as the page holds it: Platform's answer, or its read still running / failed. */
export type ShownDestination = RepositoryDestination | { kind: 'loading' } | { kind: 'failed' }

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

export function assistantMessage(turn: BuildTurn, draftId: string): BuildMessage {
  if (turn.status.kind === 'unknown') return { role: 'notice', tone: 'warning', title: buildCopy.unsupported.title, detail: buildCopy.unsupported.detail, at: turn.finishedAt ?? turn.startedAt }
  if (turn.status.value === 'failed') {
    const at = turn.finishedAt ?? turn.startedAt
    const failure = classifyBuildFailure(turn.error ?? '', undefined, 'turn', { draftId, at })
    return { role: 'notice', tone: 'error', title: failure.title, detail: failure.reason, at, ...(failure.kind !== 'policy' ? { retry: 'turn' as const } : {}), ...(failure.reference ? { reference: failure.reference } : {}) }
  }
  if (turn.status.value !== 'succeeded') return { role: 'notice', tone: 'info', title: buildCopy.progress.turn.title, at: turn.startedAt }
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
 * plus the planned address (plain text, not a live URL), where a new repository and its
 * image go (Platform's resolved destination, the one the approval binds) and what the AI
 * will build. Infrastructure wording stays in 「詳しい人向け」.
 */
export function planProposal(draft: BuildDraft, lastPlannedIntent?: string, destination?: ShownDestination): BuildProposal | undefined {
  const plan = draft.creationPlan
  if (!plan) return undefined
  const repositoryName = newRepositoryRequest(plan)?.destination?.repositoryName
  const newRepository = !repositoryName || !destination ? undefined
    : destination.kind === 'resolved'
      ? { repository: destinationRepository(destination, repositoryName), image: destinationImage(destination, repositoryName), revision: destination.revision }
      : destination.kind === 'loading' || destination.kind === 'failed' ? destination.kind : 'blocked' as const
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
    ...(newRepository ? { newRepository } : {}),
    tasks: readable.slice(0, PROPOSAL_TASKS).map((task) => { const text = detail(task.description); return text ? { title: task.title, detail: text } : { title: task.title } }),
    moreTasks: Math.max(0, readable.length - PROPOSAL_TASKS) + (handoff.length - readable.length),
    stale: needsPlanRefresh(draft, lastPlannedIntent),
  }
}

/** The proposal sits in the conversation where the plan finished, as the AI's own message. */
function proposalMessage(draft: BuildDraft, lastPlannedIntent?: string, destination?: ShownDestination): BuildMessage | undefined {
  const proposal = planProposal(draft, lastPlannedIntent, destination)
  if (!proposal) return undefined
  const generation = [...draft.creationPlanGenerations].reverse().find((item) => isOneOf(item.status, 'succeeded'))
  const at = generation?.finishedAt ?? generation?.startedAt ?? draft.updatedAt
  return { role: 'assistant', text: proposal.lead ?? proposal.name, proposal, at, turnId: `proposal:${generation?.id ?? draft.id}` }
}

/** A record Platform may mark as the switch from a retired workspace (APT-1264): a conversation turn or a plan generation. */
interface WorkspaceSwitch { startedAt: string; replacedDevWorkspaceId?: string }

/**
 * The records that announce a recreated workspace: of those a surface shows, the first (by start) to name each retired
 * workspace in `replacedDevWorkspaceId`. Derived from the records alone, so every read and reload of the same draft
 * announces the same ones, once each, and a later record that does not carry the field never repeats it.
 */
export function recreatingRecords<T extends WorkspaceSwitch>(records: readonly T[]): Set<T> {
  const announced = new Set<string>()
  const recreating = new Set<T>()
  for (const record of [...records].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    const replaced = record.replacedDevWorkspaceId
    if (!replaced || announced.has(replaced)) continue
    announced.add(replaced)
    recreating.add(record)
  }
  return recreating
}

/** The notice that the workspace was recreated, at the switch's start. Information only: no retry, no reference. */
function workspaceRecreatedNotice(at: string): BuildMessage {
  return { role: 'notice', kind: 'workspace-recreated', tone: 'info', title: buildCopy.workspaceRecreated, at }
}

/**
 * A failed turn a later conversation turn followed (APT-1365): that turn is over, so it reads as one past line. Information
 * only: no retry (it would resend nothing) and nothing asks the user to try again.
 */
function supersededFailureNotice(at: string): BuildMessage {
  return { role: 'notice', tone: 'info', title: buildCopy.failure.superseded, at }
}

/** The conversation turns as the conversation shows them, oldest first; `retry('turn')` resends the last one. */
export function shownConversationTurns(turns: readonly BuildTurn[]): BuildTurn[] {
  return conversationTurns([...turns].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)))
}

/** Of the shown conversation turns (oldest first), the failed ones a later conversation turn followed. */
function supersededIds(shown: readonly BuildTurn[]): Set<string> {
  return new Set(shown.slice(0, -1).filter((turn) => isOneOf(turn.status, 'failed')).map((turn) => turn.id))
}

/** Failed conversation turns a later conversation turn followed (APT-1365): over, never tried again from their notice. */
export function supersededFailures(turns: readonly BuildTurn[]): Set<string> {
  return supersededIds(shownConversationTurns(turns))
}

/**
 * The tab's own messages without the turn-failure notices the draft has made stale, so that they neither show nor hold
 * back a pending reply (use-build-session stops sending while its last message is a notice with `retry: 'turn'`):
 * - a notice naming a superseded failed turn (`turnId`, set when the tab observed that turn fail) is dropped;
 * - a notice saved before notices named their turn (no `turnId`) with `retry: 'turn'` is dropped when no reply is pending
 *   and the last shown conversation turn is not failed. A failed send (HTTP) keeps its reply pending until its retry, so
 *   without a pending reply such a notice can only be an observed turn failure that is no longer the last turn.
 * Every other message stays, a failed send's notice included. Answers `messages` itself when nothing is dropped.
 */
export function withoutStaleTurnFailures(messages: BuildMessage[], turns: readonly BuildTurn[], pending: boolean): BuildMessage[] {
  const shown = shownConversationTurns(turns)
  const superseded = supersededIds(shown)
  const lastFailed = isOneOf(shown.at(-1)?.status, 'failed')
  const stale = (message: BuildMessage) => message.role === 'notice' && (message.turnId !== undefined
    ? superseded.has(message.turnId)
    : message.retry === 'turn' && !pending && !lastFailed)
  return messages.some(stale) ? messages.filter((message) => !stale(message)) : messages
}

/**
 * The newest message the page decides on (re-approval, a rejected plan, the generation limit). A recreated-workspace
 * notice is display only: it is skipped, also when a device clock behind the server's sorts it after a local notice.
 */
export function lastActionable(messages: readonly BuildMessage[]): BuildMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'notice' || message.kind !== 'workspace-recreated') return message
  }
  return undefined
}

export function messagesFromDraft(draft: BuildDraft, extra: BuildMessage[], options: { lastPlannedIntent?: string; preparationDone?: boolean; destination?: ShownDestination } = {}): BuildMessage[] {
  const messages: BuildMessage[] = []
  if (draft.creationPlanUnreadable) messages.push({
    role: 'notice', tone: 'warning', title: buildCopy.unreadablePlan.title, detail: buildCopy.unreadablePlan.detail,
    ...(!draft.createdApplicationId && !draft.createdApplicationStackId && !draft.creationExecutions.length ? { retry: 'plan' as const } : {}), at: draft.updatedAt,
  })
  const all = [...draft.conversationTurns].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  // A switch from a retired workspace is told once, at the record that made it (stable sort: a notice pushed after a
  // message of the same time stays below it).
  const recreating = recreatingRecords<WorkspaceSwitch>([...all, ...draft.creationPlanGenerations])
  const recreated = (record: WorkspaceSwitch) => recreating.has(record) ? [workspaceRecreatedNotice(record.startedAt)] : []
  // Excel → app's analysis and screen-design turns read as one line before the conversation,
  // linked back to Excel → app; 「この内容で提案して」 is offered right away, since the
  // specification is already written.
  const excel = all.filter((turn) => isOneOf(turn.kind, 'excel-analysis', 'ui-design'))
  if (excel.some((turn) => isOneOf(turn.status, 'succeeded'))) {
    const text = buildCopy.questions.excelReady
    messages.push({ role: 'assistant', text, summary: text, at: excel[0]!.startedAt, turnId: `excel:${draft.id}`, options: [buildCopy.questions.kickoffReply], link: { kind: 'excel2app', draftId: draft.id } })
  }
  // The collapsed line does not hide a switch Excel → app's turns made.
  for (const turn of excel) messages.push(...recreated(turn))
  const turns = conversationTurns(all)
  const superseded = supersededIds(turns)
  for (const turn of turns) {
    messages.push({ role: 'user', text: turn.userMessage, at: turn.startedAt })
    // Right below the request, before its answer, also when the answer carries the same time (no finishedAt).
    messages.push(...recreated(turn))
    // A reply in a state this console does not know reads as that, never as an answer or a failure.
    if (turn.status.kind === 'unknown' || isOneOf(turn.status, 'succeeded', 'failed')) {
      const reply = assistantMessage(turn, draft.id)
      // Only the last conversation turn's failure can be tried again (use-build-session `retry('turn')` resends it): a
      // superseded one that offered a retry reads as one past line; one that never did (a policy refusal) keeps its reason.
      messages.push(superseded.has(turn.id) && reply.role === 'notice' && reply.retry ? supersededFailureNotice(reply.at) : reply)
    }
  }
  // A turn of a kind this console does not know is not shown, but its switch is still told.
  for (const turn of all) if (!excel.includes(turn) && !turns.includes(turn)) messages.push(...recreated(turn))
  // Before the plan's proposal, which sits where the generation finished.
  for (const generation of draft.creationPlanGenerations) messages.push(...recreated(generation))
  const proposal = proposalMessage(draft, options.lastPlannedIntent, options.destination)
  if (proposal) messages.push(proposal)
  for (const message of extra) {
    // The tab's notice of a failure it observed is over once a later conversation turn followed that turn.
    if (message.role === 'notice' && message.turnId !== undefined && superseded.has(message.turnId)) continue
    const duplicate = messages.some((item) => {
      if (item.role !== message.role) return false
      if (item.role === 'assistant' && message.role === 'assistant' && message.turnId) return item.turnId === message.turnId
      if (item.at !== message.at) return false
      if (item.role === 'notice' && message.role === 'notice') return item.title === message.title
      return 'text' in item && 'text' in message && item.text === message.text
    })
    if (!duplicate) messages.push(message)
  }
  // Only observed template startup earns the completion line; execution success
  // alone merely proves that the application's resources were created.
  const execution = draft.creationExecutions.at(-1)
  const exchange = prepareAnswers(turns)
  if (execution && isOneOf(execution.status, 'succeeded') && options.preparationDone && !exchange.open) {
    const text = buildCopy.prepareConversation.ready
    // The exchange can end on an unrelated request. Never backdate readiness above
    // that request (or a queued local message); inserting last also breaks timestamp ties.
    const at = messages.reduce((latest, message) => Date.parse(message.at) > Date.parse(latest) ? message.at : latest, execution.finishedAt ?? draft.updatedAt)
    messages.push({ role: 'assistant', text, summary: text, at, turnId: `prepared:${execution.id}` })
  }
  return messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}
