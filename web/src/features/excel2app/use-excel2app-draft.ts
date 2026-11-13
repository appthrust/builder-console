// One draft owns the workbook set, staged analysis, specification and screen design.
// Files are parsed and stored sequentially; only an explicit start submits analysis.
import { isOneOf, jobState, knownValue, type BuildDraft, type BuildTurn, type PublishPreferences, type TurnKind } from '../../model/contracts/build'
import { analysisComplete, completeUiDesign, excelAnalysisOf, uiDesignOf, workbookReadingOf, type CompleteUiDesign, type ExcelAnalysis, type UiDesign, type WorkbookEntry, type WorkbookSummary } from '../../model/contracts/excel'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../../api/build'
import { buildDraftOptions, readDraft } from '../../api/queries/build'
import { draftWorkbookGridOptions, draftWorkbooksOptions } from '../../api/queries/excel'
import { isResponseContractError } from '../../api/boundary'
import { platformErrorEnvelope } from '../../api/platform-error'
import { useCreationTools } from '../../api/queries/catalog'
import { classifyBuildFailure } from '../../model/build/failure'
import type { BuildFailure } from '../../model/build/types'
import { parseAssistantMessage } from '../../model/build/messages'
import { isBuildPending } from '../../model/build/progress'
import { parseSpec, serializeSpec } from '../../model/build/spec'
import { filesFromList, isWorkbookFile, workbookBudget, type CollectedWorkbook, type WorkbookFileState } from './collect'
import { designFromReadings, readingOf } from './design'
import { text, textJa } from './copy'
import { textEn } from './copy.en'
import { fromDraftWorkbook, planApp, toDraftWorkbook, type AppPlan, type WorkbookGrid } from './model'
import { excelSpecMarkdown, withUiDecisions } from './spec'
import { applyInstruction, suggestedInstructions } from './ui-assistant'
import { defaultUiDesign } from './ui-design'
import { readXlsx, UnsupportedWorkbook } from './xlsx'

/** The ui-design turn that derives the default design from the specification. */
export const UI_DESIGN_INIT = '__init__'

/** A turn message is at most 4,000 characters; an undo whose design JSON does not fit is not offered. */
const TURN_MESSAGE_MAX = 4000

/** The 「AI なしで続ける」 choice of a draft survives a reload of this tab. */
const OFFLINE_PREFIX = 'builder-console:excel2app:offline:'

const EMPTY_MEMBERS: WorkbookSummary[] = []
export type Excel2AppStep = 0 | 1 | 2 | 3 | 4

export interface CollectionResult {
  id: string
  /** An analysis was requested, including requests rejected before a turn exists. */
  analysisRequested: boolean
}

/** One bubble of the chat. Failed turns retain their cause for classification by the notice. */
export interface UiPreviewChatMessage {
  role: 'user' | 'assistant'
  text: string
  pending?: boolean
  failed?: boolean
  failure?: BuildFailure
}

/** Why the excel-analysis turn could not start. */
export type AnalysisProblem = 'unavailable' | 'failed' | 'quota' | 'policy'

/** Why the workbook could not be stored. */
export type StoreProblem = Exclude<WorkbookFileState, 'reading' | 'storing' | 'stored' | 'unsupported' | 'unreadable'> | 'busy' | 'created' | 'unconfirmed'

export class WorkbookStoreError extends Error {
  constructor(readonly problem: StoreProblem, readonly location?: { sheet?: string; row?: number }) {
    super(problem)
  }
}

export function errorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') return error.status
  return platformErrorEnvelope(error)?.status
}

/** Creation closes Excel preparation, even if a subsequent draft read is stale or fails. */
export function isApplicationCreated(error: unknown): boolean {
  return errorStatus(error) === 409 && platformErrorEnvelope(error)?.details?.reason === 'ApplicationCreated'
}

/** API reasons, not message wording, determine a file's terminal state. */
export function classifyStoreError(error: unknown): WorkbookStoreError {
  const status = errorStatus(error)
  const details = platformErrorEnvelope(error)?.details
  if (status === 400) {
    const sheet = typeof details?.sheet === 'string' ? details.sheet : undefined
    const row = typeof details?.row === 'number' && Number.isSafeInteger(details.row) && details.row >= 1 ? details.row : undefined
    return new WorkbookStoreError('invalid', sheet !== undefined || row !== undefined ? { sheet, row } : undefined)
  }
  if (status === 413) return new WorkbookStoreError(details?.reason === 'WorkbookSetTooLarge' ? 'setTooLarge' : 'tooLarge')
  if (status === 409) {
    const reason = details?.reason
    return new WorkbookStoreError(reason === 'ApplicationCreated' ? 'created' : reason === 'DraftBusy' ? 'busy' : reason === 'WorkbookDuplicate' ? 'duplicate' : reason === 'WorkbookSetFull' ? 'setFull' : 'failed')
  }
  return new WorkbookStoreError('failed')
}

/** The file name without its extension: the draft's title. */
export function fileStem(fileName: string): string {
  return fileName.replace(/\.(xlsx|xlsm)$/i, '') || fileName
}

/** Turns belonging to the current membership revision, including its boundary. */
export function currentTurns(draft: BuildDraft): BuildTurn[] {
  const revision = draft.source?.revision
  const turns = draft.conversationTurns
  return revision ? turns.filter((turn) => Date.parse(turn.startedAt) >= Date.parse(revision)) : turns
}

const turnsOf = (turns: BuildTurn[], kind: TurnKind) => turns.filter((turn) => isOneOf(turn.kind, kind))

export const isUndoMessage = (message: string) => message.startsWith(textJa.preview.undoRequest) || message.startsWith(textEn.preview.undoRequest)

/** The ui-design turn that restores `previous`: only a complete design is ever sent back (nothing in it is dropped). */
export function undoMessage(previous: CompleteUiDesign): string {
  return `${text.preview.undoRequest}\n\`\`\`json\n${JSON.stringify(previous)}\n\`\`\``
}

/** Designs the ui-design turns produced, as an undo stack: each change pushes, each undo pops. */
export function designStack(turns: BuildTurn[]): UiDesign[] {
  const stack: UiDesign[] = []
  for (const turn of turns) {
    if (!isOneOf(turn.status, 'succeeded') || !turn.uiDesign) continue
    if (isUndoMessage(turn.userMessage) && stack.length > 1) stack.pop()
    else stack.push(turn.uiDesign)
  }
  return stack
}

/** The chat the ui-design turns make: the instruction, then the reply's summary (or its error). */
export function designMessages(turns: BuildTurn[]): UiPreviewChatMessage[] {
  const messages: UiPreviewChatMessage[] = []
  for (const turn of turns) {
    const pending = isBuildPending(turn)
    if (turn.userMessage !== UI_DESIGN_INIT) messages.push({ role: 'user', text: isUndoMessage(turn.userMessage) ? text.preview.undoMessage : turn.userMessage, ...(pending ? { pending: true } : {}) })
    if (isOneOf(turn.status, 'failed')) messages.push({ role: 'assistant', text: turn.error || text.preview.turnFailed, failed: true })
    else if (isOneOf(turn.status, 'succeeded') && turn.assistantMessage) {
      const parts = parseAssistantMessage(turn.assistantMessage)
      messages.push({ role: 'assistant', text: parts.summary || parts.question || turn.assistantMessage })
    }
  }
  return messages
}

/** A collected set stays on step 0 until analysis has explicitly started. */
export function resumeStep(draft: BuildDraft, analysed: boolean): Excel2AppStep {
  if (!draft.source) return 0
  if (!analysed) return turnsOf(currentTurns(draft), 'excel-analysis').length > 0 ? 1 : 0
  if (!draft.uiDesign && turnsOf(currentTurns(draft), 'ui-design').length === 0) return 2
  return 3
}

/** The specification's front-matter text, kept verbatim when only the body is edited. */
export function specParts(specMarkdown: string): { frontMatter: string; body: string } {
  const { body } = parseSpec(specMarkdown)
  return { frontMatter: specMarkdown.slice(0, specMarkdown.length - body.length), body }
}

/**
 * Saves the latest value, one save at a time. A request while a save runs waits for it and
 * then saves whatever is latest by then, so text typed during a slow save is never dropped;
 * every caller (blur, 次へ) resolves once the value current at its call is settled.
 */
export function latestSaver(save: (value: string) => Promise<boolean>, latest: () => string | undefined, saved: (value: string) => void): () => Promise<boolean> {
  let inFlight: Promise<boolean> | undefined
  const run = (): Promise<boolean> => {
    if (inFlight) return inFlight.then(run)
    const value = latest()
    if (value === undefined) return Promise.resolve(true)
    inFlight = save(value)
      .then((ok) => {
        if (ok) saved(value)
        return ok
      })
      .finally(() => { inFlight = undefined })
    return inFlight
  }
  return run
}

/**
 * The name the excel-analysis turn wrote into the specification's front-matter, when the
 * draft's title (the file name until now) should follow it: the turn succeeded and no app
 * exists or is being made. Original file names stay in the source membership.
 */
export function analysisTitle(draft: BuildDraft, turn: BuildTurn | undefined): string | undefined {
  // An execution in a state this console does not know may be making the app: the title is not rewritten then.
  if (!isOneOf(turn?.status, 'succeeded') || draft.createdApplicationStackId || draft.createdApplicationId || jobState(draft.creationExecutions.at(-1)) !== 'settled') return undefined
  const name = parseSpec(draft.specMarkdown).spec.name?.trim()
  return name && name !== draft.title ? name : undefined
}

/** 用意する's two questions, persisted on the draft for every tab. */
export type PublishChoice = Required<PublishPreferences>

/** The hand-off's PATCH: the aligned name (title and specification) and the publish preferences. */
export interface HandOffPatch { title?: string; specMarkdown?: string; publishPreferences: PublishChoice }

/** Align the title/spec name and replace the draft's publish preferences in the same PATCH. */
export function handOffPatch(draft: Pick<BuildDraft, 'title' | 'specMarkdown'>, specMarkdown: string, publish: PublishChoice): HandOffPatch {
  const { name } = publish
  const { spec, body } = parseSpec(specMarkdown)
  // A document without readable front-matter keeps its text as is; the title still carries the name.
  const named = spec.name === name || body === specMarkdown ? specMarkdown : serializeSpec({ ...spec, name }, body)
  return { ...(draft.title === name ? {} : { title: name }), ...(named === draft.specMarkdown ? {} : { specMarkdown: named }), publishPreferences: publish }
}

type SpecSave = { state: 'idle' | 'saving' | 'saved' } | { state: 'failed'; body: string }

/** The 「AI なしで続ける」 preview: the design lives in this tab until the hand-off writes it into the specification. */
interface OfflineDesign {
  design: CompleteUiDesign
  history: CompleteUiDesign[]
  messages: UiPreviewChatMessage[]
}

function readOffline(draftId: string): boolean {
  try { return sessionStorage.getItem(OFFLINE_PREFIX + draftId) === '1' } catch { return false }
}

function saveOffline(draftId: string) {
  try { sessionStorage.setItem(OFFLINE_PREFIX + draftId, '1') } catch { /* The in-memory choice still applies to this visit. */ }
}

export function useExcel2AppDraft(projectId: string, draftId: string | undefined) {
  const queryClient = useQueryClient()
  const tools = useCreationTools(projectId)
  /** `false` only when the project answered that AI is unavailable; unknown counts as available. */
  const codexAvailable = tools.data?.codexAvailable !== false
  const draftQuery = useQuery({ ...buildDraftOptions(projectId, draftId ?? ''), enabled: Boolean(draftId) })
  const [storedDraft, setStoredDraft] = useState<BuildDraft>()
  const observed = draftQuery.data ?? (storedDraft?.projectId === projectId && (!draftId || storedDraft.id === draftId) ? storedDraft : undefined)
  // This flow's writes reach the draft cache at once (`receive`), but the page re-renders with them only after
  // React Query's batched observer notification. A render in between must already read the written draft: with
  // the observed one, `draftRef` goes back to the older draft and the next write builds on it (a turn appended
  // to the draft as it was before the PATCH that preceded it, undoing that PATCH in the cache).
  const draft = observed ? queryClient.getQueryData<BuildDraft>(buildDraftOptions(projectId, observed.id).queryKey) ?? observed : undefined
  const members = draft?.source?.workbooks ?? EMPTY_MEMBERS
  const [previewRequested, setPreviewRequested] = useState(false)
  const [offline, setOffline] = useState(() => (draftId ? readOffline(draftId) : false))
  const [analysisProblem, setAnalysisProblem] = useState<{ kind: AnalysisProblem; failure?: BuildFailure }>()
  const [specSave, setSpecSave] = useState<SpecSave>({ state: 'idle' })
  const [sending, setSending] = useState<string>()
  const [sendProblem, setSendProblem] = useState<{ instruction: string; message: string; failure?: BuildFailure }>()
  const [offlineDesign, setOfflineDesign] = useState<OfflineDesign>()
  const [createdDraftId, setCreatedDraftId] = useState<string>()
  const createdDraftRef = useRef<string>(undefined)
  /** A write answered 2xx in a shape this console cannot read: it may have happened. Writes stay closed until a re-read. */
  const [unconfirmed, setUnconfirmed] = useState(false)
  const unconfirmedRef = useRef(false)
  const readOnly = Boolean(draft?.createdApplicationId || draft?.createdApplicationStackId || (draft && createdDraftId === draft.id))
  const lock = useRef(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  /** A new draft whose failed workbook upload could not be cleaned up; reuse it across renders. */
  const pendingWorkbookDraft = useRef<BuildDraft>(undefined)
  const [files, setFiles] = useState<CollectedWorkbook[]>([])
  const [collecting, setCollecting] = useState(false)
  const [starting, setStarting] = useState(false)
  const [hint, setHint] = useState('')
  const uploads = useRef(new Map<string, File | WorkbookGrid>())
  const collectLock = useRef(false)

  const turns = useMemo(() => (draft ? currentTurns(draft) : []), [draft])
  const analysisTurn = turnsOf(turns, 'excel-analysis').at(-1)
  const designTurns = useMemo(() => turnsOf(turns, 'ui-design'), [turns])
  const latestDesignTurn = designTurns.at(-1)
  // A turn in a state this console does not know may still run: nothing new is sent over it.
  const turnRunning = turns.some((turn) => jobState(turn) !== 'settled')

  const version = `${draft?.source?.revision ?? ''}:${analysisTurn?.id ?? ''}:${analysisTurn ? knownValue(analysisTurn.status) ?? 'unknown' : ''}`
  const workbooksQuery = useQuery({ ...draftWorkbooksOptions(projectId, draft?.id ?? '', version), enabled: Boolean(draft?.source) })
  const gridQueries = useQueries({
    queries: members.map((member) => ({
      ...draftWorkbookGridOptions(projectId, draft!.id, member.id),
      enabled: previewRequested || offline || !codexAvailable,
    })),
    combine: (results) => ({ data: results.map((query) => query.data), failed: results.some((query) => query.isError) }),
  })
  const grids = useMemo(() => {
    const result = new Map<string, WorkbookGrid>()
    for (const [index, data] of gridQueries.data.entries()) {
      if (data) result.set(members[index]!.id, fromDraftWorkbook(data))
    }
    return result
  }, [gridQueries.data, members])
  const gridsReady = members.length > 0 && grids.size === members.length
  const inputs = useMemo(() => gridsReady ? members.map((summary) => ({ summary, grid: grids.get(summary.id)! })) : [], [gridsReady, members, grids])
  const reading = useMemo<ExcelAnalysis | undefined>(() => draft?.excelAnalysis ?? (offline && gridsReady ? excelAnalysisOf(designFromReadings(inputs)) : undefined), [draft?.excelAnalysis, offline, gridsReady, inputs])
  const plan = useMemo<AppPlan | undefined>(() => reading ? planApp(reading, draft?.title ?? '') : undefined, [reading, draft?.title])
  const usingOffline = offline && !draft?.excelAnalysis
  /** The offline fallback's own readings (read through the same constructor as the server's); the server's come from `workbooksQuery`. */
  const offlineEntries = useMemo<WorkbookEntry[] | undefined>(() => usingOffline && gridsReady ? inputs.map((input) => ({ workbook: input.summary, reading: workbookReadingOf(readingOf(input)) })) : undefined, [usingOffline, gridsReady, inputs])

  /**
   * Writes a write's answer into the draft cache after cancelling draft reads still in flight (polls and
   * `refetchDraft`, which run as the draft query): they started before this answer arrived, and landing
   * afterwards they would put back the draft as it was before the write.
   */
  async function receive(next: BuildDraft) {
    const { queryKey } = buildDraftOptions(projectId, next.id)
    await queryClient.cancelQueries({ queryKey, exact: true })
    draftRef.current = next
    setStoredDraft(next)
    queryClient.setQueryData(queryKey, next)
  }

  async function appendTurn(turn: BuildTurn) {
    const latest = draftRef.current
    if (latest) await receive({ ...latest, conversationTurns: [...latest.conversationTurns, turn] })
  }

  /** Re-reads the draft as the draft query (never a bare GET), so a later write's answer cancels it instead of being overwritten. */
  async function refetchDraft() {
    const id = draftRef.current?.id
    if (!id) return
    const read = await readDraft(queryClient, projectId, id)
    draftRef.current = read
    setStoredDraft(read)
  }

  function isReadOnly() {
    const current = draftRef.current
    return Boolean(current?.createdApplicationId || current?.createdApplicationStackId || (current && createdDraftRef.current === current.id))
  }

  /** No new write starts: the app exists, or an earlier write is still unconfirmed. */
  function writesClosed() {
    return isReadOnly() || unconfirmedRef.current
  }

  /**
   * A write whose 2xx answer this console cannot read may have happened (design §6): nothing from it is cached,
   * nothing is resent, the draft is read back, and only `confirm` (a re-read) reopens writes.
   */
  function unconfirmedWrite(error: unknown): boolean {
    if (!isResponseContractError(error)) return false
    unconfirmedRef.current = true
    setUnconfirmed(true)
    const id = draftRef.current?.id
    if (id) void queryClient.invalidateQueries({ queryKey: buildDraftOptions(projectId, id).queryKey })
    return true
  }

  /** Reads the latest draft and its set back; files whose add was unconfirmed are matched to it or offered again (same key). */
  async function confirm() {
    if (draftRef.current) await refetchDraft()
    const id = draftRef.current?.id
    if (id) await queryClient.invalidateQueries({ queryKey: [...buildDraftOptions(projectId, id).queryKey.slice(0, 3), 'workbooks'] })
    const members = draftRef.current?.source?.workbooks ?? []
    setFiles((rows) => rows.map((row) => {
      if (row.problem !== 'unconfirmed') return row
      const stored = members.find((member) => member.fileName === row.fileName && !rows.some((other) => other.workbookId === member.id))
      if (!stored) return { ...row, problem: undefined }
      uploads.current.delete(row.key)
      return { ...row, state: 'stored', problem: undefined, workbookId: stored.id }
    }))
    unconfirmedRef.current = false
    setUnconfirmed(false)
  }

  function markCreated(id: string) {
    createdDraftRef.current = id
    setCreatedDraftId(id)
    setAnalysisProblem(undefined)
    setSendProblem(undefined)
    void refetchDraft().catch(() => undefined)
  }

  async function exclusive<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return undefined
    lock.current = true
    try { return await action() } finally { lock.current = false }
  }

  function resetAnalysis(id: string) {
    try { sessionStorage.removeItem(OFFLINE_PREFIX + id) } catch { /* The in-memory choice is cleared too. */ }
    setOffline(false)
    setOfflineDesign(undefined)
    setAnalysisProblem(undefined)
    setSendProblem(undefined)
    setSpecSave({ state: 'idle' })
  }

  function confirmSetChange(): boolean {
    return !draftRef.current?.excelAnalysis && !offline || window.confirm(text.pick.confirmChange)
  }

  /** R19: a failed first POST deletes its new draft, or retains that draft for reuse. */
  async function store(grid: WorkbookGrid, key: string): Promise<string> {
    if (isReadOnly()) throw new WorkbookStoreError('created')
    const payload = toDraftWorkbook(grid)
    const current = pendingWorkbookDraft.current?.projectId === projectId ? pendingWorkbookDraft.current : draftRef.current
    let target = current
    try {
      target ??= await api.createDraft(projectId, { title: fileStem(grid.fileName), intent: text.pick.draftIntent(grid.fileName) })
      let result: api.WorkbookAdded
      try {
        result = await api.addWorkbook(projectId, target.id, payload, key)
      } catch (error) {
        // An unconfirmed add may have stored the workbook: the new draft is kept for the re-read and a same-key retry.
        if (!current && !isResponseContractError(error)) {
          try { await api.deleteDraft(projectId, target.id) }
          catch { pendingWorkbookDraft.current = target }
        } else if (!current) pendingWorkbookDraft.current = target
        throw error
      }
      pendingWorkbookDraft.current = undefined
      queryClient.setQueryData(draftWorkbookGridOptions(projectId, result.draft.id, result.workbook.id).queryKey, payload)
      await receive(result.draft)
      resetAnalysis(result.draft.id)
      setFiles((rows) => rows.map((row) => row.key === key ? { ...row, state: 'stored', workbookId: result.workbook.id } : row))
      uploads.current.delete(key)
      return result.draft.id
    } catch (error) {
      if (isApplicationCreated(error) && target) markCreated(target.id)
      if (unconfirmedWrite(error)) {
        // The new draft itself was answered readably: it is bound so the re-read and the same-key retry find it.
        if (target && !current) await receive(target)
        throw new WorkbookStoreError('unconfirmed')
      }
      throw classifyStoreError(error)
    }
  }

  function changeFile(key: string, patch: Partial<CollectedWorkbook>) {
    setFiles((rows) => rows.map((row) => row.key === key ? { ...row, ...patch } : row))
  }

  async function processFile(key: string, input: File | WorkbookGrid) {
    if (input instanceof File && !isWorkbookFile(input.name)) {
      changeFile(key, { state: 'unsupported' })
      return false
    }
    let grid: WorkbookGrid
    try {
      changeFile(key, { state: 'reading', problem: undefined, location: undefined })
      grid = input instanceof File ? await readXlsx(input) : input
    } catch (error) {
      changeFile(key, { state: error instanceof UnsupportedWorkbook ? 'unsupported' : 'unreadable' })
      return false
    }
    changeFile(key, { state: 'storing' })
    try { await store(grid, key); return true }
    catch (error) {
      const { problem } = error instanceof WorkbookStoreError ? error : new WorkbookStoreError('failed')
      const flagged = problem === 'busy' || problem === 'created' || problem === 'unconfirmed'
      changeFile(key, { state: flagged ? 'failed' : problem, problem: flagged ? problem : undefined, location: error instanceof WorkbookStoreError ? error.location : undefined })
      return false
    }
  }

  async function collect(inputs: readonly (File | WorkbookGrid)[], start = false): Promise<CollectionResult | undefined> {
    if (inputs.length === 0 || collectLock.current || lock.current || writesClosed() || turnRunning || !confirmSetChange()) return
    collectLock.current = true
    setCollecting(true)
    try {
      const queued = inputs.map((input) => ({ input, key: crypto.randomUUID() }))
      for (const { input, key } of queued) uploads.current.set(key, input)
      setFiles((rows) => [...rows, ...queued.map(({ input, key }): CollectedWorkbook => ({ key, fileName: input instanceof File ? input.name : input.fileName, state: 'reading' }))])
      let allStored = true
      for (const { input, key } of queued) {
        // An unconfirmed add closes writes: the rest of the batch is not sent; after the re-read each is offered again (same key).
        if (unconfirmedRef.current) {
          changeFile(key, { state: 'failed' })
          allStored = false
        } else if (!await processFile(key, input)) allStored = false
      }
      const analysisRequested = start && allStored && Boolean(draftRef.current?.source)
      if (analysisRequested) await analyse()
      return draftRef.current ? { id: draftRef.current.id, analysisRequested } : undefined
    } finally {
      collectLock.current = false
      setCollecting(false)
    }
  }

  async function retryFile(key: string) {
    const input = uploads.current.get(key)
    if (!input || collectLock.current || lock.current || turnRunning || writesClosed() || !confirmSetChange()) return
    collectLock.current = true
    setCollecting(true)
    try { await processFile(key, input) }
    finally { collectLock.current = false; setCollecting(false) }
  }

  async function removeWorkbook(key: string, workbookId?: string) {
    if (collectLock.current || lock.current || turnRunning || writesClosed()) return
    if (workbookId && !confirmSetChange()) return
    collectLock.current = true
    setCollecting(true)
    try {
      const current = draftRef.current
      if (workbookId && current) {
        await receive(await api.removeWorkbook(projectId, current.id, workbookId))
        resetAnalysis(current.id)
      }
      uploads.current.delete(key)
      setFiles((rows) => rows.filter((row) => row.key !== key && (!workbookId || row.workbookId !== workbookId)))
    } catch (error) {
      if (isApplicationCreated(error) && draftRef.current) markCreated(draftRef.current.id)
      if (unconfirmedWrite(error)) return
      throw classifyStoreError(error)
    } finally { collectLock.current = false; setCollecting(false) }
  }

  async function analyse(message = hint) {
    const current = draftRef.current
    if (!current?.source || writesClosed() || currentTurns(current).some((turn) => jobState(turn) !== 'settled')) return
    setAnalysisProblem(undefined)
    setStarting(true)
    try {
      await exclusive(async () => {
        try {
          const first = current.source!.workbooks[0]!
          await receive(await api.updateDraft(projectId, current.id, { title: fileStem(first.fileName), intent: text.pick.setIntent(first.fileName, current.source!.workbooks.length) }))
          await appendTurn(await api.createTurn(projectId, current.id, { kind: 'excel-analysis', message: message.trim() }))
        } catch (error) {
          if (isApplicationCreated(error)) return markCreated(current.id)
          if (unconfirmedWrite(error)) return
          const status = errorStatus(error)
          if (status === 409) return void (await refetchDraft().catch(() => undefined))
          const envelope = platformErrorEnvelope(error)
          const message = envelope?.message ?? (error instanceof Error ? error.message : '')
          const failure = classifyBuildFailure(message, status, 'turn', undefined, envelope?.code, undefined, undefined, envelope?.details)
          setAnalysisProblem({ kind: failure.kind === 'policy' || failure.kind === 'quota' ? failure.kind : status === 412 ? 'unavailable' : 'failed', failure })
        }
      })
    } finally { setStarting(false) }
  }

  // The AI names the app in the specification; the draft's title follows once per analysis.
  const titled = useRef(new Set<string>())
  const nextTitle = draft && !readOnly ? analysisTitle(draft, analysisTurn) : undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the analysis turn and the name; the PATCH reads the latest draft through a ref.
  useEffect(() => {
    const current = draftRef.current
    if (!nextTitle || !current || !analysisTurn) return
    const key = `${current.id}:${analysisTurn.id}`
    if (titled.current.has(key)) return
    titled.current.add(key)
    // A failed rename leaves the file name as the title; the hand-off writes the publish name anyway.
    void api.updateDraft(projectId, current.id, { title: nextTitle }).then(receive, () => undefined)
  }, [nextTitle, analysisTurn?.id])

  async function continueOffline() {
    const current = draftRef.current
    if (!current || !gridsReady || codexAvailable || writesClosed() || turnRunning) return
    const local = designFromReadings(inputs)
    const localPlan = planApp(excelAnalysisOf(local), current.title)
    await exclusive(async () => {
      try {
        await receive(await api.updateDraft(projectId, current.id, { specMarkdown: excelSpecMarkdown(local, localPlan, members) }))
        saveOffline(current.id)
        setOffline(true)
        setAnalysisProblem(undefined)
      } catch (error) {
        if (isApplicationCreated(error)) markCreated(current.id)
        else if (!unconfirmedWrite(error)) setAnalysisProblem({ kind: 'failed' })
      }
    })
  }

  /** Saves an edited specification body under the unchanged front-matter; resolves whether it is saved. */
  async function saveSpec(body: string): Promise<boolean> {
    const current = draftRef.current
    if (!current || writesClosed()) return false
    const { frontMatter, body: saved } = specParts(current.specMarkdown)
    if (body === saved) {
      if (specSave.state === 'failed') setSpecSave({ state: 'idle' })
      return true
    }
    setSpecSave({ state: 'saving' })
    try {
      await receive(await api.updateDraft(projectId, current.id, { specMarkdown: `${frontMatter}${body}` }))
      setSpecSave({ state: 'saved' })
      return true
    } catch (error) {
      // An unconfirmed save keeps the typed text unsaved (it is not resent); the re-read decides what to do next.
      setSpecSave(unconfirmedWrite(error) ? { state: 'idle' } : { state: 'failed', body })
      return false
    }
  }

  async function sendDesignTurn(message: string) {
    const current = draftRef.current
    if (!current || writesClosed()) return
    await exclusive(async () => {
      setSendProblem(undefined)
      setSending(message)
      try {
        await appendTurn(await api.createTurn(projectId, current.id, { kind: 'ui-design', message }))
      } catch (error) {
        if (isApplicationCreated(error)) return markCreated(current.id)
        if (unconfirmedWrite(error)) return
        const status = errorStatus(error)
        if (status === 409) await refetchDraft().catch(() => undefined)
        const envelope = platformErrorEnvelope(error)
        const cause = envelope?.message ?? (error instanceof Error ? error.message : '')
        const failure = classifyBuildFailure(cause, status, 'turn', undefined, envelope?.code, undefined, undefined, envelope?.details)
        setSendProblem({ instruction: message, message: failure.kind === 'policy' ? failure.reason : failure.kind === 'quota' ? cause : status === 412 ? text.preview.unavailable : status === 409 ? text.preview.busy : text.preview.turnFailed, failure })
      } finally {
        setSending(undefined)
      }
    })
  }

  // ── UI design ────────────────────────────────────────────────────────────
  const stack = useMemo(() => designStack(designTurns), [designTurns])
  const previous = stack.at(-2)
  const serverDesign = draft?.uiDesign ?? stack.at(-1) ?? null
  // The offline design is complete by construction; it is shown through the same constructor as the server's.
  const offlineShown = useMemo(() => (offlineDesign ? uiDesignOf(offlineDesign.design) : null), [offlineDesign])
  const currentDesign = usingOffline ? offlineShown : serverDesign
  /** Whether the shown design can be written as it is: no part of it is of a kind this console does not know or unreadable. */
  const designComplete = Boolean(currentDesign && completeUiDesign(currentDesign))
  /** The hand-off builds from the analysis and the design: an unknown part of either keeps it closed (also after a reload). */
  const handOffReady = designComplete && Boolean(reading && analysisComplete(reading))

  /** Entering the preview asks for the default design once, unless one exists or is on its way. */
  function initDesign() {
    if (isReadOnly()) return
    if (usingOffline) {
      if (!offlineDesign && plan) {
        const design = defaultUiDesign(plan)
        const screens = design.screens.filter((screen) => !screen.hidden).map((screen) => screen.title)
        setOfflineDesign({ design, history: [], messages: [{ role: 'assistant', text: text.preview.greeting(screens, text.accent[design.accent]) }] })
      }
      return
    }
    if (draftRef.current?.uiDesign || designTurns.length > 0 || sending) return
    void sendDesignTurn(UI_DESIGN_INIT)
  }

  function send(instruction: string) {
    if (isReadOnly()) return
    if (usingOffline) {
      if (!offlineDesign || !plan) return
      const result = applyInstruction(offlineDesign.design, plan, instruction)
      setOfflineDesign({
        design: result.changed ? result.design : offlineDesign.design,
        history: result.changed ? [...offlineDesign.history, offlineDesign.design] : offlineDesign.history,
        messages: [...offlineDesign.messages, { role: 'user', text: instruction }, { role: 'assistant', text: result.reply }],
      })
      return
    }
    void sendDesignTurn(instruction)
  }

  // Undo sends the previous design back, so both it and the design it replaces must be complete: never drop a part.
  const previousComplete = previous && designComplete ? completeUiDesign(previous) : undefined
  const serverUndo = previousComplete ? undoMessage(previousComplete) : undefined
  const canUndo = usingOffline ? Boolean(offlineDesign?.history.length) : Boolean(serverUndo && serverUndo.length <= TURN_MESSAGE_MAX)

  function undo() {
    if (isReadOnly()) return
    if (usingOffline) {
      const last = offlineDesign?.history.at(-1)
      if (!offlineDesign || !last) return
      setOfflineDesign({ design: last, history: offlineDesign.history.slice(0, -1), messages: [...offlineDesign.messages, { role: 'user', text: text.preview.undoMessage }, { role: 'assistant', text: text.preview.undone }] })
      return
    }
    if (canUndo && serverUndo) void sendDesignTurn(serverUndo)
  }

  /** Re-sends what failed: the local send error first, else the last ui-design turn when it failed. */
  function retryDesign() {
    if (sendProblem) return void sendDesignTurn(sendProblem.instruction)
    if (isOneOf(latestDesignTurn?.status, 'failed')) void sendDesignTurn(latestDesignTurn!.userMessage)
  }

  const messages = useMemo<UiPreviewChatMessage[]>(() => {
    if (usingOffline) return offlineDesign?.messages ?? []
    const list = designMessages(designTurns)
    if (sending && sending !== UI_DESIGN_INIT) list.push({ role: 'user', text: isUndoMessage(sending) ? text.preview.undoMessage : sending, pending: true })
    if (sendProblem) {
      if (sendProblem.instruction !== UI_DESIGN_INIT) list.push({ role: 'user', text: isUndoMessage(sendProblem.instruction) ? text.preview.undoMessage : sendProblem.instruction })
      list.push({ role: 'assistant', text: sendProblem.message, failed: true, failure: sendProblem.failure })
    }
    return list
  }, [usingOffline, offlineDesign, designTurns, sending, sendProblem])

  const designBusy = usingOffline ? false : Boolean(sending) || isBuildPending(latestDesignTurn)
  const suggestions = usingOffline
    ? (offlineDesign && plan ? suggestedInstructions(offlineDesign.design, plan) : [])
    : isOneOf(latestDesignTurn?.status, 'succeeded') ? (latestDesignTurn!.suggestedReplies ?? []) : []

  /** Persist the fallback's screen decisions, aligned name and publish preferences before opening the build. */
  async function handOff(publish: PublishChoice): Promise<boolean> {
    const current = draftRef.current
    // The build must not start from an analysis or design whose unknown part the user never saw.
    if (!current || writesClosed() || !handOffReady) return false
    const specMarkdown = usingOffline && offlineDesign ? withUiDecisions(current.specMarkdown, offlineDesign.design) : current.specMarkdown
    const patch = handOffPatch(current, specMarkdown, publish)
    try {
      await receive(await api.updateDraft(projectId, current.id, patch))
    } catch {
      return false
    }
    return true
  }

  return {
    draftQuery,
    draft,
    readOnly,
    workbooksQuery,
    offlineEntries,
    grids,
    gridsReady,
    gridsFailed: gridQueries.failed,
    loadGrids: () => setPreviewRequested(true),
    retryGrids: () => { for (const member of members) void queryClient.refetchQueries({ queryKey: draftWorkbookGridOptions(projectId, draft!.id, member.id).queryKey }) },
    files: [...members.map((member): CollectedWorkbook => ({ key: files.find((row) => row.workbookId === member.id)?.key ?? member.id, fileName: member.fileName, state: 'stored', workbookId: member.id })), ...files.filter((row) => !row.workbookId)],
    budget: workbookBudget(members),
    collecting,
    starting,
    hint,
    setHint,
    addFiles: (selected: readonly File[]) => collect(filesFromList(selected)),
    addSample: (selected: readonly WorkbookGrid[]) => collect(selected, true),
    retryFile,
    removeWorkbook,
    startAnalysis: () => collectLock.current ? Promise.resolve() : analyse(),
    codexAvailable,
    codexUnavailableReason: tools.data?.codexUnavailableReason,
    codexPolicy: tools.data?.codexPolicy,
    reading,
    plan,
    offline: usingOffline,
    analysis: {
      turn: analysisTurn,
      running: starting || isBuildPending(analysisTurn),
      problem: analysisProblem?.kind ?? (isOneOf(analysisTurn?.status, 'failed') && !draft?.excelAnalysis ? ('failed' as const) : undefined),
      failure: analysisProblem?.failure,
      error: isOneOf(analysisTurn?.status, 'failed') ? analysisTurn!.error : undefined,
      retry: () => void analyse(analysisTurn?.userMessage ?? hint),
      continueOffline,
    },
    spec: { save: saveSpec, status: specSave },
    design: {
      current: currentDesign,
      /** The hand-off may start: neither the design nor the analysis has an unknown or broken part. */
      complete: handOffReady,
      messages,
      busy: designBusy,
      activityTail: isBuildPending(latestDesignTurn) ? latestDesignTurn?.activityTail : undefined,
      suggestions,
      canUndo: canUndo && !designBusy && !readOnly,
      init: initDesign,
      send,
      undo,
      retry: retryDesign,
    },
    turnRunning,
    handOff,
    /** A write's 2xx answer could not be read; `confirm` (a re-read) is the only way on. */
    unconfirmed,
    confirm: () => confirm().catch(() => undefined),
  }
}
