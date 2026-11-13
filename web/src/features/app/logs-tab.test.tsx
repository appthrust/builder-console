import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { businessAppOf } from '../../api/testing/app-domain'
import type { ComponentLogsQuery } from '../../api/queries/app'
import { copy } from '../../copy'
import type { AppView } from '../../model/app'
import { LogsTab } from './logs-tab'

const person = { id: 'person-1', subject: 'tester', pending: false, email: 'tester@example.test', displayName: 'Tester', avatarVersion: null }
const app = businessAppOf({
  id: 'app-1', slug: 'shop', displayName: 'Shop', description: '', icon: '', tags: [], guide: '', capabilities: [], screenshots: [],
  group: { id: 'sales', path: 'sales', name: 'Sales' }, owners: [person],
  stackId: 'shop-stack', appName: 'shop', share: { scope: 'public', groupIds: [], extraPersonIds: [] },
  createdBy: person, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z',
})
const view: AppView = {
  status: 'live', label: '公開中', text: '', second: '', draft: false, url: 'https://shop.example.test/',
  platform: {
    id: 'shop', name: 'Shop', status: 'live', statusText: '', branchId: 'production', webComponentId: 'shop-web',
    facts: { webReady: true, everReleased: true, hasPublish: true },
  },
}
const logs: ComponentLogsQuery = {
  data: { pods: [], lines: [], message: 'No workload pods are running yet.' },
  error: null, isError: false, isPending: false, isFetching: false,
  dataUpdatedAt: 0, pollingStopped: false, refetch: async () => undefined,
}

test('no pods shows the stopped notice with an external open link to the published app', () => {
  const html = renderToStaticMarkup(<LogsTab app={app} view={view} logs={logs} isAdmin={false} />)
  expect(html).toContain('いまは停止中です。アプリを開くと起動し、ログが出ます。')
  expect(html).toContain('href="https://shop.example.test/"')
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noreferrer noopener"')
  expect(html).toContain('開く ↗')
  expect(html).not.toContain(copy.app.logs.empty)
})

test('pods with no lines retain the empty log message, not the stopped notice', () => {
  const html = renderToStaticMarkup(<LogsTab app={app} view={view} logs={{ ...logs, data: { pods: [{ name: 'web-pod' }], lines: [] } }} isAdmin={false} />)
  expect(html).toContain(copy.app.logs.empty)
  expect(html).not.toContain(copy.app.logs.stopped)
})

test('no published URL shows the stopped notice without inventing a destination', () => {
  const html = renderToStaticMarkup(<LogsTab app={app} view={{ ...view, url: undefined }} logs={logs} isAdmin={false} />)
  expect(html).toContain(copy.app.logs.stopped)
  expect(html).not.toContain(copy.app.logs.open)
})

test('pending and failed requests do not mistake cached empty pods for a stopped app', () => {
  for (const state of [{ isPending: true }, { isError: true, error: new Error('unavailable') }]) {
    const html = renderToStaticMarkup(<LogsTab app={app} view={view} logs={{ ...logs, ...state }} isAdmin={false} />)
    expect(html).not.toContain(copy.app.logs.stopped)
    expect(html).not.toContain(copy.app.logs.empty)
  }
})

test('pods with lines render the logs rather than either empty state', () => {
  const html = renderToStaticMarkup(<LogsTab app={app} view={view} logs={{ ...logs, data: { pods: [{ name: 'web-pod' }], lines: [{ text: 'production started' }] } }} isAdmin={false} />)
  expect(html).toContain('production started')
  expect(html).not.toContain(copy.app.logs.stopped)
  expect(html).not.toContain(copy.app.logs.empty)
})
