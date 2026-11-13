// Shared story fixtures: the single `test` entry for every story. Two automatic
// fixtures run for every test, whether or not it asks for them:
//
// - mock reset: `POST /api/console/__mock/reset` and `POST /api/v1/__mock/reset`
//   restore the console and Platform mocks (src/dev/mock-console.ts,
//   mock-platform.ts) before the test starts;
// - browser problems: ./browser-problems.ts watches the whole BrowserContext
//   from before the first navigation, and the test fails at teardown when a
//   console error, uncaught error, failed request, error boundary or rendered
//   `undefined`/`NaN` was collected. Deliberate failures are declared with
//   `withExpectedFailures` inside the step that provokes them.
import { expect, test as base, type APIRequestContext, type Page, type Request } from '@playwright/test'
import { BrowserProblemCollector, describeCount, formatBrowserProblems, type ExpectedFailure } from './browser-problems'

export { expect }
export type { ExpectedFailure }

/** Seeded identities (src/dev/mock-console.ts, mock-platform.ts). */
export const seed = {
  projectId: 'commerce',
  /** `yamada` is the signed-in person (console admin in the default MOCK_ROLE=Admin). */
  me: { id: 'p-yamada', name: '山田 太郎' },
  groups: {
    sales: { id: 'g-sales', path: 'sales', name: '営業本部' },
    salesEast: { id: 'g-sales-east', path: 'sales/east', name: '営業1部' },
    teamA: { id: 'g-team-a', path: 'sales/east/team-a', name: '営業1課' },
    planning: { id: 'g-planning', path: 'sales/planning', name: '営業企画部' },
    soumu: { id: 'g-soumu', path: 'soumu', name: '総務部' },
  },
  apps: {
    mitsumori: { id: 'a-mitsumori', slug: 'mitsumori', name: '見積作成', groupPath: 'sales/east/team-a' },
    nippo: { id: 'a-nippo', slug: 'nippo', name: '日報', groupPath: 'sales/east/team-a' },
    keihi: { id: 'a-keihi', slug: 'keihi', name: '経費精算', groupPath: 'sales/east/team-a' },
    kintai: { id: 'a-kintai', slug: 'kintai', name: '勤怠申請', groupPath: 'soumu' },
  },
} as const

export interface MockControl {
  /** Restores both mocks to their seeded state. */
  reset(): Promise<void>
  /** One lifecycle step of the Platform mock (stack stages, adopted repositories, draft generation). */
  advance(): Promise<number>
  /** `POST /api/v1/__mock/<name>` toggles documented at the top of src/dev/mock-platform.ts. */
  platform(name: string, body?: unknown): Promise<void>
  /** `POST /api/console/__mock/<name>` toggles documented at the top of src/dev/mock-console.ts. */
  console(name: string, body?: unknown): Promise<void>
}

function mockControl(request: APIRequestContext): MockControl {
  const post = async (path: string, body?: unknown) => {
    const response = await request.post(path, body === undefined ? {} : { data: body })
    expect(response.ok(), `${path} -> ${response.status()}`).toBe(true)
    return response
  }
  return {
    reset: async () => {
      await post('/api/console/__mock/reset')
      await post('/api/v1/__mock/reset')
    },
    advance: async () => {
      const answer: unknown = await (await post('/api/v1/__mock/advance')).json()
      if (!answer || typeof answer !== 'object' || !('moved' in answer) || typeof answer.moved !== 'number') {
        throw new Error('__mock/advance answered no moved count')
      }
      return answer.moved
    },
    platform: async (name, body) => void (await post(`/api/v1/__mock/${name}`, body)),
    console: async (name, body) => void (await post(`/api/console/__mock/${name}`, body)),
  }
}

/** The current test's collector (workers run one test at a time). */
let activeCollector: BrowserProblemCollector | undefined

export const test = base.extend<{ mock: MockControl; mockReset: void; browserProblems: void }>({
  mockReset: [async ({ request }, use) => {
    await mockControl(request).reset()
    await use()
  }, { auto: true }],
  browserProblems: [async ({ context }, use, testInfo) => {
    const collector = await BrowserProblemCollector.install(context)
    activeCollector = collector
    try {
      await use()
    } finally {
      activeCollector = undefined
    }
    const summary = await collector.finish()
    await testInfo.attach('browser-problems', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' })
    if (summary.problems.length > 0) throw new Error(formatBrowserProblems(summary.problems))
  }, { auto: true }],
  mock: async ({ request }, use) => {
    await use(mockControl(request))
  },
})

/**
 * Runs `action` as one step in which exactly the `expected` failures happen.
 * Each entry names the operation (method + path), the HTTP status or transport
 * error, the exact count and the reason. A missing or an extra occurrence fails
 * the step; outside it the same failure is an ordinary browser problem.
 * Unrelated console errors inside the step still fail the test.
 */
export async function withExpectedFailures(expected: readonly ExpectedFailure[], action: () => Promise<void>): Promise<void> {
  const collector = activeCollector
  if (!collector) throw new Error('withExpectedFailures must run inside a story test')
  const title = expected
    .map((failure) => `${describeCount(failure)}× ${failure.transportError ?? failure.status} ${failure.method} ${String(failure.path)}: ${failure.reason}`)
    .join('; ')
  await test.step(`expected failures: ${title}`, () => collector.expectFailures(expected, action), { box: true })
}

/**
 * The create wizard's URL-name probe: the console's `GET /resolve` answers 404
 * for a path nobody uses. The wizard checks when it proposes a generated name,
 * when the name field is left and on 次へ, and 次へ joins a check of the same name
 * still in flight, so how many checks happen depends on machine speed. This one
 * probe is therefore a range: at least one, at most `moments` (the distinct
 * moments the flow can check). `continueToShare` separately asserts that the
 * final name itself was checked free before the wizard moved on.
 */
export function freeUrlNameChecks(moments: number): ExpectedFailure {
  return { method: 'GET', path: '/api/console/resolve', status: 404, count: { min: 1, max: moments }, reason: 'the wizard checks the URL name is free (resolve answers 404)' }
}

/** A write the UI sent: the Playwright request plus its parsed JSON body (narrow before asserting). */
export interface CapturedWrite {
  request: Request
  body: unknown
}

/** Waits for the next write the UI sends to `path` (console or Platform) and returns its JSON body. */
export async function captureWrite(
  page: Page,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string | RegExp,
  action: () => Promise<void>
): Promise<CapturedWrite> {
  const [request] = await Promise.all([
    page.waitForRequest((candidate) => {
      if (candidate.method() !== method) return false
      const pathname = new URL(candidate.url()).pathname
      return typeof path === 'string' ? pathname === path : path.test(pathname)
    }),
    action(),
  ])
  const body: unknown = request.postDataJSON()
  return { request, body }
}
