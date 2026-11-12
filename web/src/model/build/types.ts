export type BuildStage = 'ask' | 'decide' | 'build' | 'publish'
export type BuildPhase = 'preparing' | 'implementing' | 'done'
export interface BuildSpecRecord { name: string; fields: string[] }
export interface BuildSpec {
  name?: string
  oneLine?: string
  users: string[]
  screens: string[]
  records: BuildSpecRecord[]
  rules: string[]
  approval?: 'none' | 'one-step' | 'two-step' | 'notify-only'
  importFrom?: 'none' | 'csv' | 'excel'
}
/** What 「作る」 will make, in the user's words (messages.ts#planProposal); shown in the chat and the right pane. */
export interface BuildProposal {
  /** The plan's own one-sentence summary, when it is product language. */
  lead?: string
  name: string
  oneLine?: string
  users: string[]
  screens: { name: string; purpose?: string }[]
  records: BuildSpecRecord[]
  rules: string[]
  /** Planned address only, rendered as non-clickable text until a screen release succeeds. */
  url?: string
  /** What the AI builds (handoff tasks): the first few, product language only. */
  tasks: { title: string; detail?: string }[]
  moreTasks: number
  /** The spec changed after this plan was made; preparing regenerates it first. */
  stale: boolean
}
export type BuildMessage =
  | { role: 'user'; text: string; at: string }
  /**
   * `text` is the reply as written (markdown); `summary` / `changed` / `question` are its
   * parsed parts (messages.ts#parseAssistantMessage). `link` points back to where the
   * message's content was made (the collapsed Excel → app line opens its analysis and screens).
   */
  | { role: 'assistant'; text: string; summary?: string; changed?: string[]; question?: string; options?: string[]; proposal?: BuildProposal; link?: { kind: 'excel2app'; draftId: string }; at: string; turnId?: string }
  | { role: 'notice'; tone: 'info' | 'warning' | 'error'; title: string; detail?: string; at: string; retry?: 'turn' | 'plan' | 'prepare' | 'implement' | 'publish'; reference?: BuildFailure['reference'] }
export interface ProgressCard {
  kind: 'workspace' | 'turn' | 'plan' | 'prepare' | 'implement' | 'publish'
  title: string
  hint?: string
  elapsedLabel?: string
  /** The last few lines of what the AI is doing right now; proves a long step is alive. */
  activity?: string[]
  interrupted: boolean
  steps?: { label: string; state: 'todo' | 'doing' | 'done' | 'failed'; detail?: string; elapsedLabel?: string; expectation?: string; activity?: string; taskId?: string; status?: string }[]
  /** Structured preparation phases, absent for older APIs. */
  staged?: boolean
  currentActivity?: string
  buildUrl?: string
  buildFailed?: boolean
  delayHint?: string
}
export interface BuildPrimary {
  action: 'plan' | 'prepare' | 'prepare-after-plan' | 'publish' | 'continue' | 'none'
  label: string
  enabled: boolean
}
export interface BuildFailure {
  /** `destination`: the platform would not create the repository where the plan said; the fix is its destination setting. */
  kind: 'workspace' | 'unavailable' | 'policy' | 'quota' | 'limit' | 'forbidden' | 'timeout' | 'failed' | 'name-taken' | 'interrupted' | 'platform' | 'group' | 'destination'
  title: string
  reason: string
  suggestedName?: string
  reasonCode?: 'PublishURLConflict'
  raw?: string
  /** Support correlation only; diagnostics stay in the advanced disclosure. */
  reference?: { draftId: string; executionId?: string; at: string }
}
