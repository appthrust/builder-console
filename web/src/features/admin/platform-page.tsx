import { useQuery } from '@tanstack/react-query'
import { FolderGit2, Globe, Package, UsersRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { createConnectionsQuery, platformSettingsQuery, useMe } from '../../api/queries'
import { copy } from '../../copy'
import { pickPublishDomain } from '../../model/create'
import { Card, Disclosure, LoadFailed, Notice, PageHeader, Skeleton, StatusPill, useDocumentTitle } from '../../ui'
import { text } from './copy'
import { DirectoryMigrationBanner } from './directory-migration'

type RowState = 'ready' | 'missing' | 'checking' | 'unknown'

/**
 * 基盤の設定 (ux-design §7.1, C3): whether the platform pieces app creation
 * needs are in place, and who to ask otherwise. Read-only for everyone; the
 * settings themselves are changed on the platform side.
 */
export function AdminPlatformPage() {
  useDocumentTitle(copy.admin.platformTitle)
  const { data: me } = useMe()
  const settings = useQuery(platformSettingsQuery)
  // Same domain inventory the create wizard publishes on (model/create pickPublishDomain).
  const connections = useQuery(createConnectionsQuery(me.projectId))
  const domain = connections.data ? pickPublishDomain(connections.data.domains) : undefined
  const domainState: RowState = connections.isPending ? 'checking' : connections.isError ? 'unknown' : domain ? 'ready' : 'missing'

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={copy.admin.platformTitle} lead={copy.admin.platformLead} />
      <div className="mb-6 empty:hidden">
        <DirectoryMigrationBanner me={me} />
      </div>
      {settings.isPending ? (
        <Card>
          <div className="divide-y divide-stone-100" aria-busy="true">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center gap-4 px-5 py-5">
                <Skeleton className="size-9 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-64 max-w-full" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : settings.isError ? (
        <LoadFailed error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <div className="space-y-6">
          {me.isConsoleAdmin ? null : <Notice tone="info">{text.platform.readOnly}</Notice>}
          <Summary
            missing={[settings.data.github.connected, settings.data.registry.connected, domainState !== 'missing'].filter((ok) => !ok).length}
            checking={domainState === 'checking'}
          />
          <Card>
            <ul className="divide-y divide-stone-100">
              <StatusRow
                icon={<FolderGit2 aria-hidden className="size-4" />}
                title={copy.admin.github}
                state={settings.data.github.connected ? 'ready' : 'missing'}
              >
                {settings.data.github.connected ? copy.admin.githubOn : copy.admin.githubOff}
              </StatusRow>
              <StatusRow
                icon={<Package aria-hidden className="size-4" />}
                title={copy.admin.registry}
                state={settings.data.registry.connected ? 'ready' : 'missing'}
              >
                {settings.data.registry.connected ? copy.admin.registryOn : copy.admin.registryOff}
              </StatusRow>
              <StatusRow icon={<Globe aria-hidden className="size-4" />} title={text.platform.domain} state={domainState}>
                {domainState === 'checking' ? (
                  <Skeleton className="h-3 w-56 max-w-full" />
                ) : domainState === 'unknown' ? (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {text.platform.domainFailed}
                    <button
                      type="button"
                      onClick={() => void connections.refetch()}
                      className="rounded-sm font-medium text-accent-strong underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {copy.common.retry}
                    </button>
                  </span>
                ) : domain ? (
                  <span className="break-all">{text.platform.domainOn(domain)}</span>
                ) : (
                  text.platform.domainOff
                )}
              </StatusRow>
              <StatusRow
                icon={<UsersRound aria-hidden className="size-4" />}
                title={copy.admin.team}
                state={me.canCreateApps ? 'ready' : 'missing'}
              >
                <span className="block">{copy.admin.teamBody}</span>
                <span className="mt-1 block font-medium text-stone-700">{me.canCreateApps ? text.platform.teamYou : text.platform.teamNotYou}</span>
              </StatusRow>
            </ul>
          </Card>
          <Disclosure title={copy.admin.advanced}>
            <p className="mb-3 text-sm text-stone-500">{text.platform.advancedLead}</p>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[10rem_1fr] sm:gap-y-2">
              <Detail label={copy.admin.project} value={settings.data.projectId} />
              {settings.data.github.connectionId ? <Detail label={copy.admin.github} value={settings.data.github.connectionId} /> : null}
              {settings.data.registry.connectionId ? <Detail label={copy.admin.registry} value={settings.data.registry.connectionId} /> : null}
              {domain ? <Detail label={text.platform.domain} value={domain} /> : null}
            </dl>
          </Disclosure>
        </div>
      )}
    </div>
  )
}

function Summary({ missing, checking }: { missing: number; checking: boolean }) {
  if (missing > 0) {
    return (
      <Notice tone="warning" title={text.platform.summaryMissing(missing)}>
        {text.platform.summaryMissingBody}
      </Notice>
    )
  }
  if (checking) return null
  return (
    <Notice tone="success" title={text.platform.summaryReady}>
      {text.platform.summaryReadyBody}
    </Notice>
  )
}

/** 未設定 stays neutral (no pulsing "in progress" dot); the warning summary above carries the urgency. */
function StatusRow({ icon, title, state, children }: { icon: ReactNode; title: string; state: RowState; children: ReactNode }) {
  return (
    <li className="flex items-start gap-4 px-5 py-4">
      <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-600">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
          <StatusPill status={state === 'ready' ? 'live' : 'unknown'} label={text.platform[state]} />
        </div>
        <div className="mt-1 text-sm text-stone-600">{children}</div>
      </div>
    </li>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-stone-500">{label}</dt>
      <dd className="mb-2 font-mono break-all text-stone-800 sm:mb-0">{value}</dd>
    </>
  )
}
