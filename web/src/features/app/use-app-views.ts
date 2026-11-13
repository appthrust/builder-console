import type { ApplicationStack } from '@appthrust/api-schema/platform-api'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { BusinessApp } from '../../api/console-unverified'
import { copy } from '../../copy'
import { useApplicationReleases, useProjectReadModels } from '../../api/queries/app'
import { useSourceRepositories } from '../../api/queries/catalog'
import { draftsOptions } from '../../api/queries/build'
import { applicationForStack, deriveAppView, stackForApplication, type AppView, type ConsoleAppsInput } from '../../model/app'
import { jobState } from '../../model/contracts/build'
import { isImprovementDraft } from '../../model/improve'
import { readCreateSession } from '../create/persistence'
import { readBuildSession } from '../build/session'

export interface AppViews {
  /** Status word + second line for one BusinessApp, joined to the platform by `stackId`. */
  viewFor(app: Pick<BusinessApp, 'id' | 'stackId' | 'createdAt'>): AppView
  /** Project-wide platform read models, for screens that need more than the view. */
  input: ConsoleAppsInput
  loading: boolean
  failed: boolean
  /** First error among the failed core queries, for LoadFailed. */
  error: unknown
  refetch: () => void
}

const NO_STACKS: ApplicationStack[] = []

/**
 * Loads the project read models once (plus each application's release overview)
 * and derives AppView per BusinessApp. One call per screen.
 */
export function useAppViews(projectId: string): AppViews {
  const { applications, stacks, publishes, summaries } = useProjectReadModels(projectId)
  const drafts = useQuery(draftsOptions(projectId))
  const repositories = useSourceRepositories(projectId)
  const applicationRows = applications.data?.data
  const stackRows = stacks.data?.data ?? NO_STACKS
  const targets = useMemo(
    () =>
      (applicationRows ?? []).filter((application) => application.status.reason !== 'default_branch_unresolved').map((application) => ({
        applicationId: application.id,
        branchId: stackForApplication(application, stackRows)?.branchId ?? application.defaultBranchId,
      })),
    [applicationRows, stackRows]
  )
  const releases = useApplicationReleases(projectId, targets)

  // Derivation is cheap and pure; recomputing per render avoids memo bookkeeping
  // over a variable-length list of release queries.
  const input: ConsoleAppsInput = {
    applications: applicationRows ?? [],
    stacks: stackRows,
    publishes: publishes.data?.data ?? [],
    componentSummaries: summaries.data ?? [],
    sourceRepositories: repositories.data?.data,
    releasesByApplication: Object.fromEntries(
      targets.map((target, index) => [target.applicationId, releases[index]?.data])
    ),
  }

  const core = [applications, stacks, publishes, summaries, drafts, repositories]
  const failedQuery = core.find((query) => query.isError && !query.data)
  const loading = core.some((query) => query.isPending)
  return {
    // Until the stacks are known a bound app would read as 停止中; say 読み込み中 instead.
    viewFor: (app) => {
      if (loading) return { status: 'deploying', label: copy.status.deploying, text: copy.common.loading, second: copy.common.loading, draft: app.stackId === null }
      const session = app.stackId ? undefined : readCreateSession(app.id)
      const application = applicationForStack(app.stackId, input)
      // Build progress comes from the session that made the app; improvement sessions have their own page.
      const draft = drafts.data?.data.find((item) => application && !item.proposalId && !isImprovementDraft(item) && item.createdApplicationId === application.id)
      const handoff = draft?.creationExecutions?.at(-1)?.approval?.implementationHandoff ?? draft?.creationPlan?.implementationHandoff
      const build = draft && handoff ? {
        draftId: draft.id,
        initialReleaseId: readBuildSession(draft.id)?.initialReleaseId,
        taskCount: handoff.tasks.length,
        tasks: draft.implementationRuns?.at(-1)?.tasks,
        run: draft.implementationRuns?.at(-1),
      } : undefined
      return deriveAppView(app, input, Date.now(), {
        observed: drafts.isSuccess,
        // A job in a state this console does not know may still run: it counts as in progress, never as finished.
        inProgress: drafts.data?.data.some((item) =>
          !item.proposalId && [...item.creationPlanGenerations, ...item.creationExecutions].some((operation) => jobState(operation) !== 'settled')
        ),
        progress: session?.progress,
        reason: session?.failure?.message,
      }, build)
    },
    input,
    loading,
    failed: failedQuery !== undefined,
    error: failedQuery?.error,
    refetch: () => {
      for (const query of core) void query.refetch()
    },
  }
}
