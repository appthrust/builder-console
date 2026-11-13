import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { consoleKeys } from '../../api/queries/console'
import { createConsoleApi } from '../../api/console-unverified'
import { createConsoleTransport } from '../../api/console'
import { createTestGateway } from '../../api/testing/gateway'
import { groupsContract } from '../../api/contracts/console/groups'
import { meContract } from '../../api/contracts/console/me'
import { consoleRoutes } from '../../dev/mock-console'
import { PublishStep } from './publish-step'

async function fixture(path: string, init?: RequestInit) {
  const url = new URL(path, 'http://mock.test')
  const response = await consoleRoutes(new Request(url, init), url)
  if (!response?.ok) throw new Error(`fixture ${path}: ${response?.status}`)
  return response
}

test.each(['private', 'group', 'company'] as const)('a fresh publish dialog uses draft name and audience %s, not stale console metadata', async (shareScope) => {
  const api = createConsoleApi(createConsoleTransport(fixture))
  const gateway = createTestGateway({ consoleFetch: fixture })
  const [me, groups, apps] = await Promise.all([gateway.console(meContract, undefined), gateway.console(groupsContract, undefined), api.apps.list({ scope: 'mine' })])
  const app = apps[0]!
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(consoleKeys.me, me)
  client.setQueryData(consoleKeys.groups, groups)
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <PublishStep app={{ ...app, displayName: '以前の名前', share: { scope: 'private', groupIds: [], extraPersonIds: [] } }} publishPreferences={{ name: '保存された名前', shareScope }} onPublished={() => {}} onCancel={() => {}} />
    </QueryClientProvider>)
    const container = document.createElement('div')
    container.innerHTML = html
    expect(container.querySelector<HTMLInputElement>('#publish-name')?.value).toBe('保存された名前')
    expect(container.querySelector<HTMLInputElement>(`input[value="${shareScope}"]`)?.checked).toBe(true)
    expect(html).not.toContain('以前の名前')
  } finally { client.clear() }
})
