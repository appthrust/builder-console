// Excel → app answers: the workbook set's list (with readings) and one stored
// grid, plus the deep structures a draft and its turns carry (the integrated
// analysis, the UI design, the staged analysis progress). Readers reuse the
// canonical api-schema shapes (unknown fields are dropped) and own these
// differences:
// - open enums: every kind, role, category, layout, accent and progress state
//   reads a value this console does not know as `{ kind: 'unknown' }`; the
//   readers check a string and the domain constructors (model/contracts/
//   excel.ts, also used for designs built in the browser) open it;
// - design parts: a UI design's list or form for one entity and its dashboard
//   cards are read one by one. A part in a shape this console cannot read is
//   `broken` (that part shows a fixed error; the rest of the design stays
//   usable). The design's own fields, the presence of each part and every
//   screen are still required: a design without them fails the whole answer.
// No collection here is normalized from absence: Go never omits them (the
// optional ones stay optional), and null is a failure.
import {
  ApplicationDraftExcelProgress,
  ApplicationDraftExcelProgressStage,
  ApplicationDraftExcelProgressWorkbookState,
  ApplicationDraftWorkbook,
  ApplicationDraftWorkbookLimits,
  ApplicationDraftWorkbookSummary,
  DashboardCard,
  ExcelAnalysis,
  ExcelAnalysisColumn,
  ExcelAnalysisEntity,
  ExcelAnalysisField,
  ExcelAnalysisFinding,
  ExcelAnalysisRule,
  ExcelAnalysisSheet,
  ExcelAnalysisWorkbook,
  ExcelWorkbookReading,
  FormDesign,
  ListDesign,
  ScreenDesign,
  UiDesign,
} from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import {
  BROKEN_PART,
  excelAnalysisOf,
  uiDesignOf,
  workbookReadingOf,
  type ExcelAnalysis as ReadAnalysis,
  type ExcelProgress,
  type StoredWorkbook,
  type ProgressStage,
  type ProgressWorkbookState,
  type UiDesign as ReadUiDesign,
  type WorkbookList,
  type WorkbookReading,
} from '../../../model/contracts/excel'
import { openEnum } from '../../boundary'
import { platformContract } from '../define'

const rule = ExcelAnalysisRule.extend({ category: z.string() })

const sheet = ExcelAnalysisSheet.extend({
  role: z.string(),
  columns: z.array(ExcelAnalysisColumn.extend({ kind: z.string() })).max(200),
  rules: z.array(rule).max(200),
})

/** A workbook reading (one entry of the set's list). */
export const workbookReadingReader: z.ZodType<WorkbookReading> = ExcelWorkbookReading.extend({
  sheets: z.array(sheet).max(50),
}).transform(workbookReadingOf)

/** The integrated analysis a draft carries. */
export const excelAnalysisReader: z.ZodType<ReadAnalysis> = ExcelAnalysis.extend({
  capabilities: z.array(z.string()).max(7),
  workbooks: z.array(ExcelAnalysisWorkbook.extend({ role: z.string() })).min(1).max(ApplicationDraftWorkbookLimits.maxWorkbooks),
  entities: z.array(ExcelAnalysisEntity.extend({
    kind: z.string(),
    fields: z.array(ExcelAnalysisField.extend({ kind: z.string() })).min(1).max(200),
    rules: z.array(rule).max(200),
  })).max(50),
  findings: z.array(ExcelAnalysisFinding.extend({ kind: z.string() })).max(20),
}).transform(excelAnalysisOf)

/**
 * A design part read on its own: present (absent fails the answer), and either
 * readable or `BROKEN_PART`. Its own issues are not reported: the part's
 * fixed error is the outcome.
 */
function part<S extends z.ZodType>(schema: S) {
  return z.unknown().superRefine((value, ctx) => {
    if (value === undefined) ctx.addIssue({ code: 'invalid_type', expected: 'object', input: value })
  }).transform((value): z.output<S> | typeof BROKEN_PART => {
    const result = schema.safeParse(value)
    return result.success ? result.data : BROKEN_PART
  })
}

/** The UI design a draft or a ui-design turn carries. */
export const uiDesignReader: z.ZodType<ReadUiDesign> = UiDesign.extend({
  accent: z.string(),
  density: z.string(),
  screens: z.array(ScreenDesign.extend({ kind: z.string() })).max(30),
  lists: z.record(UiDesign.shape.lists.keyType, part(ListDesign.extend({ layout: z.string() }))),
  forms: z.record(UiDesign.shape.forms.keyType, part(FormDesign)),
  dashboard: z.object({ cards: part(z.array(DashboardCard.extend({ kind: z.string() })).max(30)) }),
}).transform(uiDesignOf)

/** A staged excel-analysis turn's progress, with an open stage and open per-workbook states. */
export const excelProgressReader: z.ZodType<ExcelProgress> = ApplicationDraftExcelProgress.extend({
  stage: openEnum(ApplicationDraftExcelProgressStage.options as [ProgressStage, ...ProgressStage[]]),
  workbooks: z.array(z.object({
    workbookId: ApplicationDraftExcelProgress.shape.workbooks.element.shape.workbookId,
    state: openEnum(ApplicationDraftExcelProgressWorkbookState.options as [ProgressWorkbookState, ...ProgressWorkbookState[]]),
  })).max(ApplicationDraftWorkbookLimits.maxWorkbooks),
})

const WORKBOOKS = '/api/v1/projects/{projectId}/application-drafts/{id}/workbooks'

/**
 * The set's members with their readings. `data` is required: the store answers
 * an empty set as `[]` (platform-api internal/k8s/application_draft_workbooks.go:159);
 * `reading` is absent until the analysis read that member (dto_application_draft.go:361 omitempty).
 * The envelope's `meta` is not read.
 */
export const listWorkbooksContract = platformContract({
  operationId: 'platformApiListApplicationDraftWorkbooks',
  method: 'GET',
  routeTemplate: WORKBOOKS,
  successStatuses: [200],
  reader: z.object({
    data: z.array(z.object({ workbook: ApplicationDraftWorkbookSummary, reading: workbookReadingReader.optional() })),
  }) satisfies z.ZodType<WorkbookList>,
})

/** One member's stored grid (no server enum; read as the canonical shape). */
export const getWorkbookContract = platformContract({
  operationId: 'platformApiGetApplicationDraftWorkbook',
  method: 'GET',
  routeTemplate: `${WORKBOOKS}/{workbookId}`,
  successStatuses: [200],
  reader: ApplicationDraftWorkbook satisfies z.ZodType<StoredWorkbook>,
})
