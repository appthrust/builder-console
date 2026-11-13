import { expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ResourceBoundary } from '../../../ui/resource-boundary'
import { copy } from '../../../copy'
import { createTestGateway } from '../../testing/gateway'
import { retryQuery } from '../../queries/shared'
import type { ConsoleOperationContract } from '../define'
import { consoleContracts } from './operations'

interface Fixture { name: string; schema: string; body: unknown }
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL('../../../../../cmd/server/internal/api/testdata/console-wire.json', import.meta.url), 'utf8'))
const SECRET = 'SENTINEL-console-recovery-93ea'

for (const [name, schema, base] of [
  ['me', 'Me', consoleContracts.me], ['config', 'Config', consoleContracts.config], ['app', 'App', consoleContracts.app],
] as const) {
  test(`${name}: first malformed, last-good tick, recovery preserve sibling and unsent input`, async () => {
    const good = fixtures.find((fixture) => fixture.schema === schema)!.body
    let body: unknown = { [SECRET]: SECRET }
    const fetch = mock(async () => Response.json(body))
    const reports: unknown[] = []
    const gateway = createTestGateway({ consoleFetch: fetch, reportFailure: (report) => { reports.push(report) } })
    const contract: ConsoleOperationContract<undefined, unknown> = { ...base, request: () => ({ method: 'GET', path: base.routeTemplate.replace('{id}', 'app') }) }
    const client = new QueryClient({ defaultOptions: { queries: { retry: retryQuery, retryDelay: 0 } } })
    const options = { queryKey: ['wire-recovery', name], queryFn: () => gateway.console(contract, undefined), enabled: false, staleTime: 0 }
    const observer = new QueryObserver(client, options)
    const unsubscribe = observer.subscribe(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    async function render() {
      await act(async () => { root.render(<>
        <aside>Independent sibling</aside><textarea aria-label="Unsent message" defaultValue="Draft" />
        <ResourceBoundary query={observer.getCurrentResult()} resetKey={name}>{() => <p>Validated resource</p>}</ResourceBoundary>
      </>) })
    }
    try {
      await expect(client.fetchQuery(options)).rejects.toMatchObject({ code: 'response_contract_invalid' })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(options.queryKey)).toBeUndefined()
      await render()
      expect(container.textContent).toContain(copy.common.loadFailed)
      expect(container.textContent).not.toContain('Validated resource')
      expect(container.textContent).toContain('Independent sibling')
      const input = container.querySelector('textarea')!
      input.value = 'Unsent user work'
      body = good
      const lastGood = await client.fetchQuery(options)
      const timestamp = client.getQueryState(options.queryKey)!.dataUpdatedAt
      await render()
      expect(container.textContent).toContain('Validated resource')
      body = { [SECRET]: SECRET }
      await expect(client.fetchQuery(options)).rejects.toMatchObject({ code: 'response_contract_invalid' })
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(client.getQueryData<unknown>(options.queryKey)).toBe(lastGood)
      expect(client.getQueryState(options.queryKey)!.dataUpdatedAt).toBe(timestamp)
      await render()
      expect(container.textContent).toContain('Validated resource')
      expect(container.textContent).toContain(copy.common.refreshFailed(copy.relative.justNow))
      expect(container.textContent).toContain('Independent sibling')
      expect(container.querySelector('textarea')).toBe(input)
      expect(input.value).toBe('Unsent user work')
      expect(container.innerHTML).not.toContain(SECRET)
      expect(JSON.stringify(reports)).not.toContain(SECRET)
      body = good
      await client.fetchQuery(options)
      await render()
      expect(container.textContent).not.toContain(copy.common.refreshFailed(copy.relative.justNow))
      expect(container.textContent).toContain('Validated resource')
      expect(input.value).toBe('Unsent user work')
      expect(fetch).toHaveBeenCalledTimes(4)
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
      unsubscribe()
      observer.destroy()
      client.clear()
    }
  })
}
