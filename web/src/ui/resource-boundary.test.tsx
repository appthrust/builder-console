import { expect, spyOn, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ResponseContractError } from '../api/boundary'
import { ConsoleApiError } from '../api/console'
import { copy } from '../copy'
import { ResourceBoundary, type ResourceQuery } from './resource-boundary'

const SECRET = 'SENTINEL-render-77aa'
const contractError = new ResponseContractError({ source: 'console', operationId: 'op', method: 'GET', routeTemplate: '/x', issues: [{ path: '/', code: 'invalid_type' }] })
const query = <T,>(patch: Partial<ResourceQuery<T>>): ResourceQuery<T> => ({ data: undefined, error: null, dataUpdatedAt: Date.now(), isFetching: false, refetch: () => {}, ...patch })

async function render(node: ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  return {
    text: () => container.textContent ?? '',
    html: () => container.innerHTML,
    cleanup: async () => {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

test('loading, contract failure, panel-specific HTTP failure, stale data with a warning', async () => {
  const views = [
    await render(<ResourceBoundary query={query<string>({})} resetKey="a">{(data) => data}</ResourceBoundary>),
    await render(<ResourceBoundary query={query<string>({ error: contractError })} resetKey="a" failure={() => 'panel failure'}>{(data) => data}</ResourceBoundary>),
    await render(<ResourceBoundary query={query<string>({ error: new ConsoleApiError(429, { error: 'too_many_requests' }) })} resetKey="a" failure={() => 'panel failure'}>{(data) => data}</ResourceBoundary>),
    await render(<ResourceBoundary query={query<string>({ data: 'last good', error: contractError })} resetKey="a">{(data) => data}</ResourceBoundary>),
  ]
  try {
    expect(views[0]!.text()).toContain(copy.common.loading)
    expect(views[1]!.text()).toContain(copy.common.loadFailed)
    expect(views[1]!.text()).not.toContain('panel failure')
    expect(views[1]!.text()).not.toContain(contractError.message)
    expect(views[2]!.text()).toBe('panel failure')
    expect(views[3]!.text()).toContain('last good')
    expect(views[3]!.text()).toContain(copy.common.refreshFailed(copy.relative.justNow))
  } finally {
    for (const view of views) await view.cleanup()
  }
})

test('a rejected sign-in stops showing what the old credentials could read', async () => {
  const view = await render(<ResourceBoundary query={query<string>({ data: 'secret list', error: new ORPCError('UNAUTHORIZED', { status: 401 }) })} resetKey="a">{(data) => data}</ResourceBoundary>)
  try {
    expect(view.text()).toContain(copy.common.accessDenied)
    expect(view.text()).not.toContain('secret list')
  } finally {
    await view.cleanup()
  }
})

test('a render crash stays in its panel with a fixed message; siblings keep rendering', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  function Crash(): ReactNode {
    throw new Error(SECRET)
  }
  const view = await render(
    <>
      <p>sibling composer</p>
      <ResourceBoundary query={query<string>({ data: 'x' })} resetKey="a">{() => <Crash />}</ResourceBoundary>
    </>,
  )
  try {
    expect(view.text()).toContain('sibling composer')
    expect(view.text()).toContain(copy.common.panelFailed)
    expect(view.html()).not.toContain(SECRET)
  } finally {
    await view.cleanup()
    logged.mockRestore()
  }
})
