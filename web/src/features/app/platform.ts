// Joins between the console record and the platform read models the app page needs.
import type { ApplicationSourceRepository } from '@appthrust/api-schema/platform-api'
import type { BusinessApp } from '../../api/console'
import type { ComponentScope } from '../../api/queries'
import type { AppView } from '../../model/app'

/** The web component of the bound application, when the platform has observed it. */
export function webScope(projectId: string, view: AppView): ComponentScope | undefined {
  const platform = view.platform
  return platform?.webComponentId
    ? { projectId, applicationId: platform.id, branchId: platform.branchId, componentId: platform.webComponentId }
    : undefined
}

/** The stack's explicit source reference is authoritative; shared images never imply repository ownership. */
export function sourceRepositoryIdFor(view: AppView): string | undefined {
  const stack = view.stack
  return stack?.sourceKind === 'application-source-repository' ? stack.sourceRepositoryRefName || undefined : undefined
}

export function sourceRepositoryFor(
  view: AppView,
  repositories: readonly ApplicationSourceRepository[] | undefined
): ApplicationSourceRepository | undefined {
  const id = sourceRepositoryIdFor(view)
  return id ? repositories?.find((repository) => repository.id === id) : undefined
}

/** `owner/name` of the GitHub repository (置き場) behind a source, once the platform reports it. */
export function repositoryNameOf(repository: ApplicationSourceRepository | undefined): string | undefined {
  return repository?.existing?.repository ?? repository?.repositoryUrl?.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
}

/** The later of the console record's update and the web component's last release. */
export function lastUpdate(app: BusinessApp, view: AppView): string | undefined {
  const releaseAt = view.platform?.lastRelease?.at
  return releaseAt && releaseAt > app.updatedAt ? releaseAt : app.updatedAt
}
