// 基盤の設定 → 新しい置き場の作成先: where new repositories (ひな形, AI) go.
// The effective destination is the Platform API's resolution; the Project
// default is read and written through the Platform API settings route (Channel
// A: Idempotency-Key + If-Match from the GET's ETag). Nothing is stored in the
// console. The environment default is edited in the Dashboard only.
import type { GitHubSourceConnection, RegistryConnection } from '@appthrust/api-schema/platform-api'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { FolderGit2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { client } from '../../api/client'
import type { Me } from '../../api/console'
import { platformErrorEnvelope } from '../../api/platform-error'
import { keys, repositoryDestinationSettingsQuery, useDashboardSettingsUrl, type CreateConnections } from '../../api/queries'
import type { RepositoryDestinationSelection } from '../../api/repository-destination'
import { copy } from '../../copy'
import { destinationProblem, resolvedDestination } from '../../model/create'
import { Button, Card, CardBody, CardHeader, Field, LinkButton, LoadFailed, Notice, Select, Skeleton } from '../../ui'
import { text } from './copy'

/** Select values must be non-empty: these stand for "no Project default" and "let the platform pick". */
const INHERIT = '__inherit__'
const AUTO = '__auto__'
/** The settings PUT's concurrency answer (any other 412 is a blocked destination). */
const SETTINGS_CHANGED = 'repository_destination_settings_changed'

type Outcome = { kind: 'saved' } | { kind: 'changed' } | { kind: 'forbidden' } | { kind: 'failed'; message?: string }

export function RepositoryDestinationSetting({ me, connections }: { me: Me; connections: UseQueryResult<CreateConnections> }) {
  const t = text.destination
  const settings = useQuery(repositoryDestinationSettingsQuery(me.projectId))
  const dashboardUrl = useDashboardSettingsUrl()
  const environmentUrl = dashboardUrl ? new URL('/dashboard/github-apps#repository-destination-default', dashboardUrl).href : undefined
  const sources = (connections.data?.sources ?? []).filter((source) => source.capabilities.includes('createRepositories'))
  const registries = connections.data?.registries ?? []
  const declared = settings.data?.settings.defaultDestination ?? null

  return (
    <section id="repository-destination" aria-labelledby="repository-destination-title" className="scroll-mt-24">
      <Card>
        <CardHeader title={<span id="repository-destination-title">{t.title}</span>} lead={t.lead} />
        <CardBody className="space-y-5">
          <Effective connections={connections} />
          <div className="border-t border-stone-100 pt-5">
            {settings.isPending ? (
              <Skeleton className="h-9 w-72 max-w-full" />
            ) : settings.isError ? (
              <div>
                <p className="mb-2 text-sm text-stone-600">{t.loadFailed}</p>
                <LoadFailed error={settings.error} onRetry={() => void settings.refetch()} />
              </div>
            ) : me.isConsoleAdmin ? (
              <Editor
                projectId={me.projectId}
                declared={declared}
                etag={settings.data.etag}
                sources={sources}
                registries={registries}
                onReload={() => void settings.refetch()}
              />
            ) : (
              <dl className="text-sm">
                <dt className="font-medium text-stone-800">{t.project}</dt>
                <dd className="mt-1 text-stone-600" data-testid="destination-declared">{declaredLabel(declared, sources)}</dd>
              </dl>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-stone-100 pt-5 text-sm text-stone-600">
            <span>{t.environment}</span>
            {environmentUrl ? <LinkButton href={environmentUrl} external size="sm" tone="ghost">{t.openDashboard}</LinkButton> : null}
          </div>
        </CardBody>
      </Card>
    </section>
  )
}

function declaredLabel(declared: RepositoryDestinationSelection | null, sources: readonly GitHubSourceConnection[]): string {
  if (!declared) return text.destination.projectNone
  const source = sources.find((item) => item.id === declared.connectionId)
  return source ? text.destination.connectionOption(source.displayName, source.account.login) : text.destination.projectUnknown(declared.connectionId)
}

/** What the platform resolves today: where new repositories and images go, or why nothing can be created. */
function Effective({ connections }: { connections: UseQueryResult<CreateConnections> }) {
  const t = text.destination
  if (connections.isPending) return <Skeleton className="h-12 w-80 max-w-full" />
  if (connections.isError) return <LoadFailed error={connections.error} onRetry={() => void connections.refetch()} />
  const resolution = connections.data.destination
  const resolved = resolvedDestination(resolution)
  if (!resolved) {
    const problem = destinationProblem(resolution)!
    return (
      <Notice tone="warning" title={copy.create.destination.blockedTitle}>
        <span data-testid="destination-problem">{copy.create.destination.problem(problem.reason, problem.message)}</span>
      </Notice>
    )
  }
  const { destination } = resolved
  return (
    <div className="flex items-start gap-3" data-testid="destination-effective">
      <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-600">
        <FolderGit2 aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 text-sm">
        <p className="font-medium text-stone-800">{t.current}</p>
        <p className="mt-1 break-all text-stone-700">{t.currentRepository(destination.repositoryNamespace, destination.displayName)}</p>
        <p className="mt-0.5 font-mono text-xs break-all text-stone-500">{t.currentImage(destination.registryNamespace)}</p>
        <p className="mt-2 text-xs text-stone-500">{copy.create.destination.source[resolved.source]}</p>
      </div>
    </div>
  )
}

function Editor({ projectId, declared, etag, sources, registries, onReload }: {
  projectId: string
  declared: RepositoryDestinationSelection | null
  etag: string | undefined
  sources: readonly GitHubSourceConnection[]
  registries: readonly RegistryConnection[]
  onReload: () => void
}) {
  const t = text.destination
  const queryClient = useQueryClient()
  const [connectionId, setConnectionId] = useState(declared?.connectionId ?? INHERIT)
  const [imageAccessId, setImageAccessId] = useState(declared?.imageAccessId ?? AUTO)
  const [outcome, setOutcome] = useState<Outcome>()
  // A reloaded declaration (after a save or someone else's change) replaces the unsaved choice.
  useEffect(() => {
    setConnectionId(declared?.connectionId ?? INHERIT)
    setImageAccessId(declared?.imageAccessId ?? AUTO)
  }, [declared?.connectionId, declared?.imageAccessId])
  const selection: RepositoryDestinationSelection | null = connectionId === INHERIT
    ? null
    : { connectionId, ...(imageAccessId !== AUTO ? { imageAccessId } : {}) }
  const dirty = connectionId !== (declared?.connectionId ?? INHERIT) ||
    (connectionId !== INHERIT && imageAccessId !== (declared?.imageAccessId ?? AUTO))
  // One Idempotency-Key per intended change against one settings version: a resent save is the same write.
  const attempt = useRef<{ intent: string; key: string }>(undefined)

  const save = useMutation({
    mutationFn: async (next: RepositoryDestinationSelection | null) => {
      const intent = JSON.stringify([next, etag])
      if (attempt.current?.intent !== intent) attempt.current = { intent, key: crypto.randomUUID() }
      return client.platformApiPutProjectRepositoryDestinationSettings({
        params: { projectId },
        headers: { 'Idempotency-Key': attempt.current.key, 'If-Match': etag! },
        body: { defaultDestination: next },
      })
    },
    onSuccess: async () => {
      setOutcome({ kind: 'saved' })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.repositoryDestinationSettings(projectId) }),
        queryClient.invalidateQueries({ queryKey: keys.createConnections(projectId) }),
      ])
    },
    onError: (error) => {
      const envelope = platformErrorEnvelope(error)
      if (envelope?.status === 412 && envelope.details?.reason === SETTINGS_CHANGED) {
        setOutcome({ kind: 'changed' })
        onReload()
      } else if (envelope?.status === 403) {
        setOutcome({ kind: 'forbidden' })
      } else {
        setOutcome({ kind: 'failed', message: envelope?.message })
      }
    },
  })

  const declaredMissing = declared && !sources.some((source) => source.id === declared.connectionId)
  const connectionOptions = [
    { value: INHERIT, label: t.inherit },
    ...sources.map((source) => ({
      value: source.id,
      label: `${t.connectionOption(source.displayName, source.account.login)}${source.status === 'ready' ? '' : t.notReady}`,
    })),
    ...(declaredMissing ? [{ value: declared.connectionId, label: t.projectUnknown(declared.connectionId) }] : []),
  ]
  const imageOptions = [
    { value: AUTO, label: t.imageAccessAuto },
    ...registries.map((registry) => ({ value: registry.id, label: t.connectionOption(registry.displayName, registry.registryHost) })),
  ]

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!dirty || !etag || save.isPending) return
        setOutcome(undefined)
        save.mutate(selection)
      }}
    >
      <Field id="destination-connection" label={t.connection} hint={t.connectionHint}>
        <Select
          id="destination-connection"
          value={connectionId}
          onChange={(value) => { setConnectionId(value); setOutcome(undefined) }}
          options={connectionOptions}
          disabled={save.isPending}
          className="max-w-md"
        />
      </Field>
      {/* Only a choice when several registries could hold the images; otherwise the platform's pick is the only one. */}
      {connectionId !== INHERIT && (registries.length > 1 || imageAccessId !== AUTO) ? (
        <Field id="destination-image-access" label={t.imageAccess} hint={t.imageAccessHint}>
          <Select
            id="destination-image-access"
            value={imageAccessId}
            onChange={(value) => { setImageAccessId(value); setOutcome(undefined) }}
            options={imageOptions}
            disabled={save.isPending}
            className="max-w-md"
          />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" tone="primary" size="sm" loading={save.isPending} disabled={!dirty || !etag}>{t.save}</Button>
      </div>
      {outcome?.kind === 'saved' ? <Notice tone="success">{t.saved}</Notice>
        : outcome?.kind === 'changed' ? <Notice tone="warning">{t.changedElsewhere}</Notice>
          : outcome?.kind === 'forbidden' ? <Notice tone="error">{t.forbidden}</Notice>
            : outcome?.kind === 'failed' ? <Notice tone="error" title={t.saveFailed}>{outcome.message}</Notice>
              : null}
    </form>
  )
}
