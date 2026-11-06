// Shared story fixtures. Every test starts from the mock's seeded state:
// `POST /api/console/__mock/reset` and `POST /api/v1/__mock/reset` restore
// the console and Platform mocks (src/dev/mock-console.ts, mock-platform.ts).
import { expect, test as base, type APIRequestContext, type Page, type Request } from '@playwright/test'

export { expect }

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

export const test = base.extend<{ mock: MockControl }>({
  mock: async ({ request }, use) => {
    const control = mockControl(request)
    await control.reset()
    await use(control)
  },
})

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
