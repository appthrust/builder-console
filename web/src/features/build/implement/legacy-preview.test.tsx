// Legacy same-origin preview (remove at migration stage 5 with ./legacy-preview.tsx): an unmigrated workspace's
// build card, side link and readiness probe behave exactly as before APT-798.
import { taskOf } from '../../../api/testing/build-domain'
import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../../test/language'
import { setLanguage } from '../../../shell/language'
import { implementationCopy as copy } from './copy'
import { ImplementPanel } from './implement-panel'
import { PREVIEW_POLL_MS, PREVIEW_SLOW_POLL_MS, PREVIEW_TIMEOUT_MS, previewReadiness, usePreviewReadiness, type PreviewReadiness } from './legacy-preview'
import type { PreviewDatabaseControl } from './preview-database'
import type { ImplementationState } from './state'
import { PreviewSessionDepsContext, type PreviewSessionDeps } from './use-preview-session'

const LEGACY_URL = '/api/v1/projects/p1/dev-workspaces/ws-1/proxy/preview/'

const state: ImplementationState = {
  phase: 'running',
  tasks: [taskOf({ id: 'screen', title: '顧客一覧', status: 'running' })],
  preview: { projectId: 'p1', workspaceId: 'ws-1', availability: { kind: 'legacy', url: LEGACY_URL }, readBack: () => {} },
}

function withStatus(status: PreviewReadiness | undefined): ImplementationState {
  return { ...state, legacyPreview: status === undefined ? { status: 'preparing' } : { url: LEGACY_URL, status } }
}

function render(status: PreviewReadiness | undefined) {
  return renderToStaticMarkup(<ImplementPanel state={withStatus(status)} released={false} onOpenPreview={() => {}} />)
}

test('a 503 keeps the iframe and both actions gated until a 200 response', () => {
  const waiting = render(previewReadiness(503, 0))
  expect(waiting).toContain(copy.preparing)
  expect(waiting).not.toContain('<iframe')
  expect(waiting).not.toContain('href=')
  expect(waiting.match(/disabled=""/g)).toHaveLength(2)

  const ready = render(previewReadiness(200, 4_000))
  expect(ready).toContain(`<iframe`)
  expect(ready).toContain(`src="${LEGACY_URL}"`)
  expect(ready).toContain(`href="${LEGACY_URL}"`)
  expect(ready).not.toContain('disabled=""')
  expect(ready).not.toContain(copy.preparing)
})

test('the legacy frame keeps its pre-APT-798 attributes and the new tab opens the legacy URL, never the viewer page', () => {
  const ready = render('ready')
  expect(ready).toContain('sandbox="allow-same-origin allow-scripts allow-forms"')
  expect(ready).not.toContain('referrerPolicy')
  expect(ready).not.toContain('referrerpolicy')
  expect(ready).not.toContain('/-/workspaces/')
  expect(ready).toContain('target="_blank"')
  expect(ready).toContain('rel="noopener noreferrer"')
})

test('missing readiness evidence cannot expose an iframe or an enabled action', () => {
  expect(render(undefined)).not.toContain('<iframe')
  expect(render(undefined).match(/disabled=""/g)).toHaveLength(2)
})

test('only 2xx and 3xx responses are ready; network and gateway failures keep preparing', () => {
  for (const status of [undefined, 0, 199, 400, 401, 404, 502, 503, 504]) {
    expect(previewReadiness(status, 4_000)).toBe('preparing')
  }
  for (const status of [200, 204, 299, 301, 302, 399]) {
    expect(previewReadiness(status, 4_000)).toBe('ready')
  }
})

test('ten minutes changes the message and enables only the explicit new-tab escape hatch', () => {
  expect(previewReadiness(undefined, PREVIEW_TIMEOUT_MS - 1)).toBe('preparing')
  const timedOut = render(previewReadiness(503, PREVIEW_TIMEOUT_MS))
  expect(timedOut).toContain('画面がまだ開きません。もう少し待つか、新しいタブで開いてください。')
  expect(timedOut).not.toContain(copy.preparing)
  expect(timedOut).not.toContain('<iframe')
  expect(timedOut.match(/disabled=""/g)).toHaveLength(1)
  expect(timedOut).toContain(`href="${LEGACY_URL}"`)
  expect(timedOut).toContain('target="_blank"')
  expect(timedOut).toContain('rel="noopener noreferrer"')
  expect(previewReadiness(200, PREVIEW_TIMEOUT_MS)).toBe('ready')
})

test('500 is an app error, even after the deadline; a later successful response wins', () => {
  for (const elapsed of [0, PREVIEW_TIMEOUT_MS, PREVIEW_TIMEOUT_MS + PREVIEW_SLOW_POLL_MS]) {
    expect(previewReadiness(500, elapsed)).toBe('error')
    expect(previewReadiness(200, elapsed)).toBe('ready')
    expect(previewReadiness(302, elapsed)).toBe('ready')
  }
})

test.each(['ja', 'en'] as const)('every preview state renders its message, actions and no-database notice in %s', (language) => {
  const restoreLanguage = preserveLanguage()
  setLanguage(language)
  try {
    for (const status of ['preparing', 'error', 'timed-out', 'ready'] as const) {
      const html = renderToStaticMarkup(<ImplementPanel state={withStatus(status)} previewNotice={copy.previewDatabase(true)} released={false} onOpenPreview={() => {}} />)
      expect(html).toContain('role="note"')
      expect(html).toContain(copy.previewDatabase(true))
      if (status === 'ready') {
        expect(html).toContain('<iframe')
        expect(html).not.toContain('disabled=""')
      } else {
        expect(html).not.toContain('<iframe')
        const message = status === 'error' ? copy.previewError : status === 'timed-out' ? copy.previewTimedOut : copy.preparing
        expect(html).toContain(message)
        expect(html.match(/disabled=""/g)).toHaveLength(status === 'preparing' ? 2 : 1)
      }
      if (status === 'preparing') expect(html).not.toContain('href=')
      else {
        expect(html).toContain(`href="${LEGACY_URL}"`)
        expect(html).toContain('target="_blank"')
        expect(html).toContain('rel="noopener noreferrer"')
      }
      expect(render(status)).not.toContain('role="note"')
    }
  } finally {
    restoreLanguage()
  }
})

test.each(['ja', 'en'] as const)('the database line sits under the preview header with its reset action in %s', (language) => {
  const restoreLanguage = preserveLanguage()
  setLanguage(language)
  try {
    const control = (status: PreviewDatabaseControl['status'], busy = false): PreviewDatabaseControl => ({ status, excel: true, busy, pending: false, onReset: async () => true })
    const ready = renderToStaticMarkup(<ImplementPanel state={withStatus('ready')} previewDatabase={control('ready-unverified')} released={false} onOpenPreview={() => {}} />)
    expect(ready).toContain(copy.database.readyUnverified(true))
    expect(ready).not.toContain('role="note"')
    expect(ready.indexOf(copy.database.readyUnverified(true))).toBeLessThan(ready.indexOf('<iframe'))
    expect(ready).toContain(copy.databaseReset)
    expect(ready).not.toContain('disabled=""')
    // Waiting for the database, or for the AI to finish, keeps the reset action disabled; preview actions are unchanged.
    const starting = renderToStaticMarkup(<ImplementPanel state={withStatus('ready')} previewDatabase={control('starting')} released={false} onOpenPreview={() => {}} />)
    expect(starting).toContain(copy.database.starting)
    expect(starting.match(/disabled=""/g)).toHaveLength(1)
    const busy = renderToStaticMarkup(<ImplementPanel state={withStatus('ready')} previewDatabase={control('unavailable', true)} released={false} onOpenPreview={() => {}} />)
    expect(busy).toContain(copy.database.unavailable)
    expect(busy.match(/disabled=""/g)).toHaveLength(1)
    expect(busy).toContain(`title="${copy.databaseResetRunning}"`)
  } finally {
    restoreLanguage()
  }
})

test('a legacy card asks the Platform for no preview session', async () => {
  const issue: Mock<PreviewSessionDeps['issue']> = mock(async () => { throw new Error('no session for a legacy workspace') })
  const deps: PreviewSessionDeps = { issue, exchange: mock(async () => ({ kind: 'ready' as const })), now: () => Date.now(), schedule: () => () => {} }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<PreviewSessionDepsContext value={deps}><ImplementPanel state={withStatus('ready')} released={false} onOpenPreview={() => {}} /></PreviewSessionDepsContext>) })
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(LEGACY_URL)
    expect(issue).not.toHaveBeenCalled()
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
})

describe('preview polling', () => {
  let root: Root
  let container: HTMLDivElement
  let now: number
  let timers: Map<number, { at: number; run(): void }>
  let restore: (() => void)[]
  let fetchMock: Mock<(...args: Parameters<typeof fetch>) => Promise<Response>>
  let responseStatus: number | undefined

  function Harness({ url }: { url?: string }) {
    return <output>{usePreviewReadiness(url)}</output>
  }
  async function mount(url: string = LEGACY_URL) {
    await act(async () => { root.render(<Harness url={url} />) })
  }
  async function advance(ms: number) {
    const until = now + ms
    while (true) {
      const entry = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!entry) break
      const [id, timer] = entry
      now = timer.at
      timers.delete(id)
      await act(async () => { timer.run() })
    }
    now = until
  }
  beforeEach(() => {
    now = 0
    timers = new Map()
    let nextTimer = 0
    const clockSpy = spyOn(Date, 'now').mockImplementation(() => now)
    const timeoutSpy = spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, delay = 0) => {
      if (typeof handler !== 'function') throw new Error('Expected a timer callback')
      const id = ++nextTimer
      timers.set(id, { at: now + delay, run: () => handler() })
      return id
    }) as typeof window.setTimeout)
    const clearSpy = spyOn(window, 'clearTimeout').mockImplementation((id) => { timers.delete(Number(id)) })
    responseStatus = 503
    fetchMock = spyOn(globalThis, 'fetch')
    fetchMock.mockImplementation(async () => {
      if (responseStatus === undefined) throw new TypeError('Network unavailable')
      return new Response(null, { status: responseStatus })
    })
    restore = [clockSpy, timeoutSpy, clearSpy, fetchMock].map((spy) => () => spy.mockRestore())
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    for (const reset of restore.reverse()) reset()
  })

  test('500 shows error and keeps polling until 200 makes this URL terminally ready', async () => {
    responseStatus = 500
    await mount()
    expect(container.textContent).toBe('error')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    responseStatus = 200
    await advance(PREVIEW_POLL_MS)
    expect(container.textContent).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(timers.size).toBe(0)
    await advance(PREVIEW_TIMEOUT_MS * 2)
    expect(container.textContent).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test.each([undefined, 503])('a non-ready response (%s) keeps polling every 15 seconds after the deadline and recovers', async (status) => {
    responseStatus = status
    await mount()
    expect(container.textContent).toBe('preparing')
    await advance(PREVIEW_TIMEOUT_MS - 1)
    expect(container.textContent).toBe('preparing')
    await advance(1)
    expect(container.textContent).toBe('timed-out')
    const attempts = fetchMock.mock.calls.length
    responseStatus = 200
    await advance(PREVIEW_SLOW_POLL_MS - 1)
    expect(fetchMock).toHaveBeenCalledTimes(attempts)
    expect(container.textContent).toBe('timed-out')
    await advance(1)
    expect(fetchMock).toHaveBeenCalledTimes(attempts + 1)
    expect(container.textContent).toBe('ready')
    expect(timers.size).toBe(0)
  })

  test('an error stays distinct at the deadline and follows later gateway and app responses', async () => {
    responseStatus = 500
    await mount()
    await advance(PREVIEW_TIMEOUT_MS)
    expect(container.textContent).toBe('error')
    responseStatus = 503
    await advance(PREVIEW_SLOW_POLL_MS)
    expect(container.textContent).toBe('timed-out')
    responseStatus = 500
    await advance(PREVIEW_SLOW_POLL_MS)
    expect(container.textContent).toBe('error')
    responseStatus = 200
    await advance(PREVIEW_SLOW_POLL_MS)
    expect(container.textContent).toBe('ready')
  })

  test('a changed URL needs fresh readiness evidence and unmount cancels further polling', async () => {
    responseStatus = 200
    await mount()
    expect(container.textContent).toBe('ready')
    responseStatus = 503
    await mount('/preview/restarted')
    expect(container.textContent).toBe('preparing')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/preview/restarted')
    await act(async () => { root.render(null) })
    const attempts = fetchMock.mock.calls.length
    await advance(PREVIEW_TIMEOUT_MS * 2)
    expect(fetchMock).toHaveBeenCalledTimes(attempts)
    expect(timers.size).toBe(0)
  })

  test('a hung request is aborted without stopping the reader after its deadline', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const { promise, reject } = Promise.withResolvers<Response>()
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      return promise
    })
    await mount()
    await advance(PREVIEW_TIMEOUT_MS)
    expect(container.textContent).toBe('timed-out')
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    await advance(PREVIEW_SLOW_POLL_MS)
    expect(container.textContent).toBe('ready')
    expect(timers.size).toBe(0)
  })
})
