// Browser-problem collector installed on every story's BrowserContext by the
// auto fixture in ./fixtures.ts. It watches every page, popup and iframe of the
// context and records what a user would experience as breakage:
//
// - `console.error` messages (warnings are counted separately, not failed);
// - uncaught exceptions and unhandled promise rejections (`weberror`);
// - transport failures (`requestfailed`) and HTTP 4xx/5xx responses, kept apart.
//   A GET the page ended itself is not a transport failure: aborted in the
//   very task that started it (React StrictMode's development-only double
//   effect), or its body cancelled after the response arrived. Neither is a
//   GET/HEAD the page started before the test called goto/reload/goBack/
//   goForward/close on it (the replaced or closed document's reads), nor a GET of an iframe
//   the page removed. Every other `net::ERR_ABORTED`, including a write or a
//   probe a timer aborted, fails;
// - the shared error boundary (`data-testid="console-error-boundary"`) ever
//   being inserted, observed with a MutationObserver so a transient boundary
//   that a retry replaces still counts;
// - rendered `undefined` / `NaN` text at the end of the test.
//
// A story that provokes a failure on purpose declares it with
// `withExpectedFailures` (exported from ./fixtures.ts). Each declaration names
// the operation (method + path pattern), the status or transport error, the
// exact count and the reason; it applies only while its action runs, and both
// a missing and an extra occurrence fail. Problems carry URL, method, status
// or message only, never request or response bodies.
import type { BrowserContext, ConsoleMessage, Frame, Page, Request, Response, WebError } from '@playwright/test'

export const ERROR_BOUNDARY_TEST_ID = 'console-error-boundary'

type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * One deliberately provoked failure: exactly `count` matching requests inside
 * the declaring step. A range (`{ min, max }`) is reserved for the debounced
 * URL-name probe (`freeUrlNameChecks`), whose number of checks depends on typing
 * and machine speed; every other declaration is exact.
 */
export type ExpectedFailure = {
  method: HttpMethod
  /**
   * The operation's URL pathname: either a pattern where `{name}` stands for one
   * path segment (`/api/v1/projects/{projectId}/publishes/{publishId}/access`),
   * or a RegExp tested against the pathname.
   */
  path: string | RegExp
  count: number | { min: number; max: number }
  /** Why the story provokes it; shown in the report and the step title. */
  reason: string
} & ({ status: number; transportError?: never } | { transportError: string; status?: never })

export type BrowserProblem =
  | { kind: 'console-error'; message: string; location?: string; page?: string }
  | { kind: 'page-error'; message: string; page?: string }
  | { kind: 'transport-failure'; method: string; url: string; resourceType: string; errorText: string; page?: string }
  | { kind: 'http-failure'; method: string; url: string; resourceType: string; status: number; statusText: string; page?: string }
  | { kind: 'error-boundary'; url: string; text: string }
  | { kind: 'rendered-text'; url: string; token: string; excerpt: string }

export interface BrowserProblemSummary {
  problems: BrowserProblem[]
  /** Satisfied `withExpectedFailures` declarations (for the evidence attachment). */
  expected: { reason: string; operation: string; failure: string; count: number }[]
  /**
   * `net::ERR_ABORTED` GETs the page ended itself: aborted in the task that
   * started them (StrictMode's double effect), body cancelled after the response, or
   * aborted through their own signal with no timeout (the page no longer needs them).
   */
  pageCancelled: Record<CancelCause, number>
  /** Reads a story navigation cut off (in flight on that page when it started). */
  navigationDiscarded: number
  /** GETs of an iframe the page removed while they loaded (the frame detached). */
  frameRemoved: number
  consoleWarnings: number
}

type NetworkFailure =
  | { kind: 'http-failure'; method: string; url: string; status: number }
  | { kind: 'transport-failure'; method: string; url: string; errorText: string }

interface ExpectationWindow {
  entries: { failure: ExpectedFailure; matcher: RegExp; observed: string[] }[]
  /** When the action returned; while settling, only requests started before it can still count. */
  actionEnded?: number
}

/** Text that is a defect wherever it is shown to a user. */
const RENDERED_TOKENS = /\b(undefined|NaN)\b/

/** Maximum characters kept from any browser-provided message. */
const MESSAGE_LIMIT = 500

/** How long a `withExpectedFailures` scope waits after its action for declared responses still in flight. */
const SETTLE_MS = 10_000

const BINDING = '__consoleE2EProblem'

// Runs in every frame before the document's scripts:
// - reports each insertion of the shared error boundary, so a boundary that a
//   retry replaces before the test ends is still counted;
// - reports the two ways the page itself ends a GET that Chromium then logs as
//   `net::ERR_ABORTED`, so they are not mistaken for transport failures:
//   * aborted within the very task that started it: React StrictMode's
//     development-only double effect (mount, cleanup, mount) cancels the first
//     request at once and sends it again. A timer, timeout, navigation or user
//     action always aborts in a later task, so those stay failures;
//   * the response arrived and the page cancelled its body (the preview probe
//     reads only the status). The status itself is still judged.
const PAGE_OBSERVER = `(() => {
  const send = (payload) => { try { window.${BINDING}(payload) } catch {} }
  const selector = '[data-testid="${ERROR_BOUNDARY_TEST_ID}"]'
  const seen = new WeakSet()
  const report = (element) => {
    if (seen.has(element)) return
    seen.add(element)
    send({ kind: 'error-boundary', url: location.href, text: (element.textContent || '').trim().slice(0, 300) })
  }
  const scan = (node) => {
    if (!(node instanceof Element)) return
    if (node.matches(selector)) report(node)
    for (const element of node.querySelectorAll(selector)) report(element)
  }
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) scan(node)
  }).observe(document, { childList: true, subtree: true })
  if (document.documentElement) scan(document.documentElement)

  const fetchBodies = new WeakMap()
  const cancel = ReadableStream.prototype.cancel
  ReadableStream.prototype.cancel = function (reason) {
    const owner = fetchBodies.get(this)
    if (owner) send({ kind: 'fetch-cancelled', cause: 'body', method: owner.method, url: owner.url })
    return cancel.call(this, reason)
  }
  const fetch = window.fetch
  window.fetch = function (input, init) {
    const request = input instanceof Request ? input : undefined
    const method = ((init && init.method) || (request && request.method) || 'GET').toUpperCase()
    const url = new URL(request ? request.url : String(input), location.href).href
    const signal = init && init.signal ? init.signal : request && request.signal
    if (signal && !signal.aborted) {
      let startingTask = true
      const channel = new MessageChannel()
      channel.port1.onmessage = () => { startingTask = false }
      channel.port2.postMessage(0)
      signal.addEventListener('abort', () => {
        if (startingTask) send({ kind: 'fetch-cancelled', cause: 'strict-mode', method, url })
        // The page aborted its own read through the request's signal with no timeout
        // (a query cancelled when its last observer unmounted or before a cache write).
        // It decided it no longer needs the answer. A timeout carries TimeoutError; the
        // preview probe's four-second timer aborts without one, so probes never count.
        else if (signal.reason?.name !== 'TimeoutError' && !url.includes('/proxy/preview/')) send({ kind: 'fetch-cancelled', cause: 'page-aborted', method, url })
      }, { once: true })
    }
    return fetch.apply(this, arguments).then((response) => {
      if (response.body) fetchBodies.set(response.body, { method, url })
      return response
    })
  }
})()`

function clip(text: string): string {
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text
}

function pathMatcher(path: string | RegExp): RegExp {
  if (path instanceof RegExp) return path
  const source = path
    .split(/(\{[^}/]+\})/)
    .map((part) => (/^\{[^}/]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${source}$`)
}

function describeFailure(failure: ExpectedFailure): string {
  return failure.transportError ?? `HTTP ${failure.status}`
}

function describeOperation(failure: ExpectedFailure): string {
  return `${failure.method} ${String(failure.path)}`
}

/** The accepted number of occurrences: exact by default, a range only where declared. */
export function bounds(failure: ExpectedFailure): { min: number; max: number } {
  return typeof failure.count === 'number' ? { min: failure.count, max: failure.count } : failure.count
}

export function describeCount(failure: ExpectedFailure): string {
  const { min, max } = bounds(failure)
  return min === max ? String(min) : `${min}–${max}`
}

/** The one declaration allowed a range: the create wizard's debounced URL-name check. */
function isUrlNameProbe(failure: ExpectedFailure): boolean {
  return failure.method === 'GET' && failure.path === '/api/console/resolve' && failure.status === 404
}

function pageUrl(page: Page | null | undefined): string | undefined {
  if (!page || page.isClosed()) return undefined
  return page.url()
}

function frameUrl(frame: Frame | null | undefined): string | undefined {
  try {
    return frame?.url()
  } catch {
    return undefined
  }
}

function requestPage(request: Request): string | undefined {
  try {
    return pageUrl(request.frame().page())
  } catch {
    // Service-worker and detached-frame requests have no page.
    return undefined
  }
}

type TransportProblem = Extract<BrowserProblem, { kind: 'transport-failure' }>
type CancelCause = 'strict-mode' | 'body' | 'page-aborted'
/** One navigation of a page: test-driven (ends when the call returns) or a document request (ends at commit). */
type NavigationWindow = { start: number; end?: number; byDocument: boolean }

function problem(request: Request, failure: NetworkFailure, errorText: string): TransportProblem {
  return {
    kind: 'transport-failure', method: failure.method, url: failure.url, errorText,
    resourceType: request.resourceType(), page: requestPage(request),
  }
}

function requestFrame(request: Request): Frame | undefined {
  try {
    return request.frame()
  } catch {
    return undefined
  }
}

function requestOwner(request: Request): Page | undefined {
  try {
    return request.frame().page()
  } catch {
    return undefined
  }
}

export class BrowserProblemCollector {
  private readonly problems: BrowserProblem[] = []
  /** Every failed request (problem or expected), for attributing Chrome's "Failed to load resource" echoes. */
  private readonly networkFailures: NetworkFailure[] = []
  private readonly resourceEchoes: { message: string; location: string; page?: string }[] = []
  private readonly windows: ExpectationWindow[] = []
  private readonly satisfied: BrowserProblemSummary['expected'] = []
  /** `net::ERR_ABORTED` reads judged at the end: not a problem only when the page reported ending them. */
  private readonly abortedReads: TransportProblem[] = []
  /** Page-reported cancellations by `METHOD url`, not yet matched to a failed request. */
  private readonly cancellations = new Map<string, CancelCause[]>()
  /** Every test-driven navigation per page: when it was called and when it returned. */
  private readonly navigations = new Map<Page, NavigationWindow[]>()
  /** When each request was reported (Playwright's own timing is empty for a request that never got a response). */
  private readonly requestSeen = new WeakMap<Request, number>()
  /** The window each main-frame document request opened, removed again if that request fails. */
  private readonly documentWindows = new WeakMap<Request, { windows: NavigationWindow[]; window: NavigationWindow }>()
  private navigationDiscarded = 0
  private frameRemoved = 0
  private consoleWarnings = 0

  private constructor(private readonly context: BrowserContext) {}

  /** Attaches to `context` before any story navigation. */
  static async install(context: BrowserContext): Promise<BrowserProblemCollector> {
    const collector = new BrowserProblemCollector(context)
    await context.exposeBinding(BINDING, (_source, payload: unknown) => collector.onBinding(payload))
    await context.addInitScript({ content: PAGE_OBSERVER })
    context.on('request', (request) => collector.onRequest(request))
    context.on('response', (response) => collector.onResponse(response))
    context.on('requestfailed', (request) => collector.onRequestFailed(request))
    context.on('console', (message) => collector.onConsole(message))
    context.on('weberror', (error) => collector.onWebError(error))
    for (const page of context.pages()) collector.scopeNavigations(page)
    context.on('page', (page) => collector.scopeNavigations(page))
    return collector
  }

  /**
   * The navigation scope. The replaced document keeps running until the new
   * one commits, so a GET/HEAD it started before the navigation landed is its
   * read; when such a read fails with `net::ERR_ABORTED` during the navigation
   * (or within a second of its end, for event delivery), it is not a failure.
   * A navigation is a test-driven `goto`/`reload`/`goBack`/`goForward`/`close`
   * (until the call returns; closing a tab ends its document the same way) or
   * any main-frame document request, such as a followed link (until the main
   * frame commits). Writes and later aborts stay judged.
   */
  private scopeNavigations(page: Page) {
    const windows: NavigationWindow[] = []
    this.navigations.set(page, windows)
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      const now = Date.now()
      for (const window of windows) if (window.end === undefined && window.byDocument) window.end = now
    })
    for (const name of ['goto', 'reload', 'goBack', 'goForward', 'close'] as const) {
      const navigate = page[name].bind(page) as (...args: unknown[]) => Promise<Response | null | void>
      Object.assign(page, {
        [name]: async (...args: unknown[]) => {
          const window: NavigationWindow = { start: Date.now(), byDocument: false }
          windows.push(window)
          try {
            return await navigate(...args)
          } finally {
            window.end = Date.now()
          }
        },
      })
    }
  }

  private onRequest(request: Request) {
    const now = Date.now()
    this.requestSeen.set(request, now)
    if (!request.isNavigationRequest()) return
    const frame = requestFrame(request)
    const page = requestOwner(request)
    const windows = page ? this.navigations.get(page) : undefined
    if (!frame || !page || frame !== page.mainFrame() || !windows) return
    const window: NavigationWindow = { start: now, byDocument: true }
    windows.push(window)
    this.documentWindows.set(request, { windows, window })
  }

  /** A document load that failed replaced nothing: its window covers no read. */
  private dropDocumentWindow(request: Request) {
    const opened = this.documentWindows.get(request)
    if (!opened) return
    const index = opened.windows.indexOf(opened.window)
    if (index >= 0) opened.windows.splice(index, 1)
  }

  private cutOffByNavigation(request: Request): boolean {
    if (request.isNavigationRequest()) return false
    if (request.method() !== 'GET' && request.method() !== 'HEAD') return false
    const owner = requestOwner(request)
    const started = this.requestSeen.get(request) ?? 0
    const windows = owner ? this.navigations.get(owner) : undefined
    const now = Date.now()
    return started > 0 && !!windows && windows.some((window) =>
      window.start <= now && (window.end === undefined || (started <= window.end && now <= window.end + 1_000)))
  }

  /**
   * Runs `action` with `expected` failures allowed. Matching responses inside
   * the action are attributed to the declaration instead of being problems.
   * The scope then stays open until every entry has its declared count (at most
   * `SETTLE_MS`), so a count never depends on whether the UI rendered before the
   * response event arrived. While settling, only requests started before the
   * action returned can count: a later poll or retry on the same route is an
   * ordinary problem, never a substitute. Afterwards every entry must match exactly.
   */
  async expectFailures(expected: readonly ExpectedFailure[], action: () => Promise<void>): Promise<void> {
    if (expected.length === 0) throw new Error('withExpectedFailures needs at least one expected failure')
    for (const failure of expected) {
      const { min, max } = bounds(failure)
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) throw new Error(`Expected failure count must be a positive integer or a { min, max } range: ${describeOperation(failure)} (${failure.reason})`)
      if (typeof failure.count !== 'number' && !isUrlNameProbe(failure)) throw new Error(`Only the create wizard's URL-name probe (GET /api/console/resolve 404) may declare a range; declare an exact count: ${describeOperation(failure)} (${failure.reason})`)
      if ((failure.status === undefined) === (failure.transportError === undefined)) throw new Error(`Expected failure needs exactly one of status or transportError: ${describeOperation(failure)} (${failure.reason})`)
      if (!failure.reason.trim()) throw new Error(`Expected failure needs a reason: ${describeOperation(failure)}`)
    }
    const window: ExpectationWindow = {
      entries: expected.map((failure) => ({ failure, matcher: pathMatcher(failure.path), observed: [] })),
    }
    this.windows.push(window)
    try {
      await action()
      window.actionEnded = Date.now()
      const deadline = window.actionEnded + SETTLE_MS
      while (window.entries.some((entry) => entry.observed.length < bounds(entry.failure).min) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } finally {
      this.windows.splice(this.windows.indexOf(window), 1)
    }
    const mismatches = window.entries.filter((entry) => {
      const { min, max } = bounds(entry.failure)
      return entry.observed.length < min || entry.observed.length > max
    })
    if (mismatches.length > 0) {
      throw new Error([
        'Expected failures did not occur exactly as declared:',
        ...mismatches.map(({ failure, observed }) =>
          `  - ${describeFailure(failure)} ${describeOperation(failure)}: expected ${describeCount(failure)}, observed ${observed.length} (${failure.reason})${observed.length ? `\n      ${observed.join('\n      ')}` : ''}`),
      ].join('\n'))
    }
    for (const { failure, observed } of window.entries) {
      this.satisfied.push({ reason: failure.reason, operation: describeOperation(failure), failure: describeFailure(failure), count: observed.length })
    }
  }

  /** Scans the open pages for rendered `undefined`/`NaN` and returns everything collected. */
  async finish(): Promise<BrowserProblemSummary> {
    for (const page of this.context.pages()) {
      if (page.isClosed()) continue
      for (const frame of page.frames()) await this.scanRenderedText(frame)
    }
    const pageCancelled: Record<CancelCause, number> = { 'strict-mode': 0, body: 0, 'page-aborted': 0 }
    const unmatchedAborts = this.abortedReads.filter((read) => {
      const cause = this.cancellations.get(`${read.method} ${read.url}`)?.shift()
      if (!cause) return true
      pageCancelled[cause]++
      return false
    })
    const echoes = this.resourceEchoes
      .filter((echo) => !this.networkFailures.some((failure) => failure.url === echo.location))
      .map((echo): BrowserProblem => ({ kind: 'console-error', message: echo.message, location: echo.location, page: echo.page }))
    return {
      problems: [...this.problems, ...unmatchedAborts, ...echoes],
      expected: this.satisfied,
      pageCancelled,
      navigationDiscarded: this.navigationDiscarded,
      frameRemoved: this.frameRemoved,
      consoleWarnings: this.consoleWarnings,
    }
  }

  private onBinding(payload: unknown) {
    if (!payload || typeof payload !== 'object' || !('kind' in payload)) return
    if (payload.kind === 'fetch-cancelled') {
      const { cause, method, url } = payload as { cause?: unknown; method?: unknown; url?: unknown }
      if (cause !== 'strict-mode' && cause !== 'body' && cause !== 'page-aborted') return
      const key = `${String(method)} ${String(url)}`
      const causes = this.cancellations.get(key)
      if (causes) causes.push(cause)
      else this.cancellations.set(key, [cause])
      return
    }
    if (payload.kind !== 'error-boundary') return
    const { url, text } = payload as { url?: unknown; text?: unknown }
    this.problems.push({ kind: 'error-boundary', url: String(url), text: clip(String(text ?? '')) })
  }

  private onResponse(response: Response) {
    const status = response.status()
    if (status < 400) return
    const request = response.request()
    const failure: NetworkFailure = { kind: 'http-failure', method: request.method(), url: response.url(), status }
    this.networkFailures.push(failure)
    if (this.attribute(failure, request)) return
    this.problems.push({
      kind: 'http-failure', method: failure.method, url: failure.url, status, statusText: response.statusText(),
      resourceType: request.resourceType(), page: requestPage(request),
    })
  }

  private onRequestFailed(request: Request) {
    this.dropDocumentWindow(request)
    const errorText = request.failure()?.errorText ?? 'unknown'
    const failure: NetworkFailure = { kind: 'transport-failure', method: request.method(), url: request.url(), errorText }
    this.networkFailures.push(failure)
    if (this.attribute(failure, request)) return
    if (errorText === 'net::ERR_ABORTED' && this.cutOffByNavigation(request)) {
      this.navigationDiscarded++
      return
    }
    if (errorText === 'net::ERR_ABORTED' && failure.method === 'GET' && requestFrame(request)?.isDetached()) {
      this.frameRemoved++
      return
    }
    if (errorText === 'net::ERR_ABORTED' && (failure.method === 'GET' || failure.method === 'HEAD')) {
      // The page's cancellation report and the network failure arrive on
      // different channels; pair them once the test is over.
      this.abortedReads.push(problem(request, failure, errorText))
      return
    }
    this.problems.push(problem(request, failure, errorText))
  }

  private attribute(failure: NetworkFailure, request: Request): boolean {
    const pathname = new URL(failure.url).pathname
    const started = this.requestSeen.get(request) ?? Number.POSITIVE_INFINITY
    for (let index = this.windows.length - 1; index >= 0; index--) {
      const window = this.windows[index]!
      // A request the page started after the action returned (a later poll or retry) is not the action's failure.
      if (window.actionEnded !== undefined && started > window.actionEnded) continue
      for (const entry of window.entries) {
        const expected = entry.failure
        if (expected.method !== failure.method || !entry.matcher.test(pathname)) continue
        if (failure.kind === 'http-failure' ? expected.status !== failure.status : expected.transportError !== failure.errorText) continue
        entry.observed.push(`${failure.method} ${failure.url}`)
        return true
      }
    }
    return false
  }

  private onConsole(message: ConsoleMessage) {
    const type = message.type()
    if (type === 'warning') {
      this.consoleWarnings++
      return
    }
    if (type !== 'error') return
    const text = message.text()
    const { url, lineNumber, columnNumber } = message.location()
    const page = pageUrl(message.page())
    // Chrome echoes every failed resource load as a console error located at
    // the resource URL. The request itself is judged (problem or expected).
    if (text.startsWith('Failed to load resource') && url) {
      this.resourceEchoes.push({ message: clip(text), location: url, page })
      return
    }
    this.problems.push({ kind: 'console-error', message: clip(text), location: url ? `${url}:${lineNumber}:${columnNumber}` : undefined, page })
  }

  private onWebError(error: WebError) {
    const thrown = error.error()
    this.problems.push({ kind: 'page-error', message: clip(thrown.stack ?? `${thrown.name}: ${thrown.message}`), page: pageUrl(error.page()) })
  }

  private async scanRenderedText(frame: Frame) {
    let found: { token: string; excerpt: string }[]
    try {
      found = await frame.evaluate((source) => {
        const pattern = new RegExp(source, 'g')
        const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/
        const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT)
        const hits: { token: string; excerpt: string }[] = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.parentElement && skip.test(node.parentElement.tagName)) continue
          const text = node.textContent ?? ''
          for (const match of text.matchAll(pattern)) {
            const start = Math.max(0, match.index - 40)
            hits.push({ token: match[0], excerpt: text.slice(start, match.index + match[0].length + 40).trim() })
          }
        }
        return hits
      }, RENDERED_TOKENS.source)
    } catch {
      // A frame that navigated or detached during teardown has nothing left to read.
      return
    }
    const url = frameUrl(frame) ?? 'unknown'
    for (const hit of found) this.problems.push({ kind: 'rendered-text', url, token: hit.token, excerpt: clip(hit.excerpt) })
  }
}

/** Human-readable failure message: one line per problem, URL/method/status or message, no bodies. */
export function formatBrowserProblems(problems: readonly BrowserProblem[]): string {
  const lines = problems.map((problem, index) => {
    const on = (page?: string) => (page ? ` [page ${page}]` : '')
    switch (problem.kind) {
      case 'console-error':
        return `${index + 1}. console.error: ${problem.message}${problem.location ? ` (at ${problem.location})` : ''}${on(problem.page)}`
      case 'page-error':
        return `${index + 1}. uncaught error: ${problem.message}${on(problem.page)}`
      case 'transport-failure':
        return `${index + 1}. transport failure ${problem.errorText}: ${problem.method} ${problem.url} (${problem.resourceType})${on(problem.page)}`
      case 'http-failure':
        return `${index + 1}. HTTP ${problem.status}${problem.statusText ? ` ${problem.statusText}` : ''}: ${problem.method} ${problem.url} (${problem.resourceType})${on(problem.page)}`
      case 'error-boundary':
        return `${index + 1}. error boundary shown at ${problem.url}: ${problem.text}`
      case 'rendered-text':
        return `${index + 1}. rendered "${problem.token}" at ${problem.url}: …${problem.excerpt}…`
    }
  })
  return [
    `Browser problems (${problems.length}). Declare a deliberately provoked failure with withExpectedFailures(); anything else is a defect:`,
    ...lines.map((line) => `  ${line}`),
  ].join('\n')
}
