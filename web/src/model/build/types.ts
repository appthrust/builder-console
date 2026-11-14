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
  /**
   * Where a new repository is created and its image pushed (Platform's resolved destination), or
   * `blocked` when none is resolved. Absent: the plan makes no new repository, or the destination is still read.
   */
  newRepository?: { repository: string; image: string } | 'blocked'
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
  /** `retry: 'confirm'` re-reads the draft after a write whose answer could not be read; it never resends that write. */
  | { role: 'notice'; tone: 'info' | 'warning' | 'error'; title: string; detail?: string; at: string; retry?: 'turn' | 'plan' | 'prepare' | 'implement' | 'publish' | 'confirm'; reference?: BuildFailure['reference'] }
export interface ProgressCard {
  kind: 'workspace' | 'turn' | 'plan' | 'prepare' | 'implement' | 'publish'
  title: string
  hint?: string
  elapsedLabel?: string
  /** The last few lines of what the AI is doing right now; proves a long step is alive. */
  activity?: string[]
  interrupted: boolean
  /** `unknown`: the server reported a state this console version does not know; never shown as done or failed. */
  steps?: { label: string; state: 'todo' | 'doing' | 'done' | 'failed' | 'unknown'; detail?: string; elapsedLabel?: string; expectation?: string; activity?: string; taskId?: string; status?: string }[]
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
  /**
   * `unconfirmed`: a write answered 2xx with an answer this console could not read; it may have happened.
   * `destination`: Platform's repository destination moved, is not set, or did not match; nothing was created.
   */
  kind: 'workspace' | 'unavailable' | 'policy' | 'quota' | 'limit' | 'forbidden' | 'timeout' | 'failed' | 'name-taken' | 'interrupted' | 'platform' | 'group' | 'unconfirmed' | 'destination'
  title: string
  reason: string
  /**
   * `destination` only: how the destination stopped it. `changed`: the plan now shows the current destination and
   * the user approves again (「この内容で作る」, nothing to clean up); `blocked`: only a Project administrator can set it.
   */
  destination?: 'changed' | 'blocked' | 'mismatch'
  suggestedName?: string
  reasonCode?: 'PublishURLConflict'
  raw?: string
  /** Support correlation only; diagnostics stay in the advanced disclosure. */
  reference?: { draftId: string; executionId?: string; at: string }
}
