// Panel/card-level boundary for one server resource (design §7). It turns a
// query snapshot into exactly one of: loading, first-load failure, the
// content, or the content with a stale warning; and contains a render crash
// of the content to this panel. Siblings (composers, other panels) stay usable.
// It never shows an error's text or any payload: a contract failure always
// reads as the fixed "could not load" message with a retry.
import { RotateCw } from 'lucide-react'
import { Component, type ReactNode } from 'react'
import { isResponseContractError } from '../api/boundary'
import { copy, relativeTime } from '../copy'
import { Button } from './button'
import { isSignInError, LoadFailed, Loading, Notice } from './feedback'

/** The part of a React Query result the boundary reads. */
export interface ResourceQuery<T> {
  data: T | undefined
  error: unknown
  /** When `data` was last read successfully (unchanged by a failed refetch). */
  dataUpdatedAt: number
  isFetching: boolean
  refetch: () => unknown
}

export function ResourceBoundary<T>({
  query,
  resetKey,
  loading,
  failure,
  children,
}: {
  query: ResourceQuery<T>
  /** Identity of the resource (entity id or serialized query key): a new resource drops an earlier render failure. */
  resetKey: string
  loading?: ReactNode
  /**
   * How this panel explains a failed first load that is an HTTP answer
   * (e.g. a coded 4xx). Contract failures and sign-in failures never reach it.
   */
  failure?: (error: unknown, retry: () => void) => ReactNode
  children: (data: T) => ReactNode
}) {
  const retry = () => void query.refetch()
  const { data, error } = query
  // A rejected sign-in must not keep showing what the old credentials could read.
  if (error && isSignInError(error)) return <LoadFailed error={error} onRetry={retry} />
  if (data === undefined) {
    if (!error) return loading ?? <Loading />
    return failure && !isResponseContractError(error) ? failure(error, retry) : <LoadFailed error={error} onRetry={retry} />
  }
  return (
    <>
      {error ? (
        <Notice
          tone="warning"
          className="mb-3"
          actions={<Button size="sm" icon={<RotateCw />} loading={query.isFetching} onClick={retry}>{copy.common.retry}</Button>}
        >
          {copy.common.refreshFailed(relativeTime(new Date(query.dataUpdatedAt).toISOString()) ?? '')}
        </Notice>
      ) : null}
      <RenderBoundary resetKey={resetKey} onRetry={retry}>
        <Deferred render={() => children(data)} />
      </RenderBoundary>
    </>
  )
}

/** Renders the content inside the error boundary, so a throw while rendering it is caught there. */
function Deferred({ render }: { render: () => ReactNode }) {
  return render()
}

type RenderBoundaryProps = { resetKey: string; onRetry: () => void; children: ReactNode }

class RenderBoundary extends Component<RenderBoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidUpdate(previous: RenderBoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false })
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <Notice
        tone="error"
        title={copy.common.panelFailed}
        actions={
          <Button size="sm" icon={<RotateCw />} onClick={() => {
            this.setState({ failed: false })
            this.props.onRetry()
          }}>
            {copy.common.retry}
          </Button>
        }
      />
    )
  }
}
