// Dev-only in-memory Platform API for the console (`/api/v1/*`), mounted by
// ./mock-server.ts. It covers exactly the routes the SPA (and the console
// server's role lookup) call, with a tiny lifecycle driven one step per
// `POST /api/v1/__mock/advance`:
// - every new stack walks stage 0 → 3 (置き場 → 最初の版 → URL → 公開中);
//   template repositories exist at stage 1 while their first image is building;
// - an adopted repository (作ったコードから) starts with no Dockerfile, then
//   gets a proposed build-setup PR, then is ready (its stack waits at stage 0);
// - an application draft's plan generation runs for three steps (activity
//   lines grow) and then succeeds with a plan; a running creation execution
//   creates the source repository and the stack on the next step.
//   Generated plans avoid taken application names and publish URLs before readback.
// - conversation turns settle in one step, updating front-matter specs.
//   Excel analysis starts with per-workbook reading/reused progress; one advance
//   saves unread readings, designs one integrated model and settles in designing.
//   UI design initializes/refines the persisted preview and replaces spec section 9.
// - POST/GET …/application-drafts/{id}/workbooks and GET/DELETE …/workbooks/{workbookId}
//   store immutable parsed grids outside draft/list summaries (20 files, 512 KiB each,
//   4 MiB/200 sheets per set). SHA-256 digests reject duplicates; idempotent POSTs replay.
//   Set changes clear analysis/design but keep other members' readings. Active jobs
//   and created apps reject changes with 409. An empty set answers 412 WorkbookMissing.
//   Excel/UI turns share codex, busy, idempotency and advance toggles.
//   New excel-analysis/ui-design turns after creation answer 409 ApplicationCreated;
//   ordinary conversation turns and existing idempotent replays remain available.
// - implementation runs advance request → working → pushing → done for each selected
//   task, reusing the draft's workspace independently of browser requests.
//   Completed tasks record verification for their handoff acceptance criteria.
//   Publish preferences persist on the draft; title/preferences-only PATCHes may overlap implementation.
// - improvement drafts (`POST application-drafts {kind: 'improvement', applicationStackId}`) are born
//   created and bound to that seeded stack (412 without a source repository, e.g. `nippo`). While
//   read, their turns answer after ~2 s (first a clarifying question, then a 3-task proposal whose
//   first reply is 「この内容で直して」) and their runs move one step every ~1.5 s.
//   Completion submits a proposal; only Accept creates a live release and version.
// Toggles:
// - `POST /api/v1/__mock/role {role}` switches the caller's Team role (Viewer → create calls answer 403).
// - `POST /api/v1/__mock/registry {connected}` (or `MOCK_REGISTRY=off`) removes the ready registry connection.
// - `POST /api/v1/__mock/reject-next-validation` makes the next stack validation fail its `source` section once.
// - `POST /api/v1/__mock/codex {available, reason?, policy?}` (or `MOCK_CODEX=off`) switches
//   plan/turn/implementation availability. Reasons and policy names reach creation-tools and 412 details.
// - `POST /api/v1/__mock/ai-quota {exhausted: boolean}` makes AI turns, plan generation
//   and implementation tasks fail with the provider's credits message while exhausted.
//   Clear it to resume manually; completed work is retained and reset clears the toggle.
// - `POST /api/v1/__mock/stack-conflict {appName?, reason?, message?}` makes the next stack create (of
//   `appName`, or any) answer one 409 with `details.reason` (`delivery_pending` = retryable).
// - `POST /api/v1/__mock/github-repository {name}` marks `acme/<name>` as existing on GitHub (`uriage` is seeded).
// - `POST /api/v1/__mock/creation-publish-conflict` fails the next creation at stack validation
//   with detail.reason PublishURLConflict before any create. Send renameApplication and retry;
//   repositories created by earlier attempts stay bound and are reused (no cleanup).
// - `POST /api/v1/__mock/plan-generation {outcome?: 'succeeded'|'failed', error?, autoAdvance?, priorGenerations?, publish?}`
//   configures newly-created generations; GET polls advance generations/turns when autoAdvance=true.
//   priorGenerations (0–19) seeds a new draft's settled history for remaining-count checks.
//   publish=false reproduces an AI plan that omits publish (default true).
// - `POST /api/v1/__mock/prepare {stall?: 'building'|'starting'}` pauses the created app at that phase; `{}` resumes.
// - `POST /api/v1/__mock/implementation-run {outcome?, error?, autoAdvance?}` controls
//   task completion; manual advance works even with every build tab closed.
//   `{unmetCriterion: true}` makes the next completed task report one unmet criterion after
//   its repair pass (repairAttempts: 1); subsequent tasks report every criterion met.
//   `{interruptSecondTask: true}` makes the next accepted run fail its second selected task
//   with failureReason StreamInterrupted once; retry preserves completed tasks and resumes there.
// - `POST /api/v1/__mock/data {mode: 'ok'|'forbidden'|'suspended'|'unsupported'|'empty'|'subject-unbound'|'not-persisted'}`
//   switches the データ tab's database reads (403 / 412 database_suspended / 412 database_data_unsupported / no tables /
//   412 database_access_membership_unbound with membershipReason SubjectUnbound or NotPersisted); fixture in ./mock-database-data.ts.
// - `POST /api/v1/__mock/data-write {mode: 'ok'|'conflict'|'constraint'|'unavailable'}`: the next row PATCH answers
//   409 row_changed / 400 constraint_violation (with `column`); `unavailable` makes every row write 412
//   row_editing_unavailable until `ok`; rows are written by ./mock-database-rows.ts.
// - Database changes (`…/databases/{id}/changes`): `mitsumori-db` is seeded with one applied and one 承認待ち change;
//   approving moves it to ReadyToRun, which the next list read reports once before it is Succeeded (as does
//   `__mock/advance`). The `__mock/data` mode `forbidden` makes the list answer 403 too.
// - `POST /api/v1/__mock/access-forbidden {forbidden}` denies access PUTs without changing policy.
//   Each accepted access write reports pending for one GET poll, then ready.
// - `POST /api/v1/__mock/reset` returns {reset: true} and reseeds the entire mock,
//   reapplying MOCK_ROLE (default Editor), MOCK_REGISTRY and MOCK_CODEX.
import { createHash, randomBytes } from 'node:crypto'
import {
  type Application,
  type ApplicationBranchComponentConfigEntry,
  type ApplicationDraft,
  type ApplicationDraftConversationTurn,
  type ApplicationDraftImplementationRun,
  type ApplicationDraftImplementationTask,
  type ApplicationDraftCreationPlan,
  type ApplicationDraftCreationToolRegistryResponse,
  ApplicationDraftCodexUnavailableReason,
  ApplicationDraftWorkbook,
  ApplicationDraftWorkbookLimits,
  type ExcelWorkbookReading,
  ApplicationDraftPublishPreferences,
  type ApplicationRelease,
  type ApplicationReleaseOverview,
  type ApplicationSourceRepository,
  type ApplicationStack,
  type ApplicationStackDefinition,
  type ApplicationTemplateSummary,
  type ComponentReleaseState,
  type ComponentSummaryFactsV1,
  CreateApplicationDraftConversationTurnRequest,
  CreateApplicationDraftImplementationRunRequest,
  type CreateApplicationSourceRepositoryRequest,
  type CreateApplicationStackRequest,
  type DatabaseChange,
  type Domain,
  type DevWorkspaceRead,
  type DevWorkspaceOperationRead,
  type GitHubSourceConnection,
  type GitHubSourceConnectionRepository,
  type PublicOperation,
  type Publish,
  type PublishAccess,
  type PublishAccessRequest,
  type RegistryConnection,
  type ReleasePhase,
  type SourceChangeProposal,
  SourceChangeProposalDecisionRequest,
  UiDesign,
  UpdateApplicationDraftRequest,
} from '@appthrust/api-schema/platform-api'
import { implementationTodoId } from '../features/build/implement/state'
import { designFromReadings, readingOf, type DesignInput } from '../features/excel2app/design'
import { designTextJa } from '../features/excel2app/design-copy'
import { textJa as excelTextJa } from '../features/excel2app/copy'
import { fromDraftWorkbook, planApp, type AppPlan } from '../features/excel2app/model'
import { excelSpecMarkdown, withUiDecisions } from '../features/excel2app/spec'
import { applyInstruction, suggestedInstructions } from '../features/excel2app/ui-assistant'
import { defaultUiDesign } from '../features/excel2app/ui-design'
import { shareScopeLabel } from '../model/access'
import { parseSpec, serializeSpec } from '../model/build/spec'
import { buildCopy, textJa as buildTextJa } from '../model/build/copy'
import { isFirstTurn, isKickoffReply, isPrepareTurn } from '../model/build/questions'
import { dataModeFailure, findTable, resetDatabaseData, selectRows, state as dataState, type DataMode } from './mock-database-data'
import { dataWriteRoutes } from './mock-database-rows'
import { mockOwnerSubjects, mockSubject } from './mock-console'
import { proposalTerminal, proposalWaiting } from '../features/proposals/model'

export const MOCK_PROJECT_ID = 'commerce'
const TEAM_SLUG = 'commerce-team'
/** Host of the project's seeded, publish-ready domain (`GET /domains` answers `<projectId>.appthrust.test`). */
const BASE_DOMAIN = `${MOCK_PROJECT_ID}.appthrust.test`
const AI_QUOTA_ERROR = 'Codex task failed: Codex error: stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at <REDACTED>'

type Role = 'Admin' | 'Editor' | 'Viewer'
type SeedState = 'live' | 'deploying' | 'failed' | 'stopped'

/** Platform apps the console mock binds its BusinessApps to (stackId === appName). */
export const seededPlatformApps: ReadonlyArray<{ appName: string; stackId: string; state: SeedState }> = [
  { appName: 'mitsumori', stackId: 'mitsumori', state: 'live' },
  { appName: 'kintai', stackId: 'kintai', state: 'live' },
  { appName: 'nippo', stackId: 'nippo', state: 'live' },
  { appName: 'hikkoshi', stackId: 'hikkoshi', state: 'deploying' },
  { appName: 'keihi', stackId: 'keihi', state: 'failed' },
  { appName: 'kaigishitsu', stackId: 'kaigishitsu', state: 'stopped' },
]

interface MockRelease {
  id: string
  version: string
  phase: ReleasePhase
  at: string
  failureReason?: string
  transitionId: string
}

interface MockStack {
  id: string
  appName: string
  templateId: string
  sourceKind: ApplicationStack['sourceKind']
  imageRef: string
  sourceRepositoryId?: string
  /** Public hostname from the create request's publish intent. */
  host: string
  publishPath?: string
  /** 0 placing source, 1 building/releasing the first version, 2 URL propagating, 3 live. */
  stage: 0 | 1 | 2 | 3
  /** Latest release failed (問題あり) until rolled back. */
  broken: boolean
  releases: MockRelease[]
  env: ApplicationBranchComponentConfigEntry[]
}

/** An opaque config revision that changes with the variables (Go: dto_component.go `revision`, required). */
function envRevision(env: readonly { key: string; value?: string; updatedAt?: string }[]): string {
  return `rev-${env.map((entry) => `${entry.key}:${entry.updatedAt ?? ''}`).join('|').length}-${env.length}`
}

/** `mitsumori-db`'s changes: the first migration applied three days ago, the second waiting for approval. */

function seedDatabaseChanges(databaseId: string): DatabaseChange[] {
  const base = { projectId: MOCK_PROJECT_ID, databaseId, applyMode: 'Automatic' as const, sourceType: 'InlineSQL' as const, requestedBy: 'appthrust-implementation' }
  const init = `${databaseId}-0001-init`
  return [
    {
      ...base,
      id: init,
      source: { type: 'InlineSQL', path: 'db/migrations/0001_init.sql' },
      phase: 'Succeeded',
      review: { passed: true, risk: 'Low', statementCount: 2 },
      approval: { requiredCount: 0, approvedCount: 0 },
      latestRun: { id: `${init}-r1`, clusterId: 'mock', revision: 1, attempt: 1, phase: 'Succeeded', startedAt: minutesAgo(60 * 72), finishedAt: minutesAgo(60 * 72) },
      latestRevision: { databaseId, changeId: init, revision: 1, appliedAt: minutesAgo(60 * 72) },
      createdAt: minutesAgo(60 * 72),
    },
    {
      ...base,
      id: `${databaseId}-0002-create-estimates`,
      source: { type: 'InlineSQL', path: 'db/migrations/0002_create_estimates.sql' },
      phase: 'AwaitingApproval',
      review: { passed: true, risk: 'Low', statementCount: 3 },
      approval: { requiredCount: 1, approvedCount: 0 },
      createdAt: minutesAgo(30),
    },
  ]
}

/** Every ReadyToRun change of one database runs and succeeds, recording the next revisions. */
function applyReadyDatabaseChanges(changes: DatabaseChange[]): number {
  let revision = Math.max(0, ...changes.map((change) => change.latestRevision?.revision ?? 0))
  let applied = 0
  for (const change of changes) {
    if (change.phase !== 'ReadyToRun') continue
    const now = stamp()
    const attempt = (change.latestRun?.attempt ?? 0) + 1
    revision++
    applied++
    Object.assign(change, {
      phase: 'Succeeded',
      latestRun: { id: `${change.id}-r${attempt}`, clusterId: 'mock', revision, attempt, phase: 'Succeeded', startedAt: now, finishedAt: now },
      latestRevision: { databaseId: change.databaseId, changeId: change.id, revision, appliedAt: now },
    } satisfies Partial<DatabaseChange>)
  }
  return applied
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function release(version: string, phase: ReleasePhase, at: string, failureReason?: string): MockRelease {
  return { id: `rel-${version.replace(/\W/g, '')}-${Math.random().toString(36).slice(2, 7)}`, version, phase, at, transitionId: `tr-${version.replace(/\W/g, '')}`, ...(failureReason ? { failureReason } : {}) }
}

function newStack(appName: string, init: Partial<MockStack> = {}): MockStack {
  return {
    id: appName,
    appName,
    templateId: 'nextjs-postgres',
    sourceKind: 'application-source-repository',
    imageRef: `ghcr.io/acme/${appName}:edge-`,
    host: `${appName}.${BASE_DOMAIN}`,
    stage: 0,
    broken: false,
    releases: [],
    env: [{ key: 'DATABASE_URL', state: 'generated', source: 'generated', sensitive: true }],
    ...init,
  }
}

const nextId = (prefix: string) => `${prefix}-${(++state.sequence).toString(36).padStart(4, '0')}`
// Mock timestamps are strictly increasing. Real controllers never finish a run in the
// same millisecond a user turn started, but a fast test runner can; deriveImprove treats
// "turn started at or after the run ended" as the conversation being current.
let lastStamp = 0
const stamp = () => {
  lastStamp = Math.max(lastStamp + 1, Date.now())
  return new Date(lastStamp).toISOString()
}

function repositoryFor(appName: string, status: ApplicationSourceRepository['status']): ApplicationSourceRepository {
  return {
    id: `${appName}-src`,
    projectId: MOCK_PROJECT_ID,
    sourceConnectionId: 'github-source-207cb7ce',
    template: { repository: 'appthrust/template-nextjs', ref: 'main' },
    destination: { repositoryName: appName, visibility: 'private' },
    image: { imagePath: `ghcr.io/acme/${appName}`, tagFilter: 'edge-', versioningScheme: 'Alphabetical' },
    build: { state: status === 'ready' ? 'healthy' : status === 'failed' ? 'failed' : 'running', runUrl: `https://github.com/acme/${appName}/actions/runs/1`, headSha: 'mock-head', observedAt: stamp() },
    status,
    conditions: [],
    createdAt: stamp(),
    ...(status === 'ready' ? { repositoryUrl: `https://github.com/acme/${appName}`, defaultBranch: 'main' } : {}),
  }
}

/** 作ったコードから: adoption starts with no Dockerfile at the repository root. */
function adoptedRepository(body: CreateApplicationSourceRepositoryRequest & { existing: { repository: string; ref?: string } }): ApplicationSourceRepository {
  const [owner = 'acme', name = 'app'] = body.existing.repository.split('/')
  const id = `${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-src`
  return {
    id,
    projectId: MOCK_PROJECT_ID,
    ...(body.sourceConnectionId ? { sourceConnectionId: body.sourceConnectionId } : {}),
    existing: { repository: body.existing.repository, ref: body.existing.ref ?? 'main' },
    readiness: { dockerfile: 'missing', workflow: 'missing' },
    image: {
      imagePath: body.image?.imagePath ?? `ghcr.io/${owner}/${name}`.toLowerCase(),
      tagFilter: body.image?.tagFilter ?? 'edge-',
      versioningScheme: body.image?.versioningScheme ?? 'Alphabetical',
    },
    build: { mode: 'workflow-dispatch', workflow: 'deploy.yml', ref: body.existing.ref ?? 'main', state: 'unknown' },
    status: 'pending',
    conditions: [
      { type: 'RepositoryCreated', status: 'True', reason: 'RepositoryAdopted' },
      { type: 'Ready', status: 'False', reason: 'DockerfileMissing', message: 'Dockerfile not found at the repository root (Dockerfile)' },
    ],
    createdAt: stamp(),
  }
}

/** missing Dockerfile → build-setup PR proposed → ready. Returns false once ready. */
function advanceAdopted(repository: ApplicationSourceRepository): boolean {
  const fullName = repository.existing?.repository ?? ''
  if (repository.status === 'ready') return false
  if (repository.readiness?.dockerfile === 'missing') {
    repository.readiness = { dockerfile: 'present', workflow: 'proposed', proposedPullRequestUrl: `https://github.com/${fullName}/pull/7` }
    repository.conditions = [
      { type: 'RepositoryCreated', status: 'True', reason: 'RepositoryAdopted' },
      { type: 'Ready', status: 'False', reason: 'WorkflowProposed', message: 'merge the build workflow pull request to continue' },
    ]
    return true
  }
  repository.readiness = { dockerfile: 'present', workflow: 'present' }
  repository.status = 'ready'
  repository.build = { ...repository.build, state: 'healthy', runUrl: `https://github.com/${fullName}/actions/runs/1`, headSha: 'mock-head', observedAt: stamp() }
  repository.repositoryUrl = `https://github.com/${fullName}`
  repository.defaultBranch = repository.existing?.ref ?? 'main'
  repository.conditions = [{ type: 'Ready', status: 'True', reason: 'ImageAvailable' }]
  return true
}

const PLAN_ACTIVITY = [
  '> DevWorkspace を起動しました',
  '> spec.md と intent を読んでいます',
  '> 画面の構成を考えています: 一覧 / 作成 / PDF 出力',
  '> データの形を決めています: customers, items, quotes',
  '> ひな形 nextjs-postgres を選びました',
  '> creation-plan.json を書き出しています',
  '> 計画を確かめています',
]

/** The plan the mock "AI" writes: a new repository from the default ひな形, published on the project domain. */
function mockPlan(appName: string, publish = true): ApplicationDraftCreationPlan {
  return {
    summary: '見積書を作って PDF で出せるアプリです。顧客と品目を登録し、見積の一覧から探せます。',
    representation: ['SourceRepository', 'ApplicationStack', 'Application', 'Component', 'Database', 'Publish'],
    markdown: `# ${appName}\n\n- web: Next.js\n- database: PostgreSQL${publish ? `\n- publish: https://${appName}.${BASE_DOMAIN}` : ''}`,
    applicationSourceRepositoryRequest: {
      sourceConnectionId: 'github-source-207cb7ce',
      registryConnectionRef: 'ghcr-acme',
      template: { repository: 'appthrust/template-nextjs', ref: 'main' },
      destination: { repositoryName: appName, visibility: 'private' },
      image: { imagePath: `ghcr.io/acme/${appName}`, tagFilter: 'edge-', versioningScheme: 'Alphabetical' },
      build: { mode: 'observed-image', ref: 'main' },
    },
    applicationStackRequest: {
      templateId: 'nextjs-postgres',
      definitionRef: { name: 'web-postgres', version: 'v1' },
      application: { name: appName },
      branch: { id: 'production', role: 'production', createIfMissing: true },
      source: { kind: 'application-source-repository', sourceRepositoryId: `${appName}-src` },
      web: { componentName: 'web' },
      database: { componentName: 'db' },
      connection: { connectionName: 'database' },
      ...(publish ? { publish: { enabled: true, customDomain: BASE_DOMAIN, hostnamePattern: 'wildcard' as const, subdomain: appName } } : {}),
    },
    implementationHandoff: {
      summary: '見積アプリの中身を作る',
      workspaceMode: 'application-develop',
      targetApplicationRef: 'createdApplicationId',
      sourceRepositoryStrategy: 'created-source-repository',
      tasks: [{ title: '見積の画面', description: '一覧・作成・PDF 出力', acceptanceCriteria: ['見積を PDF で出せる'] }],
    },
  }
}

function deduplicatePlan(plan: ApplicationDraftCreationPlan): ApplicationDraftCreationPlan {
  const stack = plan.applicationStackRequest!
  const base = stack.application!.name
  const taken = new Set([...state.stacks.values()].map((item) => item.appName))
  if (!taken.has(base) && !publishProblem(stack.publish)) return plan
  for (let n = 2; n <= 99; n++) {
    const suffix = `-${n}`
    const name = base.slice(0, 63 - suffix.length).replace(/-+$/, '') + suffix
    const request = { ...stack, application: { ...stack.application, name }, ...(stack.applicationName !== undefined ? { applicationName: name } : {}), ...(stack.publish ? { publish: { ...stack.publish, subdomain: name } } : {}) }
    if (!taken.has(name) && !publishProblem(request.publish)) return { ...plan, applicationStackRequest: request }
  }
  throw new Error('creation plan has no free URL name with suffixes 2 through 99')
}

function renameDraftApplication(draft: ApplicationDraft, name: string): Response | undefined {
  if (draft.phase === 'created' || draft.createdApplicationId || draft.createdApplicationStackId || draft.creationExecutions.some((execution) => execution.steps.some((step) => step.tool === 'appthrust.applicationStack.create' && step.status === 'done'))) {
    return error(409, 'conflict', 'application draft has an ApplicationStack; cannot rename the application')
  }
  const stack = draft.creationPlan?.applicationStackRequest
  if (!stack) return error(412, 'failed_precondition', 'creationPlan.applicationStackRequest is required to rename the application')
  const publish = stack.publish?.enabled ? { ...stack.publish, subdomain: name } : stack.publish
  if ([...state.stacks.values()].some((item) => item.appName === name) || publishProblem(publish)) {
    return error(409, 'conflict', 'application name or publish URL is already taken', { reason: 'NameTaken' })
  }
  stack.applicationName = name
  if (stack.application) {
    if (stack.application.id === stack.application.name) stack.application.id = name
    stack.application.name = name
  }
  if (stack.publish?.enabled) stack.publish.subdomain = name
  draft.validatedCreationPlanFingerprint = undefined
}

/** Deterministic domain replies for the mock; the real turn prompt owns these choices. */
function mockQuestions(intent: string) {
  if (/人事|社員|従業員/.test(intent)) return {
    name: '人事情報管理', record: '社員', fields: ['氏名', '部署', '入社日'], users: ['人事担当者'],
    first: '社員情報を管理するのは誰ですか？', firstOptions: ['人事担当者のみ', '人事と各部署の責任者'],
    next: '社員情報には、ほかに何を記録しますか？', nextOptions: ['役職と雇用形態', '連絡先と緊急連絡先'], asksUsers: true,
  }
  if (/見積/.test(intent)) return {
    name: '見積作成', record: '見積', fields: ['顧客', '品目', '金額'], users: ['営業'],
    first: '見積の PDF には何を載せますか？', firstOptions: ['会社ロゴと連絡先', '支払期限と振込先'],
    next: '見積の承認はどうしますか？', nextOptions: ['営業だけで確定する', '上長が確認して確定する'], asksUsers: false,
  }
  if (/在庫|備品|品目/.test(intent)) return {
    name: '在庫管理', record: '品目', fields: ['品名', '数量', '保管場所'], users: ['在庫担当者'],
    first: '在庫数はどう更新しますか？', firstOptions: ['数量を直接入力する', '入出庫の履歴から計算する'],
    next: '在庫が少なくなったときはどうしますか？', nextOptions: ['一覧で確認する', '担当者に通知する'], asksUsers: false,
  }
  const subject = intent.split('\n')[0]?.trim().slice(0, 20) || '業務'
  return {
    name: subject, record: subject, fields: ['名前', '内容', '登録日'], users: ['担当者'],
    first: `「${subject}」では何から始めますか？`, firstOptions: [`${subject}の一覧`, `${subject}の登録`],
    next: `「${subject}」の記録はどう確認しますか？`, nextOptions: ['日付で絞り込む', '名前で検索する'], asksUsers: false,
  }
}

/** Bind a retained source without carrying create-only tools into the retry. */
function bindDraftSource(draft: ApplicationDraft, sourceRepositoryId: string) {
  const plan = draft.creationPlan
  if (!plan?.applicationStackRequest) return
  draft.creationPlan = {
    ...plan,
    applicationSourceRepositoryRequest: undefined,
    applicationStackRequest: {
      ...plan.applicationStackRequest,
      source: { kind: 'application-source-repository', sourceRepositoryId },
    },
    toolPlan: plan.toolPlan?.filter((step) => !step.tool.startsWith('appthrust.applicationSourceRepository.')),
    implementationHandoff: plan.implementationHandoff && { ...plan.implementationHandoff, sourceRepositoryStrategy: 'existing-source-repository' },
  }
}

function draftSourceRecord(draft: ApplicationDraft) {
  const request = draft.creationPlan?.applicationSourceRepositoryRequest
  return request?.destination && draft.createdSourceRepositories?.find((record) =>
    record.repositoryName.toLowerCase() === request.destination!.repositoryName.toLowerCase() &&
    record.sourceConnectionId === request.sourceConnectionId &&
    record.gitProviderConnectionRef?.name === request.gitProviderConnectionRef?.name &&
    record.gitProviderConnectionRef?.namespace === request.gitProviderConnectionRef?.namespace)
}

interface StoredWorkbook {
  grid: ApplicationDraftWorkbook
  reading?: ExcelWorkbookReading
}

/** Membership, never storage enumeration, determines the design's input order. */
function draftDesignInputs(draft: ApplicationDraft): DesignInput[] {
  return (draft.source?.workbooks ?? []).map((summary) => {
    const stored = state.workbooks.get(draft.id)?.get(summary.id)
    if (!stored) throw new Error('application draft workbook not found')
    return { summary, grid: fromDraftWorkbook(stored.grid) }
  })
}

function workbookSetMutable(draft: ApplicationDraft): Response | undefined {
  if (draft.createdApplicationId || draft.createdApplicationStackId) return error(409, 'conflict', 'workbooks cannot be changed after application creation', { reason: 'ApplicationCreated' })
  if ([...(draft.conversationTurns ?? []), ...(draft.creationPlanGenerations ?? []), ...draft.creationExecutions, ...(draft.implementationRuns ?? [])].some((item) => item.status === 'pending' || item.status === 'running')) {
    return error(409, 'conflict', 'application draft is busy; wait before changing workbooks', { reason: 'DraftBusy' })
  }
}

/** Match R19's one-based locations without returning grid values in errors. */
function workbookValidationError(input: unknown, issue: { path: PropertyKey[]; message: string; code: string }): Response {
  const generic = () => error(400, 'invalid_argument', issue.message)
  if (issue.path[0] !== 'sheets' || typeof issue.path[1] !== 'number' || !input || typeof input !== 'object' || !('sheets' in input) || !Array.isArray(input.sheets)) return generic()
  const sheet = input.sheets[issue.path[1]] as { name?: string; formulas?: Array<{ row?: number; column?: number }> } | undefined
  if (!sheet) return generic()
  let reason: string
  let row = 0
  let column = 0
  let message = issue.message
  if (issue.path[2] === 'rows') {
    if (issue.path.length === 3) {
      reason = 'WorkbookSheetInvalid'
      row = issue.code === 'too_big' ? 5001 : 0
      message = row ? 'sheet must contain at most 5000 rows' : 'sheet rows must be an array'
    } else {
      row = Number(issue.path[3]) + 1
      if (issue.path.length > 4) {
        reason = 'WorkbookCellInvalid'
        column = Number(issue.path[4]) + 1
        message = 'cells must be strings, numbers, booleans or null'
      } else {
        reason = 'WorkbookRowInvalid'
        message = issue.code === 'too_big' ? 'row must contain at most 200 cells' : 'row must be an array'
      }
    }
  } else if (issue.path[2] === 'validations') {
    reason = 'WorkbookValidationInvalid'
    const index = String(issue.path[3] ?? '')
    if (/^(0|[1-9]\d*)$/.test(index)) column = Number(index) + 1
    message = 'validations must map column indices to string arrays'
  } else if (issue.path[2] === 'formulas') {
    reason = 'WorkbookFormulaInvalid'
    const formula = sheet.formulas?.[Number(issue.path[3])]
    row = typeof formula?.row === 'number' ? formula.row + 1 : 0
    column = typeof formula?.column === 'number' ? formula.column + 1 : 0
    message = 'formulas require non-negative row and column indices and at most 1000 characters'
  } else if (issue.path[2] === 'mergedRanges') {
    reason = 'WorkbookSheetInvalid'
    message = 'mergedRanges must be non-negative'
  } else return generic()
  const name = typeof sheet.name === 'string' ? sheet.name : ''
  const location = `workbook sheet ${JSON.stringify(name)}${row > 0 ? ` row ${row}` : ''}${column > 0 ? ` column ${column}` : ''}`
  return error(400, 'invalid_argument', `${location}: ${message}`, { reason, sheet: name, ...(row > 0 ? { row } : {}), ...(column > 0 ? { column } : {}) })
}

/** Non-Excel drafts can also request UI design from the existing spec front matter. */
function draftUiPlan(draft: ApplicationDraft): AppPlan {
  const inputs = draftDesignInputs(draft)
  const analysis = draft.excelAnalysis ?? (inputs.length ? designFromReadings(inputs) : undefined)
  if (analysis) return planApp(analysis, draft.title)
  const { spec } = parseSpec(draft.specMarkdown)
  return {
    name: spec.name ?? draft.title,
    entities: spec.records.map((record) => ({
      name: record.name, kind: 'records', fields: record.fields.map((name) => ({ name, kind: 'text' })),
      rules: [], importRows: 0, sources: [],
    })),
    screens: spec.records.flatMap((record) => [
      { kind: 'list' as const, entity: record.name },
      { kind: 'form' as const, entity: record.name },
      { kind: 'detail' as const, entity: record.name },
    ]),
    totalImportRows: 0,
  }
}

function answerExcelTurn(draft: ApplicationDraft, turn: ApplicationDraftConversationTurn, now: string) {
  let summary: string
  let changed: string[]
  let question: string
  let suggestedReplies: string[]
  let specMarkdown: string
  if (turn.kind === 'excel-analysis') {
    // Active turns freeze set membership. Readings survive later set changes.
    const inputs = draftDesignInputs(draft)
    const readings = new Map<string, ExcelWorkbookReading>()
    for (const input of inputs) {
      const stored = state.workbooks.get(draft.id)!.get(input.summary.id)!
      stored.reading ??= readingOf(input)
      readings.set(input.summary.id, stored.reading)
    }
    const analysis = designFromReadings(inputs, readings)
    const plan = planApp(analysis, draft.title)
    turn.excelProgress = {
      stage: 'designing',
      workbooks: inputs.map(({ summary }) => ({
        workbookId: summary.id,
        state: turn.excelProgress?.workbooks.find((item) => item.workbookId === summary.id)?.state === 'reused' ? 'reused' : 'read',
      })),
    }
    draft.excelAnalysis = analysis
    summary = analysis.summary
    changed = analysis.bullets
    question = excelTextJa.analysis.nextQuestion
    suggestedReplies = [excelTextJa.spec.edit, excelTextJa.preview.title]
    specMarkdown = excelSpecMarkdown(analysis, plan, inputs.map((input) => input.summary))
  } else {
    const plan = draftUiPlan(draft)
    const current = draft.uiDesign ?? defaultUiDesign(plan)
    const restore = turn.userMessage.match(/\n```json\n([\s\S]*)\n```$/)
    let restored: UiDesign | undefined
    if (restore) {
      try {
        const result = UiDesign.safeParse(JSON.parse(restore[1]!))
        if (result.success) restored = result.data
      } catch {
        // A malformed restore is treated as an ordinary instruction, never applied as a design.
      }
    }
    const result = turn.userMessage === '__init__'
      ? { design: defaultUiDesign(plan), reply: '', changed: true }
      : restored
        ? { design: restored, reply: excelTextJa.preview.undone, changed: true }
        : applyInstruction(current, plan, turn.userMessage)
    const design = result.design
    const reply = turn.userMessage === '__init__'
      ? excelTextJa.preview.greeting(design.screens.filter((screen) => !screen.hidden).map((screen) => screen.title), excelTextJa.accent[design.accent])
      : result.reply
    turn.uiDesign = design
    draft.uiDesign = design
    summary = reply.split('\n')[0]!.slice(0, 200)
    changed = result.changed ? reply.split('\n').filter(Boolean).slice(0, 8).map((line) => line.slice(0, 200)) : []
    question = excelTextJa.preview.nextQuestion
    suggestedReplies = suggestedInstructions(design, plan).slice(0, 4).map((reply) => reply.slice(0, 80))
    specMarkdown = withUiDecisions(draft.specMarkdown, design)
  }
  const assistantMessage = ['## 要約', summary, '## 変えたところ', ...changed.map((line) => `- ${line}`), '## 次の質問', question].join('\n')
  Object.assign(turn, { status: 'succeeded', finishedAt: now, specMarkdown, assistantMessage, changed, suggestedReplies, activityTail: summary })
  draft.specMarkdown = specMarkdown
  draft.validatedCreationPlanFingerprint = undefined
  draft.updatedAt = now
}

function failQuotaTurn(draft: ApplicationDraft, turn: ApplicationDraftConversationTurn, now: string): boolean {
  if (!state.aiQuotaExhausted) return false
  Object.assign(turn, { status: 'failed', error: AI_QUOTA_ERROR, finishedAt: now })
  for (const workbook of turn.excelProgress?.workbooks ?? []) if (workbook.state === 'reading') workbook.state = 'failed'
  draft.updatedAt = now
  return true
}

/** Plan generations run three steps; a running creation execution finishes in one. */
function advanceDraft(draft: ApplicationDraft): boolean {
  let moved = false
  const now = stamp()
  if (draft.kind === 'improvement') {
    // Improvement turns answer in one step; their runs advance with the other runs.
    for (const turn of draft.conversationTurns ?? []) {
      if (turn.status !== 'pending' && turn.status !== 'running') continue
      if (failQuotaTurn(draft, turn, now)) { moved = true; continue }
      if (turn.kind === 'ui-design') answerExcelTurn(draft, turn, now)
      else answerImprovementTurn(draft, turn, now)
      draft.updatedAt = now
      moved = true
    }
    return moved
  }
  for (const turn of draft.conversationTurns ?? []) {
    if (turn.status !== 'pending' && turn.status !== 'running') continue
    if (failQuotaTurn(draft, turn, now)) { moved = true; continue }
    if (turn.kind === 'excel-analysis' || turn.kind === 'ui-design') {
      answerExcelTurn(draft, turn, now)
      moved = true
      continue
    }
    // 用意する (prepare turn): the published name (spec name + two alternatives), then who sees the app.
    const turns = draft.conversationTurns ?? []
    const prepareStart = turns.map((item) => isPrepareTurn(item.userMessage)).lastIndexOf(true)
    const prepareStep = prepareStart < 0 ? -1 : turns.indexOf(turn) - prepareStart
    if (prepareStep >= 0 && prepareStep <= 2) {
      const { spec, body } = parseSpec(draft.specMarkdown)
      const name = spec.name ?? draft.title
      const share = { private: shareScopeLabel('private'), group: shareScopeLabel('group'), company: shareScopeLabel('company') }
      const changed: string[] = []
      if (prepareStep === 1) {
        spec.name = turn.userMessage.trim()
        changed.push(`アプリの名前を「${spec.name}」にしました。`)
      }
      if (prepareStep === 2) changed.push(`見せる範囲を「${turn.userMessage}」にしました。公開するときに使います。`)
      const [summary, question, options] = prepareStep === 0 ? ['用意しているあいだに、公開するときのことを決めておきましょう。', '公開するときのアプリの名前はどれにしますか？', [name, `${name}アプリ`, `みんなの${name}`]]
        : prepareStep === 1 ? ['名前を決めました。', '誰に見せますか？', [share.private, share.group, share.company]]
          : ['公開するときは、この範囲を最初に選んでおきます。', '', []]
      const specMarkdown = serializeSpec(spec, body)
      const assistantMessage = ['## 要約', summary, '## 変えたところ', ...changed.map((item) => `- ${item}`), '## 次の質問', question].join('\n')
      Object.assign(turn, { status: 'succeeded', finishedAt: now, specMarkdown, assistantMessage, changed, suggestedReplies: options, activityTail: '仕様の更新が完了しました。' })
      draft.specMarkdown = specMarkdown
      draft.updatedAt = now
      moved = true
      continue
    }
    const { spec, body } = parseSpec(draft.specMarkdown)
    const domain = mockQuestions(draft.intent)
    const opening = isFirstTurn(turn.userMessage)
    const kickoff = isKickoffReply(turn.userMessage) || turn.userMessage === 'ここまでの内容で提案してください。'
    const answered = (draft.conversationTurns ?? []).filter((item) => item.id !== turn.id && item.status === 'succeeded' && !isFirstTurn(item.userMessage) && !isKickoffReply(item.userMessage) && item.userMessage !== 'ここまでの内容で提案してください。').length + (opening || kickoff ? 0 : 1)
    spec.name ??= domain.name
    spec.oneLine ??= draft.intent.split('\n')[0]
    const changed: string[] = []
    if (!opening && !kickoff) {
      if (domain.asksUsers && domain.firstOptions.includes(turn.userMessage)) {
        spec.users = [turn.userMessage]
        changed.push(`使う人を「${turn.userMessage}」にしました。`)
      } else {
        spec.rules = [...spec.rules, turn.userMessage]
        changed.push(`ルール「${turn.userMessage}」を追加しました。`)
      }
    }
    if (!spec.screens.length) {
      spec.screens = [`${domain.record}一覧`, `${domain.record}の編集`]
      changed.push(`${spec.screens.join('と')}の画面を追加しました。`)
    }
    if (!spec.records.length) {
      spec.records = [{ name: domain.record, fields: domain.fields }]
      changed.push(`${domain.record}に${domain.fields.join('・')}を追加しました。`)
    }
    if (!spec.users.length && !domain.asksUsers) spec.users = domain.users
    const specMarkdown = serializeSpec(spec, body)
    const ready = answered >= 2
    const question = kickoff ? 'この内容で提案を用意します。' : ready ? 'ここまでで最初の版を用意できます。' : opening ? domain.first : domain.next
    // conversation-turn.tmpl: exactly 要約 / 変えたところ / 次の質問; `changed` mirrors the bullets.
    const assistantMessage = [
      '## 要約', opening ? `「${domain.name}」について、一つずつ確認します。` : 'ご希望を仕様に反映しました。',
      '## 変えたところ', ...changed.map((item) => `- ${item}`),
      '## 次の質問', question,
    ].join('\n')
    Object.assign(turn, {
      status: 'succeeded', finishedAt: now, specMarkdown, assistantMessage, changed,
      suggestedReplies: kickoff ? [] : ready ? [buildTextJa.questions.kickoffReply, `${domain.record}の画面を増やしたい`] : opening ? domain.firstOptions : domain.nextOptions,
      activityTail: '仕様の更新が完了しました。',
    })
    draft.specMarkdown = specMarkdown
    draft.updatedAt = now
    moved = true
  }
  for (const generation of draft.creationPlanGenerations ?? []) {
    if (generation.status === 'succeeded' || generation.status === 'failed') continue
    moved = true
    const steps = (state.generationSteps.get(generation.id) ?? 0) + 1
    state.generationSteps.set(generation.id, steps)
    if (steps < 4) {
      generation.status = 'running'
      generation.stage = steps === 1 ? 'prepare' : steps === 2 ? 'plan' : 'read'
      if (steps >= 2) generation.activityTail = PLAN_ACTIVITY.slice(0, steps * 2 + 1).join('\n')
    } else {
      const outcome = state.generationOutcomes.get(generation.id)
      generation.status = state.aiQuotaExhausted ? 'failed' : outcome?.outcome ?? 'succeeded'
      generation.finishedAt = now
      delete generation.stage
      generation.activityTail = PLAN_ACTIVITY.join('\n')
      if (generation.status === 'failed') {
        generation.error = state.aiQuotaExhausted ? AI_QUOTA_ERROR : outcome?.error || 'application draft plan generation timed out waiting for workspace "mock-workspace" (phase=Starting; RuntimeReady reason=PVCPending): storage is not Bound'
        draft.phase = 'specifying'
      } else {
        try {
          draft.creationPlan = deduplicatePlan(mockPlan(`ai-app-${draft.id.slice(-4)}`, outcome?.publish))
        } catch (error) {
          Object.assign(generation, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
          draft.phase = 'planning'
          continue
        }
        if (draft.source?.workbooks.length) {
          const { spec, body } = parseSpec(draft.specMarkdown)
          draft.specMarkdown = serializeSpec({ ...spec, importFrom: 'excel' }, body)
          const plan = draftUiPlan(draft)
          draft.creationPlan.summary = draft.excelAnalysis?.summary ?? designTextJa.summary(draft.source.workbooks.length, plan.entities.length, plan.totalImportRows)
          draft.creationPlan.implementationHandoff!.summary = `${draft.uiDesign?.appName ?? plan.name} の画面と元のデータを引き継ぐ`
          draft.creationPlan.implementationHandoff!.tasks = [
            { title: buildCopy.mockExcelHandoff.screenTitle, description: buildCopy.mockExcelHandoff.screenDescription, acceptanceCriteria: [buildCopy.mockExcelHandoff.screenCriterion] },
            { title: buildCopy.mockExcelHandoff.seedTitle, description: buildCopy.mockExcelHandoff.seedDescription, acceptanceCriteria: [buildCopy.mockExcelHandoff.seedCriterion] },
          ]
        }
        // A real model folds the user's own additions into the summary; console kickoff and 公開 lines are not wishes.
        const wishes = (draft.intent.split('### 追記').at(-1) ?? '').split('\n').map((line) => line.trim()).filter((line) => line && !line.includes('提案してください') && !line.startsWith('公開:'))
        if (draft.intent.includes('### 追記') && wishes.length) draft.creationPlan.summary += ` 追加のご希望「${wishes.join('、')}」も含めます。`
        draft.phase = 'planned'
      }
    }
  }
  for (const execution of draft.creationExecutions) {
    if (execution.status !== 'running' || !execution.runStartedAt) continue
    moved = true
    const plan = draft.creationPlan
    const stackRequest = plan?.applicationStackRequest
    const appName = stackRequest?.application?.name ?? stackRequest?.applicationName
    const observe = execution.steps.find((step) => step.tool === 'appthrust.applicationStack.observe')
    if (stackRequest && (state.creationPublishConflict || publishProblem(stackRequest.publish))) {
      state.creationPublishConflict = false
      const message = 'Another publish already uses this URL.'
      execution.steps = execution.steps.map((step) => step.tool === 'appthrust.applicationStack.validate'
        ? { ...step, status: 'failed', message, finishedAt: now, detail: { since: now, attempt: execution.attempt, reason: 'PublishURLConflict' } }
        : step.tool === 'appthrust.applicationSourceRepository.validate' ? { ...step, status: 'done', finishedAt: now } : step)
      Object.assign(execution, { status: 'failed', finishedAt: now, error: message })
      draft.phase = 'planning'
      draft.validatedCreationPlanFingerprint = undefined
      continue
    }
    if (observe && !observe.phase) {
      execution.steps = execution.steps.map((step) => step === observe
        ? { ...step, status: 'running', phase: 'syncing', title: '設計図を反映しています', detail: { since: now, attempt: 1 } }
        : step.tool.endsWith('.validate') ? { ...step, status: 'done', finishedAt: now } : step)
      continue
    }
    if (!plan || !stackRequest || !appName || state.stacks.has(appName)) {
      Object.assign(execution, { status: 'failed', finishedAt: now, error: `application '${appName ?? ''}' cannot be created` })
      continue
    }
    const sourceRequest = plan.applicationSourceRepositoryRequest
    const record = draftSourceRecord(draft)
    let repository = sourceRequest
      ? record ? state.repositories.get(record.sourceRepositoryId) : undefined
      : stackRequest.source.kind === 'application-source-repository'
        ? state.repositories.get(stackRequest.source.sourceRepositoryId)
        : undefined
    const reused = !!record && repository?.status === 'ready'
    if (record && repository && !reused) {
      Object.assign(execution, { status: 'failed', finishedAt: now, error: `SourceRepository ${record.sourceRepositoryId} is not ready for reuse.` })
      draft.phase = 'planning'
      continue
    }
    if (sourceRequest && !repository) {
      const name = sourceRequest.destination?.repositoryName ?? appName
      if (state.githubRepositoryNames.has(name) && !record?.repository && !sourceRequest.existing) {
        Object.assign(execution, { status: 'failed', finishedAt: now, error: `name already exists: ${name}: GitHub repository acme/${name} already exists. Choose a different repository name.` })
        draft.phase = 'planning'
        continue
      }
      const existing = sourceRequest.existing ?? (record?.repository ? { repository: record.repository, ref: record.defaultBranch } : undefined)
      repository = existing
        ? adoptedRepository({ ...sourceRequest, template: undefined, destination: undefined, existing })
        : repositoryFor(name, 'pending')
      state.repositories.set(repository.id, repository)
      state.githubRepositoryNames.add(name)
      if (!existing || record) {
        draft.createdSourceRepositoryId = repository.id
        const created = { sourceRepositoryId: repository.id, repositoryName: name, repository: `acme/${name}`, defaultBranch: 'main', sourceConnectionId: sourceRequest.sourceConnectionId, gitProviderConnectionRef: sourceRequest.gitProviderConnectionRef }
        draft.createdSourceRepositories = [...(draft.createdSourceRepositories ?? []).filter((item) => item !== record), created]
      }
    }
    if (repository) bindDraftSource(draft, repository.id)
    execution.steps = execution.steps.map((step) => step.tool.startsWith('appthrust.applicationSourceRepository.')
      ? { ...step, status: reused ? 'skipped' : 'done', finishedAt: now }
      : step)
    const injected = state.stackConflicts.findIndex((conflict) => !conflict.appName || conflict.appName === appName)
    if (injected !== -1) {
      const { message, reason } = state.stackConflicts.splice(injected, 1)[0]!
      // GitHub has finished while the later stack mutation fails.
      if (repository) Object.assign(repository, { status: 'ready', repositoryUrl: `https://github.com/acme/${repository.destination?.repositoryName ?? appName}`, defaultBranch: 'main' })
      Object.assign(execution, { status: 'failed', finishedAt: now, error: message })
      execution.steps = execution.steps.map((step) => step.tool === 'appthrust.applicationStack.create'
        ? { ...step, status: 'failed', message, finishedAt: now, detail: { since: now, attempt: execution.attempt, reason: reason ?? 'conflict' } }
        : step)
      draft.phase = 'planning'
      continue
    }
    const stack = newStack(appName, { templateId: stackRequest.templateId, sourceRepositoryId: repository?.id, host: publishHost(stackRequest, appName), publishPath: stackRequest.publish?.path ?? '/' })
    state.stacks.set(stack.id, stack)
    execution.steps = execution.steps.map((step) => ({ ...step, status: step.status === 'skipped' ? 'skipped' : 'done', finishedAt: now, ...(step.tool === 'appthrust.applicationStack.observe' ? { phase: 'ready' as const, title: '準備ができました', detail: { since: now, attempt: 2 } } : {}) }))
    Object.assign(execution, { status: 'succeeded', finishedAt: now })
    Object.assign(draft, { phase: 'created', createdApplicationId: appName, createdApplicationStackId: stack.id, updatedAt: now })
  }
  return moved
}

/** The application-scoped workspace a draft's runs (and improvement turns) reuse, created Ready on first use. */
function ensureApplicationWorkspace(draft: ApplicationDraft, now: string): string {
  const id = draft.implementationWorkspaceId ?? nextId('ws')
  draft.implementationWorkspaceId = id
  if (!state.workspaces.has(id)) {
    const base = `/api/v1/projects/${draft.projectId}/dev-workspaces/${id}`
    state.workspaces.set(id, {
      id, projectId: draft.projectId, scope: 'application', applicationId: draft.createdApplicationId,
      componentId: `${draft.createdApplicationId}-web`, displayName: draft.title, ownerUserId: draft.ownerUserId,
      phase: 'Ready', branchName: draft.kind === 'improvement' ? `appthrust/proposal/${draft.id}` : 'main', baseRef: 'main', createdAt: now, conditions: [],
      codexUrl: `${base}/codex/`, previewUrl: `${base}/proxy/preview/`,
    })
  }
  return id
}

/** Improvement turns answer after this long; runs move one step per interval while the session page polls. */
const IMPROVEMENT_TURN_MS = 2_000
const IMPROVEMENT_STEP_MS = 1_500
const APPLY_REPLY = 'この内容で直して'

/**
 * The improvement prompt's contract, played deterministically: the first message
 * after a run (or of the session) gets one clarifying question and no tasks; the
 * next writes a 3-task proposal whose first suggested reply is 「この内容で直して」;
 * that exact reply keeps the proposal and says it can be made.
 */
function answerImprovementTurn(draft: ApplicationDraft, turn: ApplicationDraftConversationTurn, now: string) {
  const run = draft.implementationRuns?.at(-1)
  const since = run ? Date.parse(run.finishedAt ?? run.startedAt) : Number.NEGATIVE_INFINITY
  const talk = (draft.conversationTurns ?? []).filter((item) => item.status === 'succeeded' && Date.parse(item.startedAt) >= since)
  const handoff = draft.creationPlan?.implementationHandoff
  const reply = (summary: string, changed: string[], question: string, suggestedReplies: string[]) => Object.assign(turn, {
    status: 'succeeded', finishedAt: now, specMarkdown: draft.specMarkdown, changed, suggestedReplies,
    assistantMessage: ['## 要約', summary, '## 変えたところ', ...(changed.length ? changed.map((item) => `- ${item}`) : ['（なし）']), '## 次の質問', question].join('\n'),
    activityTail: 'いまの画面と記録を読みました\n直しかたをまとめました',
  })
  if (turn.userMessage.trim() === APPLY_REPLY && handoff?.tasks.length) {
    reply('この内容で直せます。', [], '「この内容で直す」を押すと、直しはじめます。', [])
    return
  }
  const short = (value: string) => { const line = value.split('\n')[0]!.trim(); return line.length > 24 ? `${line.slice(0, 24)}…` : line }
  const request = talk[0]?.userMessage ?? turn.userMessage
  if (!talk.length) {
    const filter = /絞り込|検索|フィルタ|探/.test(turn.userMessage)
    reply(`「${short(turn.userMessage)}」ですね。いまの画面と記録を読みました。`, [],
      filter ? 'どの項目で絞り込めると便利ですか？' : 'どの画面のどこを変えたいですか？',
      filter ? ['状態で絞り込みたい', '担当者で絞り込みたい', '日付の範囲で絞り込みたい'] : ['一覧の画面', '入力の画面', 'まだ決めていない'])
    return
  }
  const answer = turn.userMessage
  const tasks = [
    { title: `「${short(request)}」に対応する`, description: `${request.trim()}。いまの画面の見た目と使いかたは変えない。`, acceptanceCriteria: ['頼んだとおりに動く'] },
    { title: `「${short(answer)}」を反映する`, description: `${answer.trim()}。選んだ内容がすぐ画面に出る。`, acceptanceCriteria: ['選んだ内容で表示が変わる'] },
    { title: `「${short(request)}」のあとも前の動きが変わらないか確かめる`, description: '登録・編集・一覧の表示がこれまでどおり動くことを確かめる。', acceptanceCriteria: ['これまでの記録がそのまま見える'] },
  ]
  const requestMarkdown = [`# ${short(request)}`, '', `- ${request.trim()}`, `- ${answer.trim()}`].join('\n')
  const summary = `「${short(request)}」を、いまのデータを残したまま直します。`
  draft.creationPlan = {
    summary, markdown: requestMarkdown, representation: ['ApplicationStack'],
    implementationHandoff: { summary, workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'existing-source-repository', tasks },
  }
  draft.specMarkdown = requestMarkdown
  reply(summary, [`直すところを ${tasks.length} つにまとめました。`], 'この内容で直せます。よければ「この内容で直す」を押してください。', [APPLY_REPLY, '別の直しかたも見たい'])
}

/** Improvement sessions move with time while they are read, without `__mock/advance` or toggles. */
function settleImprovement(draft: ApplicationDraft): void {
  if (draft.kind !== 'improvement') return
  const now = Date.now()
  for (const turn of draft.conversationTurns ?? []) {
    if (turn.status !== 'pending' && turn.status !== 'running') continue
    if (now - Date.parse(turn.startedAt) >= IMPROVEMENT_TURN_MS) {
      if (!failQuotaTurn(draft, turn, new Date(now).toISOString())) answerImprovementTurn(draft, turn, new Date(now).toISOString())
      draft.updatedAt = new Date(now).toISOString()
    } else Object.assign(turn, { status: 'running', activityTail: 'いまの画面と記録を読んでいます' })
  }
  const run = draft.implementationRuns?.at(-1)
  if (run?.status !== 'pending' && run?.status !== 'running') return
  const last = state.improvementSteps.get(run.id) ?? Date.parse(run.startedAt)
  const due = Math.floor((now - last) / IMPROVEMENT_STEP_MS)
  for (let step = 0; step < due && advanceImplementation(draft); step++) state.improvementSteps.set(run.id, last + (step + 1) * IMPROVEMENT_STEP_MS)
}

function advanceImplementation(draft: ApplicationDraft): boolean {
  const run = draft.implementationRuns?.at(-1)
  if (!run || (run.status !== 'pending' && run.status !== 'running')) return false
  const now = stamp()
  const stack = state.stacks.get(draft.createdApplicationStackId!)
  if (!stack || stack.stage < 2) return false
  if (!run.devWorkspaceId) run.devWorkspaceId = ensureApplicationWorkspace(draft, now)
  run.status = 'running'
  const task = run.tasks.find((item) => run.taskIds.includes(item.id) && item.status !== 'done' && item.status !== 'skipped')
  if (!task) {
    run.status = 'succeeded'
    run.finishedAt = now
    submitImprovementProposal(draft)
    return true
  }
  if (task.status === 'pending') {
    task.status = 'running'
    task.startedAt = now
    run.currentTaskId = task.id
    run.step = 'request'
    run.activityTail = ''
  } else if (run.step === 'request') {
    run.step = 'working'
    run.activityTail = draft.kind === 'improvement' ? `「${task.title}」を進めています\n` : `画面「${task.title}」を作っています\n`
  } else if (run.step === 'working') {
    const interrupted = !state.aiQuotaExhausted && state.interruptedRuns.get(run.id) === task.id
    if (state.aiQuotaExhausted || interrupted || state.implementationRun.outcome === 'failed') {
      state.interruptedRuns.delete(run.id)
      task.status = 'failed'
      task.error = state.aiQuotaExhausted ? AI_QUOTA_ERROR : interrupted ? 'AI task stream interrupted' : (state.implementationRun.error || 'Implementation task failed')
      task.failureReason = interrupted ? 'StreamInterrupted' : 'TaskFailed'
      task.finishedAt = now
      run.status = 'failed'
      run.error = task.error
      run.failureReason = task.failureReason
      run.finishedAt = now
    } else run.step = 'pushing'
  } else {
    Object.assign(task, { status: 'done', finishedAt: now, commitSha: createHash('sha1').update(`${run.id}-${task.id}`).digest('hex'), operationId: nextId('commit') })
    if (draft.kind === 'improvement') ensureImprovementProposal(draft)
    else {
      stack.releases.push(release(`edge-v${stack.releases.length + 1}`, 'Succeeded', now))
      task.versionLabel = `v${stack.releases.length}`
    }
    const definition = draft.creationPlan?.implementationHandoff?.tasks.find((item, index) => implementationTodoId(item.title, index) === task.id)
    const unmet = state.implementationRun.unmetCriterion
    task.verification = {
      reportedAt: now,
      criteria: (definition?.acceptanceCriteria ?? []).map((criterion, index) => ({
        criterion, met: !unmet || index !== 0,
        ...(unmet && index === 0 ? { note: buildCopy.mockExcelHandoff.unmetCriterionNote } : {}),
      })),
      repairAttempts: unmet ? 1 : 0,
    }
    state.implementationRun.unmetCriterion = false
    if (run.taskIds.every((id) => run.tasks.some((item) => item.id === id && item.status === 'done'))) {
      run.status = 'succeeded'
      run.finishedAt = now
      submitImprovementProposal(draft)
    }
  }
  draft.updatedAt = now
  return true
}

function ensureImprovementProposal(draft: ApplicationDraft): SourceChangeProposal {
  const existing = draft.proposalId ? state.proposals.get(draft.proposalId) : undefined
  if (existing) return existing
  const id = nextId('proposal')
  const stack = state.stacks.get(draft.createdApplicationStackId!)!
  const now = stamp()
  const proposal: SourceChangeProposal = {
    id, projectId: draft.projectId, applicationId: draft.createdApplicationId!, sourceRepositoryId: stack.sourceRepositoryId!,
    proposer: draft.ownerUserId, reviewers: state.draftReviewers.get(draft.id) ?? [draft.ownerUserId],
    title: draft.title, summary: draft.creationPlan?.implementationHandoff?.summary ?? draft.intent,
    tasks: draft.creationPlan?.implementationHandoff?.tasks ?? [],
    base: { kind: 'GitCommit', gitCommit: { sha: 'a'.repeat(40) } },
    head: { kind: 'GitBranch', name: `appthrust/proposal/${draft.id}` },
    phase: 'Drafting', originDraftId: draft.id, previewWorkspaceId: draft.implementationWorkspaceId,
    decisions: [], createdAt: now, updatedAt: now,
  }
  state.proposals.set(id, proposal)
  draft.proposalId = id
  return proposal
}

function submitImprovementProposal(draft: ApplicationDraft): void {
  if (draft.kind !== 'improvement') return
  const proposal = ensureImprovementProposal(draft)
  const sha = draft.implementationRuns?.at(-1)?.tasks.filter((task) => task.commitSha).at(-1)?.commitSha ?? 'b'.repeat(40)
  Object.assign(proposal, {
    phase: 'Proposed', headRevision: { kind: 'GitCommit', gitCommit: { sha } },
    summary: draft.creationPlan?.implementationHandoff?.summary ?? draft.intent,
    tasks: draft.creationPlan?.implementationHandoff?.tasks ?? [],
    change: { files: 1, additions: 2, deletions: 1 }, updatedAt: stamp(),
  })
}

function advanceProposal(proposal: SourceChangeProposal): void {
  if (proposal.phase === 'Accepted') {
    proposal.phase = 'Applying'
    proposal.updatedAt = stamp()
    return
  }
  if (proposal.phase !== 'Applying') return
  const draft = proposal.originDraftId ? state.drafts.get(proposal.originDraftId) : undefined
  const stack = draft?.createdApplicationStackId ? state.stacks.get(draft.createdApplicationStackId) : undefined
  if (!draft || !stack) return
  const now = stamp()
  stack.releases.push(release(`edge-v${stack.releases.length + 1}`, 'Succeeded', now))
  for (const task of draft.implementationRuns?.at(-1)?.tasks ?? []) {
    if (task.status === 'done') task.versionLabel = `v${stack.releases.length}`
  }
  draft.updatedAt = now
  Object.assign(proposal, { phase: 'Applied', appliedRevision: proposal.headRevision, appliedVia: 'Platform', updatedAt: now })
}

function seedPlatform() {
  /** Repositories the GitHub source connection sees (`GET /source-connections/{id}/repositories`). */
  const githubRepositories: GitHubSourceConnectionRepository[] = [
    { fullName: 'acme/claude-mitsumori', defaultBranch: 'main', private: true },
    { fullName: 'acme/cursor-kintai-bot', defaultBranch: 'main', private: true },
    { fullName: 'acme/inventory-sheet', defaultBranch: 'main', private: true },
    { fullName: 'acme/customer-book', defaultBranch: 'main', private: true },
    { fullName: 'acme/approval-inbox', defaultBranch: 'main', private: true },
    { fullName: 'acme/equipment-loans', defaultBranch: 'main', private: true },
    { fullName: 'acme/sales-dashboard', defaultBranch: 'develop', private: false },
    { fullName: 'acme/hr-onboarding', defaultBranch: 'main', private: true },
    { fullName: 'acme/expense-checker', defaultBranch: 'main', private: true },
    { fullName: 'acme/meeting-room-finder', defaultBranch: 'main', private: true },
  ]
  const templates: ApplicationTemplateSummary[] = [
    ['biz-inventory-postgres', '在庫管理', 'template-biz-inventory'],
    ['biz-master-postgres', 'マスター管理', 'template-biz-master'],
    ['biz-approval-postgres', '申請・承認', 'template-biz-approval'],
    ['biz-reservation-postgres', '予約・貸出', 'template-biz-reservation'],
    ['nextjs-postgres', 'Next.js + PostgreSQL', 'template-nextjs'],
    ['remix-postgres', 'Remix + PostgreSQL', 'template-remix'],
    ['fastapi-postgres', 'FastAPI + PostgreSQL', 'template-fastapi'],
  ].map(([id, displayName, repo]) => {
    const sourceKinds: ApplicationTemplateSummary['sourceKinds'] = id === 'nextjs-postgres' ? ['github-template', 'sample-image'] : ['github-template']
    const repository = `appthrust/${repo}`
    const available = allowedTemplateRepositories.includes(repository)
    const reasons = [`github-template source requires a source connection whose allowedRepositories admits ${repository}`]
    return {
      id: id!,
      displayName: displayName!,
      category: id!.startsWith('biz-') ? 'business' as const : 'framework' as const,
      generatedKind: 'ApplicationStack' as const,
      sourceKinds,
      githubTemplate: { repository, repositoryUrl: `https://github.com/${repository}`, branch: 'main' },
      components: [
        { id: 'web', displayName: 'Web', kind: 'web' as const },
        { id: 'postgres', displayName: 'PostgreSQL', kind: 'database' as const },
      ],
      availability: {
        available: available || sourceKinds.includes('sample-image'),
        ...(!available && !sourceKinds.includes('sample-image') ? { reasons } : {}),
        sources: sourceKinds.map((kind) => kind === 'github-template'
          ? { kind, available, ...(!available ? { reasons } : {}) }
          : { kind, available: true }),
      },
    }
  })
  const state = {
    role: (process.env.MOCK_ROLE as Role | undefined) ?? 'Editor',
    registryConnected: process.env.MOCK_REGISTRY !== 'off',
    codexAvailable: process.env.MOCK_CODEX !== 'off',
    codexUnavailableReason: undefined as ApplicationDraftCreationToolRegistryResponse['codexUnavailableReason'],
    codexPolicy: undefined as string | undefined,
    aiQuotaExhausted: false,
    rejectNextValidation: false,
    creationPublishConflict: false,
    accessForbidden: false,
    access: new Map<string, { value: PublishAccess; pendingReads: number }>(),
    accessReplays: new Map<string, unknown>(),
    stacks: new Map<string, MockStack>(),
    repositories: new Map<string, ApplicationSourceRepository>(),
    drafts: new Map<string, ApplicationDraft>(),
    proposals: new Map<string, SourceChangeProposal>(),
    draftReviewers: new Map<string, string[]>(),
    workbooks: new Map<string, Map<string, StoredWorkbook>>(),
    workspaces: new Map<string, DevWorkspaceRead>(),
    documents: new Map<string, Map<string, string>>(),
    workspaceTodos: new Map<string, unknown[]>(),
    workspaceOperations: new Map<string, DevWorkspaceOperationRead>(),
    operationPushes: new Set<string>(),
    turnReplays: new Map<string, ApplicationDraftConversationTurn>(),
    /** AppArea: per-component log failures, reset with status 200; tracks actual reads. */
    logs: new Map<string, { status: number; requests: number }>(),
    /** Advances each running plan generation has had (by generation id). */
    generationSteps: new Map<string, number>(),
    /** When each improvement run last moved (by run id); see `settleImprovement`. */
    improvementSteps: new Map<string, number>(),
    planGeneration: { outcome: 'succeeded' as 'succeeded' | 'failed', error: '', autoAdvance: false, priorGenerations: 0, publish: true },
    prepare: { stall: undefined as 'building' | 'starting' | undefined },
    implementationRun: { outcome: 'succeeded' as 'succeeded' | 'failed', error: '', autoAdvance: false, unmetCriterion: false, interruptSecondTask: false },
    interruptedRuns: new Map<string, string>(),
    generationOutcomes: new Map<string, { outcome: 'succeeded' | 'failed'; error: string; publish: boolean }>(),
    /** One-shot 409s for the next stack create (of `appName`, or any). */
    stackConflicts: [] as Array<{ appName?: string; reason?: string; message: string }>,
    /** Database changes by database id (`<app>-db`); a database without an entry has none. */
    databaseChanges: new Map<string, DatabaseChange[]>(),
    /** Repository names that exist on GitHub (`acme/<name>`); a deleted source repository leaves its name here. */
    githubRepositoryNames: new Set<string>(['uriage']),
    sequence: 0,
    githubRepositories,
    templates,
  }
  for (const repository of state.githubRepositories) state.githubRepositoryNames.add(repository.fullName.slice(repository.fullName.indexOf('/') + 1))
  for (const { appName, state: seedState } of seededPlatformApps) {
    if (seedState === 'stopped') continue // bound stack is gone → 停止中
    const history = [release('edge-v1', 'Succeeded', minutesAgo(60 * 72)), release('edge-v2', 'Succeeded', minutesAgo(60 * 26)), release('edge-v3', 'Succeeded', minutesAgo(180))]
    const stack = newStack(appName, { sourceRepositoryId: `${appName}-src`, stage: 3, releases: history })
    if (appName === 'nippo') {
      stack.sourceKind = 'sample-image'
      stack.sourceRepositoryId = undefined
      stack.imageRef = 'ghcr.io/acme/mitsumori:edge-v3'
    }
    if (seedState === 'deploying') {
      stack.stage = 1
      stack.releases = [release('edge-v1', 'InProgress', minutesAgo(2))]
    }
    if (seedState === 'failed') {
      stack.broken = true
      stack.releases = [...history, release('edge-v4', 'Failed', minutesAgo(20), 'アプリが起動直後に終了しました（exit 1）')]
    }
    stack.env.push({ key: 'APP_TITLE', state: 'configured', source: 'user', sensitive: false, value: appName })
    if (appName === 'mitsumori') {
      stack.releases.push(release('edge-v3', 'Pending', minutesAgo(5)))
      for (const key of ['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_PASSWORD', 'DATABASE_PORT', 'DATABASE_READ_AVAILABLE', 'DATABASE_USER']) {
        stack.env.push({ key, state: 'generated', source: 'generated', sensitive: true })
      }
      state.databaseChanges.set(dbId(stack), seedDatabaseChanges(dbId(stack)))
    }
    state.stacks.set(stack.id, stack)
    if (stack.sourceRepositoryId) {
      state.repositories.set(stack.sourceRepositoryId, repositoryFor(appName, stack.stage === 0 ? 'pending' : 'ready'))
      state.githubRepositoryNames.add(appName)
    }
  }
  return state
}

/** Moves every unfinished, healthy stack, adopted repository, plan generation and creation execution one step forward. */
export function advance(): number {
  let moved = 0
  for (const workspace of state.workspaces.values()) {
    if (workspace.phase !== 'Starting') continue
    workspace.phase = 'Ready'
    moved++
  }
  for (const item of state.workspaceOperations.values()) {
    if (item.phase !== 'Pending' && item.phase !== 'Running') continue
    const workspace = state.workspaces.get(item.workspaceId)!
    const pushed = state.operationPushes.has(item.id)
    const commitSha = `mock-${item.id}`
    Object.assign(item, { phase: 'Succeeded', completedAt: stamp(), commit: { hasChanges: true, pushed, commitSha } })
    workspace.commitSha = commitSha
    const stack = workspace.applicationId ? state.stacks.get(workspace.applicationId) : undefined
    if (pushed && stack) stack.releases.push(release(`edge-v${stack.releases.length + 1}`, 'Succeeded', stamp()))
    moved++
  }
  for (const stack of state.stacks.values()) {
    if (stack.broken || stack.stage === 3) continue
    const repository = stack.sourceRepositoryId ? state.repositories.get(stack.sourceRepositoryId) : undefined
    if (repository?.existing && repository.status !== 'ready') {
      // The adopted repository's readiness moves first; the stack waits for it.
      if (advanceAdopted(repository)) moved++
      continue
    }
    if (state.prepare.stall === 'building' && stack.stage === 1) continue
    if (state.prepare.stall === 'starting' && stack.stage === 1 && repository && !repository.existing) {
      repository.status = 'ready'
      repository.build = { ...repository.build, state: 'healthy' }
      if (!repository.conditions.some((condition) => condition.type === 'ImageReady')) repository.conditions.push({ type: 'ImageReady', status: 'True', reason: 'ImageAvailable' })
      continue
    }
    moved++
    if (stack.stage === 0) {
      stack.stage = 1
      if (repository && !repository.existing) {
        repository.repositoryUrl = `https://github.com/acme/${stack.appName}`
        repository.defaultBranch = 'main'
        repository.conditions = [{ type: 'RepositoryCreated', status: 'True', reason: 'RepositoryReady' }]
      }
      stack.releases.push(release('edge-v1', 'InProgress', stamp()))
    } else if (stack.stage === 1) {
      stack.stage = 2
      if (repository && !repository.existing) {
        repository.status = 'ready'
        repository.build = { ...repository.build, state: 'healthy' }
        repository.conditions.push({ type: 'ImageReady', status: 'True', reason: 'ImageAvailable' })
      }
      const first = stack.releases.at(-1)
      if (first) Object.assign(first, { phase: 'Succeeded', at: stamp() })
    } else {
      stack.stage = 3
    }
  }
  // After the stacks: a stack created by an execution starts at stage 0 on the next step.
  for (const draft of state.drafts.values()) if (advanceDraft(draft)) moved++
  for (const draft of state.drafts.values()) if (advanceImplementation(draft)) moved++
  for (const proposal of state.proposals.values()) advanceProposal(proposal)
  for (const changes of state.databaseChanges.values()) moved += applyReadyDatabaseChanges(changes)
  return moved
}

// ---------------------------------------------------------------- read models

const webId = (stack: MockStack) => `${stack.appName}-web`
const dbId = (stack: MockStack) => `${stack.appName}-db`

function toStack(stack: MockStack): ApplicationStack {
  return {
    id: stack.id,
    projectId: MOCK_PROJECT_ID,
    templateId: stack.templateId,
    definitionRef: { name: 'web-postgres', version: 'v1' },
    components: [
      { id: 'web', componentId: webId(stack) },
      { id: 'database', componentId: dbId(stack) },
    ],
    applicationName: stack.appName,
    sourceKind: stack.sourceKind,
    ...(stack.sourceRepositoryId ? { sourceRepositoryRefName: stack.sourceRepositoryId } : {}),
    imageRef: stack.imageRef,
    state: stack.stage === 0 ? 'PROVISIONING' : 'ACTIVE',
    ...(stack.stage > 0 ? { applicationId: stack.appName } : {}),
    branchId: 'production',
    webComponentId: webId(stack),
    ...(stack.sourceRepositoryId ? { webRepositoryId: stack.sourceRepositoryId } : {}),
    databaseComponentId: dbId(stack),
    pendingSync: false,
  }
}

function toApplication(stack: MockStack): Application {
  return {
    id: stack.appName,
    projectId: MOCK_PROJECT_ID,
    name: stack.appName,
    defaultBranchId: 'production',
    status: { phase: stack.broken ? 'degraded' : stack.stage === 3 ? 'healthy' : 'progressing', conditions: [] },
    sourceKind: 'applicationStack',
    sourceId: stack.id,
    pendingSync: false,
  }
}

function toPublish(stack: MockStack): Publish {
  const phase = stack.stage === 1 ? 'service_creating' : stack.stage === 2 ? 'dns_propagating' : 'succeeded'
  const policy = state.access.get(webId(stack))
  const access = policy ? { ...policy.value } : { mode: 'Public' as const }
  if (policy && policy.pendingReads-- <= 0) delete access.pending
  return {
    id: webId(stack),
    projectId: MOCK_PROJECT_ID,
    applicationId: stack.appName,
    branchId: 'production',
    componentId: webId(stack),
    phase,
    ...(phase === 'succeeded' ? { publicUrl: `https://${stack.host}/` } : {}),
    pendingSync: false,
    access,
  }
}

function toSummaries(stack: MockStack): ComponentSummaryFactsV1[] {
  const fact = (id: string, statusKey: ComponentSummaryFactsV1['statusKey'], reasonKey: ComponentSummaryFactsV1['reasonKey']) =>
    // The discriminated union pairs statusKey with reasonKey; only valid pairs are passed.
    ({ id, projectId: MOCK_PROJECT_ID, applicationId: stack.appName, name: id, kindKey: 'Container', pendingSync: false, statusKey, reasonKey }) as ComponentSummaryFactsV1
  const web = stack.broken
    ? fact(webId(stack), 'Degraded', 'ReadyConditionFalse')
    : stack.stage >= 2
      ? fact(webId(stack), 'Ready', 'ComponentReady')
      : fact(webId(stack), 'Provisioning', 'DeliveryProgressing')
  return [web, fact(dbId(stack), 'Ready', 'ComponentReady')]
}

function toRelease(stack: MockStack, item: MockRelease): ApplicationRelease {
  return {
    id: item.id,
    applicationId: stack.appName,
    branchId: 'production',
    componentId: webId(stack),
    version: item.version,
    phase: item.phase,
    environmentState: 'Present',
    rollbackEligible: item.phase === 'Succeeded',
    createdAt: item.at,
    ...(item.phase === 'Succeeded' || item.phase === 'Failed' ? { finishedAt: item.at } : {}),
    ...(item.failureReason ? { failureReason: item.failureReason } : {}),
    placements: [],
    conditions: [],
    canaryTasks: [],
    executionSteps: [],
  }
}

function toOverview(stack: MockStack): ApplicationReleaseOverview {
  const releases = stack.releases.map((item) => toRelease(stack, item))
  const latest = releases.at(-1)
  const count = (phase: ReleasePhase) => releases.filter((item) => item.phase === phase).length
  return {
    projectId: MOCK_PROJECT_ID,
    applicationId: stack.appName,
    branchId: 'production',
    generatedAt: stamp(),
    summary: {
      components: 1,
      releases: releases.length,
      active: count('InProgress'),
      pending: count('Pending'),
      inProgress: count('InProgress'),
      waitingPromotion: count('WaitingPromotion'),
      succeeded: count('Succeeded'),
      failed: count('Failed'),
      queued: 0,
    },
    components: [
      {
        id: webId(stack),
        name: webId(stack),
        canaries: [],
        ...(latest ? { latestRelease: latest } : {}),
        releases,
        queue: { applicationId: stack.appName, branchId: 'production', componentId: webId(stack), paused: false, acknowledged: true, releases: [] },
      },
    ],
    queues: [],
  }
}

const digest = (version: string) => `sha256:${version.replace(/\W/g, '').padEnd(12, '0')}`

function currentRelease(stack: MockStack): MockRelease | undefined {
  return [...stack.releases].reverse().find((item) => item.phase === 'Succeeded')
}

function toReleaseState(stack: MockStack): ComponentReleaseState {
  const current = currentRelease(stack)
  const seen: Record<string, true> = {}
  const candidates = stack.releases
    .filter((item) => item.phase === 'Succeeded' && item !== current)
    .reverse()
    .filter((item) => (seen[item.version] ? false : (seen[item.version] = true)))
  return {
    projectId: MOCK_PROJECT_ID,
    applicationId: stack.appName,
    branchId: 'production',
    componentId: webId(stack),
    mode: 'AutoLatest',
    pinned: false,
    ...(current ? { targetImageTag: current.version, targetImageDigest: digest(current.version) } : {}),
    scaleToZeroConfigured: false,
    rollbackCandidates: candidates.map((item) => ({
      transitionId: item.transitionId,
      imageTag: item.version,
      imageDigest: digest(item.version),
      createdAt: item.at,
    })),
  }
}

// ------------------------------------------------------------------ catalog

const allowedTemplateRepositories = [
  'appthrust/template-nextjs',
  'appthrust/template-remix',
  'appthrust/template-fastapi',
  'appthrust/template-biz-inventory',
  'appthrust/template-biz-master',
  'appthrust/template-biz-reservation',
]

const definitions: ApplicationStackDefinition[] = [
  {
    id: 'web-postgres',
    title: 'Web + PostgreSQL',
    category: 'application',
    versions: [{ name: 'v1', served: true, default: true }],
    components: [
      { id: 'web', definitionRef: { name: 'web-service', version: 'v1' } },
      { id: 'database', definitionRef: { name: 'postgresql', version: 'v1' } },
    ],
    connections: [{ name: 'database', from: 'web', to: 'database' }],
  },
]

const sourceConnections: GitHubSourceConnection[] = [
  {
    id: 'github-source-207cb7ce',
    displayName: 'Acme GitHub',
    account: { login: 'acme', type: 'Organization' },
    capabilities: ['createRepositories', 'readTemplateRepositories', 'readPackages'],
    allowedRepositories: allowedTemplateRepositories,
    status: 'ready',
    source: 'github-source-connection-cr',
  },
]

const registryConnections: RegistryConnection[] = [
  { id: 'ghcr-acme', displayName: 'GHCR (acme)', registryHost: 'ghcr.io', registryType: 'ghcr', status: 'ready', source: 'registry-connection-cr' },
]

let state = seedPlatform()

/** The creation tool registry includes the same availability reason as the mutation gates. */
function creationTools(): ApplicationDraftCreationToolRegistryResponse {
  const tool = (name: ApplicationDraftCreationToolRegistryResponse['tools'][number]['tool'], stage: 'validate' | 'create' | 'observe') => ({
    tool: name,
    title: name,
    description: name,
    stage,
    approvalRequired: stage === 'create',
    executionOwner: 'platform-api' as const,
    actor: 'user',
    idempotent: true,
    recoverable: true,
    representations: [],
  })
  return {
    version: 1,
    executionOwner: 'platform-api',
    approvalBoundary: 'create tools require user approval',
    forbiddenDuringPlanning: [],
    tools: [
      tool('appthrust.applicationSourceRepository.validate', 'validate'),
      tool('appthrust.applicationStack.validate', 'validate'),
      tool('appthrust.applicationSourceRepository.create', 'create'),
      tool('appthrust.applicationStack.create', 'create'),
      tool('appthrust.applicationStack.observe', 'observe'),
    ],
    sequences: [
      {
        name: 'withNewSourceRepository',
        tools: [
          'appthrust.applicationSourceRepository.validate',
          'appthrust.applicationStack.validate',
          'appthrust.applicationSourceRepository.create',
          'appthrust.applicationStack.create',
          'appthrust.applicationStack.observe',
        ],
      },
    ],
    placeholderRules: [],
    codexAvailable: state.codexAvailable,
    ...(!state.codexAvailable ? { codexUnavailableReason: state.codexUnavailableReason ?? 'runtime', codexPolicy: state.codexPolicy } : {}),
  }
}

// ------------------------------------------------------------------- routing

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const error = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  json({ error: { code, message, ...(details ? { details } : {}) } }, status)

function codexUnavailable(message: string): Response {
  return error(412, 'failed_precondition', message, {
    reason: state.codexUnavailableReason ?? 'runtime',
    ...(state.codexPolicy ? { policy: state.codexPolicy } : {}),
  })
}

/** The platform's answer for a destination repository that already exists on GitHub. */
const githubRepositoryExists = (name: string) =>
  error(409, 'conflict', `GitHub repository acme/${name} already exists. Choose a different repository name.`)
const list = <T>(data: T[]) => ({ data, meta: { total: data.length } })

function operation(kind: string, id: string): PublicOperation {
  const now = stamp()
  return { id: `op-${Math.random().toString(36).slice(2, 10)}`, type: kind, state: 'accepted', writeChannel: 'A', resource: { kind, id, projectId: MOCK_PROJECT_ID }, createdAt: now, links: { self: `/api/v1/operations/${id}` } }
}

function mutation<T extends object>(kind: string, id: string, resource: T) {
  return { ...resource, resource, operation: operation(kind, id) }
}

function turnMutation(draft: ApplicationDraft, turn: ApplicationDraftConversationTurn) {
  const envelope = mutation('ApplicationDraftConversationTurn', turn.id, turn)
  envelope.operation.type = 'applicationDraft.conversationTurn.create'
  envelope.operation.writeChannel = 'W'
  envelope.operation.links.self = `/api/v1/projects/${draft.projectId}/application-drafts/${draft.id}/conversation-turns/${turn.id}`
  return json(envelope, 202)
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

function nameProblem(name: string | undefined): string | undefined {
  if (!name || name.length > 63 || !DNS_LABEL.test(name)) return `'${name ?? ''}' is not a valid DNS label`
  if (state.stacks.has(name)) return `application '${name}' already exists`
  return undefined
}

function stackBody(raw: unknown): CreateApplicationStackRequest | undefined {
  if (!raw || typeof raw !== 'object' || !('source' in raw) || !('templateId' in raw)) return undefined
  return raw as CreateApplicationStackRequest
}

const PUBLISH_URL_TAKEN = 'Another publish already uses this URL.'

/**
 * The platform's publish rule (publish.go): gateway needs customDomain + hostnamePattern; wildcard needs subdomain.
 * The URL conflict skips the publish being written (publish.go rejectPublishEndpointConflict skips the same name),
 * so re-creating a component's own publish is an update, not a conflict.
 */
function publishProblem(publish: CreateApplicationStackRequest['publish'], ownStackId?: string): string | undefined {
  if (!publish?.enabled) return undefined
  if (!publish.customDomain) return "'customDomain' is required for gateway publish"
  if (!publish.hostnamePattern) return "'hostnamePattern' is required for gateway publish"
  if (publish.hostnamePattern === 'wildcard' && !publish.subdomain) return "'subdomain' is required for wildcard publish"
  const host = (publish.hostnamePattern === 'wildcard' ? `${publish.subdomain}.${publish.customDomain}` : publish.customDomain).trim().toLowerCase().replace(/\.$/, '')
  const path = publish.path?.trim() || '/'
  if ([...state.stacks.values()].some((stack) => stack.id !== ownStackId && stack.host.toLowerCase().replace(/\.$/, '') === host && (stack.publishPath ?? '/') === (path.startsWith('/') ? path : `/${path}`))) return PUBLISH_URL_TAKEN
  return undefined
}

function publishHost(body: CreateApplicationStackRequest, name: string): string {
  const publish = body.publish
  if (!publish?.enabled) return ''
  if (!publish.customDomain) return `${name}.${BASE_DOMAIN}`
  return publish.hostnamePattern === 'wildcard' && publish.subdomain
    ? `${publish.subdomain}.${publish.customDomain}`
    : publish.customDomain
}

type Handler = (match: RegExpExecArray, request: Request, url: URL) => Response | Promise<Response>

const P = '/api/v1/projects/([^/]+)'
const APP_COMPONENT = `${P}/applications/([^/]+)/branches/([^/]+)/components/([^/]+)`

const routes: Array<[method: string, pattern: RegExp, handler: Handler]> = [
  ['GET', new RegExp(`^${P}/releases$`), () => json(list([...state.stacks.values()].flatMap((stack) => stack.releases.map((item) => ({ ...toRelease(stack, item), projectId: MOCK_PROJECT_ID })))))],
  ['POST', new RegExp(`^${P}/dev-workspaces$`), async (m, request) => {
    if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot create workspaces')
    const body = await request.json() as { scope?: 'application' | 'applicationDraft'; applicationId?: string; draftId?: string; componentId?: string; sourceRepositoryId?: string; displayName?: string; baseRef?: string }
    const id = nextId('ws')
    const base = `/api/v1/projects/${m[1]}/dev-workspaces/${id}`
    const workspace: DevWorkspaceRead = {
      id, projectId: m[1]!, scope: body.scope ?? 'application',
      applicationId: body.applicationId, draftId: body.draftId,
      componentId: body.componentId, sourceRepositoryId: body.sourceRepositoryId,
      displayName: body.displayName ?? body.applicationId ?? '新しいアプリ',
      ownerUserId: 'mock-user', phase: 'Starting', branchName: 'main', baseRef: body.baseRef ?? 'main',
      codexUrl: `${base}/codex/`, previewUrl: `${base}/proxy/preview/`,
      createdAt: stamp(), conditions: [],
    }
    state.workspaces.set(id, workspace)
    state.documents.set(id, new Map())
    state.workspaceTodos.set(id, [])
    return json(mutation('DevWorkspace', id, workspace), 201)
  }],
  ['GET', new RegExp(`^${P}/dev-workspaces/([^/]+)$`), (m) => {
    const workspace = state.workspaces.get(m[2]!)
    return workspace ? json(workspace) : error(404, 'not_found', 'workspace not found')
  }],
  ['POST', new RegExp(`^${P}/dev-workspaces/([^/]+)/restart$`), (m) => {
    const workspace = state.workspaces.get(m[2]!)
    if (!workspace) return error(404, 'not_found', 'workspace not found')
    workspace.phase = 'Starting'
    return json(mutation('DevWorkspace', workspace.id, workspace), 202)
  }],
  ['GET', new RegExp(`^${P}/dev-workspaces/([^/]+)/proxy/preview/$`), (m) => {
    const workspace = state.workspaces.get(m[2]!)
    if (!workspace) return error(404, 'not_found', 'workspace not found')
    const name = workspace.displayName.replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!)
    return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>プレビュー</title><body><h1>プレビュー: ${name}</h1></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
  }],
  ['GET', new RegExp(`^${P}/dev-workspaces/([^/]+)/codex/api/appthrust/workflow$`), (m) => {
    if (!state.workspaces.has(m[2]!)) return error(404, 'not_found', 'workspace not found')
    return json({ todos: state.workspaceTodos.get(m[2]!) ?? [] })
  }],
  ['PUT', new RegExp(`^${P}/dev-workspaces/([^/]+)/codex/api/appthrust/todos$`), async (m, request) => {
    if (!state.workspaces.has(m[2]!)) return error(404, 'not_found', 'workspace not found')
    const body = await request.json() as { todos: unknown[] }
    state.workspaceTodos.set(m[2]!, body.todos)
    return json({ todos: body.todos })
  }],
  ['GET', new RegExp(`^${P}/dev-workspaces/([^/]+)/codex/api/appthrust/spec$`), (m) => {
    const documents = state.documents.get(m[2]!)
    return documents ? json({ markdown: documents.get('spec') ?? '' }) : error(404, 'not_found', 'workspace not found')
  }],
  ['PUT', new RegExp(`^${P}/dev-workspaces/([^/]+)/codex/api/appthrust/spec$`), async (m, request) => {
    const documents = state.documents.get(m[2]!)
    if (!documents) return error(404, 'not_found', 'workspace not found')
    const body = await request.json() as { markdown: string }
    documents.set('spec', body.markdown)
    return json(body)
  }],
  ['POST', new RegExp(`^${P}/dev-workspaces/([^/]+)/codex/api/tasks$`), async (m, request) => {
    const workspace = state.workspaces.get(m[2]!)
    if (!workspace) return error(404, 'not_found', 'workspace not found')
    if (workspace.phase !== 'Ready') return error(503, 'unavailable', 'workspace is not ready')
    const body = await request.json() as { prompt?: string }
    if (!body.prompt) return error(400, 'invalid_argument', 'prompt is required')
    const events = [{ type: 'task.started' }, { type: 'output.delta', text: '画面を作っています。\n' }, { type: 'output.delta', text: 'プレビューで確認できるようになりました。\n' }, { type: 'task.completed' }]
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } })
  }],
  ['POST', new RegExp(`^${P}/dev-workspaces/([^/]+)/commit$`), async (m, request) => {
    const workspace = state.workspaces.get(m[2]!)
    if (!workspace) return error(404, 'not_found', 'workspace not found')
    const body = await request.json() as { message: string; push?: boolean }
    const commitOperation: DevWorkspaceOperationRead = { id: nextId('commit'), workspaceId: workspace.id, type: 'Commit', phase: 'Pending', createdAt: stamp(), conditions: [] }
    state.workspaceOperations.set(commitOperation.id, commitOperation)
    if (body.push) state.operationPushes.add(commitOperation.id)
    return json({ ...mutation('DevWorkspace', workspace.id, workspace), workspace, commitOperation }, 202)
  }],
  ['GET', new RegExp(`^${P}/dev-workspaces/([^/]+)/operations/([^/]+)$`), (m) => {
    const item = state.workspaceOperations.get(m[3]!)
    return item?.workspaceId === m[2] ? json(item) : error(404, 'not_found', 'workspace operation not found')
  }],
  ['POST', /^\/api\/v1\/__mock\/reset$/, () => {
    state = seedPlatform()
    resetDatabaseData()
    return json({ reset: true })
  }],
  ['POST', /^\/api\/v1\/__mock\/access-forbidden$/, async (_, request) => {
    const input = await request.json() as { forbidden?: boolean }
    state.accessForbidden = input.forbidden ?? true
    return json({ forbidden: state.accessForbidden })
  }],
  ['POST', /^\/api\/v1\/__mock\/logs$/, async (_, request) => {
    const input = await request.json() as { componentId: string; status: 200 | 403 | 500 }
    state.logs.set(input.componentId, { status: input.status, requests: 0 })
    return json(state.logs.get(input.componentId))
  }],
  ['GET', /^\/api\/v1\/__mock\/logs$/, (_, __, url) => json(state.logs.get(url.searchParams.get('componentId') ?? '') ?? { status: 200, requests: 0 })],
  ['POST', /^\/api\/v1\/__mock\/advance$/, () => json({ moved: advance() })],
  [
    'POST',
    /^\/api\/v1\/__mock\/role$/,
    async (_, request) => {
      const body = (await request.json()) as { role?: Role }
      if (body.role === 'Admin' || body.role === 'Editor' || body.role === 'Viewer') state.role = body.role
      return json({ role: state.role })
    },
  ],
  [
    'POST',
    /^\/api\/v1\/__mock\/registry$/,
    async (_, request) => {
      const body = (await request.json()) as { connected?: unknown }
      if (typeof body.connected === 'boolean') state.registryConnected = body.connected
      return json({ connected: state.registryConnected })
    },
  ],
  [
    'POST',
    /^\/api\/v1\/__mock\/reject-next-validation$/,
    () => {
      state.rejectNextValidation = true
      return json({ rejectNextValidation: true })
    },
  ],
  ['POST', /^\/api\/v1\/__mock\/creation-publish-conflict$/, () => {
    state.creationPublishConflict = true
    return json({ creationPublishConflict: true })
  }],
  [
    'POST',
    /^\/api\/v1\/__mock\/stack-conflict$/,
    async (_, request) => {
      const body = (await request.json()) as { appName?: string; reason?: string; message?: string }
      const message =
        body.message ??
        (body.reason === 'delivery_pending'
          ? 'Platform delivery is converging; retry the same request in a few seconds.'
          : 'publish endpoint is already owned by another publish')
      state.stackConflicts.push({ appName: body.appName, reason: body.reason, message })
      return json({ stackConflicts: state.stackConflicts })
    },
  ],
  [
    'POST',
    /^\/api\/v1\/__mock\/github-repository$/,
    async (_, request) => {
      const body = (await request.json()) as { name?: string }
      if (body.name) state.githubRepositoryNames.add(body.name)
      return json({ githubRepositoryNames: [...state.githubRepositoryNames] })
    },
  ],
  [
    'POST',
    /^\/api\/v1\/__mock\/codex(?:-available)?$/,
    async (_, request) => {
      const body = (await request.json()) as { available?: unknown; reason?: unknown; policy?: unknown }
      const reason = ApplicationDraftCodexUnavailableReason.safeParse(body.reason)
      if (body.reason !== undefined && !reason.success) return error(400, 'invalid_argument', 'invalid Codex availability reason')
      if (typeof body.available === 'boolean') state.codexAvailable = body.available
      state.codexUnavailableReason = state.codexAvailable ? undefined : reason.data
      state.codexPolicy = !state.codexAvailable && typeof body.policy === 'string' ? body.policy : undefined
      return json({ available: state.codexAvailable, reason: state.codexUnavailableReason, policy: state.codexPolicy })
    },
  ],
  ['POST', /^\/api\/v1\/__mock\/ai-quota$/, async (_, request) => {
    const body = await request.json() as { exhausted?: unknown }
    if (typeof body.exhausted === 'boolean') state.aiQuotaExhausted = body.exhausted
    return json({ exhausted: state.aiQuotaExhausted })
  }],
  [
    'POST',
    /^\/api\/v1\/__mock\/plan-generation$/,
    async (_, request) => {
      const body = (await request.json()) as { outcome?: string; error?: string; autoAdvance?: boolean; priorGenerations?: number; publish?: boolean }
      if (body.outcome === 'succeeded' || body.outcome === 'failed') state.planGeneration.outcome = body.outcome
      if (typeof body.error === 'string') state.planGeneration.error = body.error
      if (typeof body.autoAdvance === 'boolean') state.planGeneration.autoAdvance = body.autoAdvance
      if (typeof body.publish === 'boolean') state.planGeneration.publish = body.publish
      if (Number.isInteger(body.priorGenerations) && body.priorGenerations! >= 0 && body.priorGenerations! <= 19) state.planGeneration.priorGenerations = body.priorGenerations!
      return json(state.planGeneration)
    },
  ],
  ['POST', /^\/api\/v1\/__mock\/prepare$/, async (_, request) => {
    const body = await request.json() as { stall?: 'building' | 'starting' }
    if (body.stall !== undefined && body.stall !== 'building' && body.stall !== 'starting') return error(400, 'invalid_argument', "'stall' must be building or starting")
    state.prepare.stall = body.stall
    return json(state.prepare)
  }],
  ['POST', /^\/api\/v1\/__mock\/implementation-run$/, async (_, request) => {
    const body = await request.json() as { outcome?: 'succeeded' | 'failed'; error?: string; autoAdvance?: boolean; unmetCriterion?: boolean; interruptSecondTask?: boolean }
    if (body.outcome) state.implementationRun.outcome = body.outcome
    if (body.error !== undefined) state.implementationRun.error = body.error
    if (body.autoAdvance !== undefined) state.implementationRun.autoAdvance = body.autoAdvance
    if (typeof body.unmetCriterion === 'boolean') state.implementationRun.unmetCriterion = body.unmetCriterion
    if (typeof body.interruptSecondTask === 'boolean') state.implementationRun.interruptSecondTask = body.interruptSecondTask
    return json(state.implementationRun)
  }],
  ['GET', new RegExp(`^/api/v1/projects/([^/]+)$`), (m) => json({ id: m[1], name: m[1], teamSlug: TEAM_SLUG })],
  ['GET', /^\/api\/v1\/teams$/, () => json({ items: [{ id: 'team-commerce', slug: TEAM_SLUG, name: 'Commerce', plan: 'team', role: state.role }] })],
  [
    'GET',
    /^\/api\/v1\/teams\/([^/]+)\/directory-users$/,
    () => json({ items: [{ id: 'u-new-1', email: 'kobayashi@acme.example', name: '小林 真' }, { id: 'u-new-2', email: 'kato@acme.example', name: '加藤 葵' }] }),
  ],
  ['GET', new RegExp(`^${P}/source-connections$`), () => json(list(sourceConnections))],
  [
    'GET',
    new RegExp(`^${P}/source-connections/([^/]+)/repositories$`),
    (m, _, url) => {
      if (!sourceConnections.some((connection) => connection.id === m[2])) return error(404, 'not_found', 'source connection not found')
      const q = url.searchParams.get('q')?.trim().toLowerCase() ?? ''
      return json({ data: state.githubRepositories.filter((repository) => repository.fullName.toLowerCase().includes(q)) })
    },
  ],
  ['GET', /^\/api\/v1\/registry-connections$/, () => json(list(state.registryConnected ? registryConnections : []))],
  [
    'GET',
    new RegExp(`^${P}/domains$`),
    (m) => {
      const name = `${m[1]}.appthrust.test`
      const seeded = { id: name, projectId: m[1]!, name, source: 'seed', dnsManagement: 'platform', configuration: { state: 'valid', expectedRecords: [] }, usableForPublish: true, deletable: false, delegationReady: true, publishDnsManaged: true, externalDnsManaged: true, usedBy: [] } satisfies Domain
      return json({ data: [seeded], meta: { total: 1, capabilities: { hostedZoneProvisioningEnabled: false } } })
    },
  ],
  ['GET', new RegExp(`^${P}/application-templates$`), () => json(list(state.templates))],
  ['GET', /^\/api\/v1\/application-stack-definitions$/, () => json(list(definitions))],
  ['GET', new RegExp(`^${P}/application-source-repositories$`), () => json(list([...state.repositories.values()]))],
  [
    'GET',
    new RegExp(`^${P}/application-source-repositories/([^/]+)$`),
    (m) => {
      const repository = state.repositories.get(m[2]!)
      return repository ? json(repository) : error(404, 'not_found', 'source repository not found')
    },
  ],
  [
    'POST',
    new RegExp(`^${P}/application-source-repositories/validate$`),
    async (_, request) => {
      const body = (await request.json()) as CreateApplicationSourceRepositoryRequest
      if (body.existing) {
        const adopted = adoptedRepository({ ...body, existing: body.existing })
        const problem = !state.githubRepositories.some((repository) => repository.fullName === body.existing?.repository)
          ? `repository '${body.existing.repository}' is not visible to the source connection`
          : state.repositories.has(adopted.id)
            ? 'repository is already adopted'
            : undefined
        return json(problem ? { valid: false, message: problem } : { valid: true })
      }
      const name = body.destination?.repositoryName
      // Like the platform: an existing GitHub repository is a 409 conflict, not `valid: false`.
      if (name && state.githubRepositoryNames.has(name)) return githubRepositoryExists(name)
      const problem = name && DNS_LABEL.test(name) ? undefined : `'${name ?? ''}' is not a valid DNS label`
      return json(problem ? { valid: false, message: problem } : { valid: true })
    },
  ],
  [
    'POST',
    new RegExp(`^${P}/application-source-repositories$`),
    async (_, request) => {
      if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot create source repositories')
      const body = (await request.json()) as CreateApplicationSourceRepositoryRequest
      const connection = sourceConnections.find((source) => source.id === body.sourceConnectionId)
      const templateRepository = body.template?.repository.trim().toLowerCase()
      if (templateRepository && connection?.allowedRepositories?.length && !connection.allowedRepositories.some((allowed) => allowed.trim().toLowerCase() === templateRepository)) {
        return error(400, 'invalid_argument', "'template.repository' is not allowed by the selected source connection")
      }
      if (body.existing) {
        const repository = adoptedRepository({ ...body, existing: body.existing })
        if (state.repositories.has(repository.id)) return error(409, 'conflict', 'repository is already adopted')
        state.repositories.set(repository.id, repository)
        return json(mutation('ApplicationSourceRepository', repository.id, repository), 202)
      }
      const name = body.destination?.repositoryName
      const problem = nameProblem(name)
      if (problem || !name) return error(409, 'conflict', problem ?? 'invalid')
      if (state.githubRepositoryNames.has(name)) return githubRepositoryExists(name)
      state.githubRepositoryNames.add(name)
      const repository = repositoryFor(name, 'pending')
      state.repositories.set(repository.id, repository)
      return json(mutation('ApplicationSourceRepository', repository.id, repository), 202)
    },
  ],
  ['GET', new RegExp(`^${P}/application-drafts/creation-tools$`), () => json(creationTools())],
  ['GET', new RegExp(`^${P}/source-change-proposals$`), (m, _request, url) => {
    const filters = url.searchParams
    return json(list([...state.proposals.values()].filter((proposal) =>
      proposal.projectId === m[1] &&
      (!filters.has('applicationId') || proposal.applicationId === filters.get('applicationId')) &&
      (!filters.has('phase') || proposal.phase === filters.get('phase')) &&
      (filters.get('proposer') !== 'me' || proposal.proposer === mockSubject()) &&
      (filters.get('reviewer') !== 'me' || proposal.reviewers.includes(mockSubject()))
    )))
  }],
  ['GET', new RegExp(`^${P}/source-change-proposals/([^/]+)$`), (m) => {
    const proposal = state.proposals.get(m[2]!)
    return proposal?.projectId === m[1] ? json(proposal) : error(404, 'not_found', 'proposal not found')
  }],
  ['GET', new RegExp(`^${P}/source-change-proposals/([^/]+)/diff$`), (m) => {
    const proposal = state.proposals.get(m[2]!)
    if (!proposal || proposal.projectId !== m[1]) return error(404, 'not_found', 'proposal not found')
    return json({
      summary: proposal.change ?? { files: 1, additions: 2, deletions: 1 }, truncated: false,
      unifiedDiff: 'diff --git a/src/list.tsx b/src/list.tsx\n--- a/src/list.tsx\n+++ b/src/list.tsx\n@@ -1 +1,2 @@\n-<List items={items} />\n+<StatusFilter value={status} onChange={setStatus} />\n+<List items={items.filter(matchesStatus)} />\n',
    })
  }],
  ['POST', new RegExp(`^${P}/source-change-proposals/([^/]+)/decisions$`), async (m, request) => {
    const proposal = state.proposals.get(m[2]!)
    if (!proposal || proposal.projectId !== m[1]) return error(404, 'not_found', 'proposal not found')
    if (!proposal.reviewers.includes(mockSubject())) return error(403, 'forbidden', 'only reviewers can decide')
    if (proposal.phase !== 'Proposed') return error(409, 'conflict', 'proposal is not awaiting review')
    const parsed = SourceChangeProposalDecisionRequest.safeParse(await request.json())
    if (!parsed.success) return error(400, 'invalid_argument', 'invalid decision')
    proposal.decisions.push({ ...parsed.data, subject: mockSubject(), at: stamp() })
    proposal.phase = parsed.data.decision === 'Accept' ? 'Accepted' : parsed.data.decision === 'Reject' ? 'Rejected' : 'ChangesRequested'
    proposal.updatedAt = stamp()
    if (proposal.phase === 'Accepted') {
      // A short controller-shaped lifecycle, fenced against reset and repeat decisions.
      const advanceCurrent = () => { if (state.proposals.get(proposal.id) === proposal) advanceProposal(proposal) }
      setTimeout(advanceCurrent, 100)
      setTimeout(advanceCurrent, 1000)
    }
    return json(mutation('SourceChangeProposal', proposal.id, proposal), 202)
  }],
  ['POST', new RegExp(`^${P}/source-change-proposals/([^/]+)/submit$`), (m) => {
    const proposal = state.proposals.get(m[2]!)
    if (!proposal || proposal.projectId !== m[1]) return error(404, 'not_found', 'proposal not found')
    if (proposal.proposer !== mockSubject()) return error(403, 'forbidden', 'only the proposer can submit')
    if (!['Drafting', 'ChangesRequested', 'ApplyFailed'].includes(proposal.phase)) return error(409, 'conflict', 'proposal cannot be submitted')
    const draft = state.drafts.get(proposal.originDraftId!)
    if (draft) submitImprovementProposal(draft)
    return json(mutation('SourceChangeProposal', proposal.id, proposal), 202)
  }],
  ['POST', new RegExp(`^${P}/source-change-proposals/([^/]+)/withdraw$`), (m) => {
    const proposal = state.proposals.get(m[2]!)
    if (!proposal || proposal.projectId !== m[1]) return error(404, 'not_found', 'proposal not found')
    if (proposal.proposer !== mockSubject()) return error(403, 'forbidden', 'only the proposer can withdraw')
    if (proposalTerminal(proposal.phase) || proposal.phase === 'Accepted' || proposal.phase === 'Applying') return error(409, 'conflict', 'proposal cannot be withdrawn')
    Object.assign(proposal, { phase: 'Withdrawn', updatedAt: stamp() })
    return json(mutation('SourceChangeProposal', proposal.id, proposal), 202)
  }],
  ['GET', new RegExp(`^${P}/application-drafts$`), () => {
    for (const draft of state.drafts.values()) settleImprovement(draft)
    if (state.implementationRun.autoAdvance) for (const draft of state.drafts.values()) advanceImplementation(draft)
    return json(list([...state.drafts.values()].filter((draft) => draft.ownerUserId === mockSubject())))
  }],
  [
    'POST',
    new RegExp(`^${P}/application-drafts$`),
    async (_, request) => {
      if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot create application drafts')
      const body = (await request.json()) as { title?: string; intent?: string; kind?: string; applicationStackId?: string; reviewers?: string[] }
      const intent = body.intent?.trim()
      if (!intent || intent.length > 8000) return error(400, 'invalid_argument', "'intent' is required (max 8000)")
      const improvement = body.kind === 'improvement'
      if (body.kind !== undefined && body.kind !== 'creation' && !improvement) return error(400, 'invalid_argument', "'kind' must be creation or improvement")
      if (improvement && !body.applicationStackId) return error(400, 'invalid_argument', 'applicationStackId is required for an improvement draft')
      if (!improvement && body.applicationStackId) return error(400, 'invalid_argument', 'applicationStackId is only accepted for an improvement draft')
      // Like platform-api: the target stack must resolve to an application with a source repository.
      const stack = improvement ? state.stacks.get(body.applicationStackId!) : undefined
      if (improvement && !stack) return error(412, 'failed_precondition', 'the application stack has no application')
      if (stack && !stack.sourceRepositoryId) return error(412, 'failed_precondition', 'the application has no source repository')
      const reviewers = improvement ? mockOwnerSubjects(body.applicationStackId!) : []
      if (improvement && !reviewers.length) return error(412, 'reviewers_unavailable', 'An app owner must sign in before a proposal can be created')
      const now = stamp()
      const draft: ApplicationDraft = {
        id: nextId('draft'),
        projectId: MOCK_PROJECT_ID,
        title: body.title?.trim() || (stack ? stack.appName : intent.slice(0, 40)),
        intent,
        specMarkdown: stack ? intent : '',
        architectureMarkdown: '',
        phase: stack ? 'created' : 'specifying',
        ...(stack ? { kind: 'improvement' as const, createdApplicationId: stack.appName, createdApplicationStackId: stack.id } : {}),
        creationPlanGenerations: [],
        conversationTurns: [],
        creationExecutions: [],
        ownerUserId: mockSubject(),
        createdAt: now,
        updatedAt: now,
      }
      state.drafts.set(draft.id, draft)
      if (improvement) state.draftReviewers.set(draft.id, reviewers)
      return json(mutation('ApplicationDraft', draft.id, draft), 201)
    },
  ],
  [
    'GET',
    new RegExp(`^${P}/application-drafts/([^/]+)$`),
    (m) => {
      const draft = state.drafts.get(m[2]!)
      // Jobs progress with time, whichever resource the client polls.
      if (draft) settleImprovement(draft)
      if (draft && state.planGeneration.autoAdvance) advanceDraft(draft)
      if (draft && state.implementationRun.autoAdvance) advanceImplementation(draft)
      return draft ? json(draft) : error(404, 'not_found', 'application draft not found')
    },
  ],
  ['POST', new RegExp(`^${P}/application-drafts/([^/]+)/workbooks$`), async (m, request) => {
    const draft = state.drafts.get(m[2]!)
    if (!draft || draft.projectId !== m[1]) return error(404, 'not_found', 'application draft not found')
    if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot update application drafts')
    const body = await request.arrayBuffer()
    if (body.byteLength > ApplicationDraftWorkbookLimits.maxWorkbookBytes) return error(413, 'payload_too_large', 'workbook JSON must not exceed 512 KiB', { reason: 'WorkbookTooLarge' })
    let input: unknown
    try {
      input = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return error(400, 'invalid_argument', 'invalid JSON body')
    }
    const parsed = ApplicationDraftWorkbook.safeParse(input)
    if (!parsed.success) return workbookValidationError(input, parsed.error.issues[0]!)
    const grid = parsed.data
    const canonical = JSON.stringify(grid)
    const bytes = new TextEncoder().encode(canonical).length
    if (bytes > ApplicationDraftWorkbookLimits.maxWorkbookBytes) return error(413, 'payload_too_large', 'workbook JSON must not exceed 512 KiB', { reason: 'WorkbookTooLarge' })
    const blocked = workbookSetMutable(draft)
    if (blocked) return blocked
    const digest = createHash('sha256').update(canonical).digest('hex')
    const key = request.headers.get('Idempotency-Key')
    const id = `wb-${key ? createHash('sha256').update(`${draft.projectId}/${draft.id}/${key}`).digest('hex').slice(0, 12) : randomBytes(6).toString('hex')}`
    const members = draft.source?.workbooks ?? []
    const replay = members.find((member) => member.id === id)
    if (replay) return replay.digest === digest
      ? json({ draft, workbook: replay }, 201)
      : error(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request')
    const duplicate = members.find((member) => member.digest === digest)
    if (duplicate) return error(409, 'conflict', 'workbook is already a member of this draft', { reason: 'WorkbookDuplicate', workbookId: duplicate.id })
    if (members.length >= ApplicationDraftWorkbookLimits.maxWorkbooks) return error(409, 'conflict', 'workbook set must contain at most 20 workbooks', { reason: 'WorkbookSetFull' })
    if (members.reduce((sum, member) => sum + member.bytes, bytes) > ApplicationDraftWorkbookLimits.maxSetBytes || members.reduce((sum, member) => sum + member.sheetCount, grid.sheets.length) > ApplicationDraftWorkbookLimits.maxSetSheets) {
      return error(413, 'payload_too_large', 'workbook set must not exceed 4 MiB or 200 sheets', { reason: 'WorkbookSetTooLarge' })
    }
    const now = stamp()
    const workbook = { id, fileName: grid.fileName, sheetCount: grid.sheets.length, rowCount: grid.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0), truncated: grid.sheets.some((sheet) => sheet.truncated), bytes, digest, addedAt: now }
    let stored = state.workbooks.get(draft.id)
    if (!stored) { stored = new Map(); state.workbooks.set(draft.id, stored) }
    stored.set(id, { grid })
    draft.source = { kind: 'excel', revision: now, workbooks: [...members, workbook] }
    delete draft.excelAnalysis
    delete draft.uiDesign
    draft.updatedAt = now
    return json({ draft, workbook }, 201)
  }],
  ['GET', new RegExp(`^${P}/application-drafts/([^/]+)/workbooks$`), (m) => {
    const draft = state.drafts.get(m[2]!)
    if (!draft || draft.projectId !== m[1]) return error(404, 'not_found', 'application draft not found')
    return json(list((draft.source?.workbooks ?? []).map((workbook) => {
      const reading = state.workbooks.get(draft.id)?.get(workbook.id)?.reading
      return { workbook, ...(reading ? { reading } : {}) }
    })))
  }],
  ['GET', new RegExp(`^${P}/application-drafts/([^/]+)/workbooks/([^/]+)$`), (m) => {
    const draft = state.drafts.get(m[2]!)
    if (!draft || draft.projectId !== m[1]) return error(404, 'not_found', 'application draft not found')
    const stored = draft.source?.workbooks.some((workbook) => workbook.id === m[3]) && state.workbooks.get(draft.id)?.get(m[3]!)
    return stored ? json(stored.grid) : error(404, 'not_found', 'application draft workbook not found')
  }],
  ['DELETE', new RegExp(`^${P}/application-drafts/([^/]+)/workbooks/([^/]+)$`), (m) => {
    const draft = state.drafts.get(m[2]!)
    if (!draft || draft.projectId !== m[1]) return error(404, 'not_found', 'application draft not found')
    if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot update application drafts')
    const blocked = workbookSetMutable(draft)
    if (blocked) return blocked
    if (!draft.source?.workbooks.some((workbook) => workbook.id === m[3])) return error(404, 'not_found', 'application draft workbook not found')
    const workbooks = draft.source.workbooks.filter((workbook) => workbook.id !== m[3])
    const now = stamp()
    if (workbooks.length) draft.source = { kind: 'excel', revision: now, workbooks }
    else delete draft.source
    state.workbooks.get(draft.id)?.delete(m[3]!)
    if (!workbooks.length) state.workbooks.delete(draft.id)
    delete draft.excelAnalysis
    delete draft.uiDesign
    draft.updatedAt = now
    return json(draft)
  }],
  [
    'PATCH',
    new RegExp(`^${P}/application-drafts/([^/]+)$`),
    async (m, request) => {
      const draft = state.drafts.get(m[2]!)
      if (!draft) return error(404, 'not_found', 'application draft not found')
      if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot update application drafts')
      const body = (await request.json()) as UpdateApplicationDraftRequest
      if (body.renameApplication !== undefined) {
        if ('creationPlan' in body) return error(400, 'invalid_argument', "'renameApplication' and 'creationPlan' are mutually exclusive")
        if (!UpdateApplicationDraftRequest.shape.renameApplication.safeParse(body.renameApplication).success) return error(400, 'invalid_argument', "'renameApplication.name' must be a DNS label")
      }
      if (body.publishPreferences != null && !ApplicationDraftPublishPreferences.safeParse(body.publishPreferences).success) return error(400, 'invalid_argument', 'invalid publish preferences')
      if ('markPublished' in body && body.markPublished !== true) return error(400, 'invalid_argument', "'markPublished' must be true")
      if ('publishedAt' in body) return error(400, 'invalid_argument', "'publishedAt' is managed by markPublished")
      const keys = Object.keys(body)
      const publishMetadataOnly = keys.length > 0 && keys.every((key) => key === 'title' ? typeof body.title === 'string' : key === 'publishPreferences' && body.publishPreferences != null)
      const preparing = draft.phase === 'creating' || [...(draft.conversationTurns ?? []), ...(draft.creationPlanGenerations ?? []), ...draft.creationExecutions].some((item) => item.status === 'pending' || item.status === 'running')
      const implementing = draft.implementationRuns?.some((run) => run.status === 'pending' || run.status === 'running')
      // Publication metadata does not change the implementation input.
      if (preparing || (implementing && !publishMetadataOnly)) return error(409, 'conflict', 'application draft creation is running; wait for it to finish before updating the draft')
      if (body.markPublished && !draft.createdApplicationId) return error(409, 'conflict', 'application draft has no created application; create an application before marking it published')
      const hasResources = draft.createdApplicationId || draft.createdApplicationStackId || draft.createdSourceRepositoryId || draft.creationExecutions.some((item) => item.steps.some((step) => step.status === 'done' && step.tool.endsWith('.create')))
      if ('creationPlan' in body && hasResources) return error(409, 'conflict', 'application draft has AppThrust creation resources; cleanup is required before replacing the creation plan')
      if (body.renameApplication) {
        const failure = renameDraftApplication(draft, body.renameApplication.name)
        if (failure) return failure
      }
      if (body.title) draft.title = body.title.trim()
      if (body.publishPreferences != null) draft.publishPreferences = ApplicationDraftPublishPreferences.parse(body.publishPreferences)
      // Like platform-api applyApplicationDraftUpdate: a new intent keeps the plan and phase; the console decides when to regenerate.
      if (body.intent) draft.intent = body.intent.trim()
      if (body.specMarkdown !== undefined) draft.specMarkdown = body.specMarkdown
      if (body.creationPlan !== undefined) {
        draft.creationPlan = body.creationPlan
        draft.validatedCreationPlanFingerprint = undefined
      }
      draft.updatedAt = stamp()
      if (body.markPublished) draft.publishedAt = draft.updatedAt
      return json(mutation('ApplicationDraft', draft.id, draft))
    },
  ],
  [
    'DELETE',
    new RegExp(`^${P}/application-drafts/([^/]+)$`),
    (m) => {
      const draft = state.drafts.get(m[2]!)
      if (!draft) return error(404, 'not_found', 'application draft not found')
      if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot delete application drafts')
      // Like platform-api `delete`: refuse while a job runs, and until cleanup removed creation resources.
      if ([...(draft.conversationTurns ?? []), ...(draft.creationPlanGenerations ?? []), ...draft.creationExecutions].some((item) => item.status === 'pending' || item.status === 'running')) return error(409, 'conflict', 'application draft creation is running; wait for it to finish before deleting the draft')
      if (draft.createdApplicationStackId || draft.creationExecutions.some((execution) => execution.steps.some((step) => step.status === 'done' && step.tool.endsWith('.create')))) return error(409, 'conflict', 'application draft has AppThrust creation resources; cleanup is required before deleting the draft')
      state.drafts.delete(draft.id)
      state.workbooks.delete(draft.id)
      return json({ deleted: true, id: draft.id, operation: operation('ApplicationDraft', draft.id) }, 202)
    },
  ],
  [
    'POST',
    new RegExp(`^${P}/application-drafts/([^/]+)/creation-cleanups$`),
    (m) => {
      const draft = state.drafts.get(m[2]!)
      if (!draft) return error(404, 'not_found', 'application draft not found')
      if (draft.kind === 'improvement') return error(412, 'failed_precondition', 'improvement drafts have no creation resources to clean up')
      if (draft.creationExecutions.some((execution) => execution.status === 'running')) return error(409, 'conflict', 'application draft creation is running; wait for it to finish before cleanup')
      if (draft.createdApplicationStackId) state.stacks.delete(draft.createdApplicationStackId)
      const sourceId = draft.createdSourceRepositoryId
      const repository = sourceId ? state.repositories.get(sourceId) : undefined
      const approval = draft.creationExecutions.at(-1)?.approval
      if (approval && draft.creationPlan) {
        draft.creationPlan = {
          ...draft.creationPlan,
          applicationSourceRepositoryRequest: approval.applicationSourceRepositoryRequest,
          applicationStackRequest: approval.applicationStackRequest,
          toolPlan: approval.toolPlan,
          implementationHandoff: approval.implementationHandoff,
        }
      }
      if (repository?.status === 'ready') bindDraftSource(draft, repository.id)
      else if (sourceId) {
        state.repositories.delete(sourceId)
        delete draft.createdSourceRepositoryId
      }
      draft.creationExecutions = []
      draft.phase = 'planned'
      delete draft.createdApplicationStackId
      delete draft.createdApplicationId
      delete draft.validatedCreationPlanFingerprint
      draft.updatedAt = stamp()
      return json(mutation('ApplicationDraft', draft.id, draft))
    },
  ],
  ['POST', new RegExp(`^${P}/application-drafts/([^/]+)/implementation-runs$`), async (m, request) => {
    const draft = state.drafts.get(m[2]!)
    if (!draft) return error(404, 'not_found', 'application draft not found')
    if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot implement applications')
    const proposal = draft.proposalId ? state.proposals.get(draft.proposalId) : undefined
    if (proposal && (proposalWaiting(proposal.phase) || proposalTerminal(proposal.phase))) return error(409, 'conflict', 'proposal is awaiting review or is closed')
    const handoff = draft.creationPlan?.implementationHandoff
    if (draft.phase !== 'created' || !draft.createdApplicationId || !handoff?.tasks.length) return error(412, 'failed_precondition', 'created application and handoff tasks are required')
    const previous = draft.implementationRuns?.at(-1)
    if (previous?.status === 'pending' || previous?.status === 'running') return error(409, 'conflict', 'implementation run is running')
    if (!state.codexAvailable) return codexUnavailable('implementation runtime is not available')
    const text = await request.text()
    const parsed = CreateApplicationDraftImplementationRunRequest.safeParse(text ? JSON.parse(text) : {})
    if (!parsed.success) return error(400, 'invalid_argument', 'invalid implementation request')
    const body = parsed.data
    const ids = handoff.tasks.map((task, index) => implementationTodoId(task.title, index))
    for (const selected of [body.taskIds ?? [], body.skipTaskIds ?? [], body.change ? [body.change.taskId] : []]) {
      if (new Set(selected).size !== selected.length || selected.some((id) => !ids.includes(id))) return error(400, 'invalid_argument', 'task IDs must be unique handoff task IDs')
    }
    if (body.skipTaskIds?.some((id) => body.taskIds?.includes(id) || body.change?.taskId === id)) return error(400, 'invalid_argument', 'a task cannot be selected and skipped')
    const taskIds: string[] = []
    const tasks: ApplicationDraftImplementationTask[] = handoff.tasks.map((definition, index) => {
      const id = ids[index]!
      const prior = previous?.tasks.find((task) => task.id === id)
      const status = prior?.status === 'done' || prior?.status === 'skipped' ? prior.status : 'pending'
      if (body.skipTaskIds?.includes(id)) return { ...prior, id, title: definition.title, status: 'skipped' }
      const selected = body.change ? body.change.taskId === id : body.taskIds ? body.taskIds.includes(id) : status === 'pending'
      if (!selected) return { ...prior, id, title: definition.title, status }
      taskIds.push(id)
      return { id, title: definition.title, status: 'pending', message: body.change?.message ?? prior?.message }
    })
    const run: ApplicationDraftImplementationRun = { id: nextId('impl'), status: 'pending', startedAt: stamp(), devWorkspaceId: draft.implementationWorkspaceId ?? '', taskIds, tasks }
    if (state.implementationRun.interruptSecondTask) {
      if (taskIds[1]) state.interruptedRuns.set(run.id, taskIds[1])
      state.implementationRun.interruptSecondTask = false
    }
    draft.implementationRuns = [...(draft.implementationRuns ?? []).slice(-19), run]
    return json({ run, resource: run, operation: operation('ApplicationDraftImplementationRun', run.id) }, 202)
  }],
  ['GET', new RegExp(`^${P}/application-drafts/([^/]+)/implementation-runs/([^/]+)$`), (m) => {
    const draft = state.drafts.get(m[2]!)
    if (draft && state.implementationRun.autoAdvance) advanceImplementation(draft)
    const run = draft?.implementationRuns?.find((item) => item.id === m[3])
    return run ? json(run) : error(404, 'not_found', 'implementation run not found')
  }],
  ['POST', new RegExp(`^${P}/application-drafts/([^/]+)/implementation-runs/([^/]+)/cancel$`), (m) => {
    const run = state.drafts.get(m[2]!)?.implementationRuns?.find((item) => item.id === m[3])
    if (!run) return error(404, 'not_found', 'implementation run not found')
    if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot cancel implementation')
    if (run.status === 'pending' || run.status === 'running') Object.assign(run, { status: 'cancelled', finishedAt: stamp() })
    state.interruptedRuns.delete(run.id)
    return json({ run, resource: run, operation: operation('ApplicationDraftImplementationRun', run.id) }, 202)
  }],
  [
    'POST',
    new RegExp(`^${P}/application-drafts/([^/]+)/creation-plan-generations$`),
    (m) => {
      const draft = state.drafts.get(m[2]!)
      if (!draft) return error(404, 'not_found', 'application draft not found')
      if (draft.kind === 'improvement') return error(412, 'failed_precondition', 'improvement drafts do not generate creation plans')
      if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot generate plans')
      if (!draft.creationPlanGenerations?.length && state.planGeneration.priorGenerations) {
        draft.creationPlanGenerations = Array.from({ length: state.planGeneration.priorGenerations }, () => ({
          id: nextId('gen'), status: 'failed' as const, startedAt: stamp(), devWorkspaceId: 'mock-workspace', error: 'previous generation failed',
        }))
      }
      if ((draft.creationPlanGenerations?.length ?? 0) >= 20) return error(409, 'conflict', 'plan generation limit 20 reached')
      if (draft.creationPlanGenerations?.some((item) => item.status === 'pending' || item.status === 'running')) return error(409, 'conflict', 'plan generation is in progress')
      if (draft.conversationTurns?.some((item) => item.status === 'pending' || item.status === 'running')) return error(409, 'conflict', 'conversation turn is in progress')
      if (!state.codexAvailable) return codexUnavailable('plan generation runtime is not available')
      draft.devWorkspaceId ??= nextId('ws')
      const generation = { id: nextId('gen'), status: 'pending' as const, stage: 'workspace' as const, startedAt: stamp(), devWorkspaceId: draft.devWorkspaceId }
      state.generationOutcomes.set(generation.id, { outcome: state.planGeneration.outcome, error: state.planGeneration.error, publish: state.planGeneration.publish })
      draft.creationPlanGenerations = [...(draft.creationPlanGenerations ?? []), generation]
      draft.phase = 'planning'
      return json(mutation('ApplicationDraftCreationPlanGeneration', generation.id, generation), 202)
    },
  ],
  [
    'GET',
    new RegExp(`^${P}/application-drafts/([^/]+)/creation-plan-generations/([^/]+)$`),
    (m) => {
      const draft = state.drafts.get(m[2]!)
      if (draft && state.planGeneration.autoAdvance) advanceDraft(draft)
      const generation = draft?.creationPlanGenerations?.find((item) => item.id === m[3])
      return generation ? json(generation) : error(404, 'not_found', 'plan generation not found')
    },
  ],
  ['POST', new RegExp(`^${P}/application-drafts/([^/]+)/conversation-turns$`), async (m, request) => {
    const draft = state.drafts.get(m[2]!)
    if (!draft) return error(404, 'not_found', 'application draft not found')
    if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot create conversation turns')
    const proposal = draft.proposalId ? state.proposals.get(draft.proposalId) : undefined
    if (proposal && (proposalWaiting(proposal.phase) || proposalTerminal(proposal.phase))) return error(409, 'conflict', 'proposal is awaiting review or is closed')
    const parsed = CreateApplicationDraftConversationTurnRequest.safeParse(await request.json())
    if (!parsed.success) return error(400, 'invalid_argument', parsed.error.issues[0]?.message ?? 'invalid conversation turn')
    const kind = parsed.data.kind ?? 'conversation'
    const message = parsed.data.message || (kind === 'excel-analysis' && (draft.source?.workbooks.length ?? 0) > 1 ? designTextJa.requestMany : excelTextJa.analysis.request)
    const key = request.headers.get('Idempotency-Key')
    const replayKey = key ? `${draft.id}:${key}` : undefined
    const replay = replayKey ? state.turnReplays.get(replayKey) : undefined
    if (replay && (replay.userMessage !== message || replay.kind !== kind)) return error(409, 'conflict', 'Idempotency-Key was already used with a different request')
    if (replay) return turnMutation(draft, replay)
    if (draft.createdApplicationId && kind !== 'conversation') return error(409, 'conflict', 'application draft Excel analysis and UI design are unavailable after application creation', { reason: 'ApplicationCreated' })
    if (draft.conversationTurns?.some((item) => item.status === 'pending' || item.status === 'running') || draft.creationPlanGenerations?.some((item) => item.status === 'pending' || item.status === 'running')) return error(409, 'conflict', 'application draft conversation turn or plan generation is running')
    if ((draft.conversationTurns?.length ?? 0) >= 50) return error(412, 'failed_precondition', 'application draft has reached 50 conversation turns')
    if (!state.codexAvailable) return codexUnavailable('application draft conversation is not available')
    if (kind === 'excel-analysis' && !draft.source?.workbooks.length) return error(412, 'failed_precondition', 'application draft workbook is required for Excel analysis', { reason: 'WorkbookMissing' })
    // Improvement turns read the app's own code: they run in its application workspace.
    const devWorkspaceId = draft.kind === 'improvement' ? ensureApplicationWorkspace(draft, stamp()) : (draft.devWorkspaceId ??= nextId('ws'))
    if (draft.kind === 'improvement') Object.assign(draft, { devWorkspaceId, activeWorkspaceId: devWorkspaceId })
    const turn: ApplicationDraftConversationTurn = { id: nextId('turn'), kind, status: 'pending', startedAt: stamp(), devWorkspaceId, userMessage: message }
    if (kind === 'excel-analysis') {
      let firstUnread = true
      turn.excelProgress = {
        stage: 'reading',
        workbooks: draft.source!.workbooks.map((workbook) => {
          const reused = state.workbooks.get(draft.id)?.get(workbook.id)?.reading !== undefined
          const workbookState = reused ? 'reused' : firstUnread ? 'reading' : 'pending'
          if (!reused) firstUnread = false
          return { workbookId: workbook.id, state: workbookState }
        }),
      }
    }
    draft.conversationTurns = [...(draft.conversationTurns ?? []), turn]
    if (replayKey) state.turnReplays.set(replayKey, turn)
    return turnMutation(draft, turn)
  }],
  ['GET', new RegExp(`^${P}/application-drafts/([^/]+)/conversation-turns/([^/]+)$`), (m) => {
    const draft = state.drafts.get(m[2]!)
    if (draft) settleImprovement(draft)
    if (draft && state.planGeneration.autoAdvance) advanceDraft(draft)
    const turn = draft?.conversationTurns?.find((item) => item.id === m[3])
    return turn ? json(turn) : error(404, 'not_found', 'application draft conversation turn not found')
  }],
  [
    'POST',
    new RegExp(`^${P}/application-drafts/([^/]+)/creation-plan-validations$`),
    (m) => {
      const draft = state.drafts.get(m[2]!)
      if (!draft) return error(404, 'not_found', 'application draft not found')
      if (draft.kind === 'improvement') return error(412, 'failed_precondition', 'improvement drafts do not validate creation plans')
      const appName = draft.creationPlan?.applicationStackRequest?.application?.name ?? draft.creationPlan?.applicationStackRequest?.applicationName
      const request = draft.creationPlan?.applicationSourceRepositoryRequest
      const name = request?.destination?.repositoryName
      const record = draftSourceRecord(draft)
      const source = record ? state.repositories.get(record.sourceRepositoryId) : undefined
      const reuseProblem = source && source.status !== 'ready' ? `SourceRepository ${source.id} is not ready for reuse.` : undefined
      const collision = name && state.githubRepositoryNames.has(name) && !source && !record?.repository
        ? `name already exists: ${name}: GitHub repository acme/${name} already exists. Choose a different repository name.`
        : undefined
      const problem = !draft.creationPlan ? 'creationPlan is required' : nameProblem(appName) ?? reuseProblem ?? collision ?? publishProblem(draft.creationPlan.applicationStackRequest?.publish)
      const validation = problem
        ? { valid: false, message: problem, staticErrors: [problem] }
        : { valid: true, message: record ? `Existing repository ${record.repositoryName} created by this draft will be ${source ? 'reused' : 'adopted by a new SourceRepository'}.` : 'ok', creationPlanFingerprint: `fp-${draft.id}` }
      if (!problem) draft.validatedCreationPlanFingerprint = `fp-${draft.id}`
      return json(mutation('ApplicationDraftCreationPlanValidation', draft.id, validation))
    },
  ],
  [
    'POST',
    new RegExp(`^${P}/application-drafts/([^/]+)/creation-executions$`),
    async (m, request) => {
      if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot create applications')
      const draft = state.drafts.get(m[2]!)
      if (!draft) return error(404, 'not_found', 'application draft not found')
      if (draft.kind === 'improvement') return error(412, 'failed_precondition', 'improvement drafts do not run creation executions')
      const body = (await request.json()) as { clientRequestId?: string; creationPlanFingerprint?: string }
      if (!body.clientRequestId || body.creationPlanFingerprint !== draft.validatedCreationPlanFingerprint) {
        return error(409, 'conflict', 'the creation plan changed since it was validated')
      }
      // Like platform-api handler/application_draft.go:1246-1250: 202 for a new execution, 200 for a replay of its clientRequestId.
      const replay = draft.creationExecutions.some((item) => item.clientRequestId === body.clientRequestId)
      if (!replay) {
        const tools = creationTools().sequences[0]!.tools.filter((tool) => draft.creationPlan?.applicationSourceRepositoryRequest || !tool.startsWith('appthrust.applicationSourceRepository.'))
        const steps = tools.map((tool, index) => ({
          id: `step-${index + 1}`,
          tool,
          status: 'pending' as const,
        }))
        draft.creationExecutions.push({
          id: nextId('exec'),
          clientRequestId: body.clientRequestId,
          attempt: draft.creationExecutions.length + 1,
          status: 'running',
          startedAt: stamp(),
          steps,
          approval: {
            creationPlanFingerprint: body.creationPlanFingerprint,
            applicationSourceRepositoryRequest: structuredClone(draft.creationPlan?.applicationSourceRepositoryRequest),
            applicationStackRequest: structuredClone(draft.creationPlan?.applicationStackRequest),
            toolPlan: structuredClone(draft.creationPlan?.toolPlan),
            implementationHandoff: structuredClone(draft.creationPlan?.implementationHandoff),
          },
        })
        draft.phase = 'creating'
      }
      return json(mutation('ApplicationDraft', draft.id, draft), replay ? 200 : 202)
    },
  ],
  [
    'POST',
    new RegExp(`^${P}/application-drafts/([^/]+)/creation-executions/([^/]+)/run$`),
    (m) => {
      const draft = state.drafts.get(m[2]!)
      const execution = draft?.creationExecutions.find((item) => item.id === m[3])
      if (!draft || !execution) return error(404, 'not_found', 'creation execution not found')
      execution.runStartedAt ??= stamp()
      return json(mutation('ApplicationDraft', draft.id, draft), 202)
    },
  ],
  ['GET', new RegExp(`^${P}/application-stacks$`), () => json(list([...state.stacks.values()].map(toStack)))],
  [
    'GET',
    new RegExp(`^${P}/application-stacks/([^/]+)$`),
    (m) => {
      const stack = state.stacks.get(m[2]!)
      return stack ? json(toStack(stack)) : error(404, 'not_found', 'stack not found')
    },
  ],
  [
    'POST',
    new RegExp(`^${P}/application-stacks/validate$`),
    async (_, request) => {
      const body = stackBody(await request.json())
      const name = body?.application?.name
      const resolvedBranch = { applicationId: name ?? 'x', branchId: 'production', management: { source: 'applicationStack', mutableFields: [] }, state: 'pending' }
      const ok = { valid: true, message: 'ok' }
      const section = (problem: string | undefined) => (problem ? { valid: false, message: problem } : ok)
      // Mirrors the platform: a sample-image source needs a ready registry. The one-shot toggle forces it.
      const registryMissing = state.rejectNextValidation || (body?.source.kind === 'sample-image' && !state.registryConnected)
      state.rejectNextValidation = false
      const source = section(
        registryMissing ? 'sample-image ApplicationStack source requires a ready credentialed ContainerRepository' : undefined
      )
      const runtime = section(!body ? 'invalid request' : nameProblem(name))
      const publish = section(body ? publishProblem(body.publish) : undefined)
      const valid = source.valid && runtime.valid && publish.valid
      return json({
        valid,
        message: valid ? 'ok' : 'Launch needs changes before resources can be created.',
        source,
        runtime,
        publish,
        resolvedBranch,
      })
    },
  ],
  [
    'POST',
    new RegExp(`^${P}/application-stacks$`),
    async (_, request) => {
      if (state.role === 'Viewer') return error(403, 'forbidden', 'team role Viewer cannot create applications')
      const body = stackBody(await request.json())
      const name = body?.application?.name
      const problem = !body ? 'invalid request' : nameProblem(name)
      if (problem || !body || !name) return error(409, 'conflict', problem ?? 'invalid')
      const injected = state.stackConflicts.findIndex((conflict) => !conflict.appName || conflict.appName === name)
      if (injected !== -1) {
        const { message, reason } = state.stackConflicts.splice(injected, 1)[0]!
        return error(409, 'conflict', message, reason ? { reason } : undefined)
      }
      const source = body.source
      const repository = source.kind === 'application-source-repository' ? state.repositories.get(source.sourceRepositoryId) : undefined
      const stack = newStack(name, {
        templateId: body.templateId,
        sourceKind: source.kind,
        host: publishHost(body, name),
        publishPath: body.publish?.path ?? '/',
        ...(source.kind === 'application-source-repository'
          ? {
              sourceRepositoryId: source.sourceRepositoryId,
              ...(repository ? { imageRef: `${repository.image.imagePath}:${repository.image.tagFilter ?? ''}` } : {}),
            }
          : { imageRef: 'imageRef' in source ? source.imageRef : '', sourceKind: 'sample-image' as const }),
      })
      state.stacks.set(stack.id, stack)
      const resource = { ...toStack(stack), applicationId: name, branchId: 'production', branch: { applicationId: name, branchId: 'production', management: { source: 'applicationStack', mutableFields: [] }, state: 'pending' } }
      return json(mutation('ApplicationStack', stack.id, resource), 202)
    },
  ],
  [
    'DELETE',
    new RegExp(`^${P}/application-source-repositories/([^/]+)$`),
    (m) => {
      const repository = state.repositories.get(m[2]!)
      if (!repository) return error(404, 'not_found', 'source repository not found')
      const referencing = [...state.stacks.values()].filter((stack) => stack.sourceRepositoryId === repository.id).map((stack) => stack.id)
      if (referencing.length > 0) {
        return error(409, 'conflict', 'source repository is referenced by an application stack', { reason: 'referenced_by_stack', stackIds: referencing })
      }
      // Like the platform, the GitHub repository itself stays (its name remains taken).
      state.repositories.delete(repository.id)
      return json(mutation('ApplicationSourceRepository', repository.id, repository), 202)
    },
  ],
  [
    'DELETE',
    new RegExp(`^${P}/application-stacks/([^/]+)$`),
    (m) => {
      const stack = state.stacks.get(m[2]!)
      if (!stack) return error(404, 'not_found', 'stack not found')
      // Like the platform, the source repository binding stays until it is deleted on its own.
      state.stacks.delete(stack.id)
      return json(mutation('ApplicationStack', stack.id, { id: stack.id, deleted: true }), 202)
    },
  ],
  [
    'GET',
    new RegExp(`^${P}/applications$`),
    () => json(list([...state.stacks.values()].filter((stack) => stack.stage > 0).map(toApplication))),
  ],
  [
    'GET',
    new RegExp(`^${P}/publishes$`),
    () => json(list([...state.stacks.values()].filter((stack) => stack.stage > 0 && stack.host).map(toPublish))),
  ],
  [
    'POST',
    new RegExp(`^${P}/publishes$`),
    async (_, request) => {
      if (state.role === 'Viewer') return error(403, 'forbidden', 'Team Editor is required')
      const body = await request.json() as { applicationId: string; branchId: string; componentId: string; destination: { type: string }; customDomain?: string; hostnamePattern?: 'wildcard' | 'apex'; subdomain?: string; idempotencyKey?: string }
      const stack = state.stacks.get(body.applicationId)
      if (!stack || body.branchId !== 'production' || body.componentId !== webId(stack)) return error(404, 'not_found', 'production web component not found')
      const problem = publishProblem({ enabled: true, customDomain: body.customDomain, hostnamePattern: body.hostnamePattern, subdomain: body.subdomain }, stack.id)
      // Like the platform: another publish holding the URL is 409 publish_url_conflict.
      if (problem === PUBLISH_URL_TAKEN) return error(409, 'conflict', 'publish endpoint is already owned by another publish', { reason: 'publish_url_conflict' })
      if (body.destination?.type !== 'gateway' || problem) return error(400, 'invalid_argument', problem ?? 'gateway destination is required')
      stack.host = body.hostnamePattern === 'wildcard' ? `${body.subdomain}.${body.customDomain}` : body.customDomain!
      // Like the platform (internal/handler/publish.go:1631): 202 with the mutation envelope.
      const publish = toPublish(stack)
      return json(mutation('HTTPPublish', publish.id, publish), 202)
    },
  ],
  [
    'PUT',
    new RegExp(`^${P}/publishes/([^/]+)/access$`),
    async (m, request) => {
      if (state.accessForbidden || state.role === 'Viewer') return error(403, 'forbidden', 'Team Editor is required')
      const stack = [...state.stacks.values()].find((item) => webId(item) === m[2] && item.stage > 0)
      if (!stack) return error(404, 'not_found', 'publish not found')
      const key = request.headers.get('Idempotency-Key')
      if (!key) return error(400, 'invalid_argument', 'Idempotency-Key is required')
      const replay = state.accessReplays.get(`${m[2]}:${key}`)
      if (replay) return json(replay)
      const body = await request.json() as PublishAccessRequest
      if (!['Public', 'Authenticated'].includes(body.mode) || (body.externalAuthorization && (body.mode !== 'Authenticated' || body.externalAuthorization.appInstallation !== 'builder-console'))) return error(400, 'invalid_argument', 'invalid access request')
      const value: PublishAccess = {
        mode: body.mode,
        ...(body.mode === 'Authenticated' ? { authorization: { defaultAction: 'Allow', ruleCount: 0, ...(body.externalAuthorization ? { external: { appInstallation: 'builder-console', path: '/authz' } } : {}) } } : {}),
        pending: { reason: 'PolicyReferencesPending', message: 'Waiting for policy application' },
      }
      state.access.set(m[2]!, { value, pendingReads: 1 })
      // Stable channel W mutations answer with the public operation envelope.
      const envelope = {
        ...value,
        resource: value,
        operation: {
          id: `publish-access-${m[2]}-${key}`, type: 'publish.access.update', state: 'succeeded', writeChannel: 'W',
          resource: { kind: 'HTTPPublish', id: m[2], projectId: m[1] }, idempotencyKey: key, replayed: false,
          createdAt: stamp(), links: { self: `/api/v1/projects/${m[1]}/publishes/${m[2]}/access` },
        },
      }
      state.accessReplays.set(`${m[2]}:${key}`, envelope)
      return json(envelope)
    },
  ],
  [
    'GET',
    new RegExp(`^${P}/publishes/([^/]+)/access$`),
    (m) => {
      const stack = [...state.stacks.values()].find((item) => webId(item) === m[2] && item.stage > 0)
      return stack ? json(toPublish(stack).access) : error(404, 'not_found', 'publish not found')
    },
  ],
  [
    'GET',
    new RegExp(`^${P}/component-summaries$`),
    () => json({ items: [...state.stacks.values()].filter((stack) => stack.stage > 0).flatMap(toSummaries) }),
  ],
  [
    'GET',
    new RegExp(`^${P}/applications/([^/]+)/releases$`),
    (m) => {
      const stack = state.stacks.get(m[2]!)
      return stack ? json(toOverview(stack)) : error(404, 'not_found', 'application not found')
    },
  ],
  [
    'GET',
    new RegExp(`^${APP_COMPONENT}/release-state$`),
    (m) => {
      const stack = state.stacks.get(m[2]!)
      return stack ? json(toReleaseState(stack)) : error(404, 'not_found', 'application not found')
    },
  ],
  [
    'POST',
    new RegExp(`^${APP_COMPONENT}/rollback$`),
    async (m, request) => {
      const stack = state.stacks.get(m[2]!)
      const body = (await request.json()) as { targetTransitionId?: string }
      const target = stack?.releases.find((item) => item.transitionId === body.targetTransitionId && item.phase === 'Succeeded')
      if (!stack || !target) return error(404, 'not_found', 'rollback target not found')
      stack.releases.push({ ...release(target.version, 'Succeeded', stamp()), transitionId: target.transitionId })
      stack.broken = false
      const response = {
        projectId: MOCK_PROJECT_ID,
        applicationId: stack.appName,
        branchId: 'production',
        componentId: webId(stack),
        transitionId: `tr-rollback-${Date.now()}`,
        targetTransitionId: target.transitionId,
        targetImageTag: target.version,
        targetImageDigest: digest(target.version),
      }
      return json(mutation('ComponentRollback', response.transitionId, response), 202)
    },
  ],
  [
    'GET',
    new RegExp(`^${APP_COMPONENT}/env-vars$`),
    (m) => {
      const stack = state.stacks.get(m[2]!)
      if (!stack) return error(404, 'not_found', 'application not found')
      // Go writes the revision on every read (platform-api internal/api/dto_component.go:685).
      return json({ projectId: MOCK_PROJECT_ID, applicationId: stack.appName, branchId: m[3], componentId: m[4], revision: envRevision(stack.env), variables: stack.env })
    },
  ],
  [
    'PUT',
    new RegExp(`^${APP_COMPONENT}/env-vars$`),
    async (m, request) => {
      const stack = state.stacks.get(m[2]!)
      if (!stack) return error(404, 'not_found', 'application not found')
      const body = (await request.json()) as { variables: Array<{ key: string; value?: string; sensitive: boolean }> }
      const previous = stack.env
      stack.env = [
        ...previous.filter((entry) => entry.source === 'generated'),
        ...body.variables.map((variable) => ({
          key: variable.key,
          state: 'configured' as const,
          source: 'user' as const,
          sensitive: variable.sensitive,
          // Sensitive values are write-only; a retained secret is sent without a value.
          ...(variable.sensitive ? {} : { value: variable.value ?? previous.find((entry) => entry.key === variable.key)?.value ?? '' }),
          updatedAt: stamp(),
        })),
      ]
      const resource = { projectId: MOCK_PROJECT_ID, applicationId: stack.appName, branchId: m[3]!, componentId: m[4]!, revision: envRevision(stack.env), variables: stack.env }
      // 202 like platform-api internal/handler/application_branch_config.go:295,301.
      return json(mutation('ApplicationBranchComponentConfig', m[4]!, resource), 202)
    },
  ],
  [
    'GET',
    new RegExp(`^${P}/components/([^/]+)/logs$`),
    (m) => {
      const stack = [...state.stacks.values()].find((item) => webId(item) === m[2])
      if (!stack) return error(404, 'not_found', 'component not found')
      const scenario = state.logs.get(m[2]!)
      if (scenario) {
        scenario.requests++
        if (scenario.status !== 200) return error(scenario.status, scenario.status === 403 ? 'forbidden' : 'internal_error', 'mock log read unavailable')
      }
      const lines = stack.broken
        ? ['> next start', 'ready - started server on 0.0.0.0:3000', 'Error: DATABASE_URL の接続に失敗しました', 'process exited with code 1']
        : ['> next start', 'ready - started server on 0.0.0.0:3000', 'GET / 200 in 41ms', 'GET /api/health 200 in 3ms']
      return json({
        clusterId: 'mock',
        namespace: MOCK_PROJECT_ID,
        service: webId(stack),
        pods: [{ name: `${webId(stack)}-0`, phase: 'Running', ready: !stack.broken, containers: ['web'] }],
        containers: ['web'],
        lines: lines.map((text, index) => ({ timestamp: minutesAgo(lines.length - index), text })),
        fetchedAt: stamp(),
      })
    },
  ],
  // ---- app data (read): データ tab; one 備品在庫 catalog answers for every `<app>-db` (./mock-database-data.ts)
  [
    'POST',
    /^\/api\/v1\/__mock\/data$/,
    async (_, request) => {
      const body = (await request.json()) as { mode?: DataMode }
      const modes: DataMode[] = ['ok', 'forbidden', 'suspended', 'unsupported', 'empty', 'subject-unbound', 'not-persisted']
      if (body.mode && modes.includes(body.mode)) dataState.mode = body.mode
      return json({ mode: dataState.mode })
    },
  ],
  ['GET', new RegExp(`^${P}/databases/([^/]+)/schema/tables$`), (m) => dataRead(m[2]!, () =>
    json(list(dataState.mode === 'empty' ? [] : [...dataState.tables.values()].map(({ schema }) => ({ schema: schema.schema, name: schema.name, type: 'table_or_view' })))))],
  ['GET', new RegExp(`^${P}/databases/([^/]+)/schema/tables/([^/]+)/([^/]+)$`), (m) => dataRead(m[2]!, () => {
    const table = findTable(decodeURIComponent(m[3]!), decodeURIComponent(m[4]!))
    if (!table || dataState.mode === 'empty') return error(404, 'not_found', 'table not found')
    return json({ ...table.schema, rowCountEstimate: table.rows.length, fetchedAt: stamp() })
  })],
  ['GET', new RegExp(`^${P}/databases/([^/]+)/tables/([^/]+)/([^/]+)/rows$`), (m, _, url) => dataRead(m[2]!, () => {
    const table = findTable(decodeURIComponent(m[3]!), decodeURIComponent(m[4]!))
    if (!table || dataState.mode === 'empty') return error(404, 'not_found', 'table not found')
    const orderBy = url.searchParams.get('orderBy') || undefined
    if (orderBy && !table.schema.columns.some((column) => column.name === orderBy)) return error(400, 'invalid_argument', `unknown column '${orderBy}'`)
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    const direction = url.searchParams.get('direction') === 'desc' ? 'desc' : 'asc'
    return json(selectRows(table, { limit, offset, orderBy, direction, q: url.searchParams.get('q') ?? undefined }))
  })],
  // ---- app data (write): row create/update/delete and `__mock/data-write` (./mock-database-rows.ts)
  ...dataWriteRoutes({
    role: () => state.role,
    hasDatabase: (databaseId) => [...state.stacks.values()].some((stack) => dbId(stack) === databaseId),
    operation,
  }),
  // ---- database changes: the overview's 「データベースの変更」 (features/app/database-changes.tsx)
  ['GET', new RegExp(`^${P}/databases/([^/]+)/changes$`), (m) => {
    const blocked = databaseChangesBlocked(m[2]!)
    if (blocked) return blocked
    const changes = state.databaseChanges.get(m[2]!) ?? []
    // Serialized before the run: a just-approved change is reported ReadyToRun once, then Succeeded.
    const response = json(list(changes))
    applyReadyDatabaseChanges(changes)
    return response
  }],
  ['POST', new RegExp(`^${P}/databases/([^/]+)/changes/([^/]+)/approvals$`), async (m, request) => {
    const change = databaseChangeFor(m[2]!, m[3]!)
    if (change instanceof Response) return change
    if (state.role === 'Viewer') return error(403, 'forbidden', 'approving database changes requires the Editor role')
    if (change.phase !== 'AwaitingApproval') return error(409, 'conflict', `database change is ${change.phase}, not AwaitingApproval`)
    const { decision, reason } = (await request.json()) as { decision?: string; reason?: string }
    if (decision !== 'Approved' && decision !== 'Rejected') return error(400, 'invalid_argument', "'decision' must be Approved or Rejected")
    const approvals = change.approvals ?? []
    const approval = change.approval ?? { requiredCount: 1, approvedCount: 0 }
    Object.assign(change, {
      phase: decision === 'Approved' ? 'ReadyToRun' : 'Rejected',
      approvals: [...approvals, { id: `${change.id}-a${approvals.length + 1}`, decision, approver: 'yamada@acme.example', ...(reason ? { reason } : {}), createdAt: stamp() }],
      approval: decision === 'Approved' ? { ...approval, approvedCount: approval.approvedCount + 1 } : { ...approval, rejected: true },
    } satisfies Partial<DatabaseChange>)
    return json(mutation('DatabaseChange', change.id, change), 201)
  }],
  ['POST', new RegExp(`^${P}/databases/([^/]+)/changes/([^/]+)/retry$`), (m) => {
    const change = databaseChangeFor(m[2]!, m[3]!)
    if (change instanceof Response) return change
    if (state.role === 'Viewer') return error(403, 'forbidden', 'retrying database changes requires the Editor role')
    if (change.phase !== 'Failed' || change.latestRun?.retryable !== true) return error(409, 'conflict', 'database change has no retryable failed run')
    change.phase = 'ReadyToRun'
    return json(mutation('DatabaseChange', change.id, change), 202)
  }],
]

/** Every data route: an unknown database is 404, then the `__mock/data` mode decides before `serve`. */
function dataRead(databaseId: string, serve: () => Response): Response {
  if (![...state.stacks.values()].some((stack) => dbId(stack) === databaseId)) return error(404, 'not_found', 'database not found')
  const failure = dataModeFailure()
  return failure ? error(failure.status, failure.code, failure.message, failure.details) : serve()
}

/**
 * Change routes: an unknown database is 404; the `__mock/data` mode `forbidden` answers 403 like the data reads,
 * and `subject-unbound` / `not-persisted` the same 412 database_access_membership_unbound.
 */
function databaseChangesBlocked(databaseId: string): Response | undefined {
  if (![...state.stacks.values()].some((stack) => dbId(stack) === databaseId)) return error(404, 'not_found', 'database not found')
  if (dataState.mode === 'forbidden') return error(403, 'forbidden', 'caller may not read database changes', { reason: 'forbidden' })
  const failure = dataState.mode === 'subject-unbound' || dataState.mode === 'not-persisted' ? dataModeFailure() : undefined
  return failure ? error(failure.status, failure.code, failure.message, failure.details) : undefined
}

function databaseChangeFor(databaseId: string, changeId: string): DatabaseChange | Response {
  const blocked = databaseChangesBlocked(databaseId)
  if (blocked) return blocked
  return state.databaseChanges.get(databaseId)?.find((change) => change.id === changeId) ?? error(404, 'not_found', 'database change not found')
}

/** Handles `/api/v1/*`; `undefined` means "not a mock-platform route". */
export async function platformRoutes(request: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith('/api/v1/')) return undefined
  for (const [method, pattern, handler] of routes) {
    if (method !== request.method) continue
    const match = pattern.exec(url.pathname)
    if (match) return handler(match, request, url)
  }
  return error(404, 'not_found', `mock platform has no route for ${request.method} ${url.pathname}`)
}
