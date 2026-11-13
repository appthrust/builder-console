import { ArrowDown, Lock, RefreshCw, ScrollText } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BusinessApp } from '../../model/contracts/console'
import { isLogsForbidden, type ComponentLogsQuery } from '../../api/queries/app'
import { copy, relativeTime } from '../../copy'
import type { AppView } from '../../model/app'
import { paths } from '../../routes/paths'
import { locale } from '../../shell/language'
import { Button, Card, CardBody, CardHeader, EmptyState, LinkButton, Loading, Notice } from '../../ui'
import { text } from './copy'
import { OwnerContact } from './owner-contact'
import { StaleNotice } from './notices'

/** Within this many pixels of the end the view counts as "following" new lines. */
const FOLLOW_SLACK_PX = 24

export function LogsTab({ app, view, logs, isAdmin }: {
  app: BusinessApp
  view: AppView
  logs: ComponentLogsQuery
  isAdmin: boolean
}) {
  const componentId = view.platform?.webComponentId
  const forbidden = isLogsForbidden(logs.error)
  const lead = !componentId ? text.logs.emptyLead
    : logs.pollingStopped ? text.logs.unavailableLead
      : logs.isError ? text.logs.retryingLead
        : logs.isPending ? text.logs.loadingLead : text.logs.lead
  const lines = logs.data?.lines ?? []
  const fetchedAt = logs.dataUpdatedAt ? relativeTime(new Date(logs.dataUpdatedAt).toISOString()) : undefined

  return (
    <div className="space-y-4">
      {view.status === 'failed' ? (
        <Notice
          tone="warning"
          title={text.logs.failedTitle}
          actions={
            <LinkButton size="sm" href={paths.app(app.group.path, app.slug, 'releases')}>
              {copy.app.overview.nextReleases}
            </LinkButton>
          }
        >
          {view.help ?? text.logs.failedBody}
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title={copy.app.logs.title}
          lead={lead}
          actions={
            componentId && !logs.isError ? (
              <div className="flex items-center gap-3">
                {fetchedAt ? <span className="hidden text-xs text-stone-500 sm:inline">{text.logs.fetchedAt(fetchedAt)}</span> : null}
                <Button
                  size="sm"
                  onClick={() => void logs.refetch()}
                  loading={logs.isFetching}
                  disabled={logs.isFetching}
                  icon={<RefreshCw aria-hidden className="size-4" />}
                >
                  {logs.isFetching ? text.logs.refreshing : text.logs.refresh}
                </Button>
              </div>
            ) : null
          }
        />
        <CardBody>
          {/* A failed refresh keeps the lines already read (a 403 does not: old access is not reused). */}
          {componentId && !forbidden && logs.isError && logs.data ? <div className="mb-3"><StaleNotice updatedAt={logs.dataUpdatedAt} refetching={logs.isFetching} onRetry={() => void logs.refetch()} /></div> : null}
          {!componentId ? (
            <EmptyState icon={<ScrollText aria-hidden className="size-5" />} title={text.logs.emptyLead} />
          ) : logs.isPending ? (
            <Loading />
          ) : forbidden ? (
            <Notice tone="warning" title={text.logs.forbiddenTitle} actions={
              <div className="flex flex-wrap gap-2">
                <OwnerContact app={app} />
                {isAdmin ? <LinkButton href="/-/admin/platform">{text.logs.platform}</LinkButton> : null}
                <LinkButton href="/help">{text.logs.help}</LinkButton>
              </div>
            }>
              <span className="inline-flex items-center gap-2"><Lock aria-hidden className="size-4 shrink-0" />{text.logs.forbiddenBody}</span>
            </Notice>
          ) : logs.isError && !logs.data ? (
            <Notice tone="error" title={text.logs.unavailable} actions={<Button size="sm" loading={logs.isFetching} onClick={() => void logs.refetch()}>{copy.common.retry}</Button>}>
              {logs.pollingStopped ? text.logs.unavailableLead : text.logs.retryingLead}
            </Notice>
          ) : lines.length === 0 && logs.isError ? null : logs.data?.pods.length === 0 ? (
            <Notice title={copy.app.logs.stopped} actions={
              view.url ? <LinkButton external href={view.url}>{copy.app.logs.open}</LinkButton> : null
            } />
          ) : lines.length === 0 ? (
            <EmptyState icon={<ScrollText aria-hidden className="size-5" />} title={copy.app.logs.empty} />
          ) : (
            <LogLines lines={lines} />
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function LogLines({ lines }: { lines: ReadonlyArray<{ timestamp?: string; text: string }> }) {
  const ref = useRef<HTMLPreElement>(null)
  // Follow new lines while the reader sits at the end; stay put when they scrolled up to read.
  const [following, setFollowing] = useState(true)
  const last = lines.at(-1)

  useLayoutEffect(() => {
    const element = ref.current
    if (element && following) element.scrollTop = element.scrollHeight
  }, [following, lines.length, last?.timestamp, last?.text])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const onScroll = () => setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX)
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="relative">
      <pre
        ref={ref}
        aria-label={text.logs.region}
        className="max-h-[32rem] min-h-40 overflow-auto rounded-md bg-stone-900 p-4 font-mono text-xs leading-relaxed text-stone-100"
        data-testid="logs"
        tabIndex={0}
      >
        {lines.map((line, index) => (
          <div key={`${line.timestamp ?? ''}-${index}`} className="break-all whitespace-pre-wrap">
            {line.timestamp ? (
              <span className="mr-3 text-stone-400 select-none">{new Date(line.timestamp).toLocaleTimeString(locale())}</span>
            ) : null}
            {line.text}
          </div>
        ))}
      </pre>
      {following ? null : (
        <Button
          size="sm"
          className="absolute right-4 bottom-4 shadow-md"
          icon={<ArrowDown aria-hidden className="size-4" />}
          onClick={() => setFollowing(true)}
        >
          {text.logs.jumpLatest}
        </Button>
      )}
    </div>
  )
}
