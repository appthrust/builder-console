import { describe, expect, test } from 'bun:test'
import type {
  Application,
  ApplicationDraftImplementationRun,
  ApplicationRelease,
  ApplicationReleaseOverview,
  ApplicationStack,
  ComponentSummaryFactsV1,
  Publish,
  ReleasePhase,
} from '@appthrust/api-schema/platform-api'
import { copy } from '../copy'
import { appsInputOf, releaseOf, releaseStateOf, sourcesOf, type WireAppSources, type WireAppsInput } from '../api/testing/app-domain'
import { runOf, taskOf } from '../api/testing/build-domain'
import { isSourceBuildFailed } from '../features/app/platform'
import * as model from './app'
import { draftState, versionLabel, type AppBuildProgress, type ConsoleApp, type DraftPlatformState } from './app'

// Fixtures are wire literals; every model function under test sees only what the production readers make of them.
type ConsoleAppSources = WireAppSources
type ConsoleAppsInput = WireAppsInput
const deriveConsoleApp = (wire: WireAppSources) => model.deriveConsoleApp(sourcesOf(wire))
const deriveConsoleApps = (wire: WireAppsInput) => model.deriveConsoleApps(appsInputOf(wire))
const deriveAppView = (app: Parameters<typeof model.deriveAppView>[0], wire: WireAppsInput, now?: number, draftPlatform?: DraftPlatformState, build?: AppBuildProgress) =>
  model.deriveAppView(app, appsInputOf(wire), now, draftPlatform, build)
const implementedReleaseReady = (platform: ConsoleApp | undefined, releases: readonly unknown[], build: AppBuildProgress) =>
  model.implementedReleaseReady(platform, releases.map(releaseOf), build)
const appSecondLine = (platform: ConsoleApp, releases: readonly unknown[], now?: number, build?: AppBuildProgress) =>
  model.appSecondLine(platform, releases.map(releaseOf), now, build)
const deriveRollbackView = (wire: unknown) => model.deriveRollbackView(releaseStateOf(wire))
const repositoryFacts = (repository: { id: string; build?: { state?: string } }) => ({ id: repository.id, buildFailed: isSourceBuildFailed(repository) })

const application: Application = {
  id: 'shop',
  projectId: 'pj',
  name: 'shop',
  defaultBranchId: 'production',
  status: { phase: 'healthy', conditions: [] },
  sourceKind: 'applicationStack',
  sourceId: 'shop-stack',
  pendingSync: false,
}

const stack: ApplicationStack = {
  id: 'shop-stack',
  projectId: 'pj',
  templateId: 'nextjs-postgres',
  applicationName: 'shop',
  sourceKind: 'sample-image',
  applicationId: 'shop',
  branchId: 'production',
  webComponentId: 'shop-web',
  databaseComponentId: 'shop-db',
  pendingSync: false,
}

function summary(
  id: string,
  status: Pick<ComponentSummaryFactsV1, 'statusKey' | 'reasonKey'>
): ComponentSummaryFactsV1 {
  // The discriminated union pairs statusKey with reasonKey; fixtures pass valid pairs.
  const fact = { id, projectId: 'pj', applicationId: 'shop', name: id, kindKey: 'Container', pendingSync: false, ...status }
  return fact as ComponentSummaryFactsV1
}

const readyComponents = [
  summary('shop-web', { statusKey: 'Ready', reasonKey: 'ComponentReady' }),
  summary('shop-db', { statusKey: 'Ready', reasonKey: 'ComponentReady' }),
]

const succeededPublish: Publish = {
  id: 'shop-publish',
  projectId: 'pj',
  applicationId: 'shop',
  branchId: 'production',
  componentId: 'shop-web',
  publicUrl: 'https://shop.example.test/',
  phase: 'succeeded',
  pendingSync: false,
}

function release(phase: ReleasePhase, extra: Partial<ApplicationRelease> = {}): ApplicationRelease {
  return {
    id: `release-${phase.toLowerCase()}`,
    applicationId: 'shop',
    branchId: 'production',
    componentId: 'shop-web',
    version: '1.2.0',
    phase,
    environmentState: 'Present',
    rollbackEligible: true,
    createdAt: '2026-10-05T00:00:00.000Z',
    placements: [],
    conditions: [],
    canaryTasks: [],
    executionSteps: [],
    ...extra,
  }
}

function overview(latest: ApplicationRelease): ApplicationReleaseOverview {
  return {
    projectId: 'pj',
    applicationId: 'shop',
    branchId: 'production',
    generatedAt: '2026-10-05T00:00:00.000Z',
    summary: { components: 1, releases: 1, active: 0, pending: 0, inProgress: 0, waitingPromotion: 0, succeeded: 0, failed: 0, queued: 0 },
    components: [
      {
        id: 'shop-web',
        name: 'shop-web',
        canaries: [],
        latestRelease: latest,
        releases: [latest],
        queue: { applicationId: 'shop', branchId: 'production', componentId: 'shop-web', paused: false, acknowledged: true, releases: [] },
      },
    ],
    queues: [],
  }
}

function sources(overrides: Partial<ConsoleAppSources> = {}): ConsoleAppSources {
  return {
    application,
    stack,
    publishes: [succeededPublish],
    componentSummaries: readyComponents,
    releases: overview(release('Succeeded')),
    ...overrides,
  }
}

describe('AI build URL gate', () => {
  const template = release('Succeeded')
  const next = release('Succeeded', { id: 'screen-release', createdAt: '2026-10-05T00:10:00.000Z' })
  const build = { draftId: 'draft', initialReleaseId: template.id, taskCount: 3, tasks: [
    taskOf({ id: 'one', title: '顧客一覧', status: 'done' }),
    taskOf({ id: 'two', title: '見積の編集', status: 'running' }),
    taskOf({ id: 'three', title: 'PDF', status: 'pending' }),
  ] }
  const app = { stackId: stack.id, createdAt: '2026-10-05T00:00:00Z' }
  const input: ConsoleAppsInput = { applications: [application], stacks: [stack], publishes: [succeededPublish], componentSummaries: readyComponents, releasesByApplication: { shop: overview(template) } }

  test('the template is never a public app, even after the first task was pushed', () => {
    const view = deriveAppView(app, input, Date.now(), undefined, build)
    expect(view).toMatchObject({ label: '作っています', text: '作っています（画面 2/3）', platform: { statusText: '作っています（画面 2/3）' } })
    expect(view.url).toBeUndefined()
    expect(view.platform?.url).toBeUndefined()
    expect(appSecondLine(deriveConsoleApp(sources()), [template], Date.now(), build)).toBe('作っています（画面 2/3）')
  })

  test('a later successful web release and an actually pushed task are both required', () => {
    const platform = deriveConsoleApp(sources({ releases: overview(next) }))
    expect(implementedReleaseReady(platform, [template, next], build)).toBe(true)
    expect(implementedReleaseReady(platform, [template, next], { ...build, tasks: [taskOf({ id: 'one', title: '顧客一覧', status: 'skipped' })] })).toBe(false)
    expect(implementedReleaseReady({ ...platform, lastRelease: { ...platform.lastRelease!, phase: { kind: 'known', value: 'InProgress' } } }, [template, next], build)).toBe(false)
    const ready = deriveAppView(app, { ...input, releasesByApplication: { shop: overview(next) } }, Date.now(), undefined, build)
    expect(ready.url).toBe(succeededPublish.publicUrl)
    expect(ready.label).toBe('作っています')
    expect(ready.build).toEqual({ draftId: 'draft', phase: 'implementing' })
  })

  test('a tab without session evidence uses persisted tasks and two releases in the same branch', () => {
    const platform = deriveConsoleApp(sources({ releases: overview(next) }))
    const unknown = { draftId: 'draft', taskCount: 3, tasks: build.tasks }
    expect(implementedReleaseReady(platform, [next], unknown)).toBe(false)
    expect(implementedReleaseReady(platform, [template, next], unknown)).toBe(true)
    expect(implementedReleaseReady(platform, [{ ...template, componentId: 'shop-db' }, next], unknown)).toBe(false)
    expect(implementedReleaseReady(platform, [{ ...template, branchId: 'preview' }, next], unknown)).toBe(false)
    expect(deriveAppView(app, input, Date.now(), undefined, unknown).second).toBe('作っています（画面 2/3）')
    expect(implementedReleaseReady(platform, [template, next], { draftId: 'draft', taskCount: 3 })).toBe(false)
  })

  test('server run steps remain linked to the build even when a first screen is live', () => {
    const run: ApplicationDraftImplementationRun = {
      id: 'impl-1', status: 'running', devWorkspaceId: 'ws-1', startedAt: template.createdAt!, currentTaskId: 'two', step: 'working', taskIds: ['one', 'two'],
      tasks: [{ id: 'one', title: '顧客一覧', status: 'done' }, { id: 'two', title: '見積の編集', status: 'running' }],
    }
    const readyInput = { ...input, releasesByApplication: { shop: overview(next) } }
    for (const [status, step, text] of [
      ['running', 'working', '画面「見積の編集」を作っています'],
      ['running', 'pushing', '保存しています'],
      ['failed', 'working', '止まっています'],
      ['cancelled', 'working', '止まっています'],
    ] as const) {
      const progress = { ...build, run: runOf({ ...run, status, step }), tasks: run.tasks.map(taskOf) }
      expect(deriveAppView(app, readyInput, Date.now(), undefined, progress)).toMatchObject({
        second: text, url: succeededPublish.publicUrl, build: { draftId: 'draft', phase: 'implementing' },
      })
    }
    const tasks = run.tasks.map((task) => ({ ...task, status: 'done' as const }))
    expect(deriveAppView(app, readyInput, Date.now(), undefined, { ...build, tasks: tasks.map(taskOf), run: runOf({ ...run, tasks, status: 'succeeded' }) })).toMatchObject({
      label: '公開中', build: { draftId: 'draft', phase: 'done' },
    })
    expect(deriveAppView(app, readyInput, Date.now(), undefined, { ...build, run: runOf({ ...run, tasks: [{ ...run.tasks[1]!, title: 'Codex workspace' }] }) }).second).toBe('画面「アプリ」を作っています')
    const remaining = [{ ...run.tasks[0]!, status: 'done' as const }, { ...run.tasks[1]!, status: 'pending' as const }]
    expect(deriveAppView(app, readyInput, Date.now(), undefined, { ...build, tasks: remaining.map(taskOf), run: runOf({ ...run, status: 'succeeded', tasks: remaining }) })).toMatchObject({
      second: '止まっています', build: { draftId: 'draft', phase: 'implementing' },
    })
  })

  test('unknown run and task statuses stay building, never stopped, saving or finished', () => {
    const readyInput = { ...input, releasesByApplication: { shop: overview(next) } }
    for (const [status, taskStatus] of [['future-run-status', 'running'], ['succeeded', 'future-task-status']]) {
      const run = runOf({
        id: 'future-run', status, step: 'pushing', devWorkspaceId: 'workspace', startedAt: template.createdAt!, taskIds: ['screen'],
        tasks: [{ id: 'screen', title: '顧客一覧', status: taskStatus }],
      })
      const progress = { ...build, taskCount: 1, tasks: run.tasks, run }
      expect(appSecondLine(deriveConsoleApp(sources({ releases: overview(next) })), [template, next], Date.now(), progress)).toBe(copy.statusText.building(1, 1))
      expect(deriveAppView(app, readyInput, Date.now(), undefined, progress)).toMatchObject({
        label: '作っています', second: copy.statusText.building(1, 1),
        build: { draftId: 'draft', phase: 'implementing' },
      })
    }
  })

  test('known persisted completion and a live later release suffice despite an unknown run status', () => {
    const platform = deriveConsoleApp(sources({ releases: overview(next) }))
    const now = Date.parse(next.createdAt!)
    const wire = {
      id: 'future-run', status: 'future-run-status', devWorkspaceId: 'workspace', startedAt: template.createdAt!,
      taskIds: ['one', 'two'],
      tasks: [{ id: 'one', title: '顧客一覧', status: 'done' }, { id: 'two', title: '見積', status: 'skipped' }],
    }
    const run = runOf(wire)
    const progress = { ...build, taskCount: 2, tasks: run.tasks, run }
    expect(platform).toMatchObject({ status: 'live', url: succeededPublish.publicUrl })
    expect(appSecondLine(platform, [template, next], now, progress)).toBe(appSecondLine(platform, [template, next], now))
    expect(appSecondLine(platform, [template, next], now, progress)).toContain('v2')

    const unknownTaskRun = runOf({ ...wire, tasks: [wire.tasks[0], { ...wire.tasks[1], status: 'future-task-status' }] })
    expect(appSecondLine(platform, [template, next], now, { ...progress, tasks: unknownTaskRun.tasks, run: unknownTaskRun })).toBe(copy.statusText.building(2, 2))
  })
})

describe('deriveConsoleApp', () => {
  test('unresolved applications remain degraded cards without affecting healthy apps', () => {
    const unresolved: Application = {
      ...application, defaultBranchId: '',
      status: { phase: 'degraded', reason: 'default_branch_unresolved', conditions: [] },
    }
    const platform = deriveConsoleApp(sources({ application: unresolved }))
    expect(platform).toMatchObject({ id: 'shop', status: 'failed', statusText: copy.statusText.unresolved, branchId: '' })
    expect(platform.url).toBeUndefined()
    expect(deriveConsoleApp(sources()).status).toBe('live')
    for (const stacks of [[stack], []]) {
      const input: ConsoleAppsInput = {
        applications: [unresolved], stacks, publishes: [succeededPublish],
        componentSummaries: readyComponents, releasesByApplication: { shop: overview(release('Succeeded')) },
      }
      const view = deriveAppView({ stackId: stack.id, createdAt: '' }, input, Date.now(), undefined, { draftId: 'draft', taskCount: 1 })
      expect(view).toMatchObject({ status: 'failed', label: copy.status.failed, second: copy.statusText.unresolved })
      expect(view.url).toBeUndefined()
    }
  })

  test('live: all components ready, publish succeeded with URL, latest release succeeded', () => {
    const app = deriveConsoleApp(sources())
    expect(app.status).toBe('live')
    expect(app.statusText).toBe(copy.statusText.liveVersion('v1'))
    expect(copy.status[app.status]).toBe('公開中')
    expect(app.url).toBe('https://shop.example.test/')
    expect(app.lastRelease?.version).toBe('1.2.0')
    expect(app.webComponentId).toBe('shop-web')
    expect(app.stackId).toBe('shop-stack')
    expect(app.branchId).toBe('production')
    expect(app.facts).toEqual({
      webReady: true,
      webReleasePhase: 'Succeeded',
      everReleased: true,
      hasPublish: true,
      publishPhase: 'succeeded',
    })
  })

  test('live without a web release falls back to the plain sentence', () => {
    const app = deriveConsoleApp(sources({ releases: undefined }))
    expect(app.status).toBe('live')
    expect(app.statusText).toBe(copy.statusText.live)
  })

  test('live without publish intent says there is no URL', () => {
    const app = deriveConsoleApp(sources({ publishes: [] }))
    expect(app.status).toBe('live')
    expect(app.url).toBeUndefined()
    expect(app.statusText).toBe(copy.statusText.liveNoUrl)
  })

  test('deploying: a provisioning component explains its reasonKey', () => {
    const app = deriveConsoleApp(
      sources({
        componentSummaries: [
          summary('shop-web', { statusKey: 'Provisioning', reasonKey: 'PendingSync' }),
          readyComponents[1]!,
        ],
      })
    )
    expect(app.status).toBe('deploying')
    expect(app.statusText).toBe('変更を反映しています。')
  })

  test('deploying: latest release in progress', () => {
    const app = deriveConsoleApp(sources({ releases: overview(release('InProgress')) }))
    expect(app.status).toBe('deploying')
    expect(app.statusText).toBe(copy.statusText.releaseInProgress)
  })

  test('deploying: publish requested but not yet succeeded', () => {
    const app = deriveConsoleApp(
      sources({ publishes: [{ ...succeededPublish, phase: 'dns_propagating' }] })
    )
    expect(app.status).toBe('deploying')
    expect(app.statusText).toBe(copy.publishPhase.dns_propagating)
  })

  test('deploying: publish succeeded but no URL yet', () => {
    const { publicUrl: _omitted, ...withoutUrl } = succeededPublish
    const app = deriveConsoleApp(sources({ publishes: [withoutUrl] }))
    expect(app.status).toBe('deploying')
    expect(app.statusText).toBe(copy.statusText.publishUrlMissing)
  })

  test('publish list wins over the stack creation-time snapshot', () => {
    const app = deriveConsoleApp(
      sources({ stack: { ...stack, publish: { ...succeededPublish, phase: 'service_creating' } } })
    )
    expect(app.status).toBe('live')
  })

  test('failed: a blocked component', () => {
    const app = deriveConsoleApp(
      sources({
        componentSummaries: [
          summary('shop-web', { statusKey: 'Blocked', reasonKey: 'DeliveryBlocked' }),
          summary('shop-db', { statusKey: 'Provisioning', reasonKey: 'PendingSync' }),
        ],
      })
    )
    expect(app.status).toBe('failed')
    expect(app.statusText).toBe('新しい版の反映が止まっています。')
  })

  test('failed: an undeclared port says so in plain words and tells the user what to add', () => {
    const app = deriveConsoleApp(
      sources({
        componentSummaries: [
          summary('shop-web', { statusKey: 'Blocked', reasonKey: 'PortUnresolved' }),
          readyComponents[1]!,
        ],
        releases: undefined,
      })
    )
    expect(app.status).toBe('failed')
    expect(app.statusText).toBe('アプリがどの番号で待ち受けるか分かりません。')
    expect(app.help).toContain('EXPOSE')
    expect(app.statusText + app.help).not.toMatch(/ContainerInstance|Knative|probe|ポート/)
    expect(app.webPort).toBeUndefined()
  })

  test('a reason without a specific next action carries no help; the resolved web port is carried', () => {
    const app = deriveConsoleApp(
      sources({ componentSummaries: [{ ...readyComponents[0]!, port: 80 }, readyComponents[1]!] })
    )
    expect(app.help).toBeUndefined()
    expect(app.webPort).toBe(80)
  })

  test('failed: latest release failed, failureReason carried to lastRelease', () => {
    const app = deriveConsoleApp(
      sources({ releases: overview(release('Failed', { failureReason: 'image pull failed' })) })
    )
    expect(app.status).toBe('failed')
    expect(app.statusText).toBe(copy.statusText.releaseFailed)
    expect(app.lastRelease?.failureReason).toBe('image pull failed')
  })

  test('unknown: no application stack', () => {
    const app = deriveConsoleApp(sources({ stack: undefined }))
    expect(app.status).toBe('unknown')
    expect(copy.status[app.status]).toBe('停止中')
    expect(app.statusText).toBe(copy.statusText.noStack)
  })

  test('unknown: application deleting is stated explicitly', () => {
    const app = deriveConsoleApp(sources({ application: { ...application, deleting: true } }))
    expect(app.status).toBe('unknown')
    expect(app.statusText).toBe(copy.statusText.deleting)
  })

  test('unknown: no component facts cannot prove live', () => {
    const app = deriveConsoleApp(sources({ componentSummaries: [] }))
    expect(app.status).toBe('unknown')
    expect(app.statusText).toBe(copy.statusText.noComponents)
  })

  test('unknown: zero components wins over an in-flight release and a pending publish', () => {
    const app = deriveConsoleApp(
      sources({
        componentSummaries: [],
        releases: overview(release('InProgress')),
        publishes: [{ ...succeededPublish, phase: 'pod_waiting' }],
      })
    )
    expect(app.status).toBe('unknown')
    expect(app.statusText).toBe(copy.statusText.noComponents)
  })

  test('unknown: a component reasonKey=DeletionInProgress is stated as deleting', () => {
    const app = deriveConsoleApp(
      sources({
        componentSummaries: [
          summary('shop-web', { statusKey: 'Provisioning', reasonKey: 'DeletionInProgress' }),
          readyComponents[1]!,
        ],
      })
    )
    expect(app.status).toBe('unknown')
    expect(app.statusText).toBe(copy.statusText.deleting)
  })

  test('unknown: deletion wins over a blocked component and a failed release', () => {
    const app = deriveConsoleApp(
      sources({
        application: { ...application, deleting: true },
        componentSummaries: [summary('shop-web', { statusKey: 'Blocked', reasonKey: 'DeliveryBlocked' })],
        releases: overview(release('Failed')),
      })
    )
    expect(app.status).toBe('unknown')
    expect(app.statusText).toBe(copy.statusText.deleting)
  })

  test('unknown: statusKey=Unknown (DependencyUnavailable) is not deploying', () => {
    const app = deriveConsoleApp(
      sources({
        componentSummaries: [
          readyComponents[0]!,
          summary('shop-db', { statusKey: 'Unknown', reasonKey: 'DependencyUnavailable' }),
        ],
      })
    )
    expect(app.status).toBe('unknown')
    expect(app.statusText).toBe('連携先のサービスに接続できません。')
  })

  test('unknown: statusKey=Unknown (CanonicalStatusUnavailable) wins over a provisioning component', () => {
    const app = deriveConsoleApp(
      sources({
        componentSummaries: [
          summary('shop-web', { statusKey: 'Provisioning', reasonKey: 'PendingSync' }),
          summary('shop-db', { statusKey: 'Unknown', reasonKey: 'CanonicalStatusUnavailable' }),
        ],
      })
    )
    expect(app.status).toBe('unknown')
    expect(app.statusText).toBe('状態を取得できません。しばらくしてから確認してください。')
  })

  test('failed: a blocked component wins over an Unknown one', () => {
    const app = deriveConsoleApp(
      sources({
        componentSummaries: [
          summary('shop-web', { statusKey: 'Unknown', reasonKey: 'CanonicalStatusUnavailable' }),
          summary('shop-db', { statusKey: 'Blocked', reasonKey: 'DeliveryBlocked' }),
        ],
      })
    )
    expect(app.status).toBe('failed')
  })

  test('failed: publish phase=failed', () => {
    const app = deriveConsoleApp(sources({ publishes: [{ ...succeededPublish, phase: 'failed' }] }))
    expect(app.status).toBe('failed')
    expect(app.statusText).toBe(copy.publishPhase.failed)
  })

  test('latest release shows the web component only; a failed database release still fails the app', () => {
    const web = release('Succeeded', { id: 'web-1', version: '1.2.0', createdAt: '2026-10-05T00:00:00.000Z' })
    const db = release('Failed', {
      id: 'db-1',
      componentId: 'shop-db',
      version: '16.4',
      createdAt: '2026-10-05T01:00:00.000Z',
    })
    const base = overview(web)
    const dbComponent = { ...base.components[0]!, id: 'shop-db', name: 'shop-db', latestRelease: db, releases: [db] }
    const app = deriveConsoleApp(sources({ releases: { ...base, components: [...base.components, dbComponent] } }))
    expect(app.lastRelease?.id).toBe('web-1')
    expect(app.status).toBe('failed')
    expect(app.statusText).toBe(copy.statusText.releaseFailed)
  })

  test('no web component release means no latest release, even if another component has one', () => {
    const db = release('Succeeded', { id: 'db-1', componentId: 'shop-db', version: '16.4' })
    const base = overview(db)
    const app = deriveConsoleApp(
      sources({ releases: { ...base, components: [{ ...base.components[0]!, id: 'shop-db', name: 'shop-db' }] } })
    )
    expect(app.lastRelease).toBeUndefined()
    expect(app.status).toBe('live')
  })

  test('other applications’ components do not leak into the status', () => {
    const other = { ...summary('x-web', { statusKey: 'Blocked', reasonKey: 'DeliveryBlocked' }), applicationId: 'other' }
    expect(deriveConsoleApp(sources({ componentSummaries: [...readyComponents, other] })).status).toBe('live')
  })
})

describe('deriveConsoleApps', () => {
  test('maps every application with its own release overview', () => {
    const apps = deriveConsoleApps({
      applications: [application],
      stacks: [stack],
      publishes: [succeededPublish],
      componentSummaries: readyComponents,
      releasesByApplication: { shop: overview(release('Pending')) },
    })
    expect(apps.map((app) => [app.id, app.status])).toEqual([['shop', 'deploying']])
  })
})

describe('deriveAppView (BusinessApp ↔ stack by stackId)', () => {
  const created = '2026-10-06T00:00:00.000Z'
  const now = Date.parse(created) + 60_000
  const input = (overrides: Partial<ConsoleAppsInput> = {}): ConsoleAppsInput => ({
    applications: [application],
    stacks: [stack],
    publishes: [succeededPublish],
    componentSummaries: readyComponents,
    releasesByApplication: { shop: overview(release('Succeeded')) },
    ...overrides,
  })

  test('bound and live: joins by stackId and carries the URL', () => {
    const view = deriveAppView({ stackId: 'shop-stack', createdAt: created }, input(), now)
    expect(view).toMatchObject({ status: 'live', label: '公開中', url: 'https://shop.example.test/', draft: false })
    expect(view.stack?.id).toBe('shop-stack')
    expect(view.platform?.id).toBe('shop')
  })

  test('a recreated stack keeps its component and version regardless of stack list order', () => {
    const oldStack = { ...stack, id: 'stack-5c2cfe9ddb14', webComponentId: 'stack-5c2cfe9ddb14-web', applicationId: 'quality-issues' }
    const currentStack = { ...stack, id: 'stack-710052df3c82', webComponentId: 'stack-710052df3c82-web', applicationId: 'quality-issues' }
    const currentRelease = release('Succeeded', { applicationId: 'quality-issues', componentId: currentStack.webComponentId })
    const currentOverview = overview(currentRelease)
    currentOverview.applicationId = 'quality-issues'
    currentOverview.components[0]!.id = currentStack.webComponentId
    for (const stacks of [[oldStack, currentStack], [currentStack, oldStack]]) {
      const view = deriveAppView({ stackId: currentStack.id, createdAt: created }, input({
        // The Application's creation source is not the Console app's stack binding.
        applications: [{ ...application, id: 'quality-issues', sourceId: oldStack.id }],
        stacks,
        componentSummaries: [{ ...readyComponents[0]!, id: currentStack.webComponentId, applicationId: 'quality-issues' }],
        publishes: [{ ...succeededPublish, applicationId: 'quality-issues', componentId: currentStack.webComponentId }],
        releasesByApplication: { 'quality-issues': currentOverview },
      }), now)
      expect(view.stack?.id).toBe(currentStack.id)
      expect(view.platform).toMatchObject({
        id: 'quality-issues', stackId: currentStack.id, branchId: 'production',
        webComponentId: currentStack.webComponentId, lastRelease: { id: currentRelease.id },
      })
      expect(view.second).toContain('v1')
    }
  })

  test('logs use the bound stack branch rather than the Application default', () => {
    const view = deriveAppView(
      { stackId: 'shop-stack', createdAt: created },
      input({ stacks: [{ ...stack, branchId: 'staging' }] }),
      now,
    )
    expect(view.platform?.webComponentId).toBe('shop-web')
    expect(view.platform?.branchId).toBe('staging')
  })

  test('joins by stackId even when the Application is only linked through sourceId', () => {
    const view = deriveAppView(
      { stackId: 'shop-stack', createdAt: created },
      input({ stacks: [{ ...stack, applicationId: undefined }] }),
      now
    )
    expect(view.platform?.id).toBe('shop')
  })

  test('draft: 準備中 while fresh, 作りかけ (never 問題あり) once abandoned', () => {
    expect(deriveAppView({ stackId: null, createdAt: created }, input(), now)).toMatchObject({
      status: 'deploying',
      label: '準備中',
      text: copy.statusText.draft,
      draft: true,
    })
    const abandoned = deriveAppView({ stackId: null, createdAt: created }, input(), now + 20 * 60_000, { observed: true })
    expect(abandoned).toMatchObject({
      status: 'unfinished',
      label: '作りかけ',
      text: copy.statusText.draftStale,
      draft: true,
      next: ['resume', 'ask', 'delete'],
    })
    expect(abandoned.status).not.toBe('failed')
  })

  test('bound stack missing from the platform: 停止中', () => {
    const view = deriveAppView({ stackId: 'gone', createdAt: created }, input(), now)
    expect(view).toMatchObject({ status: 'unknown', label: '停止中', text: copy.statusText.noStack })
  })

  test('stack exists but no Application observed yet: 準備中', () => {
    const view = deriveAppView(
      { stackId: 'shop-stack', createdAt: created },
      input({ applications: [], stacks: [{ ...stack, applicationId: undefined }] }),
      now
    )
    expect(view).toMatchObject({ status: 'deploying', text: copy.statusText.preparing })
    expect(view.stack?.id).toBe('shop-stack')
  })

  test('a name collision does not join: another stack with the same application name is ignored', () => {
    const view = deriveAppView(
      { stackId: 'other-stack', createdAt: created },
      input({ stacks: [stack, { ...stack, id: 'other-stack', applicationId: 'other' }] }),
      now
    )
    expect(view.stack?.id).toBe('other-stack')
    expect(view.status).toBe('deploying')
  })

  test('a failure with a specific next action carries it as help', () => {
    const view = deriveAppView(
      { stackId: 'shop-stack', createdAt: created },
      input({ componentSummaries: [summary('shop-web', { statusKey: 'Blocked', reasonKey: 'PortUnresolved' })] }),
      now
    )
    expect(view).toMatchObject({ status: 'failed', label: '問題あり', text: 'アプリがどの番号で待ち受けるか分かりません。' })
    expect(view.help).toContain('EXPOSE')
  })
})

describe('deriveRollbackView', () => {
  test('prefers image tags, hides the current target, and reports in-flight transitions', () => {
    const view = deriveRollbackView({
      projectId: 'pj',
      applicationId: 'shop',
      branchId: 'production',
      componentId: 'shop-web',
      mode: 'Pinned',
      pinned: true,
      targetImageTag: '1.2.0',
      targetImageDigest: 'sha256:current',
      activeTransitionId: 'op-1',
      scaleToZeroConfigured: false,
      rollbackCandidates: [
        { transitionId: 't-1', imageTag: '1.1.0', imageDigest: 'sha256:abc' },
        { transitionId: 't-0', imageTag: '1.2.0', imageDigest: 'sha256:current' },
      ],
    })
    expect(view).toEqual({ currentVersion: '1.2.0', inFlight: true, options: [{ transitionId: 't-1', version: '1.1.0' }] })
  })
})

describe('versionLabel', () => {
  const releases = [
    release('Succeeded', { id: 'r3', createdAt: '2026-10-07T03:00:00Z', finishedAt: '2026-10-07T03:01:00Z' }),
    release('Failed', { id: 'r1', createdAt: '2026-10-07T01:00:00Z', finishedAt: '2026-10-07T04:00:00Z' }),
    release('Pending', { id: 'r2', createdAt: '2026-10-07T02:00:00Z' }),
  ]
  test('numbers every release in creation order, not API order, completion time or raw tag', () => {
    expect(versionLabel(releases, 'r3')).toEqual({ n: 3, label: 'v3', at: '2026-10-07T03:00:00Z' })
    expect(versionLabel(releases, 'r1')?.label).toBe('v1')
    expect(releases.map((item) => item.id)).toEqual(['r3', 'r1', 'r2'])
    expect(versionLabel(releases, 'missing')).toBeUndefined()
    expect(versionLabel([], undefined)).toBeUndefined()
  })
  test('uses id as a deterministic tie-breaker and startedAt only when createdAt is missing', () => {
    const sameTime = releases.map((item) => ({ ...item, createdAt: undefined, startedAt: '2026-10-07T03:00:00Z' }))
    expect(versionLabel(sameTime, 'r3')?.n).toBe(3)
  })
  test('builds user-facing second lines without the raw tag', () => {
    const platform = deriveConsoleApp(sources({ releases: overview(releases[0]!) }))
    expect(appSecondLine(platform, releases, Date.parse('2026-10-07T06:00:00Z'))).toBe('最新の版 (v3・3 時間前) が動いています。')
  })
  test('a queued copy of the running version does not claim the app is not live', () => {
    const running = releases[0]!
    const queued = release('Pending', { id: 'queued', version: running.version, createdAt: '2026-10-07T04:00:00Z' })
    const data = overview(queued)
    data.components[0]!.releases = [queued, running]
    const app = deriveConsoleApp(sources({ releases: data }))
    expect(app.status).toBe('live')
    expect(app.lastRelease?.id).toBe(running.id)
  })
})

describe('draftState', () => {
  const createdAt = '2026-10-07T00:00:00Z'
  const draft = { stackId: null, createdAt }
  const now = Date.parse(createdAt) + 25 * 60_000
  test('requires an observed inactive platform and strictly more than twenty minutes', () => {
    expect(draftState(draft, undefined, now).status).toBe('deploying')
    expect(draftState(draft, { observed: false }, now).status).toBe('deploying')
    expect(draftState(draft, { observed: true }, Date.parse(createdAt) + 20 * 60_000).status).toBe('deploying')
    expect(draftState(draft, { observed: true }, now)).toEqual({
      status: 'unfinished', reason: copy.statusText.draftStale, next: ['resume', 'ask', 'delete'],
    })
  })
  test('active platform work and bound apps are never abandoned drafts', () => {
    expect(draftState({ ...draft, stackId: 'stack' }, { observed: true }, now).status).toBe('deploying')
    expect(draftState(draft, { observed: true, inProgress: true }, now).status).toBe('deploying')
  })
  test('keeps the failed step reason and next actions without inventing a failure from an invalid clock', () => {
    expect(draftState(draft, { observed: true, reason: '置き場を確認できませんでした' }, now).reason).toBe('置き場を確認できませんでした')
    expect(draftState({ ...draft, createdAt: 'unknown' }, { observed: true }, now).status).toBe('deploying')
  })
})

describe('source build status on app details and mine rows', () => {
  const app = { stackId: stack.id, createdAt: '2026-10-11T00:00:00Z' }
  const repository = { id: 'shop-src', projectId: 'pj', image: { imagePath: 'ghcr.io/acme/shop' }, status: 'ready' as const, conditions: [], build: { state: 'failed' as const } }
  const input: ConsoleAppsInput = {
    applications: [application], stacks: [{ ...stack, sourceKind: 'application-source-repository', sourceRepositoryRefName: repository.id }],
    publishes: [succeededPublish], componentSummaries: readyComponents, releasesByApplication: { shop: overview(release('Succeeded')) },
    sourceRepositories: [repositoryFacts(repository)],
  }
  test('an observed failure overrides AI 作っています and an older Ready image', () => {
    const result = deriveAppView(app, input, Date.now(), undefined, { draftId: 'draft', taskCount: 1, tasks: [taskOf({ id: 'screen', title: '顧客一覧', status: 'running' })] })
    expect(result).toMatchObject({ status: 'failed', label: 'ビルドに失敗しています', text: 'ビルドに失敗しています', second: 'ビルドに失敗しています', platform: { status: 'failed', statusText: 'ビルドに失敗しています' } })
    expect(result.build?.draftId).toBe('draft')
    expect(deriveAppView(app, { ...input, applications: [] }).second).toBe('ビルドに失敗しています')
  })
  test('joins only the explicit source and recovers with the next observation', () => {
    expect(deriveAppView(app, { ...input, stacks: [stack] }).status).toBe('live')
    expect(deriveAppView(app, { ...input, sourceRepositories: [repositoryFacts({ ...repository, id: 'other-src' })] }).status).toBe('live')
    for (const state of ['healthy', 'running', 'unknown'] as const) {
      expect(deriveAppView(app, { ...input, sourceRepositories: [repositoryFacts({ ...repository, build: { state } })] }).status).toBe('live')
    }
  })
  test('drafts use the retained source reference before a stack exists', () => {
    expect(deriveAppView({ ...app, stackId: null }, input, Date.now(), { observed: true, progress: { sourceRepositoryId: repository.id } })).toMatchObject({ status: 'failed', second: 'ビルドに失敗しています', draft: true })
  })
})
