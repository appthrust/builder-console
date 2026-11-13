// Joins between the console record and the platform read models the app page needs.
import type { ComponentScope } from '../../api/queries/app'
import type { AppView } from '../../model/app'
import { isOneOf } from '../../model/contracts/build'
import type { BusinessApp } from '../../model/contracts/console'

/** What the app screens read of a source repository (the catalog's list item). */
export interface SourceRepositoryRef {
  id: string
  repositoryUrl?: string
  existing?: { repository?: string }
}

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
  return stack && isOneOf(stack.sourceKind, 'application-source-repository') ? stack.sourceRepositoryRefName || undefined : undefined
}

export function sourceRepositoryFor<R extends SourceRepositoryRef>(view: AppView, repositories: readonly R[] | undefined): R | undefined {
  const id = sourceRepositoryIdFor(view)
  return id ? repositories?.find((repository) => repository.id === id) : undefined
}

/** Whether the source's last image build is known to have failed; a state this console does not know is not a failure. */
export function isSourceBuildFailed(repository: { build?: { state?: string } }): boolean {
  return repository.build?.state === 'failed'
}

/** `owner/name` of the GitHub repository (置き場) behind a source, once the platform reports it. */
export function repositoryNameOf(repository: SourceRepositoryRef | undefined): string | undefined {
  return repository?.existing?.repository ?? repository?.repositoryUrl?.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
}

/** The later of the console record's update and the web component's last release. */
export function lastUpdate(app: BusinessApp, view: AppView): string | undefined {
  const releaseAt = view.platform?.lastRelease?.at
  return releaseAt && releaseAt > app.updatedAt ? releaseAt : app.updatedAt
}
