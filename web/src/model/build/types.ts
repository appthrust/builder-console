export type BuildStage = 'ask' | 'decide' | 'build' | 'publish'
export type BuildPhase = 'preparing' | 'implementing' | 'done'
/**
 * What the build stage says about the implementation run in the header and the conversation (APT-1124).
 * `implementing`: tasks finished (done or skipped) of all, the current task's title when it is product language,
 * the time since the run started, and whether its lease lapsed while running (server-side recovery owns it).
 * `built`: finished with something pushed (公開する is the next step); `unchanged`: finished with every task skipped;
 * `stopped`: the run failed or was cancelled.
 */
export type BuildOutcome =
  | { kind: 'implementing'; finished: number; total: number; current?: string; elapsedLabel?: string; interrupted: boolean }
  | { kind: 'built' | 'unchanged' | 'stopped' }
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
   * Where a new repository is created and its image pushed as the proposal shows it (Platform's resolved destination,
   * with the `revision` an approval binds), `blocked` when none is resolved, `loading` while it is read and `failed`
   * when it could not be read. Only a shown destination (the object form) can be approved. Absent: the plan makes no
   * new repository.
   */
  newRepository?: { repository: string; image: string; revision: string } | 'blocked' | 'loading' | 'failed'
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
  /**
   * `retry: 'confirm'` re-reads the draft after a write whose answer could not be read; it never resends that write.
   * `retry: 'recheck'`: Platform's validation rejected the plan for a cause that may lie outside it; the notice offers
   * 「もう一度確かめる」 (the same plan validated once more) and 「計画を作り直す」.
   */
  | { role: 'notice'; tone: 'info' | 'warning' | 'error'; title: string; detail?: string; at: string; retry?: 'turn' | 'plan' | 'prepare' | 'implement' | 'publish' | 'confirm' | 'recheck'; reference?: BuildFailure['reference'] }
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
   * `plan`: Platform's validation answered that this plan cannot be approved as it is, for a reason this console knows
   * (or a plan generation's stored error is that check); nothing was created and a new plan goes on.
   */
  kind: 'workspace' | 'unavailable' | 'policy' | 'quota' | 'limit' | 'forbidden' | 'timeout' | 'failed' | 'name-taken' | 'interrupted' | 'platform' | 'group' | 'unconfirmed' | 'destination' | 'plan'
  title: string
  reason: string
  /**
   * `destination` only: how the destination stopped it. `changed`: the plan now shows the current destination and
   * the user approves again (「この内容で作る」, nothing to clean up); `blocked`: only a Project administrator can set it.
   */
  destination?: 'changed' | 'blocked' | 'mismatch'
  /**
   * `plan` only: what the plan has to change. `destination`: it does not carry the Project's current repository
   * destination (none, or another one); `incomplete`: it breaks Platform's rules for a plan.
   */
  plan?: 'destination' | 'incomplete'
  /**
   * Platform's validation answered `valid: false` for a cause that may lie outside the plan: a reason this console
   * does not know (kind `platform`, with its reference) or a repository destination Platform calls unusable (kind
   * `plan`). The same plan may be validated once more, only on the user's 「もう一度確かめる」 (use-draft-creation `recheck`).
   */
  recheck?: true
  suggestedName?: string
  reasonCode?: 'PublishURLConflict'
  raw?: string
  /** Support correlation only; diagnostics stay in the advanced disclosure. */
  reference?: { draftId: string; executionId?: string; at: string }
}
