import { taskOf, workspaceOf } from '../../../api/testing/build-domain'
import { atConsoleOrigin } from '../../../api/testing/console-origin'
import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { preserveLanguage } from '../../../../test/language'
import { ResponseContractError } from '../../../api/boundary'
import type { PreviewExchange } from '../../../api/workspace'
import { buildCopy } from '../../../model/build/copy'
import type { PreviewSession } from '../../../model/contracts/build'
import { setLanguage } from '../../../shell/language'
import { implementationCopy as copy } from './copy'
import { ImplementPanel } from './implement-panel'
import { previewAvailability, type PreviewAvailability } from './preview'
import type { PreviewDatabaseControl } from './preview-database'
import type { ImplementationState } from './state'
import { previewDatabaseResetError } from './use-implementation'
import { PreviewSessionDepsContext, type PreviewSessionDeps } from './use-preview-session'

const ORIGIN = 'https://pv-0123456789abcdef0123456789abcdef.commerce.appthrust.test'
const PUBLISH_UID = '7d0f3c52-9a41-4f7e-8b52-3c1f0e6a9b10'
const GRANT = 'SENTINEL-grant-eyJhbGciOiJFUzI1NiJ9.e30.c2ln'
const ready: PreviewAvailability = { kind: 'ready', publishUID: PUBLISH_UID, origin: ORIGIN }

function stateWith(availability: PreviewAvailability, readBack = () => {}): ImplementationState {
  return {
    phase: 'running',
    tasks: [taskOf({ id: 'screen', title: '顧客一覧', status: 'running' })],
    preview: { projectId: 'commerce', workspaceId: 'ws-1', availability, readBack },
  }
}

describe('previewAvailability', () => {
  let leaveConsole: () => void
  beforeEach(() => { leaveConsole = atConsoleOrigin('https://console.commerce.appthrust.test') })
  afterEach(() => leaveConsole())
  const endpoint = { target: 'preview', state: 'Ready', url: `${ORIGIN}/`, publishUID: PUBLISH_UID, sessionPath: '/api/v1/projects/commerce/dev-workspaces/ws-1/http-sessions' }
  const workspace = (phase: string, change: Record<string, unknown> = {}, endpoints: unknown[] | undefined = [{ ...endpoint, ...change }]) => workspaceOf({
    id: 'ws-1', projectId: 'commerce', scope: 'application', displayName: '見積', ownerUserId: 'owner', phase, branchName: 'main', baseRef: 'main', conditions: [],
    ...(endpoints ? { httpEndpoints: endpoints } : {}),
  })

  test('only a Ready endpoint of a running workspace asks for a session; its origin is the endpoint URL\'s origin', () => {
    expect(previewAvailability(workspace('Ready'))).toEqual(ready)
    expect(previewAvailability(workspace('Degraded'))).toEqual(ready)
  })

  test('every other answer is a named state, never a session request', () => {
    expect(previewAvailability(workspace('Ready', { state: 'Pending', url: undefined }))).toEqual({ kind: 'preparing' })
    expect(previewAvailability(workspace('Ready', { state: 'Unavailable', url: undefined, reason: 'HostnameConflict' }))).toEqual({ kind: 'conflict' })
    expect(previewAvailability(workspace('Ready', { state: 'Unavailable', url: undefined, reason: 'WorkspaceSleeping' }))).toEqual({ kind: 'asleep' })
    expect(previewAvailability(workspace('Ready', { state: 'Unavailable', url: undefined, reason: 'BackendTransportUnavailable' }))).toEqual({ kind: 'unavailable' })
    expect(previewAvailability(workspace('Ready', { state: 'Exposed', url: undefined }))).toEqual({ kind: 'unknown' })
    // A Ready endpoint on a sibling app of the Project, or on another domain, is never embedded or asked a grant for.
    expect(previewAvailability(workspace('Ready', { url: 'https://mitsumori.commerce.appthrust.test/' }))).toEqual({ kind: 'unknown' })
    expect(previewAvailability(workspace('Ready', { url: `https://pv-${'a'.repeat(32)}.commerce.example.test/` }))).toEqual({ kind: 'unknown' })
    // Once the Platform marks the workspace as moved, a missing endpoint is unavailable, never a way back. The mark
    // is a historical receipt: True from an older generation and an old transition time is still True (never legacy).
    const moved = workspaceOf({
      id: 'ws-1', projectId: 'commerce', scope: 'application', displayName: '見積', ownerUserId: 'owner', phase: 'Ready', branchName: 'main', baseRef: 'main',
      conditions: [{ type: 'DirectPreviewActivated', status: 'True', observedGeneration: 1, lastTransitionTime: '2026-01-01T00:00:00Z' }], previewUrl: '/api/v1/projects/commerce/dev-workspaces/ws-1/proxy/preview/',
    })
    expect(previewAvailability(moved)).toEqual({ kind: 'unavailable' })
    expect(previewAvailability(workspace('Hibernating'))).toEqual({ kind: 'unknown' })
    for (const phase of ['Sleeping', 'Stopping', 'Stopped']) expect(previewAvailability(workspace(phase))).toEqual({ kind: 'asleep' })
    for (const phase of ['Failed', 'Deleting']) expect(previewAvailability(workspace(phase))).toEqual({ kind: 'unavailable' })
  })

  const LEGACY = '/api/v1/projects/commerce/dev-workspaces/ws-1/proxy/preview/'
  const RECEIPT = { type: 'DirectPreviewActivated', status: 'True', reason: 'PreviewEndpointReady', lastTransitionTime: '2026-01-01T00:00:00Z' }
  const read = (change: Record<string, unknown>) => workspaceOf({
    id: 'ws-1', projectId: 'commerce', scope: 'application', displayName: '見積', ownerUserId: 'owner', phase: 'Ready', branchName: 'main', baseRef: 'main', conditions: [], ...change,
  })

  test('each Platform answer decides the display: endpoint → new viewer, receipt → never legacy, legacy URL → legacy, else cannot display yet', () => {
    // 1. A preview endpoint: the new viewer by its state, never legacy, even with the legacy URL beside it.
    expect(previewAvailability(read({ httpEndpoints: [endpoint], previewUrl: LEGACY }))).toEqual(ready)
    expect(previewAvailability(read({ httpEndpoints: [{ ...endpoint, state: 'Pending', url: undefined }], previewUrl: LEGACY }))).toEqual({ kind: 'preparing' })
    // 2. The receipt without an endpoint: unavailable, never legacy.
    expect(previewAvailability(read({ conditions: [RECEIPT], previewUrl: LEGACY }))).toEqual({ kind: 'unavailable' })
    // 3. Never moved, with the legacy relative URL: the legacy display, framed only once the workspace is Ready.
    expect(previewAvailability(read({ previewUrl: LEGACY }))).toEqual({ kind: 'legacy', url: LEGACY })
    for (const phase of ['Starting', 'Sleeping', 'Hibernating']) expect(previewAvailability(read({ phase, previewUrl: LEGACY }))).toEqual({ kind: 'legacy' })
    // A receipt that is not True does not mark the workspace as moved.
    for (const status of ['False', 'Unknown', 'Maybe']) expect(previewAvailability(read({ conditions: [{ ...RECEIPT, status }], previewUrl: LEGACY }))).toEqual({ kind: 'legacy', url: LEGACY })
    // 4. Neither: the plain "cannot display yet". An absolute URL is not the legacy proxy path and is never framed.
    expect(previewAvailability(read({}))).toEqual({ kind: 'unpublished' })
    expect(previewAvailability(read({ httpEndpoints: [] }))).toEqual({ kind: 'unpublished' })
    expect(previewAvailability(read({ previewUrl: `${ORIGIN}/` }))).toEqual({ kind: 'unpublished' })
    expect(previewAvailability(read({ previewUrl: 'https://elsewhere.example/api/v1/projects/commerce/dev-workspaces/ws-1/proxy/preview/' }))).toEqual({ kind: 'unpublished' })
  })

  test('the receipt is sticky whatever its age: True from an older generation and transition time is never legacy', () => {
    const old = { ...RECEIPT, observedGeneration: 1, lastTransitionTime: '2020-01-01T00:00:00Z' }
    expect(previewAvailability(read({ conditions: [old], previewUrl: LEGACY }))).toEqual({ kind: 'unavailable' })
    expect(previewAvailability(read({ conditions: [old], previewUrl: LEGACY, httpEndpoints: [{ ...endpoint, state: 'Pending', url: undefined }] }))).toEqual({ kind: 'preparing' })
  })

  test('a workspace on the new viewer whose endpoint disappears or fails never falls back to legacy', () => {
    // The answers one workspace gives over time once its endpoint has been Ready (the Platform recorded the receipt).
    const answers = [
      read({ conditions: [RECEIPT], previewUrl: `${ORIGIN}/`, httpEndpoints: [endpoint] }),
      read({ conditions: [RECEIPT], previewUrl: LEGACY }),
      read({ conditions: [RECEIPT], previewUrl: LEGACY, httpEndpoints: [{ ...endpoint, state: 'Unavailable', url: undefined, reason: 'BackendTransportUnavailable' }] }),
      read({ phase: 'Sleeping', conditions: [RECEIPT], previewUrl: LEGACY }),
      read({ phase: 'Starting', conditions: [RECEIPT], previewUrl: LEGACY }),
    ]
    expect(answers.map((answer) => previewAvailability(answer).kind)).toEqual(['ready', 'unavailable', 'unavailable', 'asleep', 'unavailable'])
    for (const answer of answers) expect(answer.legacyPreviewUrl).toBeUndefined()
  })
})

describe('the build card before a session', () => {
  test('a Ready endpoint shows connecting, no frame, 「見てみる」 disabled, and the new tab opens the Console viewer', () => {
    const html = renderToStaticMarkup(<ImplementPanel state={stateWith(ready)} released={false} onOpenPreview={() => {}} />)
    expect(html).toContain(copy.viewer.connecting)
    expect(html).not.toContain('<iframe')
    expect(html.match(/disabled=""/g)).toHaveLength(1)
    expect(html).toContain('href="/-/workspaces/ws-1/preview"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain(ORIGIN)
  })

  test('before the workspace is read nothing is offered', () => {
    const html = renderToStaticMarkup(<ImplementPanel state={{ ...stateWith(ready), preview: undefined }} released={false} onOpenPreview={() => {}} />)
    expect(html).toContain(copy.preparing)
    expect(html.match(/disabled=""/g)).toHaveLength(2)
    expect(html).not.toContain('href=')
  })

  test.each(['ja', 'en'] as const)('each endpoint state that asks for nothing renders its sentence in %s', (language) => {
    const restoreLanguage = preserveLanguage()
    setLanguage(language)
    try {
      const sentences = { preparing: copy.preparing, asleep: copy.viewer.asleep, unpublished: copy.viewer.unpublished, conflict: copy.viewer.conflict, unavailable: copy.viewer.unavailable, unknown: copy.viewer.unknown } as const
      for (const [kind, sentence] of Object.entries(sentences) as [keyof typeof sentences, string][]) {
        const html = renderToStaticMarkup(<ImplementPanel state={stateWith({ kind })} previewNotice={copy.previewDatabase(true)} released={false} onOpenPreview={() => {}} />)
        expect(html).toContain(sentence)
        expect(html).not.toContain('<iframe')
        expect(html).toContain(copy.previewDatabase(true))
        expect(html.indexOf(copy.previewDatabase(true))).toBeLessThan(html.indexOf(sentence))
      }
    } finally {
      restoreLanguage()
    }
  })
})

test.each(['ja', 'en'] as const)('the database line sits under the preview header with its reset action in %s', (language) => {
  const restoreLanguage = preserveLanguage()
  setLanguage(language)
  try {
    const control = (status: PreviewDatabaseControl['status'], busy = false): PreviewDatabaseControl => ({ status, excel: true, busy, pending: false, onReset: async () => true })
    const render = (database: PreviewDatabaseControl) => renderToStaticMarkup(<ImplementPanel state={stateWith(ready)} previewDatabase={database} released={false} onOpenPreview={() => {}} />)
    const running = render(control('ready-unverified'))
    expect(running).toContain(copy.database.readyUnverified(true))
    expect(running).not.toContain('role="note"')
    expect(running.indexOf(copy.database.readyUnverified(true))).toBeLessThan(running.indexOf(copy.viewer.connecting))
    expect(running).toContain(copy.databaseReset)
    // Only 「見てみる」 waits for the session.
    expect(running.match(/disabled=""/g)).toHaveLength(1)
    // Waiting for the database, or for the AI to finish, keeps the reset action disabled too.
    const starting = render(control('starting'))
    expect(starting).toContain(copy.database.starting)
    expect(starting.match(/disabled=""/g)).toHaveLength(2)
    const busy = render(control('unavailable', true))
    expect(busy).toContain(copy.database.unavailable)
    expect(busy.match(/disabled=""/g)).toHaveLength(2)
    expect(busy).toContain(`title="${copy.databaseResetRunning}"`)
  } finally {
    restoreLanguage()
  }
})

test('reset refusals become plain sentences from details.reason', () => {
  const refusal = (status: number, reason?: string) => new ORPCError('UNKNOWN', { status, data: { body: { error: { code: 'conflict', message: 'preview database is busy', ...(reason ? { details: { reason } } : {}) } } } })
  expect(previewDatabaseResetError(refusal(409, 'PreviewDatabaseBusy'))).toBe(copy.databaseResetBusy)
  expect(previewDatabaseResetError(refusal(412, 'PreviewDatabaseNotEnabled'))).toBe(copy.databaseResetNotEnabled)
  expect(previewDatabaseResetError(refusal(409))).toBe(copy.databaseResetFailed)
  expect(previewDatabaseResetError(new Error('network'))).toBe(copy.databaseResetFailed)
})

const platformRefusal = (status: number, reason: string) => new ORPCError('UNKNOWN', { status, data: { body: { error: { code: 'refused', message: 'refused', details: { reason } } } } })

describe('the preview session', () => {
  let root: Root
  let container: HTMLDivElement
  let now: number
  let timers: Map<number, { at: number; run(): void }>
  let nextTimer: number
  let issued: number
  let issue: Mock<PreviewSessionDeps['issue']>
  let exchange: Mock<PreviewSessionDeps['exchange']>
  let visibility: PropertyDescriptor | undefined
  let hidden: boolean

  const grant = (): PreviewSession => ({ origin: ORIGIN, publishUID: PUBLISH_UID, exchangeUrl: `${ORIGIN}/__appthrust/session/${PUBLISH_UID}`, grant: `${GRANT}-${++issued}`, expiresAt: new Date(now + 55_000).toISOString(), renewAfterSeconds: 30 })
  const deps = (): PreviewSessionDeps => ({
    issue, exchange,
    now: () => now,
    schedule: (ms, run) => {
      const id = ++nextTimer
      timers.set(id, { at: now + ms, run })
      return () => { timers.delete(id) }
    },
  })
  async function render(node: ReactNode) {
    await act(async () => { root.render(<PreviewSessionDepsContext value={deps()}>{node}</PreviewSessionDepsContext>) })
  }
  async function mount(state = stateWith(ready)) {
    await render(<ImplementPanel state={state} released={false} onOpenPreview={() => {}} />)
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
  async function setHidden(value: boolean) {
    hidden = value
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  }
  const frame = () => container.querySelector('iframe')
  const button = (name: string) => [...container.querySelectorAll('button')].find((element) => element.textContent === name)

  beforeEach(() => {
    // An epoch clock: the grant's `expiresAt` is placed on it.
    now = Date.parse('2026-11-14T00:00:00Z')
    timers = new Map()
    nextTimer = 0
    issued = 0
    hidden = false
    visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' })
    issue = mock(async () => grant())
    exchange = mock(async (): Promise<PreviewExchange> => ({ kind: 'ready' }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    else Reflect.deleteProperty(document, 'visibilityState')
  })

  test('grant → exchange → ready shows the preview origin with the design\'s frame attributes; the grant reaches no DOM or URL', async () => {
    await mount()
    expect(issue).toHaveBeenCalledTimes(1)
    expect(issue.mock.calls[0]).toEqual(['commerce', 'ws-1', PUBLISH_UID])
    expect(exchange).toHaveBeenCalledTimes(1)
    const preview = frame()!
    expect(preview.getAttribute('src')).toBe(`${ORIGIN}/`)
    expect(preview.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms')
    expect(preview.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(preview.hasAttribute('allow')).toBe(false)
    expect(preview.getAttribute('title')).toBe(copy.preview)
    expect(button(copy.open)?.disabled).toBe(false)
    expect(container.innerHTML).not.toContain(GRANT)
    expect(window.location.href).not.toContain(GRANT)
  })

  test('a fresh grant every 30 s keeps the same frame; nothing is requested while the viewer is hidden', async () => {
    await mount()
    const first = frame()
    await advance(29_999)
    expect(issue).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(issue).toHaveBeenCalledTimes(2)
    expect(exchange).toHaveBeenCalledTimes(2)
    expect(exchange.mock.calls[1]?.[0].grant).not.toBe(exchange.mock.calls[0]?.[0].grant)
    expect(frame()).toBe(first)

    await setHidden(true)
    await advance(120_000)
    expect(issue).toHaveBeenCalledTimes(2)
    expect(frame()).toBe(first)
  })

  test('back in the foreground after the renewal time, the viewer re-authorizes before the frame shows again', async () => {
    await mount()
    const first = frame()
    await setHidden(true)
    await advance(45_000)
    const pending = Promise.withResolvers<PreviewSession>()
    issue.mockImplementationOnce(() => pending.promise)
    await setHidden(false)
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(copy.viewer.resuming)
    await act(async () => { pending.resolve(grant()) })
    expect(issue).toHaveBeenCalledTimes(2)
    expect(frame()).not.toBeNull()
    expect(frame()).not.toBe(first)
  })

  test('back in the foreground within the renewal time keeps the frame and renews on schedule', async () => {
    await mount()
    const first = frame()
    await setHidden(true)
    await advance(10_000)
    await setHidden(false)
    expect(issue).toHaveBeenCalledTimes(1)
    await advance(20_000)
    expect(issue).toHaveBeenCalledTimes(2)
    expect(frame()).toBe(first)
  })

  test('a failed renewal removes the frame at once and never retries by itself; reconnecting asks for a new grant', async () => {
    await mount()
    issue.mockImplementationOnce(async () => { throw platformRefusal(503, 'workspace_session_unavailable') })
    await advance(30_000)
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(copy.viewer.renewFailed)
    expect(button(copy.open)?.disabled).toBe(true)
    await advance(300_000)
    expect(issue).toHaveBeenCalledTimes(2)
    await act(async () => { button(copy.viewer.reconnect)!.click() })
    expect(issue).toHaveBeenCalledTimes(3)
    expect(frame()?.getAttribute('src')).toBe(`${ORIGIN}/`)
  })

  test('an exchange the preview origin refuses during renewal stops the preview too', async () => {
    await mount()
    exchange.mockImplementationOnce(async () => ({ kind: 'refused', status: 401 }))
    await advance(30_000)
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(copy.viewer.renewFailed)
  })

  test('a lost permission stops the preview, explains it and offers no reconnect', async () => {
    await mount()
    issue.mockImplementationOnce(async () => { throw platformRefusal(403, 'workspace_access_denied') })
    await advance(30_000)
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(copy.viewer.revoked)
    expect(button(copy.viewer.reconnect)).toBeUndefined()
    await advance(300_000)
    expect(issue).toHaveBeenCalledTimes(2)
  })

  test.each([
    [platformRefusal(403, 'workspace_access_denied'), copy.viewer.denied],
    [platformRefusal(403, 'workspace_session_credential_not_allowed'), copy.viewer.credentialNotAllowed],
    [platformRefusal(404, 'workspace_not_found'), copy.viewer.notFound],
    [platformRefusal(409, 'workspace_not_running'), copy.viewer.asleep],
    [platformRefusal(412, 'preview_origin_unavailable'), copy.viewer.unpublished],
    [platformRefusal(412, 'workspace_runtime_unavailable'), copy.viewer.unavailable],
    [platformRefusal(412, 'workspace_session_verifier_unavailable'), copy.viewer.verifierUnavailable],
    [platformRefusal(503, 'workspace_session_unavailable'), copy.viewer.failed],
  ])('a first refusal is its own sentence, with no frame (%#)', async (error, sentence) => {
    issue.mockImplementationOnce(async () => { throw error })
    await mount()
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(sentence)
    expect(issue).toHaveBeenCalledTimes(1)
  })

  test('a Cookie the browser refuses is explained, with reconnect and the new-tab viewer', async () => {
    exchange.mockImplementationOnce(async () => ({ kind: 'cookie-refused' }))
    await mount()
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(copy.viewer.cookieRefused)
    const links = [...container.querySelectorAll('a')].filter((link) => link.textContent === copy.newTab)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('/-/workspaces/ws-1/preview')
      expect(link.getAttribute('rel')).toContain('noopener')
    }
    expect(button(copy.viewer.reconnect)).toBeDefined()
  })

  test('an unreadable grant answer offers only reading the state back, then a new grant', async () => {
    const readBack = mock(() => {})
    issue.mockImplementationOnce(async () => { throw new ResponseContractError({ source: 'platform', operationId: 'platformApiCreateDevWorkspaceHTTPSession', method: 'POST', routeTemplate: '/api/v1/projects/{projectId}/dev-workspaces/{id}/http-sessions', issues: [] }) })
    await mount(stateWith(ready, readBack))
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(copy.viewer.unconfirmed)
    expect(button(copy.viewer.reconnect)).toBeUndefined()
    await act(async () => { button(buildCopy.failure.confirm)!.click() })
    expect(readBack).toHaveBeenCalledTimes(1)
    expect(issue).toHaveBeenCalledTimes(2)
    expect(frame()).not.toBeNull()
  })

  test('a grant for another origin is never exchanged: the workspace is read back', async () => {
    const readBack = mock(() => {})
    issue.mockImplementationOnce(async () => ({ ...grant(), origin: 'https://pv-ffffffffffffffffffffffffffffffff.commerce.appthrust.test' }))
    await mount(stateWith(ready, readBack))
    expect(exchange).not.toHaveBeenCalled()
    expect(readBack).toHaveBeenCalledTimes(1)
    expect(frame()).toBeNull()
  })

  test('a viewer opened in the background asks for nothing until it is in the foreground', async () => {
    hidden = true
    await mount()
    expect(issue).not.toHaveBeenCalled()
    expect(container.textContent).toContain(copy.viewer.connecting)
    await setHidden(false)
    expect(issue).toHaveBeenCalledTimes(1)
    expect(frame()).not.toBeNull()
  })

  test('several viewers each hold their own session', async () => {
    await render(<>
      <ImplementPanel state={stateWith(ready)} released={false} onOpenPreview={() => {}} />
      <ImplementPanel state={stateWith(ready)} released={false} onOpenPreview={() => {}} />
    </>)
    expect(issue).toHaveBeenCalledTimes(2)
    expect(container.querySelectorAll('iframe')).toHaveLength(2)
    await advance(30_000)
    expect(issue).toHaveBeenCalledTimes(4)
  })

  test('a renewal that never settles ends the preview by the shown session\'s expiry', async () => {
    await mount()
    issue.mockImplementationOnce(() => Promise.withResolvers<PreviewSession>().promise)
    await advance(30_000)
    expect(issue).toHaveBeenCalledTimes(2)
    expect(frame()).not.toBeNull()
    await advance(24_999)
    expect(frame()).not.toBeNull()
    await advance(1)
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(copy.viewer.renewFailed)
  })

  test('a Platform clock far from this device\'s never shortens or stretches the session: a stalled renewal ends it 55 s after the grant was asked for', async () => {
    // This device's clock runs two minutes ahead of the Platform's: the grant's expiresAt already looks past.
    issue.mockImplementation(async () => ({ ...grant(), expiresAt: new Date(now - 120_000).toISOString() }))
    await mount()
    issue.mockImplementationOnce(() => Promise.withResolvers<PreviewSession>().promise)
    await advance(30_000)
    expect(frame()).not.toBeNull()
    await advance(24_999)
    expect(frame()).not.toBeNull()
    await advance(1)
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(copy.viewer.renewFailed)
  })

  test('a slow exchange does not extend the session: the deadline counts from the grant request', async () => {
    const slow = Promise.withResolvers<PreviewExchange>()
    exchange.mockImplementationOnce(() => slow.promise)
    await mount()
    await advance(10_000)
    await act(async () => { slow.resolve({ kind: 'ready' }) })
    expect(frame()).not.toBeNull()
    // Renewal at 40 s (30 s after the frame showed) stalls; the session asked for at 0 s ends at 55 s.
    issue.mockImplementationOnce(() => Promise.withResolvers<PreviewSession>().promise)
    await advance(30_000)
    expect(issue).toHaveBeenCalledTimes(2)
    await advance(14_999)
    expect(frame()).not.toBeNull()
    await advance(1)
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(copy.viewer.renewFailed)
  })

  test('an exchange that never settles fails the first connection after its bound', async () => {
    exchange.mockImplementationOnce(() => Promise.withResolvers<PreviewExchange>().promise)
    await mount()
    expect(container.textContent).toContain(copy.viewer.connecting)
    await advance(20_000)
    expect(frame()).toBeNull()
    expect(container.textContent).toContain(copy.viewer.failed)
  })

  test('unmounting stops renewing', async () => {
    await mount()
    await act(async () => { root.render(null) })
    await advance(120_000)
    expect(issue).toHaveBeenCalledTimes(1)
  })
})
