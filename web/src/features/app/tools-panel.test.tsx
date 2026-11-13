import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConsoleApiError } from '../../api/console'
import { type AppTools } from '../../api/console-unverified'
import { APP_TOOLS_POLL_MS, appToolsQuery } from '../../api/queries/console'
import { POLL_INTERVAL_MS } from '../../api/queries/shared'
import { copy } from '../../copy'
import { text } from './copy'
import { ToolsPanel, ToolsPanelView } from './tools-panel'

const noop = () => undefined
const view = (tools: AppTools | undefined, error: unknown = null) => renderToStaticMarkup(<ToolsPanelView tools={tools} error={error} onRetry={noop} />)
const approvals = { slug: 'quote-approvals', name: '見積の承認', description: '承認待ちの見積を一覧します。', url: 'https://tools.pj-1.example.test/t/quote-approvals', liveReleaseNumber: 3 }
const search = { slug: 'quote-search', name: '見積の検索', description: '', url: 'https://tools.pj-1.example.test/t/quote-search', liveReleaseNumber: 1 }
const editUrl = 'https://tools.pj-1.example.test/edit'

test('without the Tools built-in app the panel is not rendered', () => {
  expect(view({ available: false })).toBe('')
})

test('while Tools installs the panel says so, with no tools and no create link', () => {
  const html = view({ available: false, pending: true })
  expect(html).toContain(text.tools.title)
  expect(html).toContain(text.tools.installing)
  expect(html).not.toContain(text.tools.create)
})

test('tools open on the Tools origin in a new tab; the create link appears only with editUrl', () => {
  const html = view({ available: true, tools: [approvals, search], editUrl })
  expect(html).toContain(approvals.name)
  expect(html).toContain(approvals.description)
  expect(html).toContain(search.name)
  expect(html).toContain(`href="${approvals.url}" target="_blank" rel="noreferrer noopener"`)
  expect(html).toContain(`aria-label="${text.tools.openLabel(approvals.name)}"`)
  expect(html).toContain(`href="${editUrl}"`)
  expect(html).toContain(text.tools.create)
  expect(view({ available: true, tools: [approvals] })).not.toContain(text.tools.create)
})

test('no tools yet: the empty state offers Create a tool to editors and stays a plain line for others', () => {
  const editor = view({ available: true, tools: [], editUrl })
  expect(editor).toContain(text.tools.empty)
  expect(editor).toContain(text.tools.emptyHint)
  expect(editor).toContain(`href="${editUrl}"`)
  const viewer = view({ available: true, tools: [] })
  expect(viewer).toContain(text.tools.empty)
  expect(viewer).not.toContain(text.tools.emptyHint)
  expect(viewer).not.toContain(text.tools.create)
})

test('an unreachable Tools built-in app reads as one line with a retry inside the panel, never an alert', () => {
  const html = view({ available: true, error: 'tools_unavailable', tools: [] })
  expect(html).toContain(text.tools.unavailable)
  expect(html).toContain(copy.common.retry)
  expect(html).not.toContain('role="alert"')
})

test('a failed read stays inside the panel; 403/404 hide it', () => {
  expect(view(undefined, new ConsoleApiError(500, { error: 'internal', message: 'boom' }))).toContain(text.tools.unavailable)
  expect(view(undefined, new ConsoleApiError(0, undefined))).toContain(text.tools.unavailable)
  expect(view(undefined, new ConsoleApiError(403, { error: 'forbidden', message: 'forbidden' }))).toBe('')
  expect(view(undefined, new ConsoleApiError(404, { error: 'not_found', message: 'not found' }))).toBe('')
  expect(view(undefined, null)).toBe('')
})

test('the tools read polls at the regular interval only while Tools installs', () => {
  const options = appToolsQuery('a-1')
  if (typeof options.refetchInterval !== 'function') throw new Error('Tools polling callback missing')
  const interval = (data: AppTools) => (options.refetchInterval as (query: unknown) => unknown)({ state: { data } })
  expect(interval({ available: false, pending: true })).toBe(POLL_INTERVAL_MS)
  expect(interval({ available: true, tools: [] })).toBe(APP_TOOLS_POLL_MS)
  expect(interval({ available: false })).toBe(APP_TOOLS_POLL_MS)
})

test('ToolsPanel follows the answer for an unbound app: a draft shows No tools yet without a create link', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const panel = () => renderToStaticMarkup(<QueryClientProvider client={client}><ToolsPanel appId="a-draft" /></QueryClientProvider>)
  expect(panel()).toBe('')
  // The server short-circuits an unbound app (no appName) to exactly this, for every role.
  client.setQueryData(appToolsQuery('a-draft').queryKey, (): AppTools => ({ available: true, tools: [] }))
  const html = panel()
  expect(html).toContain(text.tools.title)
  expect(html).toContain(text.tools.empty)
  expect(html).not.toContain(text.tools.create)
})
