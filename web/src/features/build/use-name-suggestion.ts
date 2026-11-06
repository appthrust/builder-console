import type { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import { useQuery } from '@tanstack/react-query'
import { buildKeys } from '../../api/build-queries'
import { client } from '../../api/client'
import { consoleApi } from '../../api/console'
import type { BuildFailure } from '../../model/build/types'
import { suggestFreeUrlName } from '../create/availability'

/** Use the wizard's availability check, not a guessed suffix from the failure text. */
export function useNameSuggestion(draft: ApplicationDraft, failure: BuildFailure | undefined, groupPath: string | undefined): string | undefined {
  const urlName = draft.creationPlan?.applicationStackRequest?.publish?.subdomain
  const enabled = failure?.reasonCode === 'PublishURLConflict' && Boolean(urlName && groupPath)
  const suggestion = useQuery({
    queryKey: [...buildKeys.draft(draft.projectId, draft.id), 'free-url-name', groupPath, urlName, draft.creationExecutions?.at(-1)?.id, draft.createdApplicationStackId],
    enabled,
    queryFn: async ({ signal }) => await suggestFreeUrlName({
      projectId: draft.projectId, groupPath: groupPath!, urlName: urlName!, entry: undefined,
      own: { stackId: draft.createdApplicationStackId },
    }, { resolve: consoleApi.resolve, platform: client, signal }) ?? null,
  })
  return enabled ? suggestion.data ?? undefined : undefined
}
