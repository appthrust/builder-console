// 「このアプリのツール」 (Built-in app Connect, console-tools.md §1): tools published by the Tools built-in app that read this
// app's data and that the viewer may use. Hidden when the project has no Tools built-in app; one calm line while it
// installs; a failure stays inside the panel and never takes the app page down.
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ArrowUpRight, Clock, Plus, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import { ConsoleApiError, type AppTool, type AppTools } from '../../api/console'
import { appToolsQuery } from '../../api/queries'
import { copy } from '../../copy'
import { Button, LinkButton, Section } from '../../ui'
import { text } from './copy'

/** Response-driven for every app, drafts included: the server answers an unbound app with `{available: true, tools: []}`. */
export function ToolsPanel({ appId }: { appId: string }) {
  const tools = useQuery(appToolsQuery(appId))
  if (tools.isPending) return null
  return <ToolsPanelView tools={tools.data} error={tools.error} retrying={tools.isFetching} onRetry={() => void tools.refetch()} />
}

export function ToolsPanelView({ tools, error, retrying = false, onRetry }: {
  tools: AppTools | undefined
  error: unknown
  retrying?: boolean
  onRetry(): void
}) {
  if (!tools) {
    // 403/404: the caller cannot see this app's tools (or the server predates them), so there is nothing to show.
    if (!error || (error instanceof ConsoleApiError && (error.status === 403 || error.status === 404))) return null
    return <Frame><Unavailable retrying={retrying} onRetry={onRetry} /></Frame>
  }
  if (!tools.available) {
    if (!tools.pending) return null
    return <Frame><Calm icon={<Clock />}>{text.tools.installing}</Calm></Frame>
  }
  const create = tools.editUrl ? (
    <LinkButton href={tools.editUrl} external size="sm" icon={<Plus />} data-testid="app-tools-create">
      {text.tools.create}
    </LinkButton>
  ) : undefined
  if (tools.error === 'tools_unavailable') return <Frame><Unavailable retrying={retrying} onRetry={onRetry} /></Frame>
  if (tools.tools.length === 0) {
    return (
      <Frame>
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-stone-300 px-4 py-5 sm:flex-row sm:items-center sm:justify-between" data-testid="app-tools-empty">
          <div className="min-w-0">
            <p className="text-sm font-medium text-stone-800">{text.tools.empty}</p>
            {create ? <p className="mt-0.5 text-sm text-stone-500">{text.tools.emptyHint}</p> : null}
          </div>
          {create}
        </div>
      </Frame>
    )
  }
  return (
    <Frame actions={create}>
      <ul className="grid gap-3 sm:grid-cols-2" data-testid="app-tools">
        {tools.tools.map((tool) => <ToolCard key={tool.slug} tool={tool} />)}
      </ul>
    </Frame>
  )
}

function ToolCard({ tool }: { tool: AppTool }) {
  return (
    <li className="flex min-w-0 items-start gap-3 rounded-lg border border-line bg-surface p-4" data-testid={`app-tool-${tool.slug}`}>
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-600 [&_svg]:size-4">
        <Wrench />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="break-words text-sm font-semibold text-stone-900">{tool.name}</h3>
        {tool.description ? <p className="mt-0.5 line-clamp-2 break-words text-sm text-stone-600">{tool.description}</p> : null}
      </div>
      <LinkButton href={tool.url} external size="sm" icon={<ArrowUpRight />} aria-label={text.tools.openLabel(tool.name)} className="shrink-0">
        {text.tools.open}
      </LinkButton>
    </li>
  )
}

function Frame({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <Section title={text.tools.title} lead={text.tools.lead} actions={actions}>
      {children}
    </Section>
  )
}

function Unavailable({ retrying, onRetry }: { retrying: boolean; onRetry(): void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-testid="app-tools-unavailable">
      <Calm icon={<AlertCircle />}>{text.tools.unavailable}</Calm>
      <Button size="sm" tone="ghost" onClick={onRetry} disabled={retrying}>{copy.common.retry}</Button>
    </div>
  )
}

function Calm({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-stone-600 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-stone-400">
      <span aria-hidden className="contents">{icon}</span>
      <span>{children}</span>
    </p>
  )
}
