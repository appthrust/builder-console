// Excel → app domain values: the workbook set, its readings, the integrated
// analysis and the UI design. Feature code reads these types and the pure
// operations below, never the wire.
//
// Two kinds of value share these shapes:
// - read values (`WorkbookReading`, `ExcelAnalysis`, `UiDesign`) may come from
//   a newer Platform: every server enum is an open value (an unknown kind is
//   `{ kind: 'unknown' }`, never mapped onto a known one), and a UI design's
//   list, form and dashboard parts are read one by one (a part this console
//   cannot read is `broken`, the rest of the design stays usable);
// - complete values (`Complete*`) hold only what this console knows. Local
//   generation (the offline fallback, the mock runtime) builds them, and only
//   they are written back (an undo, the specification's screen decisions), so
//   nothing this console cannot represent is ever dropped by a write.
// Server answers and local designs become read values through the same
// constructors (`workbookReadingOf`, `excelAnalysisOf`, `uiDesignOf`); the
// response readers in api/contracts/platform/excel.ts end in them.
import type {
  Accent as CanonicalAccent,
  ApplicationDraftExcelProgressStage,
  ApplicationDraftExcelProgressWorkbookState,
  ApplicationDraftWorkbook,
  ApplicationDraftWorkbookSummary,
  DashboardCard as CanonicalCard,
  DashboardCardKind,
  Density as CanonicalDensity,
  ExcelAnalysis as CanonicalAnalysis,
  ExcelAnalysisCapability,
  ExcelAnalysisColumn,
  ExcelAnalysisColumnKind,
  ExcelAnalysisEntity,
  ExcelAnalysisEntityKind,
  ExcelAnalysisField,
  ExcelAnalysisFinding,
  ExcelAnalysisFindingKind,
  ExcelAnalysisRule,
  ExcelAnalysisRuleCategory,
  ExcelAnalysisSheet,
  ExcelAnalysisSheetRole,
  ExcelAnalysisSource,
  ExcelAnalysisWorkbook,
  ExcelAnalysisWorkbookRole,
  ExcelWorkbookReading,
  FormDesign as CanonicalForm,
  ListDesign as CanonicalList,
  ListLayout as CanonicalListLayout,
  ScreenDesign as CanonicalScreen,
  ScreenKind as CanonicalScreenKind,
  UiDesign as CanonicalUiDesign,
} from '@appthrust/api-schema/platform-api'
import {
  Accent as AccentValues,
  ApplicationDraftWorkbookLimits,
  DashboardCardKind as CardKindValues,
  Density as DensityValues,
  ExcelAnalysisCapability as CapabilityValues,
  ExcelAnalysisColumnKind as ColumnKindValues,
  ExcelAnalysisEntityKind as EntityKindValues,
  ExcelAnalysisFindingKind as FindingKindValues,
  ExcelAnalysisRuleCategory as RuleCategoryValues,
  ExcelAnalysisSheetRole as SheetRoleValues,
  ExcelAnalysisWorkbookRole as WorkbookRoleValues,
  ListLayout as ListLayoutValues,
  ScreenKind as ScreenKindValues,
} from '@appthrust/api-schema/platform-api'
import type { OpenValue } from '../../api/boundary'
import { knownValue } from './build'

export type ColumnKind = ExcelAnalysisColumnKind
export type RuleCategory = ExcelAnalysisRuleCategory
export type SheetRole = ExcelAnalysisSheetRole
export type Capability = ExcelAnalysisCapability
export type WorkbookRole = ExcelAnalysisWorkbookRole
export type EntityKind = ExcelAnalysisEntityKind
export type FindingKind = ExcelAnalysisFindingKind
export type Accent = CanonicalAccent
export type Density = CanonicalDensity
export type ListLayout = CanonicalListLayout
export type ScreenKind = CanonicalScreenKind
export type CardKind = DashboardCardKind
export type ProgressStage = ApplicationDraftExcelProgressStage
export type ProgressWorkbookState = ApplicationDraftExcelProgressWorkbookState

/** Bounds of a draft's workbook set (per workbook, per set), as Platform enforces them. */
export const workbookLimits = ApplicationDraftWorkbookLimits

/** One member of the draft's set (immutable once added). */
export type WorkbookSummary = ApplicationDraftWorkbookSummary
/** A workbook's grid as uploaded and as stored (no server enum: read as is). */
export type StoredWorkbook = ApplicationDraftWorkbook

// ── Complete values: everything known, what this console builds and writes ──
export type CompleteReadingSheet = ExcelAnalysisSheet
export type CompleteWorkbookReading = ExcelWorkbookReading
export type CompleteAnalysisEntity = ExcelAnalysisEntity
export type CompleteExcelAnalysis = CanonicalAnalysis
export type CompleteScreen = CanonicalScreen
export type CompleteList = CanonicalList
export type CompleteForm = CanonicalForm
export type CompleteCard = CanonicalCard
export type CompleteUiDesign = CanonicalUiDesign

// ── Read values ──
export type AnalysisRule = Omit<ExcelAnalysisRule, 'category'> & { category: OpenValue<RuleCategory> }
export type ReadingColumn = Omit<ExcelAnalysisColumn, 'kind'> & { kind: OpenValue<ColumnKind> }
export type ReadingSheet = Omit<ExcelAnalysisSheet, 'role' | 'columns' | 'rules'> & { role: OpenValue<SheetRole>; columns: ReadingColumn[]; rules: AnalysisRule[] }
/** One workbook read on its own (the server's reading, or the offline fallback's). */
export type WorkbookReading = Omit<ExcelWorkbookReading, 'sheets'> & { sheets: ReadingSheet[] }
/** A member of the set with its reading once the analysis read it. */
export interface WorkbookEntry { workbook: WorkbookSummary; reading?: WorkbookReading }
export interface WorkbookList { data: WorkbookEntry[] }

export type AnalysisField = Omit<ExcelAnalysisField, 'kind'> & { kind: OpenValue<ColumnKind> }
export type AnalysisSource = ExcelAnalysisSource
export type AnalysisEntity = Omit<ExcelAnalysisEntity, 'kind' | 'fields' | 'rules'> & { kind: OpenValue<EntityKind>; fields: AnalysisField[]; rules: AnalysisRule[] }
export type AnalysisWorkbook = Omit<ExcelAnalysisWorkbook, 'role'> & { role: OpenValue<WorkbookRole> }
export type AnalysisFinding = Omit<ExcelAnalysisFinding, 'kind'> & { kind: OpenValue<FindingKind> }
/** The business designed from the whole set. */
export type ExcelAnalysis = Omit<CanonicalAnalysis, 'capabilities' | 'workbooks' | 'entities' | 'findings'> & {
  capabilities: OpenValue<Capability>[]
  workbooks: AnalysisWorkbook[]
  entities: AnalysisEntity[]
  findings: AnalysisFinding[]
}

export type ScreenDesign = Omit<CanonicalScreen, 'kind'> & { kind: OpenValue<ScreenKind> }
export type ListDesign = Omit<CanonicalList, 'layout'> & { layout: OpenValue<ListLayout> }
export type FormDesign = CanonicalForm
export type DashboardCard = Omit<CanonicalCard, 'kind'> & { kind: OpenValue<CardKind> }
/** A part of a design read on its own: `broken` when the server sent it in a shape this console cannot read. */
export type DesignPart<T> = { state: 'ok'; value: T } | { state: 'broken' }
/** A UI design read through the boundary (or built locally and read through `uiDesignOf`). */
export interface UiDesign {
  appName: string
  accent: OpenValue<Accent>
  density: OpenValue<Density>
  /** Screens in navigation order; a screen of an unknown kind keeps its place. */
  screens: ScreenDesign[]
  /** Per records entity. */
  lists: Record<string, DesignPart<ListDesign>>
  forms: Record<string, DesignPart<FormDesign>>
  dashboard: DesignPart<DashboardCard[]>
  notes: string[]
}

/** Where a staged excel-analysis turn is: per-workbook reading, then the design stage. */
export interface ExcelProgress {
  stage: OpenValue<ProgressStage>
  workbooks: { workbookId: string; state: OpenValue<ProgressWorkbookState> }[]
}

// ── Constructors: wire-shaped (or complete) values → read values ──

/** `T` with the named enum fields widened to any string: what a reader has checked before the constructor opens them. */
type Loose<T, K extends keyof T> = Omit<T, K> & { [P in K]: string }

/** A design part the reader could not read. */
export const BROKEN_PART: unique symbol = Symbol('broken design part')
type Part<T> = T | typeof BROKEN_PART

export type WorkbookReadingShape = Omit<ExcelWorkbookReading, 'sheets'> & {
  sheets: (Omit<Loose<ExcelAnalysisSheet, 'role'>, 'columns' | 'rules'> & { columns: Loose<ExcelAnalysisColumn, 'kind'>[]; rules: Loose<ExcelAnalysisRule, 'category'>[] })[]
}
export type ExcelAnalysisShape = Omit<CanonicalAnalysis, 'capabilities' | 'workbooks' | 'entities' | 'findings'> & {
  capabilities: string[]
  workbooks: Loose<ExcelAnalysisWorkbook, 'role'>[]
  entities: (Omit<Loose<ExcelAnalysisEntity, 'kind'>, 'fields' | 'rules'> & { fields: Loose<ExcelAnalysisField, 'kind'>[]; rules: Loose<ExcelAnalysisRule, 'category'>[] })[]
  findings: Loose<ExcelAnalysisFinding, 'kind'>[]
}
export interface UiDesignShape {
  appName: string
  accent: string
  density: string
  screens: Loose<CanonicalScreen, 'kind'>[]
  lists: Record<string, Part<Loose<CanonicalList, 'layout'>>>
  forms: Record<string, Part<CanonicalForm>>
  dashboard: { cards: Part<Loose<CanonicalCard, 'kind'>[]> }
  notes: string[]
}

function opener<const K extends string>(values: { options: readonly K[] }) {
  const known = new Set<string>(values.options)
  return (value: string): OpenValue<K> => (known.has(value) ? { kind: 'known', value: value as K } : { kind: 'unknown' })
}

const columnKind = opener<ColumnKind>(ColumnKindValues)
const ruleCategory = opener<RuleCategory>(RuleCategoryValues)
const sheetRole = opener<SheetRole>(SheetRoleValues)
const capability = opener<Capability>(CapabilityValues)
const workbookRole = opener<WorkbookRole>(WorkbookRoleValues)
const entityKind = opener<EntityKind>(EntityKindValues)
const findingKind = opener<FindingKind>(FindingKindValues)
const accent = opener<Accent>(AccentValues)
const density = opener<Density>(DensityValues)
const listLayout = opener<ListLayout>(ListLayoutValues)
const screenKind = opener<ScreenKind>(ScreenKindValues)
const cardKind = opener<CardKind>(CardKindValues)

const ruleOf = (rule: Loose<ExcelAnalysisRule, 'category'>): AnalysisRule => ({ ...rule, category: ruleCategory(rule.category) })

/** A workbook reading (the server's, or one read in this tab) as a read value. */
export function workbookReadingOf(reading: WorkbookReadingShape): WorkbookReading {
  return {
    ...reading,
    sheets: reading.sheets.map((sheet) => ({
      ...sheet,
      role: sheetRole(sheet.role),
      columns: sheet.columns.map((column) => ({ ...column, kind: columnKind(column.kind) })),
      rules: sheet.rules.map(ruleOf),
    })),
  }
}

/** An integrated analysis (the server's, or the offline fallback's) as a read value. */
export function excelAnalysisOf(analysis: ExcelAnalysisShape): ExcelAnalysis {
  return {
    ...analysis,
    capabilities: analysis.capabilities.map(capability),
    workbooks: analysis.workbooks.map((workbook) => ({ ...workbook, role: workbookRole(workbook.role) })),
    entities: analysis.entities.map((entity) => ({
      ...entity,
      kind: entityKind(entity.kind),
      fields: entity.fields.map((field) => ({ ...field, kind: columnKind(field.kind) })),
      rules: entity.rules.map(ruleOf),
    })),
    findings: analysis.findings.map((finding) => ({ ...finding, kind: findingKind(finding.kind) })),
  }
}

function partOf<S, T>(part: Part<S>, read: (value: S) => T): DesignPart<T> {
  return part === BROKEN_PART ? { state: 'broken' } : { state: 'ok', value: read(part) }
}

const mapRecord = <S, T>(record: Record<string, S>, read: (value: S) => T): Record<string, T> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, read(value)]))

/** A UI design (the server's, or one built in this tab) as a read value. */
export function uiDesignOf(design: UiDesignShape): UiDesign {
  return {
    appName: design.appName,
    accent: accent(design.accent),
    density: density(design.density),
    screens: design.screens.map((screen) => ({ ...screen, kind: screenKind(screen.kind) })),
    lists: mapRecord(design.lists, (part) => partOf(part, (list) => ({ ...list, layout: listLayout(list.layout) }))),
    forms: mapRecord(design.forms, (part) => partOf(part, (form) => form)),
    dashboard: partOf(design.dashboard.cards, (cards) => cards.map((card) => ({ ...card, kind: cardKind(card.kind) }))),
    notes: design.notes,
  }
}

// ── Pure operations ──

/** The part's value, or `undefined` when it is broken. */
export function partValue<T>(part: DesignPart<T> | undefined): T | undefined {
  return part?.state === 'ok' ? part.value : undefined
}

/**
 * Whether every kind, role and category of the analysis is one this console knows. The build is made from the
 * analysis and the design together: while a part of either is unknown, the hand-off would build what the user
 * could not see, so it stays closed.
 */
export function analysisComplete(analysis: ExcelAnalysis): boolean {
  const known = (value: OpenValue<string>) => value.kind === 'known'
  return analysis.capabilities.every(known) && analysis.workbooks.every((workbook) => known(workbook.role)) && analysis.findings.every((finding) => known(finding.kind))
    && analysis.entities.every((entity) => known(entity.kind) && entity.fields.every((field) => known(field.kind)) && entity.rules.every((rule) => known(rule.category)))
}

function completeRecord<T, C>(record: Record<string, DesignPart<T>>, complete: (value: T) => C | undefined): Record<string, C> | undefined {
  const result: Record<string, C> = {}
  for (const [key, part] of Object.entries(record)) {
    const value = part.state === 'ok' ? complete(part.value) : undefined
    if (value === undefined) return undefined
    result[key] = value
  }
  return result
}

/** Every item with its kind known, or `undefined` when one is not. */
function completeKinds<T extends { kind: OpenValue<K> }, K extends string>(items: T[]): (Omit<T, 'kind'> & { kind: K })[] | undefined {
  const result: (Omit<T, 'kind'> & { kind: K })[] = []
  for (const item of items) {
    const kind = knownValue(item.kind)
    if (kind === undefined) return undefined
    result.push({ ...item, kind })
  }
  return result
}

/**
 * The design as this console can write it, or `undefined` while any part of it
 * is unknown or broken: writing it then would silently drop that part.
 */
export function completeUiDesign(design: UiDesign): CompleteUiDesign | undefined {
  const accentValue = knownValue(design.accent)
  const densityValue = knownValue(design.density)
  const screens = completeKinds<ScreenDesign, ScreenKind>(design.screens)
  const lists = completeRecord(design.lists, (list): CompleteList | undefined => {
    const layout = knownValue(list.layout)
    return layout && { ...list, layout }
  })
  const forms = completeRecord(design.forms, (form) => form)
  const cards = design.dashboard.state === 'ok' ? completeKinds<DashboardCard, CardKind>(design.dashboard.value) : undefined
  if (!accentValue || !densityValue || !screens || !lists || !forms || !cards) return undefined
  return { appName: design.appName, accent: accentValue, density: densityValue, screens, lists, forms, dashboard: { cards }, notes: design.notes }
}
